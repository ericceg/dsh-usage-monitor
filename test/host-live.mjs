// Dev-only live probe: uses the locally stored Platform grant through a mock
// account service so the route can be tested without the running app.
import { readFileSync } from 'node:fs'
import { apply, buildPayload } from '../lib/index.js'

const credentials = readFileSync(`${process.env.HOME}/.dsh/.credentials.yaml`, 'utf8')
const token = /deepseek-account-platform\/default:[\s\S]*?token:\s*(\S+)/.exec(credentials)?.[1]
if (!token) throw new Error('no local DeepSeek account token found')

const account = {
  async getPlatformSession() {
    return { origin: 'https://platform.deepseek.com', token }
  },
}

const cfg = {
  defaultModel: 'deepseek-flash',
  lowBalanceChf: 2,
  refreshSeconds: 60,
  fxFallbackRates: { CNY: 8.05, USD: 1.21 },
  balanceCacheMs: 0,
  usageCacheMs: 0,
  fxCacheMs: 0,
  requestTimeoutMs: 20000,
}

const tz = -new Date().getTimezoneOffset() * 60
const body = await buildPayload(`/api/dsh-credits?tz=${tz}&force=1&version=0.2.1&locale=en`, account, cfg)
console.log(JSON.stringify({
  ok: body.ok,
  signedIn: body.signedIn,
  expired: body.expired,
  warnings: body.warnings,
  fx: body.fx,
  account: body.account,
  pricing: body.pricing,
  usageMonth: body.usage?.label,
  byCurrency: Object.fromEntries(Object.entries(body.usage?.byCurrency ?? {}).map(([c, v]) => [c, {
    total: v.total,
    today: v.today,
    tokens: v.tokens,
    cacheHitRate: v.cacheHitRate,
    topModels: v.byModel.slice(0, 3).map(m => ({ model: m.model, cost: m.cost })),
    days: v.days.length,
  }])),
}, null, 2))
if (JSON.stringify(body).includes(token)) throw new Error('TOKEN LEAK DETECTED')
