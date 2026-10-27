/**
 * dsh-credits — host half.
 *
 * Serves one same-origin JSON route for the browser half:
 *   GET /api/dsh-credits?tz=<seconds east of UTC>&force=0|1
 *
 * It reads the signed-in DeepSeek Platform grant through the account service,
 * then asks Platform for the wallet summary and the current-month usage cost
 * and token tables. FX rates come from Frankfurter (ECB reference rates) with
 * a configurable fallback. No credential or platform token ever leaves this
 * process.
 */
import { createHash } from 'node:crypto'

/** Bundle metadata. */
export const name = 'dsh-credits'

/** Host services this plugin needs before it activates. */
export const inject = ['deepseekAccount', 'webServer', 'connection']

const ROUTE = '/api/dsh-credits'
const FX_URL = 'https://api.frankfurter.dev/v1/latest?base=CHF&symbols=CNY,USD'
const FX_SOURCE = 'frankfurter'

/** DeepSeek list prices, in currency units per 1M tokens: [off-peak, peak]. */
const PRICE_TABLE = {
  CNY: {
    'deepseek-flash': {
      cacheHit: [0.02, 0.04],
      cacheMiss: [1, 2],
      output: [4, 8],
    },
    'deepseek-v4-pro': {
      cacheHit: [0.15, 0.3],
      cacheMiss: [4.5, 9],
      output: [13.5, 27],
    },
  },
  USD: {
    'deepseek-flash': {
      cacheHit: [0.003, 0.006],
      cacheMiss: [0.15, 0.3],
      output: [0.6, 1.2],
    },
    'deepseek-v4-pro': {
      cacheHit: [0.022, 0.044],
      cacheMiss: [0.66, 1.32],
      output: [1.98, 3.96],
    },
  },
}

const DEFAULTS = {
  defaultModel: 'deepseek-flash',
  lowBalanceChf: 2,
  refreshSeconds: 60,
  fxFallbackRates: { CNY: 8.05, USD: 1.21 },
  balanceCacheMs: 30_000,
  usageCacheMs: 5 * 60_000,
  fxCacheMs: 6 * 60 * 60_000,
  requestTimeoutMs: 15_000,
  /** Extra headers for deployments that put Platform behind private routing. */
  platformRequestHeaders: {},
}

/** @param {number} value @returns {number} clamped UTC offset in seconds. */
function clampOffset(value) {
  if (!Number.isFinite(value)) return 0
  return Math.max(-14 * 3600, Math.min(14 * 3600, Math.trunc(value)))
}

/** @param {URLSearchParams} query @returns {number} */
function queryOffset(query) {
  const raw = query.get('tz')
  return clampOffset(raw === null ? 0 : Number(raw))
}

/** @param {number} tzOffset @returns {{year:number, month:number, date:string}} */
function localDate(tzOffset) {
  const shifted = new Date(Date.now() + tzOffset * 1000)
  const year = shifted.getUTCFullYear()
  const month = shifted.getUTCMonth() + 1
  const day = shifted.getUTCDate()
  return { year, month, date: `${year}-${pad2(month)}-${pad2(day)}` }
}

/** @param {number} tzOffset @returns {{year:number, month:number}} UTC Gregorian month for Platform queries. */
function usageMonth(tzOffset) {
  const shifted = new Date(Date.now() + tzOffset * 1000)
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1 }
}

/** @param {number} value @returns {string} */
function pad2(value) {
  return value < 10 ? `0${value}` : String(value)
}

/** @param {number} year @param {number} month @returns {string} */
function monthLabel(year, month) {
  const date = new Date(Date.UTC(year, month - 1, 1))
  return new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date)
}

/**
 * DeepSeek peak windows are Beijing weekdays 09:00–12:00 and 14:00–18:00.
 * Chinese public holidays are not modelled; the price table is advisory.
 * @param {number} [now] epoch milliseconds.
 * @returns {boolean} whether the current instant bills at peak rates.
 */
function isPeak(now = Date.now()) {
  const beijing = new Date(now + 8 * 3600 * 1000)
  const weekday = beijing.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes()
  return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60)
}

/** @param {Record<string, unknown>} headers @returns {Headers} */
function platformHeaders(session, meta) {
  const headers = {
    accept: 'application/json',
    'x-dsh-auth-token': session.token,
    'x-client-platform': 'web',
    'x-client-version': meta.version,
    'x-client-locale': meta.wireLocale,
    'x-client-timezone-offset': String(meta.tzOffset),
  }
  for (const [key, value] of Object.entries(session.requestHeaders ?? {})) {
    if (value !== undefined && value !== null) headers[key.toLowerCase()] = String(value)
  }
  return headers
}

/** One Platform call; throws a tagged error for expired credentials. */
async function platformFetch(session, meta, path, params, timeoutMs) {
  const origin = session.origin.endsWith('/') ? session.origin : `${session.origin}/`
  const url = new URL(path.replace(/^\//, ''), origin)
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, String(value))
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort(new Error('platform request timed out')) }, timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: platformHeaders(session, meta),
      redirect: 'error',
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) {
      throw Object.assign(new Error(`platform HTTP ${String(response.status)}`), { status: response.status })
    }
    let payload
    try { payload = JSON.parse(text) } catch { throw new Error('platform returned invalid JSON') }
    if (payload === null || typeof payload !== 'object') throw new Error('platform returned no payload')
    const biz = payload.data
    const top = typeof payload.code === 'number' ? payload.code : 0
    const nested = biz && typeof biz.biz_code === 'number' ? biz.biz_code : 0
    if (top === 40002 || top === 40003 || nested === 40002 || nested === 40003) {
      throw Object.assign(new Error('platform credential rejected'), { expired: true })
    }
    if (top !== 0) throw new Error(`platform error ${String(top)}: ${String(payload.msg ?? '')}`)
    if (nested !== 0) throw new Error(`platform error ${String(nested)}: ${String(biz?.biz_msg ?? '')}`)
    return biz && Object.prototype.hasOwnProperty.call(biz, 'biz_data') ? biz.biz_data : biz
  } finally {
    clearTimeout(timer)
  }
}

/** @param {unknown} list @returns {Array<{currency:string,balance:string}>} */
function normalizeWallets(list) {
  if (!Array.isArray(list)) return []
  return list
    .filter(wallet => wallet !== null && typeof wallet === 'object')
    .map(wallet => ({
      currency: String(wallet.currency ?? ''),
      balance: String(wallet.balance ?? '0'),
    }))
    .filter(wallet => wallet.currency !== '')
}

/** @param {unknown} biz @returns {{normal:Array, bonus:Array, totalCosts:Array}} */
function normalizeSummary(biz) {
  const source = biz !== null && typeof biz === 'object' ? biz : {}
  return {
    normal: normalizeWallets(source.normal_wallets),
    bonus: normalizeWallets(source.bonus_wallets),
    totalCosts: Array.isArray(source.total_costs)
      ? source.total_costs
        .filter(entry => entry !== null && typeof entry === 'object')
        .map(entry => ({ currency: String(entry.currency ?? ''), amount: String(entry.amount ?? '0') }))
        .filter(entry => entry.currency !== '')
      : [],
  }
}

/** @param {unknown} usage @returns {Record<string, number>} */
function usageAmounts(usage) {
  const result = {}
  if (!Array.isArray(usage)) return result
  for (const entry of usage) {
    if (entry === null || typeof entry !== 'object') continue
    const type = String(entry.type ?? '')
    const amount = Number(entry.amount)
    if (type === '' || !Number.isFinite(amount)) continue
    result[type] = (result[type] ?? 0) + amount
  }
  return result
}

/** @param {Record<string, number>} amounts @returns {number} */
function costOf(amounts) {
  let total = 0
  for (const [type, amount] of Object.entries(amounts)) {
    if (type === 'REQUEST') continue
    total += amount
  }
  return total
}

/** @param {Array} blocks @returns {Map<string, object>} */
function indexByCurrency(blocks) {
  const map = new Map()
  if (!Array.isArray(blocks)) return map
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    const currency = String(block.currency ?? '')
    if (currency !== '') map.set(currency, block)
  }
  return map
}

/** @param {Array} models @returns {Map<string, object>} */
function indexByModel(models) {
  const map = new Map()
  if (!Array.isArray(models)) return map
  for (const model of models) {
    if (model === null || typeof model !== 'object') continue
    const key = String(model.model ?? '')
    if (key !== '') map.set(key, model)
  }
  return map
}

/**
 * Fold the cost and amount tables into one compact per-currency view.
 * @param {unknown} costData
 * @param {unknown} amountData
 * @param {string} todayDate
 * @returns {{byCurrency: Record<string, object>, currencies: string[]}}
 */
function normalizeUsage(costData, amountData, todayDate) {
  const costBlocks = indexByCurrency(costData)
  // The amount endpoint answers one currency-independent table: { total, days }.
  // The cost endpoint answers one block per wallet currency.
  const amountModels = indexByModel(amountData?.total)
  const currencies = costBlocks.size > 0 ? [...costBlocks.keys()] : ['CNY']
  const byCurrency = {}

  for (const currency of currencies) {
    const costBlock = costBlocks.get(currency)
    const costModels = indexByModel(costBlock?.total)
    const modelNames = [...new Set([...costModels.keys(), ...amountModels.keys()])].sort()

    const byModel = []
    const tokens = { cacheHit: 0, cacheMiss: 0, prompt: 0, output: 0, requests: 0 }
    let monthTotal = 0

    for (const model of modelNames) {
      const costAmounts = usageAmounts(costModels.get(model)?.usage)
      const tokenAmounts = usageAmounts(amountModels.get(model)?.usage)
      const cost = costOf(costAmounts)
      const modelTokens = {
        cacheHit: tokenAmounts.PROMPT_CACHE_HIT_TOKEN ?? 0,
        cacheMiss: tokenAmounts.PROMPT_CACHE_MISS_TOKEN ?? 0,
        prompt: tokenAmounts.PROMPT_TOKEN ?? 0,
        output: tokenAmounts.RESPONSE_TOKEN ?? 0,
        requests: tokenAmounts.REQUEST ?? 0,
      }
      monthTotal += cost
      tokens.cacheHit += modelTokens.cacheHit
      tokens.cacheMiss += modelTokens.cacheMiss
      tokens.prompt += modelTokens.prompt
      tokens.output += modelTokens.output
      tokens.requests += modelTokens.requests
      if (cost > 0) byModel.push({ model, cost, tokens: modelTokens })
    }
    byModel.sort((left, right) => right.cost - left.cost)

    const days = []
    if (Array.isArray(costBlock?.days)) {
      for (const day of costBlock.days) {
        if (day === null || typeof day !== 'object' || typeof day.date !== 'string') continue
        let cost = 0
        if (Array.isArray(day.data)) {
          for (const model of day.data) cost += costOf(usageAmounts(model?.usage))
        }
        days.push({ date: day.date, cost })
      }
    }
    days.sort((left, right) => left.date.localeCompare(right.date))
    const upToToday = days.filter(day => day.date <= todayDate)
    const sparkline = (upToToday.length > 0 ? upToToday : days).slice(-14)
    const today = days.find(day => day.date === todayDate)
    const billedInput = tokens.cacheHit + tokens.cacheMiss + tokens.prompt
    const cacheHitRate = billedInput > 0 ? tokens.cacheHit / billedInput : null

    byCurrency[currency] = {
      total: monthTotal,
      byModel,
      tokens,
      cacheHitRate,
      days: sparkline,
      today: today?.cost ?? 0,
      todayDate: today?.date ?? null,
    }
  }

  return { byCurrency, currencies }
}

/** Read (or refresh) the Platform wallet summary. */
async function readSummary(session, meta, cfg, force) {
  const key = tokenKey(session.token)
  const cached = cache.summary
  if (!force && cached.key === key && Date.now() - cached.at < cfg.balanceCacheMs) return cached.value
  const biz = await platformFetch(session, meta, '/api/v0/users/get_user_summary', {}, cfg.requestTimeoutMs)
  const value = normalizeSummary(biz)
  cache.summary = { key, at: Date.now(), value }
  return value
}

/** Read (or refresh) the current-month cost and token tables. */
async function readUsage(session, meta, cfg, year, month, todayDate, force) {
  const key = `${tokenKey(session.token)}:${String(year)}-${String(month)}:${todayDate}`
  const cached = cache.usage
  if (!force && cached.key === key && Date.now() - cached.at < cfg.usageCacheMs) {
    return cached.value
  }
  const results = await Promise.allSettled([
    platformFetch(session, meta, '/api/v0/usage/cost', { month, year }, cfg.requestTimeoutMs),
    platformFetch(session, meta, '/api/v0/usage/amount', { month, year }, cfg.requestTimeoutMs),
  ])
  const costData = results[0].status === 'fulfilled' ? results[0].value : null
  const amountData = results[1].status === 'fulfilled' ? results[1].value : null
  if (costData === null && amountData === null) {
    const reason = results[0].status === 'rejected' ? results[0].reason : undefined
    throw reason instanceof Error ? reason : new Error('usage query failed')
  }
  const value = {
    year,
    month,
    label: monthLabel(year, month),
    ...normalizeUsage(costData, amountData, todayDate),
  }
  cache.usage = { key, at: Date.now(), value }
  return value
}

/** Read (or refresh) CHF reference rates. Never rejects. */
async function readFx(cfg, force) {
  const cached = cache.fx
  if (!force && cached.value !== null && Date.now() - cached.at < cfg.fxCacheMs) return cached.value
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort(new Error('fx request timed out')) }, cfg.requestTimeoutMs)
    try {
      const response = await fetch(FX_URL, {
        headers: { accept: 'application/json' },
        redirect: 'follow',
        signal: controller.signal,
      })
      const payload = await response.json()
      const rates = payload?.rates
      if (!response.ok || rates === null || typeof rates !== 'object') throw new Error('fx response invalid')
      const value = {
        base: 'CHF',
        rates: {
          CHF: 1,
          CNY: Number(rates.CNY) > 0 ? Number(rates.CNY) : cfg.fxFallbackRates.CNY,
          USD: Number(rates.USD) > 0 ? Number(rates.USD) : cfg.fxFallbackRates.USD,
        },
        date: typeof payload.date === 'string' ? payload.date : null,
        source: FX_SOURCE,
        fetchedAt: Date.now(),
        stale: false,
      }
      cache.fx = { at: Date.now(), value }
      return value
    } finally {
      clearTimeout(timer)
    }
  } catch {
    if (cached.value !== null) return { ...cached.value, stale: true }
    return {
      base: 'CHF',
      rates: { CHF: 1, ...cfg.fxFallbackRates },
      date: null,
      source: 'fallback',
      fetchedAt: Date.now(),
      stale: true,
    }
  }
}

/** @param {string} token @returns {string} */
function tokenKey(token) {
  return createHash('sha256').update(token).digest('hex').slice(0, 16)
}

/** @param {object} wallets @returns {string} preferred billing currency for local price estimates. */
function primaryCurrency(account) {
  const all = [...(account?.normal ?? []), ...(account?.bonus ?? [])]
  if (all.some(wallet => wallet.currency === 'CNY' && Number(wallet.balance) > 0)) return 'CNY'
  if (all.some(wallet => wallet.currency === 'USD' && Number(wallet.balance) > 0)) return 'USD'
  if (all.some(wallet => wallet.currency === 'CNY')) return 'CNY'
  return all[0]?.currency === 'USD' ? 'USD' : 'CNY'
}

const cache = {
  summary: { key: '', at: 0, value: null },
  usage: { key: '', at: 0, value: null },
  fx: { at: 0, value: null },
}

/**
 * Build one complete response snapshot.
 * @param {string} rawUrl request URL with query.
 * @param {object} account DeepSeek account service.
 * @param {object} cfg resolved config.
 * @returns {Promise<object>} JSON body.
 */
export async function buildPayload(rawUrl, account, cfg) {
  const url = new URL(rawUrl, 'http://localhost')
  const tzOffset = queryOffset(url.searchParams)
  const force = url.searchParams.get('force') === '1'
  const client = localDate(tzOffset)
  const month = usageMonth(tzOffset)
  const meta = {
    tzOffset,
    version: url.searchParams.get('version') || '0.2.1',
    wireLocale: /^zh/i.test(url.searchParams.get('locale') || '') ? 'zh_CN' : 'en_US',
  }
  const warnings = []

  const fx = await readFx(cfg, force)
  const session = await account.getPlatformSession()
  if (!session || typeof session.token !== 'string' || typeof session.origin !== 'string') {
    return {
      ok: true,
      signedIn: false,
      updatedAt: Date.now(),
      account: null,
      usage: null,
      fx,
      pricing: null,
      lowBalanceChf: cfg.lowBalanceChf,
      refreshSeconds: cfg.refreshSeconds,
      warnings: ['signed-out'],
    }
  }

  const [summaryResult, usageResult] = await Promise.allSettled([
    readSummary(session, meta, cfg, force),
    readUsage(session, meta, cfg, month.year, month.month, client.date, force),
  ])

  let accountBucket = null
  if (summaryResult.status === 'fulfilled') {
    accountBucket = summaryResult.value
  } else {
    warnings.push(expiredReason(summaryResult.reason) ? 'session-expired' : 'balance-unavailable')
    if (expiredReason(summaryResult.reason)) {
      return {
        ok: true,
        signedIn: true,
        expired: true,
        updatedAt: Date.now(),
        account: null,
        usage: null,
        fx,
        pricing: null,
        lowBalanceChf: cfg.lowBalanceChf,
        refreshSeconds: cfg.refreshSeconds,
        warnings,
      }
    }
  }

  let usage = null
  if (usageResult.status === 'fulfilled') {
    usage = usageResult.value
  } else {
    warnings.push(expiredReason(usageResult.reason) ? 'session-expired' : 'usage-unavailable')
  }

  const currency = primaryCurrency(accountBucket)
  const pricing = {
    currency,
    defaultModel: cfg.defaultModel,
    peak: isPeak(),
    models: PRICE_TABLE[currency] ?? PRICE_TABLE.CNY,
  }

  return {
    ok: true,
    signedIn: true,
    expired: false,
    updatedAt: Date.now(),
    account: {
      normal: accountBucket?.normal ?? [],
      bonus: accountBucket?.bonus ?? [],
      totalCosts: accountBucket?.totalCosts ?? [],
      usageUrl: `${session.origin.replace(/\/$/, '')}/usage`,
      topUpUrl: `${session.origin.replace(/\/$/, '')}/top_up`,
    },
    usage,
    fx,
    pricing,
    lowBalanceChf: cfg.lowBalanceChf,
    refreshSeconds: cfg.refreshSeconds,
    warnings,
  }
}

/** @param {unknown} reason @returns {boolean} */
function expiredReason(reason) {
  return Boolean(reason !== null && typeof reason === 'object' && reason.expired === true)
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} body */
function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, max-age=0',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

/**
 * Mount the route.
 * @param {import('@deepseek-ai/cordis').Context} ctx host context.
 * @param {Record<string, unknown>} [config] loader row config.
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  const account = ctx.deepseekAccount
  const webServer = ctx.webServer
  const connection = ctx.connection
  if (account === undefined || webServer === undefined) {
    console.error('[dsh-credits] missing deepseekAccount or webServer; credits chip stays empty')
    return
  }

  const handler = async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      // The Web server's exact routes are public unless they check the signed
      // browser cookie themselves. Reuse Connection's admission so this route
      // is only readable by the authenticated app document.
      if (connection !== undefined && connection !== null) {
        const admitted = connection.admit({ headers: req.headers })
        if (admitted !== null && typeof admitted === 'object' && 'rejection' in admitted) {
          sendJson(res, admitted.rejection, { ok: false, error: 'unauthorized' })
          return
        }
      }
      if (req.method === 'HEAD') {
        res.writeHead(204, { 'cache-control': 'no-store' })
        res.end()
        return
      }
      const body = await buildPayload(req.url ?? ROUTE, account, cfg)
      sendJson(res, 200, body)
    } catch (error) {
      console.error('[dsh-credits] route failed:', error instanceof Error ? error.message : error)
      sendJson(res, 500, { ok: false, error: 'internal', message: 'credits query failed' })
    }
  }

  ctx.effect(() => webServer.register({ kind: 'exact', path: ROUTE, handler }))
  ctx.logger?.('dsh-credits')?.info?.('serving %s', ROUTE)
}
