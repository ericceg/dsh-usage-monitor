// dsh-credits — client bundle (Web).
//
// Plain __ModuleLoader__ factory, no build step. Registers three surfaces:
//   - a persistent credits chip in the sidebar footer (above Settings)
//   - a per-chat spend pill in the composer dock (next to the token stats)
//   - one shared details panel in shell.overlay
//
// Data comes from the host half's same-origin GET /api/dsh-credits route.
window.__ModuleLoader__.load({
  id: 'dsh-credits',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useSyncExternalStore } = React

    // ---------------------------------------------------------------------
    // Formatting
    // ---------------------------------------------------------------------

    const SYMBOLS = { CNY: '\u00a5', USD: '$', CHF: 'CHF ', EUR: '\u20ac', GBP: '\u00a3' }

    function symbolOf(currency) {
      return SYMBOLS[currency] !== undefined ? SYMBOLS[currency] : String(currency) + ' '
    }

    function number(value) {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : 0
    }

    function formatNative(amount, currency) {
      if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) return '\u2014'
      const value = Number(amount)
      const digits = Math.abs(value) > 0 && Math.abs(value) < 0.01 ? 4 : 2
      return symbolOf(currency) + value.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: digits,
      })
    }

    function formatChf(amount) {
      if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) return '\u2014'
      const value = Number(amount)
      if (value > 0 && value < 0.01) return 'CHF <0.01'
      return 'CHF ' + value.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    }

    function formatChfPrecise(amount) {
      if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) return '\u2014'
      const value = Number(amount)
      if (value > 0 && value < 0.1) return 'CHF ' + value.toFixed(3)
      return 'CHF ' + value.toFixed(2)
    }

    function formatTokens(value) {
      const count = number(value)
      if (count >= 1e9) return (count / 1e9).toFixed(2) + 'B'
      if (count >= 1e6) return (count / 1e6).toFixed(2) + 'M'
      if (count >= 1e3) return (count / 1e3).toFixed(1) + 'K'
      return String(Math.round(count))
    }

    function formatPercent(value) {
      if (value === null || value === undefined || !Number.isFinite(Number(value))) return '\u2014'
      const percent = Number(value) * 100
      return (percent >= 99.95 ? '100' : percent.toFixed(1)) + '%'
    }

    function formatClock(timestamp) {
      if (!timestamp) return '\u2014'
      const date = new Date(timestamp)
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }

    function rateOf(fx, currency) {
      const rate = number(fx && fx.rates ? fx.rates[currency] : undefined)
      return rate > 0 ? rate : null
    }

    function toChf(amount, currency, fx) {
      if (currency === 'CHF') return number(amount)
      const rate = rateOf(fx, currency)
      return rate === null ? null : number(amount) / rate
    }

    // ---------------------------------------------------------------------
    // Data store
    // ---------------------------------------------------------------------

    const POLL_MS = 60_000

    const store = {
      state: {
        status: 'loading',
        data: null,
        error: null,
        refreshing: false,
        updatedAt: 0,
        panelOpen: false,
        chat: null,
      },
      listeners: new Set(),
      timer: null,
      inflight: null,
      started: false,
      onVisible: null,
      onFocus: null,
    }

    store.getSnapshot = () => store.state

    store.emit = (patch) => {
      store.state = { ...store.state, ...patch }
      for (const listener of [...store.listeners]) {
        try { listener() } catch (error) { console.error('[dsh-credits] listener failed', error) }
      }
    }

    store.subscribe = (listener) => {
      store.listeners.add(listener)
      startPolling()
      return () => {
        store.listeners.delete(listener)
        if (store.listeners.size === 0) stopPolling()
      }
    }

    function clientQuery(force) {
      const tz = -new Date().getTimezoneOffset() * 60
      const boot = typeof window !== 'undefined' ? window.__DSH_BOOT__ : undefined
      const version = boot && boot.release && boot.release.version ? String(boot.release.version) : '0.2.1'
      const locale = (typeof navigator !== 'undefined' && navigator.language) || 'en'
      const params = new URLSearchParams({
        tz: String(tz),
        version,
        locale,
        force: force ? '1' : '0',
      })
      return '/api/dsh-credits?' + params.toString()
    }

    function refresh(force) {
      if (store.inflight !== null && force !== true) return store.inflight
      store.emit({ refreshing: true, status: store.state.data === null ? 'loading' : store.state.status })
      const promise = (async () => {
        try {
          const response = await fetch(clientQuery(force === true), {
            cache: 'no-store',
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
          })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          const data = await response.json()
          if (data === null || typeof data !== 'object') throw new Error('invalid response')
          store.emit({
            status: 'ready',
            data,
            error: data.ok === false ? String(data.message || data.error || 'query failed') : null,
            refreshing: false,
            updatedAt: Date.now(),
          })
        } catch (error) {
          store.emit({
            status: store.state.data === null ? 'error' : 'ready',
            error: String((error && error.message) || error),
            refreshing: false,
          })
        }
      })()
      const wrapped = promise.finally(() => {
        if (store.inflight === wrapped) store.inflight = null
      })
      store.inflight = wrapped
      return wrapped
    }

    function startPolling() {
      if (store.started) return
      store.started = true
      void refresh(false)
      store.timer = setInterval(() => { void refresh(false) }, POLL_MS)
      if (typeof document !== 'undefined') {
        store.onVisible = () => { if (document.visibilityState === 'visible') void refresh(false) }
        document.addEventListener('visibilitychange', store.onVisible)
      }
      if (typeof window !== 'undefined') {
        store.onFocus = () => { void refresh(false) }
        window.addEventListener('focus', store.onFocus)
      }
    }

    function stopPolling() {
      if (!store.started) return
      store.started = false
      if (store.timer !== null) { clearInterval(store.timer); store.timer = null }
      if (typeof document !== 'undefined' && store.onVisible) document.removeEventListener('visibilitychange', store.onVisible)
      if (typeof window !== 'undefined' && store.onFocus) window.removeEventListener('focus', store.onFocus)
      store.onVisible = null
      store.onFocus = null
    }

    function setPanelOpen(open) {
      if (store.state.panelOpen === open) return
      store.emit({ panelOpen: open })
      if (open) void refresh(true)
    }

    function setChat(chat) {
      const previous = store.state.chat
      if (previous !== null && chat !== null
        && previous.sessionId === chat.sessionId
        && previous.tokens === chat.tokens
        && previous.chf === chat.chf
        && previous.currency === chat.currency
        && previous.model === chat.model) return
      if (previous === null && chat === null) return
      store.emit({ chat })
    }

    function clearChat(sessionId) {
      const previous = store.state.chat
      if (previous === null) return
      if (sessionId !== undefined && previous.sessionId !== sessionId) return
      store.emit({ chat: null })
    }

    function useStore() {
      return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    }

    // ---------------------------------------------------------------------
    // Derived values
    // ---------------------------------------------------------------------

    function accountBalance(account, fx) {
      const result = { chf: null, byCurrency: {}, nativeParts: [] }
      if (account === null || account === undefined) return result
      const wallets = [
        ...(Array.isArray(account.normal) ? account.normal : []),
        ...(Array.isArray(account.bonus) ? account.bonus : []),
      ]
      let chf = 0
      let hasChf = false
      for (const wallet of wallets) {
        const amount = number(wallet.balance)
        if (amount === 0) continue
        const currency = String(wallet.currency || '')
        result.byCurrency[currency] = (result.byCurrency[currency] || 0) + amount
        const converted = toChf(amount, currency, fx)
        if (converted !== null) { chf += converted; hasChf = true }
      }
      if (hasChf) result.chf = chf
      for (const [currency, amount] of Object.entries(result.byCurrency)) {
        result.nativeParts.push(formatNative(amount, currency))
      }
      return result
    }

    function usageCurrency(data) {
      const byCurrency = data && data.usage && data.usage.byCurrency ? data.usage.byCurrency : null
      if (byCurrency === null) return null
      const preferred = data.pricing && data.pricing.currency
      if (preferred && byCurrency[preferred]) return preferred
      const keys = Object.keys(byCurrency)
      return keys.length > 0 ? keys[0] : null
    }

    function usageSumFor(data, field) {
      const usage = data && data.usage ? data.usage : null
      const fx = data ? data.fx : null
      const result = { chf: null, byCurrency: {}, nativeParts: [] }
      if (usage === null || usage.byCurrency === null || usage.byCurrency === undefined) return result
      let chf = 0
      let hasChf = false
      for (const [currency, bucket] of Object.entries(usage.byCurrency)) {
        const amount = number(bucket[field])
        if (amount === 0) continue
        result.byCurrency[currency] = (result.byCurrency[currency] || 0) + amount
        const converted = toChf(amount, currency, fx)
        if (converted !== null) { chf += converted; hasChf = true }
      }
      if (hasChf) result.chf = chf
      for (const [currency, amount] of Object.entries(result.byCurrency)) {
        result.nativeParts.push(formatNative(amount, currency))
      }
      return result
    }

    function totalCostChf(account, fx) {
      const result = { chf: null, byCurrency: {}, nativeParts: [] }
      if (account === null || account === undefined || !Array.isArray(account.totalCosts)) return result
      let chf = 0
      let hasChf = false
      for (const cost of account.totalCosts) {
        const amount = number(cost.amount)
        if (amount === 0) continue
        const currency = String(cost.currency || '')
        result.byCurrency[currency] = (result.byCurrency[currency] || 0) + amount
        const converted = toChf(amount, currency, fx)
        if (converted !== null) { chf += converted; hasChf = true }
      }
      if (hasChf) result.chf = chf
      for (const [currency, amount] of Object.entries(result.byCurrency)) {
        result.nativeParts.push(formatNative(amount, currency))
      }
      return result
    }

    function estimateChat(usage, data, sessionId, nodes) {
      if (usage === null || usage === undefined) return null
      const cacheHit = number(usage.cacheReadTokens)
      const cacheMiss = number(usage.uncachedInputTokens) + number(usage.cacheWriteTokens)
      const output = number(usage.outputTokens)
      const tokens = cacheHit + cacheMiss + output
      if (tokens <= 0) return null
      const pricing = data && data.pricing ? data.pricing : null
      if (pricing === null || pricing.models === undefined) {
        return { sessionId, tokens, chf: null, native: null, currency: null, model: null }
      }
      let model = pricing.models[pricing.defaultModel] !== undefined
        ? pricing.defaultModel
        : Object.keys(pricing.models)[0]
      // The token projection has no route, but the loaded Chat turns do. Use a
      // route only when every route-bearing turn agrees on one priced model.
      try {
        const routes = new Set()
        for (const node of Array.isArray(nodes) ? nodes : []) {
          const turnUsage = node && node.data ? node.data.tokenUsage : undefined
          for (const route of turnUsage && Array.isArray(turnUsage.routes) ? turnUsage.routes : []) {
            if (route && typeof route.model === 'string' && pricing.models[route.model] !== undefined) routes.add(route.model)
          }
        }
        if (routes.size === 1) model = [...routes][0]
      } catch {
        // Keep the default model; a changed Chat snapshot shape must not break the pill.
      }
      const table = pricing.models[model]
      const index = pricing.peak === true ? 1 : 0
      const native = (cacheHit / 1e6) * number(table.cacheHit[index])
        + (cacheMiss / 1e6) * number(table.cacheMiss[index])
        + (output / 1e6) * number(table.output[index])
      const rate = rateOf(data.fx, pricing.currency)
      const chf = rate === null ? null : native / rate
      return { sessionId, tokens, chf, native, currency: pricing.currency, model, peak: pricing.peak === true, estimated: true }
    }

    // ---------------------------------------------------------------------
    // Surfaced components
    // ---------------------------------------------------------------------

    function Dot({ tone }) {
      return h('span', { className: 'dsc-dot dsc-dot-' + tone, 'aria-hidden': 'true' })
    }

    function CreditsChip(props) {
      const state = useStore()
      const wide = props.wide !== false
      const data = state.data
      const balance = data && data.account ? accountBalance(data.account, data.fx) : null
      const chf = balance === null ? null : balance.chf
      const low = chf !== null && chf < number(data.lowBalanceChf || 2)
      const tone = state.error !== null && data === null ? 'err' : low ? 'warn' : 'ok'
      const signedOut = data !== null && data.signedIn === false
      const amount = signedOut ? 'Sign in' : chf === null ? '\u2014' : formatChf(chf)
      const native = balance !== null && balance.nativeParts.length > 0 ? balance.nativeParts.join(' + ') : null
      const title = signedOut
        ? 'DeepSeek credits \u2014 sign in from Settings \u2192 Account'
        : 'Credits left: ' + (chf === null ? 'unavailable' : formatChf(chf)) + (native ? ' (' + native + ')' : '')
          + (low ? ' \u2014 low balance' : '')
          + (state.error ? ' \u2014 ' + state.error : '')
          + '. Click for usage details.'

      return h('button', {
        type: 'button',
        className: 'dsc-chip' + (wide ? ' dsc-chip-wide' : ' dsc-chip-rail'),
        onClick: () => { setPanelOpen(true) },
        title,
        'aria-label': title,
        'data-tone': tone,
      },
      h(Dot, { tone }),
      wide
        ? h('span', { className: 'dsc-chip-body' },
          h('span', { className: 'dsc-chip-label' }, 'Credits'),
          h('span', { className: 'dsc-chip-amount' }, amount),
        )
        : h('span', { className: 'dsc-chip-rail-amount' }, chf === null ? '\u2014' : chf.toFixed(1)),
      )
    }

    function CreditsPill(props) {
      const state = useStore()
      const usage = props.useProjection('tokenUsage')
      const nodes = props.useChat(s => s.legacy.nodes)
      const sessionId = props.sessionId
      const chat = useMemo(
        () => estimateChat(usage, state.data, sessionId, nodes),
        [usage, state.data, sessionId, nodes],
      )
      useEffect(() => {
        if (chat === null) clearChat()
        else setChat(chat)
      }, [chat === null ? null : chat.tokens, chat === null ? null : chat.chf, chat === null ? null : chat.model, sessionId])
      // Leaving a conversation (or switching sessions) means the panel should
      // not keep claiming the previous chat's spend as "this chat".
      useEffect(() => () => { clearChat(sessionId) }, [sessionId])
      if (chat === null) return null
      const title = [
        'This chat \u2248 ' + formatNative(chat.native, chat.currency) + ' (' + formatChfPrecise(chat.chf) + ')',
        formatTokens(chat.tokens) + ' tokens',
        chat.model || null,
        chat.peak ? 'peak price' : 'off-peak price',
        'estimated from provider-reported tokens; click for credits & usage',
      ].filter(Boolean).join(' \u00b7 ')
      return h('span', { className: 'dsc-pill-anchor', 'data-composer-stat': 'credits' },
        h('button', {
          type: 'button',
          className: 'dsc-pill',
          title,
          'aria-label': title,
          onClick: () => { setPanelOpen(true) },
        },
        h('span', { className: 'dsc-pill-glyph', 'aria-hidden': 'true' }, '\u2248'),
        h('span', { className: 'dsc-pill-text' }, formatChfPrecise(chat.chf)),
        ),
      )
    }

    function Row({ label, value, sub, tone }) {
      return h('div', { className: 'dsc-row' },
        h('div', { className: 'dsc-row-label' }, label, sub ? h('span', { className: 'dsc-row-sub' }, sub) : null),
        h('div', { className: 'dsc-row-value' + (tone ? ' dsc-tone-' + tone : '') }, value),
      )
    }

    function Sparkline({ days, currency }) {
      if (!Array.isArray(days) || days.length === 0) return null
      const max = Math.max(...days.map(day => number(day.cost)), 0)
      return h('div', { className: 'dsc-spark', role: 'img', 'aria-label': 'Daily spend' },
        ...days.map(day => h('div', {
          key: day.date,
          className: 'dsc-spark-bar',
          title: day.date + ': ' + formatNative(day.cost, currency),
          style: { height: (max > 0 ? Math.max(3, Math.round((number(day.cost) / max) * 34)) : 3) + 'px' },
          'data-empty': number(day.cost) === 0 ? 'true' : 'false',
        })),
      )
    }

    function CreditsPanel() {
      const state = useStore()
      const open = state.panelOpen
      useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            setPanelOpen(false)
          }
        }
        document.addEventListener('keydown', onKey, true)
        window.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('keydown', onKey, true)
          window.removeEventListener('keydown', onKey, true)
        }
      }, [open])
      if (!open) return null

      const data = state.data
      const error = state.error
      const signedOut = data !== null && data.signedIn === false
      const expired = data !== null && data.expired === true
      const warnings = data && Array.isArray(data.warnings) ? data.warnings : []
      const account = data && data.account ? data.account : null
      const fx = data ? data.fx : null
      const balance = accountBalance(account, fx)
      const month = usageSumFor(data, 'total')
      const today = usageSumFor(data, 'today')
      const allTime = totalCostChf(account, fx)
      const chat = state.chat
      const primaryCurrency = usageCurrency(data)
      const usageBucket = data && data.usage && data.usage.byCurrency && primaryCurrency
        ? data.usage.byCurrency[primaryCurrency]
        : null
      const tokens = usageBucket ? usageBucket.tokens : null
      const models = usageBucket && Array.isArray(usageBucket.byModel) ? usageBucket.byModel.slice(0, 4) : []
      const days = usageBucket && Array.isArray(usageBucket.days) ? usageBucket.days : []
      const rateCurrency = usageBucket ? primaryCurrency : null
      const low = balance.chf !== null && balance.chf < number(data && data.lowBalanceChf || 2)

      const header = h('div', { className: 'dsc-panel-head' },
        h('div', { className: 'dsc-panel-title' },
          h('span', { className: 'dsc-panel-mark', 'aria-hidden': 'true' }, '\u25c8'),
          h('span', null, 'Credits & usage'),
          expired ? h('span', { className: 'dsc-badge dsc-badge-err' }, 'Session expired') : null,
        ),
        h('button', { type: 'button', className: 'dsc-close', onClick: () => { setPanelOpen(false) }, 'aria-label': 'Close' }, '\u00d7'),
      )

      const body = []

      if (signedOut || expired) {
        body.push(h('div', { className: 'dsc-empty' },
          h('div', { className: 'dsc-empty-title' }, 'Sign in to see credits'),
          h('div', { className: 'dsc-empty-copy' }, 'Open Settings \u2192 Account and sign in to DeepSeek. This panel updates automatically.'),
        ))
      } else if (data === null) {
        body.push(h('div', { className: 'dsc-empty' },
          h('div', { className: 'dsc-empty-title' }, error ? 'Credits unavailable' : 'Loading credits\u2026'),
          error ? h('div', { className: 'dsc-empty-copy' }, error) : null,
        ))
      } else {
        body.push(h('div', { className: 'dsc-hero' },
          h('div', { className: 'dsc-hero-label' }, 'Total left'),
          h('div', { className: 'dsc-hero-value' + (low ? ' dsc-tone-warn' : '') }, balance.chf === null ? '\u2014' : formatChf(balance.chf)),
          h('div', { className: 'dsc-hero-native' }, balance.nativeParts.length > 0 ? balance.nativeParts.join(' + ') : 'No stored balance'),
          low
            ? h('div', { className: 'dsc-hero-warn' },
              'Low balance \u2014 ',
              account && account.topUpUrl
                ? h('a', { className: 'dsc-hero-link', href: account.topUpUrl, target: '_blank', rel: 'noopener noreferrer' }, 'top up on Platform')
                : 'top up on Platform',
            )
            : null,
        ))

        body.push(h('div', { className: 'dsc-grid' },
          h('div', { className: 'dsc-stat' },
            h('div', { className: 'dsc-stat-label' }, 'This chat'),
            h('div', { className: 'dsc-stat-value' }, chat === null ? '\u2014' : formatChfPrecise(chat.chf)),
            h('div', { className: 'dsc-stat-sub' }, chat === null
              ? 'Open a chat'
              : '\u2248 ' + formatNative(chat.native, chat.currency) + ' \u00b7 ' + formatTokens(chat.tokens) + ' tokens'),
          ),
          h('div', { className: 'dsc-stat' },
            h('div', { className: 'dsc-stat-label' }, 'Today'),
            h('div', { className: 'dsc-stat-value' }, formatChf(today.chf)),
            h('div', { className: 'dsc-stat-sub' }, today.nativeParts.length > 0 ? today.nativeParts.join(' + ') : 'No spend yet'),
          ),
          h('div', { className: 'dsc-stat' },
            h('div', { className: 'dsc-stat-label' }, data.usage ? data.usage.label : 'This month'),
            h('div', { className: 'dsc-stat-value' }, formatChf(month.chf)),
            h('div', { className: 'dsc-stat-sub' }, month.nativeParts.length > 0 ? month.nativeParts.join(' + ') : 'No spend yet'),
          ),
          h('div', { className: 'dsc-stat' },
            h('div', { className: 'dsc-stat-label' }, 'All time'),
            h('div', { className: 'dsc-stat-value' }, formatChf(allTime.chf)),
            h('div', { className: 'dsc-stat-sub' }, allTime.nativeParts.length > 0 ? allTime.nativeParts.join(' + ') : 'Platform total'),
          ),
        ))

        const walletRows = []
        for (const wallet of account && Array.isArray(account.normal) ? account.normal : []) {
          if (number(wallet.balance) === 0) continue
          walletRows.push(h(Row, {
            key: 'normal-' + wallet.currency,
            label: 'Topped-up balance',
            value: formatNative(wallet.balance, wallet.currency),
            sub: 'CHF ' + (toChf(wallet.balance, wallet.currency, fx) === null ? '\u2014' : toChf(wallet.balance, wallet.currency, fx).toFixed(2)),
          }))
        }
        for (const wallet of account && Array.isArray(account.bonus) ? account.bonus : []) {
          if (number(wallet.balance) === 0) continue
          walletRows.push(h(Row, {
            key: 'bonus-' + wallet.currency,
            label: 'Granted balance',
            value: formatNative(wallet.balance, wallet.currency),
            sub: 'CHF ' + (toChf(wallet.balance, wallet.currency, fx) === null ? '\u2014' : toChf(wallet.balance, wallet.currency, fx).toFixed(2)),
          }))
        }
        if (walletRows.length > 0) {
          body.push(h('div', { className: 'dsc-section' },
            h('div', { className: 'dsc-section-title' }, 'Balance'),
            walletRows,
          ))
        }

        if (days.length > 0) {
          body.push(h('div', { className: 'dsc-section' },
            h('div', { className: 'dsc-section-title' }, 'Daily spend', h('span', { className: 'dsc-section-note' }, 'last ' + days.length + ' days \u00b7 ' + (rateCurrency || ''))),
            h(Sparkline, { days, currency: rateCurrency }),
          ))
        }

        if (models.length > 0) {
          body.push(h('div', { className: 'dsc-section' },
            h('div', { className: 'dsc-section-title' }, 'This month by model'),
            ...models.map(model => h(Row, {
              key: 'model-' + model.model,
              label: model.model,
              sub: formatTokens(number(model.tokens && model.tokens.cacheHit) + number(model.tokens && model.tokens.cacheMiss) + number(model.tokens && model.tokens.output)) + ' tokens',
              value: formatNative(model.cost, rateCurrency),
              tone: null,
            })),
          ))
        }

        if (tokens !== null && tokens !== undefined) {
          const billedInput = number(tokens.cacheHit) + number(tokens.cacheMiss) + number(tokens.prompt)
          body.push(h('div', { className: 'dsc-section' },
            h('div', { className: 'dsc-section-title' }, 'This month tokens'),
            h('div', { className: 'dsc-token-grid' },
              h('div', null, h('div', { className: 'dsc-token-label' }, 'Cache hit'), h('div', { className: 'dsc-token-value' }, formatTokens(tokens.cacheHit))),
              h('div', null, h('div', { className: 'dsc-token-label' }, 'Cache miss'), h('div', { className: 'dsc-token-value' }, formatTokens(tokens.cacheMiss))),
              h('div', null, h('div', { className: 'dsc-token-label' }, 'Output'), h('div', { className: 'dsc-token-value' }, formatTokens(tokens.output))),
              h('div', null, h('div', { className: 'dsc-token-label' }, 'Cache hit rate'), h('div', { className: 'dsc-token-value' }, formatPercent(usageBucket.cacheHitRate))),
              h('div', null, h('div', { className: 'dsc-token-label' }, 'Requests'), h('div', { className: 'dsc-token-value' }, formatTokens(tokens.requests))),
              h('div', null, h('div', { className: 'dsc-token-label' }, 'Billed input'), h('div', { className: 'dsc-token-value' }, formatTokens(billedInput))),
            ),
          ))
        }

        const notes = []
        if (fx !== null && fx !== undefined) {
          const cny = rateOf(fx, 'CNY')
          const usd = rateOf(fx, 'USD')
          notes.push('FX: 1 CHF = ' + (cny === null ? '\u2014' : '\u00a5' + cny.toFixed(4))
            + (usd === null ? '' : ' = $' + usd.toFixed(4))
            + (fx.date ? ' \u00b7 ' + fx.date : '')
            + (fx.source ? ' \u00b7 ' + fx.source : '')
            + (fx.stale ? ' (cached)' : ''))
        }
        if (data.pricing !== null && data.pricing !== undefined) {
          notes.push('Chat estimate uses ' + data.pricing.defaultModel + ' list prices ('
            + data.pricing.currency + ', ' + (data.pricing.peak ? 'peak' : 'off-peak') + ' now). Cache-write tokens are priced as cache-miss.')
        }
        if (warnings.includes('usage-unavailable')) notes.push('Platform usage is unavailable right now; balance is still live.')
        if (warnings.includes('session-expired')) notes.push('The Platform session expired. Sign in again from Settings \u2192 Account.')
        if (warnings.includes('balance-unavailable')) notes.push('The wallet summary is unavailable right now.')
        if (error !== null && error !== undefined) notes.push('Last error: ' + error)
        if (notes.length > 0) {
          body.push(h('div', { className: 'dsc-notes' }, ...notes.map((note, index) => h('div', { key: 'note-' + index }, note))))
        }

        body.push(h('div', { className: 'dsc-actions' },
          h('div', { className: 'dsc-updated' }, state.refreshing ? 'Refreshing\u2026' : 'Updated ' + formatClock(state.updatedAt)),
          h('div', { className: 'dsc-action-buttons' },
            h('button', { type: 'button', className: 'dsc-btn', onClick: () => { void refresh(true) }, disabled: state.refreshing === true }, 'Refresh'),
            account && account.usageUrl
              ? h('a', { className: 'dsc-btn', href: account.usageUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Open Platform')
              : null,
          ),
        ))
      }

      return h('div', { className: 'dsc-panel-root', onMouseDown: (event) => { if (event.target === event.currentTarget) setPanelOpen(false) } },
        h('div', { className: 'dsc-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Credits and usage' },
          header,
          h('div', { className: 'dsc-panel-body' }, ...body),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------

    const CSS = `
      .dsc-chip { display:flex; align-items:center; gap:7px; box-sizing:border-box; width:100%; min-width:0;
        border:0; background:transparent; color:var(--dsw-alias-label-primary, #e8e8e8); cursor:pointer;
        font-family:inherit; text-align:left; border-radius:8px; padding:6px 8px; }
      .dsc-chip:hover { background:color-mix(in srgb, var(--dsw-alias-label-primary, #e8e8e8) 7%, transparent); }
      .dsc-chip:focus-visible { outline:2px solid var(--dsw-alias-brand-primary, #4d6bfe); outline-offset:1px; }
      .dsc-chip-rail { justify-content:center; flex-direction:column; gap:3px; padding:5px 0; }
      .dsc-chip-rail-amount { font-size:10px; line-height:1; font-variant-numeric:tabular-nums; color:var(--dsw-alias-label-secondary, #9b9b9b); }
      .dsc-chip-body { display:flex; flex-direction:column; min-width:0; line-height:1.2; }
      .dsc-chip-label { font-size:10px; letter-spacing:.02em; color:var(--dsw-alias-label-secondary, #9b9b9b); }
      .dsc-chip-amount { font-size:12.5px; font-weight:600; font-variant-numeric:tabular-nums; white-space:nowrap;
        overflow:hidden; text-overflow:ellipsis; }
      .dsc-dot { width:6px; height:6px; border-radius:50%; flex:none; background:var(--dsw-alias-state-success-primary, #3ecf8e); }
      .dsc-dot-warn { background:var(--dsw-alias-state-warn-primary, #f5a623); }
      .dsc-dot-err { background:var(--dsw-alias-state-error-primary, #f56c6c); }
      .dsc-dot-ok { background:var(--dsw-alias-state-success-primary, #3ecf8e); }

      .dsc-pill-anchor { display:inline-flex; align-items:center; }
      .dsc-pill { display:inline-flex; align-items:center; gap:4px; height:24px; padding:0 8px; border:0;
        border-radius:999px; background:transparent; color:var(--dsw-alias-label-secondary, #9b9b9b);
        font-family:inherit; font-size:12px; font-variant-numeric:tabular-nums; cursor:pointer; white-space:nowrap; }
      .dsc-pill:hover { color:var(--dsw-alias-label-primary, #e8e8e8); background:color-mix(in srgb, var(--dsw-alias-label-primary, #e8e8e8) 8%, transparent); }
      .dsc-pill:focus-visible { outline:2px solid var(--dsw-alias-brand-primary, #4d6bfe); outline-offset:1px; }
      .dsc-pill-glyph { font-size:12px; opacity:.8; }
      .dsc-pill-text { font-weight:500; }

      .dsc-panel-root { position:fixed; inset:0; z-index:4000; display:flex; align-items:center; justify-content:center;
        padding:24px; background:rgba(0,0,0,.38); pointer-events:auto; }
      .dsc-panel { width:min(600px, 100%); max-height:min(82vh, 760px); display:flex; flex-direction:column;
        background:var(--dsw-alias-bg-layer-2, #232323); color:var(--dsw-alias-label-primary, #e8e8e8);
        border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12)); border-radius:16px;
        box-shadow:0 24px 80px rgba(0,0,0,.45); overflow:hidden;
        font-family:inherit; font-size:13px; }
      .dsc-panel-head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:16px 18px 12px; }
      .dsc-panel-title { display:flex; align-items:center; gap:8px; font-size:15px; font-weight:600; }
      .dsc-panel-mark { color:var(--dsw-alias-brand-primary, #4d6bfe); font-size:16px; }
      .dsc-badge { font-size:10.5px; font-weight:600; padding:2px 7px; border-radius:999px; }
      .dsc-badge-err { color:#ffb4b4; background:rgba(245,108,108,.14); }
      .dsc-close { border:0; background:transparent; color:var(--dsw-alias-label-secondary, #9b9b9b);
        font-size:22px; line-height:1; width:30px; height:30px; border-radius:8px; cursor:pointer; }
      .dsc-close:hover { color:var(--dsw-alias-label-primary, #e8e8e8); background:color-mix(in srgb, var(--dsw-alias-label-primary, #e8e8e8) 8%, transparent); }
      .dsc-panel-body { padding:0 18px 16px; overflow:auto; display:flex; flex-direction:column; gap:14px; }

      .dsc-hero { padding:14px 16px; border-radius:12px; background:color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 10%, transparent);
        border:1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 22%, transparent); }
      .dsc-hero-label { font-size:11px; letter-spacing:.04em; text-transform:uppercase; color:var(--dsw-alias-label-secondary, #9b9b9b); }
      .dsc-hero-value { font-size:30px; line-height:1.15; font-weight:700; font-variant-numeric:tabular-nums; margin-top:2px; }
      .dsc-hero-native { margin-top:3px; color:var(--dsw-alias-label-secondary, #9b9b9b); font-size:12.5px; }
      .dsc-hero-warn { margin-top:7px; font-size:12px; font-weight:600; color:var(--dsw-alias-state-warn-primary, #f5a623); }
      .dsc-hero-link { color:inherit; text-decoration:underline; text-underline-offset:2px; }

      .dsc-grid { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:8px; }
      .dsc-stat { padding:10px 11px; border-radius:10px; background:color-mix(in srgb, var(--dsw-alias-label-primary, #e8e8e8) 5%, transparent);
        min-width:0; }
      .dsc-stat-label { font-size:11px; color:var(--dsw-alias-label-secondary, #9b9b9b); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .dsc-stat-value { margin-top:3px; font-size:15px; font-weight:650; font-variant-numeric:tabular-nums; }
      .dsc-stat-sub { margin-top:2px; font-size:10.5px; color:var(--dsw-alias-label-secondary, #9b9b9b); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

      .dsc-section { display:flex; flex-direction:column; gap:6px; }
      .dsc-section-title { display:flex; align-items:baseline; justify-content:space-between; gap:8px;
        font-size:11px; letter-spacing:.04em; text-transform:uppercase; color:var(--dsw-alias-label-secondary, #9b9b9b); }
      .dsc-section-note { text-transform:none; letter-spacing:0; font-size:10.5px; }
      .dsc-row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:6px 0;
        border-bottom:1px solid color-mix(in srgb, var(--dsw-alias-label-primary, #e8e8e8) 7%, transparent); }
      .dsc-row:last-child { border-bottom:0; }
      .dsc-row-label { display:flex; flex-direction:column; min-width:0; }
      .dsc-row-sub { font-size:10.5px; color:var(--dsw-alias-label-secondary, #9b9b9b); margin-top:1px; }
      .dsc-row-value { font-variant-numeric:tabular-nums; font-weight:600; white-space:nowrap; }
      .dsc-tone-warn { color:var(--dsw-alias-state-warn-primary, #f5a623); }

      .dsc-spark { display:flex; align-items:flex-end; gap:4px; height:40px; padding:4px 2px 0; }
      .dsc-spark-bar { flex:1; min-width:4px; border-radius:3px 3px 1px 1px; background:var(--dsw-alias-brand-primary, #4d6bfe); opacity:.8; }
      .dsc-spark-bar[data-empty="true"] { background:color-mix(in srgb, var(--dsw-alias-label-primary, #e8e8e8) 16%, transparent); opacity:1; }

      .dsc-token-grid { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:8px; }
      .dsc-token-label { font-size:10.5px; color:var(--dsw-alias-label-secondary, #9b9b9b); }
      .dsc-token-value { font-size:13.5px; font-weight:600; font-variant-numeric:tabular-nums; margin-top:1px; }

      .dsc-notes { display:flex; flex-direction:column; gap:3px; font-size:10.5px; line-height:1.5; color:var(--dsw-alias-label-secondary, #9b9b9b); }
      .dsc-actions { display:flex; align-items:center; justify-content:space-between; gap:10px; padding-top:2px; }
      .dsc-updated { font-size:10.5px; color:var(--dsw-alias-label-secondary, #9b9b9b); }
      .dsc-action-buttons { display:flex; align-items:center; gap:8px; }
      .dsc-btn { display:inline-flex; align-items:center; justify-content:center; height:28px; padding:0 12px; border-radius:8px;
        border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.16)); background:transparent;
        color:var(--dsw-alias-label-primary, #e8e8e8); font-family:inherit; font-size:12px; font-weight:500;
        cursor:pointer; text-decoration:none; }
      .dsc-btn:hover { background:color-mix(in srgb, var(--dsw-alias-label-primary, #e8e8e8) 8%, transparent); }
      .dsc-btn:disabled { opacity:.55; cursor:default; }

      .dsc-empty { padding:28px 18px; text-align:center; }
      .dsc-empty-title { font-size:15px; font-weight:600; }
      .dsc-empty-copy { margin-top:6px; color:var(--dsw-alias-label-secondary, #9b9b9b); font-size:12px; line-height:1.5; }

      @media (max-width: 560px) {
        .dsc-grid { grid-template-columns:repeat(2, minmax(0,1fr)); }
        .dsc-token-grid { grid-template-columns:repeat(2, minmax(0,1fr)); }
      }
    `

    // ---------------------------------------------------------------------
    // Plugin
    // ---------------------------------------------------------------------

    exports.name = 'dsh-credits'
    exports.inject = ['slots']

    exports.apply = function apply(ctx) {
      const slots = ctx.slots !== undefined ? ctx.slots : ctx.get('slots')
      if (slots === undefined || slots === null) {
        console.error('[dsh-credits] slots service is absent; credits UI not mounted')
        return
      }

      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.dshCredits = 'styles'
        style.textContent = CSS
        document.head.append(style)
        return () => { style.remove() }
      })

      ctx.effect(() => slots.inject('sidebar.footer.action', () => slots.register({
        name: 'sidebar.footer.action',
        id: 'dsh-credits',
        order: 40,
        label: () => 'Credits',
      }, CreditsChip)))

      ctx.effect(() => slots.inject('conversation.composer.dock', () => slots.register({
        name: 'conversation.composer.dock',
        id: 'credits',
        order: 2,
        label: () => 'Credits',
      }, CreditsPill)))

      ctx.effect(() => slots.inject('shell.overlay', () => slots.register({
        name: 'shell.overlay',
        id: 'dsh-credits-panel',
        order: 960,
        label: () => 'Credits & usage',
      }, CreditsPanel)))

      console.info('[dsh-credits] mounted: sidebar chip, composer pill, details panel')
    }

    return module.exports
  },
})
