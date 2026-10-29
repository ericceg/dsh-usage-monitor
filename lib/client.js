// dsh-credits — client bundle (Web).
//
// Plain __ModuleLoader__ factory, no build step. Registers five surfaces:
//   - a persistent credits chip in the sidebar footer (above Settings)
//   - a per-chat spend pill in the composer dock (next to the token stats)
//   - a floating, draggable credits card in shell.overlay (always on top)
//   - one shared details panel in shell.overlay
//   - a Settings → General row that hides or shows the floating card
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
    const {
      useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
    } = React

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

    /** Exact money for tooltips: small daily amounts keep four decimals, trailing zeros trimmed. */
    function formatExact(amount, currency) {
      if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) return '\u2014'
      const value = Number(amount)
      const digits = Math.abs(value) >= 1 ? 2 : 4
      const text = value.toFixed(digits).replace(/(\.\d\d)0+$/, '$1')
      return symbolOf(currency) + text
    }

    /** Turn a Platform "YYYY-MM-DD" bucket date into "Wed, 29 Oct". */
    function formatDay(date) {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date))
      if (match === null) return String(date)
      const value = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
      try {
        return value.toLocaleDateString([], {
          weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
        })
      } catch {
        return String(date)
      }
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
    const CARD_KEY = 'dsh-credits:card:v1'
    const SETTINGS_KEY = 'dsh-credits:settings:v1'
    const RECENT_CHATS_KEY = 'dsh-credits:recent-chats:v1'
    const MAX_RECENT_CHATS = 6
    const CARD_MARGIN = 12

    function storageGet(key) {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return null
        return window.localStorage.getItem(key)
      } catch {
        // Storage can throw in private mode or when a policy blocks it.
        return null
      }
    }

    function storageSet(key, value) {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return
        window.localStorage.setItem(key, value)
      } catch {
        // Persistence is a convenience; the card still works without it.
      }
    }

    function readJsonStorage(key) {
      const raw = storageGet(key)
      if (raw === null || raw === '') return null
      try {
        return JSON.parse(raw)
      } catch {
        return null
      }
    }

    function loadCardPreferences() {
      const stored = readJsonStorage(CARD_KEY)
      const source = stored !== null && typeof stored === 'object' ? stored : {}
      return {
        mode: source.mode === 'compact' ? 'compact' : 'expanded',
        x: typeof source.x === 'number' && Number.isFinite(source.x) ? source.x : null,
        y: typeof source.y === 'number' && Number.isFinite(source.y) ? source.y : null,
      }
    }

    /** The device's own preferences. `null` means "follow the Host default". */
    function loadSettings() {
      const stored = readJsonStorage(SETTINGS_KEY)
      const source = stored !== null && typeof stored === 'object' ? stored : {}
      return {
        showCard: typeof source.floatingCard === 'boolean' ? source.floatingCard : null,
      }
    }

    function loadRecentChats() {
      const stored = readJsonStorage(RECENT_CHATS_KEY)
      if (!Array.isArray(stored)) return []
      const recent = []
      for (const entry of stored) {
        if (entry === null || typeof entry !== 'object') continue
        if (typeof entry.sessionId !== 'string' || entry.sessionId === '') continue
        const chf = Number(entry.chf)
        if (!Number.isFinite(chf)) continue
        recent.push({
          sessionId: entry.sessionId,
          title: typeof entry.title === 'string' && entry.title !== '' ? entry.title : null,
          chf,
          tokens: number(entry.tokens),
          model: typeof entry.model === 'string' ? entry.model : null,
          at: number(entry.at),
        })
        if (recent.length >= MAX_RECENT_CHATS) break
      }
      return recent
    }

    function saveCardPreferences() {
      storageSet(CARD_KEY, JSON.stringify({
        mode: store.state.cardMode,
        x: store.state.cardX,
        y: store.state.cardY,
      }))
    }

    function saveSettings() {
      storageSet(SETTINGS_KEY, JSON.stringify({ floatingCard: store.state.showCard }))
    }

    const cardPreferences = loadCardPreferences()
    const settingsPreferences = loadSettings()

    const store = {
      state: {
        status: 'loading',
        data: null,
        error: null,
        refreshing: false,
        updatedAt: 0,
        panelOpen: false,
        chat: null,
        cardMode: cardPreferences.mode,
        cardX: cardPreferences.x,
        cardY: cardPreferences.y,
        showCard: settingsPreferences.showCard,
        recentChats: loadRecentChats(),
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

    function chatSignature(chat) {
      if (chat === null) return 'none'
      return [chat.sessionId, chat.tokens, chat.chf, chat.model, chat.title || ''].join('\u0000')
    }

    function setChat(chat) {
      const previous = store.state.chat
      if (chatSignature(previous) === chatSignature(chat)) return
      store.emit({ chat })
    }

    function clearChat(sessionId) {
      const previous = store.state.chat
      if (previous === null) return
      if (sessionId !== undefined && previous.sessionId !== sessionId) return
      store.emit({ chat: null })
    }

    /** Keep the last few finished chats on this device so the card has history. */
    function rememberChat(chat) {
      if (chat === null || chat === undefined) return
      if (!Number.isFinite(chat.chf) || chat.chf <= 0 || number(chat.tokens) <= 0) return
      const entry = {
        sessionId: chat.sessionId,
        title: chat.title || null,
        chf: chat.chf,
        tokens: chat.tokens,
        model: chat.model || null,
        at: Date.now(),
      }
      const recent = [entry, ...store.state.recentChats.filter(item => item.sessionId !== entry.sessionId)]
        .slice(0, MAX_RECENT_CHATS)
      storageSet(RECENT_CHATS_KEY, JSON.stringify(recent))
      store.emit({ recentChats: recent })
    }

    function setCardMode(mode) {
      const next = mode === 'compact' ? 'compact' : 'expanded'
      if (store.state.cardMode === next) return
      store.emit({ cardMode: next })
      saveCardPreferences()
    }

    function setCardPosition(x, y) {
      const hasPosition = typeof x === 'number' && Number.isFinite(x)
        && typeof y === 'number' && Number.isFinite(y)
      const nextX = hasPosition ? x : null
      const nextY = hasPosition ? y : null
      if (store.state.cardX === nextX && store.state.cardY === nextY) return
      store.emit({ cardX: nextX, cardY: nextY })
      saveCardPreferences()
    }

    /**
     * Whether the floating card should render. An explicit device choice wins;
     * otherwise the Host config decides, and the card shows while loading.
     */
    function isCardVisible(state) {
      if (typeof state.showCard === 'boolean') return state.showCard
      const data = state.data
      return data === null || data === undefined || data.floatingCard !== false
    }

    function setCardVisible(visible) {
      const next = typeof visible === 'boolean' ? visible : null
      if (store.state.showCard === next) return
      store.emit({ showCard: next })
      saveSettings()
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

    /** Pick a single priced model from the routes a group of turns used. */
    function resolvePricedModel(pricing, routes) {
      if (pricing === null || pricing === undefined || pricing.models === undefined) return null
      const models = Object.keys(pricing.models)
      const candidates = new Set()
      for (const route of Array.isArray(routes) ? routes : []) {
        if (route && typeof route.model === 'string' && pricing.models[route.model] !== undefined) {
          candidates.add(route.model)
        }
      }
      if (candidates.size === 1) return [...candidates][0]
      if (pricing.defaultModel !== undefined && pricing.models[pricing.defaultModel] !== undefined) {
        return pricing.defaultModel
      }
      return models.length > 0 ? models[0] : null
    }

    /**
     * Price one provider-reported usage record with the list price table.
     * @returns {object|null} null when the record carries no billable tokens.
     */
    function priceUsage(usage, data, sessionId, routes) {
      if (usage === null || usage === undefined) return null
      const cacheHit = number(usage.cacheReadTokens)
      const cacheMiss = number(usage.uncachedInputTokens) + number(usage.cacheWriteTokens)
      const output = number(usage.outputTokens)
      const tokens = cacheHit + cacheMiss + output
      if (tokens <= 0) return null
      const pricing = data && data.pricing ? data.pricing : null
      const model = resolvePricedModel(pricing, routes)
      if (pricing === null || model === null) {
        return {
          sessionId, tokens, cacheHit, cacheMiss, output,
          chf: null, native: null, currency: null, model: null, peak: false, estimated: true,
        }
      }
      const table = pricing.models[model]
      const index = pricing.peak === true ? 1 : 0
      const native = (cacheHit / 1e6) * number(table.cacheHit[index])
        + (cacheMiss / 1e6) * number(table.cacheMiss[index])
        + (output / 1e6) * number(table.output[index])
      const rate = rateOf(data.fx, pricing.currency)
      const chf = rate === null ? null : native / rate
      return {
        sessionId, tokens, cacheHit, cacheMiss, output, chf, native,
        currency: pricing.currency, model, peak: pricing.peak === true, estimated: true,
      }
    }

    function estimateChat(usage, data, sessionId, nodes) {
      return priceUsage(usage, data, sessionId, collectRoutes(nodes))
    }

    /** Collect the model routes the loaded Chat turns reported. */
    function collectRoutes(nodes) {
      const routes = []
      try {
        for (const node of Array.isArray(nodes) ? nodes : []) {
          const turnUsage = node && node.data ? node.data.tokenUsage : undefined
          if (turnUsage && Array.isArray(turnUsage.routes)) routes.push(...turnUsage.routes)
        }
      } catch {
        // A changed Chat snapshot shape must not break the pill or the card.
      }
      return routes
    }

    function timeAgo(timestamp) {
      const at = number(timestamp)
      if (at <= 0) return ''
      const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
      if (seconds < 60) return 'just now'
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return minutes + 'm ago'
      const hours = Math.round(minutes / 60)
      if (hours < 24) return hours + 'h ago'
      return Math.round(hours / 24) + 'd ago'
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
      const title = props.useProjection('title')
      const nodes = props.useChat(s => s.legacy.nodes)
      const sessionId = props.sessionId
      const chat = useMemo(() => {
        const value = estimateChat(usage, state.data, sessionId, nodes)
        if (value === null) return null
        return {
          ...value,
          title: typeof title === 'string' && title !== '' ? title : null,
        }
      }, [usage, state.data, sessionId, nodes, title])
      const signature = chatSignature(chat)
      useEffect(() => {
        if (chat === null) clearChat()
        else setChat(chat)
      }, [signature, sessionId])
      // Leaving a conversation (or switching sessions) means the card should
      // not keep claiming the previous chat's spend, but the finished chat is
      // worth keeping in the card's short history. The cleanup runs before the
      // next session's effect publishes, so the store still holds this chat.
      useEffect(() => () => {
        const previous = store.state.chat
        if (previous !== null && previous.sessionId === sessionId) rememberChat(previous)
        clearChat(sessionId)
      }, [sessionId])
      if (chat === null) return null
      const tooltip = [
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
          title: tooltip,
          'aria-label': tooltip,
          onClick: () => { setPanelOpen(true) },
        },
        h('span', { className: 'dsc-pill-glyph', 'aria-hidden': 'true' }, '\u2248'),
        h('span', { className: 'dsc-pill-text' }, formatChfPrecise(chat.chf)),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Floating card
    // ---------------------------------------------------------------------

    function clampCardPosition(element, x, y) {
      if (element === null || typeof window === 'undefined') return { x, y }
      const rect = element.getBoundingClientRect()
      const maxX = Math.max(CARD_MARGIN, window.innerWidth - rect.width - CARD_MARGIN)
      const maxY = Math.max(CARD_MARGIN, window.innerHeight - rect.height - CARD_MARGIN)
      return {
        x: Math.min(Math.max(CARD_MARGIN, x), maxX),
        y: Math.min(Math.max(CARD_MARGIN, y), maxY),
      }
    }

    function clampNumber(value, min, max) {
      return Math.min(Math.max(value, min), max)
    }

    /** The area the card may occupy, recomputed from its current box size. */
    function motionBounds(width, height) {
      if (typeof window === 'undefined') return { minX: CARD_MARGIN, minY: CARD_MARGIN, maxX: CARD_MARGIN, maxY: CARD_MARGIN }
      return {
        minX: CARD_MARGIN,
        minY: CARD_MARGIN,
        maxX: Math.max(CARD_MARGIN, window.innerWidth - width - CARD_MARGIN),
        maxY: Math.max(CARD_MARGIN, window.innerHeight - height - CARD_MARGIN),
      }
    }

    function CreditsFloatingCard() {
      const state = useStore()
      const cardRef = useRef(null)
      const motionRef = useRef(null)
      const pendingRef = useRef(null)
      const [moving, setMoving] = useState(false)
      const [ready, setReady] = useState(false)

      const data = state.data
      const expanded = state.cardMode !== 'compact'
      const positioned = typeof state.cardX === 'number' && typeof state.cardY === 'number'
      const visible = isCardVisible(state)

      // A saved position must stay on screen after a resize or a mode change.
      useLayoutEffect(() => {
        const element = cardRef.current
        if (element === null) return
        // A running drag or glide owns the transform; clamping now would fight it.
        if (motionRef.current !== null) {
          setReady(true)
          return
        }
        if (!positioned) {
          setReady(true)
          return
        }
        const next = clampCardPosition(element, state.cardX, state.cardY)
        if (next.x !== state.cardX || next.y !== state.cardY) setCardPosition(next.x, next.y)
        setReady(true)
      }, [expanded, positioned, state.cardX, state.cardY])

      useEffect(() => {
        if (typeof window === 'undefined') return undefined
        const onResize = () => {
          if (motionRef.current !== null) finishMotion(true)
          const current = store.state
          if (typeof current.cardX !== 'number' || typeof current.cardY !== 'number') return
          const next = clampCardPosition(cardRef.current, current.cardX, current.cardY)
          if (next.x !== current.cardX || next.y !== current.cardY) setCardPosition(next.x, next.y)
        }
        window.addEventListener('resize', onResize)
        const viewport = window.visualViewport
        if (viewport) viewport.addEventListener('resize', onResize)
        return () => {
          window.removeEventListener('resize', onResize)
          if (viewport) viewport.removeEventListener('resize', onResize)
          const motion = motionRef.current
          if (motion !== null && motion.raf !== 0) cancelAnimationFrame(motion.raf)
          motionRef.current = null
        }
      }, [])

      if (!visible) return null

      const account = data && data.account ? data.account : null
      const fx = data ? data.fx : null
      const balance = accountBalance(account, fx)
      const today = usageSumFor(data, 'today')
      const month = usageSumFor(data, 'total')
      const allTime = totalCostChf(account, fx)
      const chat = state.chat
      const recentChats = Array.isArray(state.recentChats) ? state.recentChats : []
      const visibleRecent = recentChats
        .filter(entry => chat === null || entry.sessionId !== chat.sessionId)
        .slice(0, 4)
      const signedOut = data !== null && data.signedIn === false
      const expired = data !== null && data.expired === true
      const primaryCurrency = usageCurrency(data)
      const usageBucket = data && data.usage && data.usage.byCurrency && primaryCurrency
        ? data.usage.byCurrency[primaryCurrency]
        : null
      const days = usageBucket && Array.isArray(usageBucket.days) ? usageBucket.days : []
      // The card speaks CHF only; the Platform buckets are in the wallet currency.
      const cardDays = days.map(day => ({
        date: day.date,
        cost: toChf(day.cost, primaryCurrency, fx),
      }))
      const monthLabel = data && data.usage && data.usage.label ? data.usage.label : 'This month'
      const chatHitRate = chat !== null && chat.cacheHit + chat.cacheMiss > 0
        ? chat.cacheHit / (chat.cacheHit + chat.cacheMiss)
        : null

      function toggle() {
        setCardMode(expanded ? 'compact' : 'expanded')
      }

      function applyMotion(motion) {
        const element = cardRef.current
        if (element === null) return
        const dx = motion.x - motion.originX
        const dy = motion.y - motion.originY
        element.style.transform = 'translate3d(' + dx.toFixed(2) + 'px, ' + dy.toFixed(2)
          + 'px, 0) rotate(' + motion.rotate.toFixed(2) + 'deg) scale(' + motion.scale.toFixed(3) + ')'
      }

      function stepMotion(now) {
        const motion = motionRef.current
        if (motion === null) return
        const previous = motion.lastTime === 0 ? now : motion.lastTime
        const dt = Math.min(48, Math.max(8, now - previous))
        motion.lastTime = now
        if (motion.kind === 'drag') {
          // Follow the pointer with a short time constant instead of gluing the
          // card to it, and lean into the movement a little.
          const follow = 1 - Math.exp(-dt / 30)
          motion.x += (motion.targetX - motion.x) * follow
          motion.y += (motion.targetY - motion.y) * follow
          const settle = 1 - Math.exp(-dt / 60)
          motion.rotate += (motion.targetRotate - motion.rotate) * settle
          motion.scale += (1.012 - motion.scale) * settle
        } else {
          motion.x += motion.vx * dt
          motion.y += motion.vy * dt
          const decay = Math.exp(-dt / 130)
          motion.vx *= decay
          motion.vy *= decay
          const settle = 1 - Math.exp(-dt / 90)
          motion.rotate += (0 - motion.rotate) * settle
          motion.scale += (1 - motion.scale) * settle
          const bounds = motion.bounds
          if (motion.x <= bounds.minX) { motion.x = bounds.minX; motion.vx = 0 }
          else if (motion.x >= bounds.maxX) { motion.x = bounds.maxX; motion.vx = 0 }
          if (motion.y <= bounds.minY) { motion.y = bounds.minY; motion.vy = 0 }
          else if (motion.y >= bounds.maxY) { motion.y = bounds.maxY; motion.vy = 0 }
          if (Math.abs(motion.vx) + Math.abs(motion.vy) < 0.03) {
            finishMotion(true)
            return
          }
        }
        applyMotion(motion)
        motion.raf = requestAnimationFrame(stepMotion)
      }

      function finishMotion(commit) {
        const motion = motionRef.current
        if (motion === null) return
        motionRef.current = null
        if (motion.raf !== 0) cancelAnimationFrame(motion.raf)
        const element = cardRef.current
        if (element !== null) {
          element.style.transform = ''
          element.style.willChange = ''
          if (commit) {
            const x = Math.round(motion.x)
            const y = Math.round(motion.y)
            element.style.left = x + 'px'
            element.style.top = y + 'px'
            element.style.right = 'auto'
          } else if (positioned) {
            element.style.left = state.cardX + 'px'
            element.style.top = state.cardY + 'px'
            element.style.right = 'auto'
          } else {
            element.style.left = ''
            element.style.top = ''
            element.style.right = ''
          }
        }
        setMoving(false)
        if (commit) setCardPosition(Math.round(motion.x), Math.round(motion.y))
      }

      function startMotion(event) {
        const pending = pendingRef.current
        if (pending === null) return
        const motion = {
          kind: 'drag',
          x: pending.originX,
          y: pending.originY,
          originX: pending.originX,
          originY: pending.originY,
          targetX: pending.originX,
          targetY: pending.originY,
          bounds: motionBounds(pending.width, pending.height),
          rotate: 0,
          targetRotate: 0,
          scale: 1,
          vx: 0,
          vy: 0,
          samples: [{ t: event.timeStamp || performance.now(), x: event.clientX, y: event.clientY }],
          lastTime: 0,
          raf: 0,
        }
        motionRef.current = motion
        setMoving(true)
        motion.raf = requestAnimationFrame(stepMotion)
      }

      function onPointerDown(event) {
        if (event.button !== 0 || motionRef.current !== null) return
        const target = event.target
        if (target && typeof target.closest === 'function'
          && target.closest('button, a, input, select, textarea, [data-card-no-drag]')) return
        const element = cardRef.current
        if (element === null) return
        const rect = element.getBoundingClientRect()
        pendingRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          originX: rect.left,
          originY: rect.top,
          width: rect.width,
          height: rect.height,
        }
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* older engines */ }
        try { event.currentTarget.focus({ preventScroll: true }) } catch { /* older engines */ }
        event.preventDefault()
      }

      function onPointerMove(event) {
        const pending = pendingRef.current
        if (pending === null || pending.pointerId !== event.pointerId) return
        const dx = event.clientX - pending.startX
        const dy = event.clientY - pending.startY
        let motion = motionRef.current
        if (motion === null) {
          if (Math.abs(dx) + Math.abs(dy) < 4) return
          startMotion(event)
          motion = motionRef.current
          if (motion === null) return
        }
        motion.targetX = clampNumber(pending.originX + dx, motion.bounds.minX, motion.bounds.maxX)
        motion.targetY = clampNumber(pending.originY + dy, motion.bounds.minY, motion.bounds.maxY)
        const now = event.timeStamp || performance.now()
        motion.samples.push({ t: now, x: event.clientX, y: event.clientY })
        if (motion.samples.length > 5) motion.samples.shift()
        const first = motion.samples[0]
        const last = motion.samples[motion.samples.length - 1]
        const span = last.t - first.t
        if (span > 8) {
          const vx = (last.x - first.x) / span
          motion.targetRotate = clampNumber(vx * 1.1, -2.2, 2.2)
          motion.vx = vx
          motion.vy = (last.y - first.y) / span
        }
        event.preventDefault()
      }

      function onPointerUp(event) {
        const pending = pendingRef.current
        if (pending === null || pending.pointerId !== event.pointerId) return
        pendingRef.current = null
        try { event.currentTarget.releasePointerCapture(pending.pointerId) } catch { /* already released */ }
        const motion = motionRef.current
        if (motion === null) return
        const samples = motion.samples
        const first = samples[0]
        const last = samples[samples.length - 1]
        const span = Math.max(1, last.t - first.t)
        let vx = (last.x - first.x) / span
        let vy = (last.y - first.y) / span
        const speed = Math.hypot(vx, vy)
        const lastMoveAge = (event.timeStamp || performance.now()) - last.t
        // Holding still before releasing means a precise drop, not a fling.
        if (!Number.isFinite(speed) || speed < 0.06 || lastMoveAge > 140) {
          finishMotion(true)
          return
        }
        if (speed > 1.8) {
          vx = (vx / speed) * 1.8
          vy = (vy / speed) * 1.8
        }
        // A flick keeps gliding after the pointer is gone; the running frame
        // loop picks up the new phase.
        motion.kind = 'glide'
        motion.vx = vx
        motion.vy = vy
        motion.lastTime = 0
      }

      function onPointerCancel(event) {
        const pending = pendingRef.current
        if (pending === null || pending.pointerId !== event.pointerId) return
        pendingRef.current = null
        try { event.currentTarget.releasePointerCapture(pending.pointerId) } catch { /* already released */ }
        finishMotion(false)
      }

      function onHeaderKeyDown(event) {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          toggle()
          return
        }
        if (event.key === 'Home') {
          event.preventDefault()
          setCardPosition(null, null)
          return
        }
        const step = event.shiftKey ? 48 : 12
        let dx = 0
        let dy = 0
        if (event.key === 'ArrowLeft') dx = -step
        else if (event.key === 'ArrowRight') dx = step
        else if (event.key === 'ArrowUp') dy = -step
        else if (event.key === 'ArrowDown') dy = step
        else return
        event.preventDefault()
        const element = cardRef.current
        if (element === null) return
        const rect = element.getBoundingClientRect()
        const next = clampCardPosition(element, rect.left + dx, rect.top + dy)
        setCardPosition(next.x, next.y)
      }

      const amount = signedOut ? 'Sign in' : formatChf(balance.chf)
      const toggleLabel = expanded ? 'Collapse credits card' : 'Expand credits card'
      const header = h('div', {
        className: 'dsc-card-head',
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel,
        onDoubleClick: toggle,
        onKeyDown: onHeaderKeyDown,
        tabIndex: 0,
        role: 'group',
        'aria-label': 'Credits card. Drag to move, press Enter to ' + (expanded ? 'collapse' : 'expand') + '.',
        title: 'Drag to move \u00b7 double-click to ' + (expanded ? 'collapse' : 'expand'),
      },
      h('span', { className: 'dsc-card-title' }, 'Credits'),
      h('span', { className: 'dsc-card-head-spacer' }),
      h('button', {
        type: 'button',
        className: 'dsc-card-toggle',
        onClick: (event) => { event.stopPropagation(); toggle() },
        onPointerDown: (event) => { event.stopPropagation() },
        'aria-expanded': expanded,
        'aria-label': toggleLabel,
        title: toggleLabel,
      }, h('span', {
        className: 'dsc-card-chevron',
        'data-open': expanded ? 'true' : 'false',
        'aria-hidden': 'true',
      })),
      )

      const compactBody = h('div', { className: 'dsc-card-mini' },
        h('div', { className: 'dsc-card-mini-main' },
          h('span', { className: 'dsc-card-mini-value' }, amount),
          h('span', { className: 'dsc-card-mini-caption' }, signedOut ? 'from Settings \u2192 Account' : 'left'),
        ),
        h('div', { className: 'dsc-card-mini-line' },
          h('span', null, 'Today ' + formatChf(today.chf)),
          chat !== null
            ? h('span', { className: 'dsc-card-mini-chat' }, 'Chat \u2248 ' + formatChfPrecise(chat.chf))
            : h('span', null, signedOut ? 'Sign in to track spend' : allTime.chf === null ? 'No spend yet' : 'All time ' + formatChf(allTime.chf)),
        ),
      )

      const hero = h('div', { className: 'dsc-card-hero' },
        h('div', { className: 'dsc-card-hero-label' }, 'Total left'),
        h('div', { className: 'dsc-card-hero-value' },
          signedOut ? 'Sign in' : balance.chf === null ? '\u2014' : formatChf(balance.chf)),
        signedOut
          ? h('div', { className: 'dsc-card-hero-note' }, 'Connect a DeepSeek account in Settings \u2192 Account')
          : balance.chf === null
            ? h('div', { className: 'dsc-card-hero-note' }, 'Balance unavailable')
            : null,
      )

      const stats = h('div', { className: 'dsc-card-grid' },
        h('div', { className: 'dsc-card-stat' },
          h('div', { className: 'dsc-card-stat-label' }, 'This chat'),
          h('div', { className: 'dsc-card-stat-value' }, chat === null ? '\u2014' : formatChfPrecise(chat.chf)),
          h('div', { className: 'dsc-card-stat-sub' }, chat === null ? 'No chat open' : formatTokens(chat.tokens) + ' tokens'),
        ),
        h('div', { className: 'dsc-card-stat' },
          h('div', { className: 'dsc-card-stat-label' }, 'Today'),
          h('div', { className: 'dsc-card-stat-value' }, formatChf(today.chf)),
          h('div', { className: 'dsc-card-stat-sub' }, 'so far today'),
        ),
        h('div', { className: 'dsc-card-stat' },
          h('div', { className: 'dsc-card-stat-label' }, monthLabel),
          h('div', { className: 'dsc-card-stat-value' }, formatChf(month.chf)),
          h('div', { className: 'dsc-card-stat-sub' }, 'so far this month'),
        ),
        h('div', { className: 'dsc-card-stat' },
          h('div', { className: 'dsc-card-stat-label' }, 'All time'),
          h('div', { className: 'dsc-card-stat-value' }, formatChf(allTime.chf)),
          h('div', { className: 'dsc-card-stat-sub' }, 'lifetime'),
        ),
      )

      const chatSection = chat === null ? null : h('div', { className: 'dsc-card-section' },
        h('div', { className: 'dsc-card-chat-meta' },
          h('span', null, formatTokens(chat.tokens) + ' tokens'),
          chatHitRate === null ? null : h('span', null, formatPercent(chatHitRate) + ' cache hit'),
          h('span', null, chat.model || 'default model'),
        ),
      )

      const recentSection = chat === null && visibleRecent.length > 0
        ? h('div', { className: 'dsc-card-section' },
          h('div', { className: 'dsc-card-section-title' },
            h('span', null, 'Recent chats'),
            h('span', { className: 'dsc-card-section-note' }, 'on this device'),
          ),
          ...visibleRecent.map(entry => h('div', {
            key: entry.sessionId,
            className: 'dsc-card-recent',
            title: (entry.title || entry.sessionId) + (entry.at > 0 ? ' \u00b7 ' + timeAgo(entry.at) : ''),
          },
          h('span', { className: 'dsc-card-recent-title' }, entry.title || 'Chat ' + entry.sessionId.slice(0, 6)),
          h('span', { className: 'dsc-card-recent-cost' }, formatChfPrecise(entry.chf)),
          )),
        )
        : null

      const sparkSection = days.length > 0
        ? h('div', { className: 'dsc-card-section' },
          h('div', { className: 'dsc-card-section-title' },
            h('span', null, 'Daily spend'),
            h('span', { className: 'dsc-card-section-note' }, 'last ' + days.length + ' days \u00b7 hover'),
          ),
          h(Sparkline, { days: cardDays, money: (cost) => formatExact(cost, 'CHF') }),
        )
        : null

      const empty = h('div', { className: 'dsc-card-empty' },
        h('div', { className: 'dsc-card-empty-title' }, expired ? 'Session expired' : 'Sign in to see credits'),
        h('div', { className: 'dsc-card-empty-copy' }, expired
          ? 'The Platform session expired. Sign in again from Settings \u2192 Account.'
          : 'Open Settings \u2192 Account and sign in to DeepSeek. This card updates automatically.'),
      )

      const loading = h('div', { className: 'dsc-card-empty' },
        h('div', { className: 'dsc-card-empty-title' }, state.error ? 'Credits unavailable' : 'Loading credits\u2026'),
        state.error ? h('div', { className: 'dsc-card-empty-copy' }, state.error) : null,
      )

      const footer = h('div', { className: 'dsc-card-foot' },
        h('span', { className: 'dsc-card-updated' }, state.refreshing ? 'Refreshing\u2026' : 'Updated ' + formatClock(state.updatedAt)),
        h('div', { className: 'dsc-card-actions' },
          h('button', {
            type: 'button',
            className: 'dsc-card-btn',
            disabled: state.refreshing === true,
            onClick: () => { void refresh(true) },
          }, state.refreshing ? 'Refreshing' : 'Refresh'),
          h('button', {
            type: 'button',
            className: 'dsc-card-btn',
            onClick: () => { setPanelOpen(true) },
          }, 'Details'),
        ),
      )

      const expandedBody = h('div', { className: 'dsc-card-body' },
        signedOut || expired
          ? empty
          : data === null
            ? loading
            : h(React.Fragment, null, hero, stats, chatSection, recentSection, sparkSection),
        footer,
      )

      const style = positioned
        ? { left: state.cardX + 'px', top: state.cardY + 'px', right: 'auto' }
        : undefined

      return h('aside', {
        ref: cardRef,
        className: 'dsc-card' + (moving ? ' dsc-card-moving' : ''),
        style,
        'data-expanded': expanded ? 'true' : 'false',
        'data-positioned': positioned ? 'true' : 'false',
        'data-ready': ready ? 'true' : 'false',
        'aria-label': 'DeepSeek credits',
      },
      header,
      expanded ? expandedBody : compactBody,
      )
    }

    function Row({ label, value, sub, tone }) {
      return h('div', { className: 'dsc-row' },
        h('div', { className: 'dsc-row-label' }, label, sub ? h('span', { className: 'dsc-row-sub' }, sub) : null),
        h('div', { className: 'dsc-row-value' + (tone ? ' dsc-tone-' + tone : '') }, value),
      )
    }

    /**
     * Daily-spend histogram. Hovering (or tabbing to it and using the arrow
     * keys) opens a tooltip with that day's exact amount.
     */
    function Sparkline({ days, currency, money, subMoney }) {
      const [hovered, setHovered] = useState(null)
      if (!Array.isArray(days) || days.length === 0) return null
      const total = days.length
      const formatMoney = typeof money === 'function'
        ? money
        : (cost) => formatNative(cost, currency)
      const formatSub = typeof subMoney === 'function' ? subMoney : null
      const max = Math.max(...days.map(day => number(day.cost)), 0)
      const index = hovered !== null && hovered >= 0 && hovered < total ? hovered : null
      const day = index === null ? null : days[index]
      const summary = 'Daily spend for the last ' + total + ' days. Use the arrow keys to read each day.'
      const describe = (entry) => formatDay(entry.date) + ': ' + formatMoney(entry.cost)
        + (formatSub === null ? '' : ' (' + formatSub(entry.cost) + ')')

      function onKeyDown(event) {
        let next = null
        if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
          next = index === null ? total - 1 : Math.min(total - 1, index + 1)
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
          next = index === null ? 0 : Math.max(0, index - 1)
        } else if (event.key === 'Home') {
          next = 0
        } else if (event.key === 'End') {
          next = total - 1
        } else if (event.key === 'Escape') {
          setHovered(null)
          return
        } else {
          return
        }
        event.preventDefault()
        setHovered(next)
      }

      return h('div', {
        className: 'dsc-spark',
        role: 'img',
        tabIndex: 0,
        'aria-label': day === null ? summary : describe(day),
        onMouseLeave: () => { setHovered(null) },
        onBlur: () => { setHovered(null) },
        onKeyDown,
      },
      ...days.map((entry, dayIndex) => h('div', {
        key: entry.date,
        className: 'dsc-spark-slot',
        onMouseEnter: () => { setHovered(dayIndex) },
        onMouseLeave: () => { setHovered(current => (current === dayIndex ? null : current)) },
      },
      h('div', {
        className: 'dsc-spark-bar',
        style: { height: (max > 0 ? Math.max(3, Math.round((number(entry.cost) / max) * 34)) : 3) + 'px' },
        'data-empty': number(entry.cost) === 0 ? 'true' : 'false',
      }),
      )),
      day === null ? null : h('div', {
        className: 'dsc-spark-tip',
        role: 'tooltip',
        style: { '--dsc-tip-x': (((index + 0.5) / total) * 100).toFixed(3) + '%' },
      },
      h('div', { className: 'dsc-spark-tip-date' }, formatDay(day.date)),
      h('div', { className: 'dsc-spark-tip-value' }, formatMoney(day.cost)),
      formatSub === null ? null : h('div', { className: 'dsc-spark-tip-sub' }, formatSub(day.cost)),
      ),
      )
    }

    function Switch({ checked, label, onChange }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        className: 'dsc-switch',
        'data-on': checked ? 'true' : 'false',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        onClick: () => { onChange(!checked) },
      }, h('span', { className: 'dsc-switch-knob', 'aria-hidden': 'true' }))
    }

    /** Settings → General row: show or hide the floating card on this device. */
    function FloatingCardSettingRow() {
      const state = useStore()
      const visible = isCardVisible(state)
      return h('div', { className: 'dsc-setting-row' },
        h('div', { className: 'dsc-setting-copy' },
          h('div', { className: 'dsc-setting-title' }, 'Floating credits card'),
          h('div', { className: 'dsc-setting-desc' },
            'Show the draggable credits card over the app. Its position and collapsed state are stored on this device.'),
        ),
        h(Switch, {
          checked: visible,
          label: 'Show floating credits card',
          onChange: (next) => { setCardVisible(next) },
        }),
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
          const sparkNote = ['last ' + days.length + ' days', rateCurrency, 'hover for exact']
            .filter(Boolean).join(' \u00b7 ')
          body.push(h('div', { className: 'dsc-section' },
            h('div', { className: 'dsc-section-title' }, 'Daily spend', h('span', { className: 'dsc-section-note' }, sparkNote)),
            h(Sparkline, {
              days,
              currency: rateCurrency,
              money: (cost) => formatExact(cost, rateCurrency),
              subMoney: (cost) => formatExact(toChf(cost, rateCurrency, fx), 'CHF'),
            }),
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

      body.push(h('div', { className: 'dsc-setting-row dsc-panel-setting' },
        h('div', { className: 'dsc-setting-copy' },
          h('div', { className: 'dsc-setting-title' }, 'Floating card'),
          h('div', { className: 'dsc-setting-desc' }, 'Show the draggable credits card over the app'),
        ),
        h(Switch, {
          checked: isCardVisible(state),
          label: 'Show floating credits card',
          onChange: (next) => { setCardVisible(next) },
        }),
      ))

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

      .dsc-spark { position:relative; display:flex; align-items:flex-end; gap:4px; height:40px; padding:4px 2px 0; }
      .dsc-spark:focus-visible { outline:2px solid var(--dsw-alias-brand-primary, #4d6bfe); outline-offset:2px; border-radius:6px; }
      .dsc-spark-slot { position:relative; flex:1; min-width:4px; height:100%; display:flex; align-items:flex-end; }
      .dsc-spark-bar { width:100%; border-radius:3px 3px 1px 1px; background:var(--dsw-alias-brand-primary, #4d6bfe); opacity:.8; transition:opacity 120ms ease; }
      .dsc-spark-bar[data-empty="true"] { background:color-mix(in srgb, var(--dsw-alias-label-primary, #e8e8e8) 16%, transparent); opacity:1; }
      .dsc-spark-slot:hover .dsc-spark-bar { opacity:1; }
      .dsc-spark-tip { position:absolute; bottom:calc(100% - 2px); left:clamp(0px, calc(var(--dsc-tip-x, 50%) - 66px), calc(100% - 132px));
        width:132px; box-sizing:border-box; padding:6px 8px; border-radius:8px; pointer-events:none; z-index:5;
        background:var(--dsw-specific-menu, #26272c); color:var(--dsw-alias-label-primary, #e8e8e8);
        border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12)); box-shadow:0 8px 20px rgba(0,0,0,.35);
        font-size:10.5px; line-height:1.4; white-space:nowrap; }
      .dsc-spark-tip-date { font-size:9.5px; letter-spacing:.02em; text-transform:uppercase; color:var(--dsw-alias-label-secondary, #9b9b9b); }
      .dsc-spark-tip-value { margin-top:2px; font-size:11.5px; font-weight:600; font-variant-numeric:tabular-nums; }
      .dsc-spark-tip-sub { color:var(--dsw-alias-label-secondary, #9b9b9b); font-variant-numeric:tabular-nums; }

      /* Settings row: used in Settings → General and in the details panel. */
      .dsc-setting-row { display:flex; align-items:center; justify-content:space-between; gap:24px; padding:16px 0;
        border-bottom:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12)); }
      .dsc-setting-copy { min-width:0; }
      .dsc-setting-title { font-size:13.5px; font-weight:600; line-height:1.4; }
      .dsc-setting-desc { margin-top:3px; font-size:11.5px; line-height:1.45; color:var(--dsw-alias-label-secondary, #9b9b9b); }
      .dsc-panel-setting { padding:12px 0 2px; border-bottom:0; border-top:1px solid color-mix(in srgb, var(--dsw-alias-label-primary, #e8e8e8) 8%, transparent); }
      .dsc-switch { flex:none; width:34px; height:20px; padding:2px; border:0; border-radius:999px; cursor:pointer;
        background:color-mix(in srgb, var(--dsw-alias-label-primary, #e8e8e8) 20%, transparent);
        transition:background 150ms ease; }
      .dsc-switch[data-on="true"] { background:var(--dsw-alias-brand-primary, #4d6bfe); }
      .dsc-switch:focus-visible { outline:2px solid var(--dsw-alias-brand-primary, #4d6bfe); outline-offset:2px; }
      .dsc-switch-knob { display:block; width:16px; height:16px; border-radius:50%; background:#fff;
        box-shadow:0 1px 2px rgba(0,0,0,.25); transition:transform 150ms ease; }
      .dsc-switch[data-on="true"] .dsc-switch-knob { transform:translateX(14px); }

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

      /* Floating, draggable credits card (shell.overlay).
         Monochrome and Swiss-franc only: no accent colours, no decorative
         glyphs, no borders. Hierarchy comes from type and tonal fills. */
      .dsc-card { position:fixed; top:calc(var(--dsh-frame-overlay-top, 20px) + 12px); right:20px; z-index:100;
        box-sizing:border-box; width:308px; max-width:calc(100vw - 24px);
        display:flex; flex-direction:column; overflow:hidden;
        background:color-mix(in srgb, var(--dsw-specific-menu, #26272c) 94%, transparent);
        color:var(--dsw-alias-label-primary, #e8e8e8);
        border-radius:var(--dsw-radius-lg, 16px);
        box-shadow:0 16px 44px rgba(0,0,0,.42), inset 0 1px 0 rgba(255,255,255,.04);
        backdrop-filter:var(--dsw-menu-backdrop-filter, blur(18px));
        font-family:inherit; font-size:12.5px; line-height:1.35;
        pointer-events:auto;
        transition:left 200ms cubic-bezier(.2,.8,.2,1), top 200ms cubic-bezier(.2,.8,.2,1),
          box-shadow 200ms ease; }
      .dsc-card-moving { transition:none; cursor:grabbing; will-change:transform; user-select:none;
        box-shadow:0 28px 70px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.04); }
      .dsc-card[data-positioned="true"] { right:auto; }
      .dsc-card[data-ready="false"] { opacity:0; }

      .dsc-card-head { display:flex; align-items:center; gap:8px; padding:9px 10px 7px 12px;
        cursor:grab; user-select:none; touch-action:none; }
      .dsc-card-moving .dsc-card-head { cursor:grabbing; }
      .dsc-card-head:focus-visible { outline:2px solid var(--dsw-alias-label-primary, #e8e8e8); outline-offset:-3px; border-radius:10px; }
      .dsc-card-title { font-size:10.5px; font-weight:600; letter-spacing:.06em; text-transform:uppercase;
        color:var(--dsw-alias-label-tertiary, #7a7a80); }
      .dsc-card-head-spacer { flex:1; }
      .dsc-card-toggle { width:24px; height:24px; flex:none; display:grid; place-items:center; padding:0;
        border:0; border-radius:6px; background:transparent; color:var(--dsw-alias-label-tertiary, #7a7a80); cursor:pointer; }
      .dsc-card-toggle:hover { color:var(--dsw-alias-label-primary, #e8e8e8); background:color-mix(in srgb, var(--dsw-alias-label-primary, #e8e8e8) 7%, transparent); }
      .dsc-card-toggle:focus-visible { outline:2px solid var(--dsw-alias-label-primary, #e8e8e8); outline-offset:1px; }
      .dsc-card-chevron { width:7px; height:7px; border-right:1.4px solid currentColor; border-bottom:1.4px solid currentColor;
        transform:translateY(2px) rotate(45deg); transition:transform 180ms ease; }
      .dsc-card-chevron[data-open="true"] { transform:translateY(-1px) rotate(-135deg); }

      .dsc-card-mini { display:flex; flex-direction:column; gap:2px; padding:0 13px 11px;
        animation:dsc-card-in 160ms cubic-bezier(.2,.8,.2,1); }
      .dsc-card-mini-main { display:flex; align-items:baseline; gap:6px; }
      .dsc-card-mini-value { font-size:21px; font-weight:650; line-height:1.12; font-variant-numeric:tabular-nums; letter-spacing:-.01em; }
      .dsc-card-mini-caption { font-size:10px; color:var(--dsw-alias-label-tertiary, #7a7a80); }
      .dsc-card-mini-line { display:flex; align-items:baseline; gap:10px; font-size:10.5px;
        color:var(--dsw-alias-label-tertiary, #7a7a80); white-space:nowrap; overflow:hidden; }
      .dsc-card-mini-chat { color:var(--dsw-alias-label-secondary, #a0a0a6); font-variant-numeric:tabular-nums; }

      .dsc-card-body { display:flex; flex-direction:column; gap:12px; padding:2px 13px 11px;
        overflow:auto; max-height:min(58vh, 540px); scrollbar-gutter:stable;
        animation:dsc-card-in 200ms cubic-bezier(.2,.8,.2,1); }
      @keyframes dsc-card-in {
        from { opacity:0; transform:translateY(-5px); }
        to { opacity:1; transform:translateY(0); }
      }
      .dsc-card-hero { padding:1px 0 0; }
      .dsc-card-hero-label { font-size:9.5px; letter-spacing:.07em; text-transform:uppercase;
        color:var(--dsw-alias-label-tertiary, #7a7a80); }
      .dsc-card-hero-value { margin-top:1px; font-size:27px; line-height:1.08; font-weight:650;
        font-variant-numeric:tabular-nums; letter-spacing:-.015em; }
      .dsc-card-hero-note { margin-top:3px; font-size:10.5px; color:var(--dsw-alias-label-tertiary, #7a7a80); }

      .dsc-card-grid { display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:6px; }
      .dsc-card-stat { min-width:0; padding:8px 9px; border-radius:9px;
        background:color-mix(in srgb, var(--dsw-alias-label-primary, #e8e8e8) 5%, transparent); }
      .dsc-card-stat-label { font-size:9.5px; letter-spacing:.03em; text-transform:uppercase;
        color:var(--dsw-alias-label-tertiary, #7a7a80); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .dsc-card-stat-value { margin-top:2px; font-size:14px; font-weight:600; font-variant-numeric:tabular-nums; }
      .dsc-card-stat-sub { margin-top:1px; font-size:9.5px; color:var(--dsw-alias-label-tertiary, #7a7a80);
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

      .dsc-card-section { display:flex; flex-direction:column; gap:5px; }
      .dsc-card-section-title { display:flex; align-items:baseline; justify-content:space-between; gap:8px;
        font-size:9.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--dsw-alias-label-tertiary, #7a7a80); }
      .dsc-card-section-title > span:first-child { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .dsc-card-section-note { flex:none; text-transform:none; letter-spacing:0; font-size:9.5px; }
      .dsc-card-chat-meta { display:flex; flex-wrap:wrap; gap:2px 10px; font-size:10.5px;
        color:var(--dsw-alias-label-tertiary, #7a7a80); }
      .dsc-card-recent { display:flex; align-items:baseline; justify-content:space-between; gap:10px; padding:3px 0; }
      .dsc-card-recent-title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
        font-size:11.5px; color:var(--dsw-alias-label-secondary, #a0a0a6); }
      .dsc-card-recent-cost { flex:none; font-size:11px; font-weight:600; font-variant-numeric:tabular-nums; }

      .dsc-card-foot { display:flex; align-items:center; justify-content:space-between; gap:8px; padding-top:2px; }
      .dsc-card-updated { font-size:9.5px; color:var(--dsw-alias-label-tertiary, #7a7a80); }
      .dsc-card-actions { display:flex; align-items:center; gap:2px; }
      .dsc-card-btn { height:24px; padding:0 8px; border:0; border-radius:6px; background:transparent;
        color:var(--dsw-alias-label-secondary, #a0a0a6); font-family:inherit; font-size:10.5px; font-weight:500; cursor:pointer; }
      .dsc-card-btn:hover { color:var(--dsw-alias-label-primary, #e8e8e8); background:color-mix(in srgb, var(--dsw-alias-label-primary, #e8e8e8) 7%, transparent); }
      .dsc-card-btn:disabled { opacity:.5; cursor:default; }
      .dsc-card-empty { padding:10px 2px 4px; }
      .dsc-card-empty-title { font-size:12.5px; font-weight:600; }
      .dsc-card-empty-copy { margin-top:3px; font-size:11px; line-height:1.45; color:var(--dsw-alias-label-tertiary, #7a7a80); }

      .dsc-card .dsc-spark { height:32px; }
      .dsc-card .dsc-spark-bar { background:var(--dsw-alias-label-primary, #e8e8e8); opacity:.4; }
      .dsc-card .dsc-spark-bar[data-empty="true"] { background:color-mix(in srgb, var(--dsw-alias-label-primary, #e8e8e8) 14%, transparent); opacity:1; }

      @media (max-width: 560px) {
        .dsc-grid { grid-template-columns:repeat(2, minmax(0,1fr)); }
        .dsc-token-grid { grid-template-columns:repeat(2, minmax(0,1fr)); }
        .dsc-card { width:min(308px, calc(100vw - 24px)); }
      }
      @media (prefers-reduced-motion: reduce) {
        .dsc-card, .dsc-card-body, .dsc-card-mini, .dsc-card-chevron { animation:none; transition:none; }
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
        id: 'dsh-credits-card',
        order: 950,
        label: () => 'Credits card',
      }, CreditsFloatingCard)))

      ctx.effect(() => slots.inject('shell.overlay', () => slots.register({
        name: 'shell.overlay',
        id: 'dsh-credits-panel',
        order: 960,
        label: () => 'Credits & usage',
      }, CreditsPanel)))

      // Settings → General gets the on/off switch for the floating card. When a
      // deployment composes no settings shell the slot never appears, so the
      // details panel carries the same switch.
      ctx.effect(() => slots.inject('settings.general.item', () => slots.register({
        name: 'settings.general.item',
        id: 'dsh-credits-floating-card',
        order: 20,
        label: 'Floating credits card',
      }, FloatingCardSettingRow)))

      console.info('[dsh-credits] mounted: sidebar chip, composer pill, floating card, details panel, settings row')
    }

    return module.exports
  },
})
