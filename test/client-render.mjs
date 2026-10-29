// Render the registered surfaces in Node with a tiny React stand-in.
// Catches hook-order mistakes, missing elements and the floating-card setting
// without a browser; no network and no real DOM are used.
import { readFileSync } from 'node:fs'

// --- minimal React ---------------------------------------------------------

const Fragment = Symbol('Fragment')
let hookName = ''
let hoverOverride = -1
let snapshot = null

const react = {
  Fragment,
  createElement(type, props, ...children) {
    return { type, props: props || {}, children }
  },
  useEffect() {},
  useLayoutEffect() {},
  useMemo(fn) { return fn() },
  useRef(value) { return { current: value } },
  useCallback(fn) { return fn },
  useState(initial) {
    if (hookName === 'Sparkline' && hoverOverride >= 0) return [hoverOverride, () => {}]
    return [initial, () => {}]
  },
  useSyncExternalStore() { return snapshot },
}

function renderNode(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(renderNode).join('')
  if (typeof node.type === 'function') {
    const previous = hookName
    hookName = node.type.name
    try { return renderNode(node.type(node.props)) } finally { hookName = previous }
  }
  const children = (node.children || []).map(renderNode).join('')
  if (node.type === Fragment) return children
  const attrs = []
  for (const [key, value] of Object.entries(node.props)) {
    if (key === 'children' || key === 'key' || key === 'style') continue
    if (value === undefined || value === null || value === false || typeof value === 'function') continue
    attrs.push(key + '="' + String(value) + '"')
  }
  return '<' + node.type + (attrs.length > 0 ? ' ' + attrs.join(' ') : '') + '>' + children + '</' + node.type + '>'
}

/** Expand function components into plain elements so props stay inspectable. */
function expandNode(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expandNode)
  if (typeof node.type === 'function') {
    const previous = hookName
    hookName = node.type.name
    try { return expandNode(node.type(node.props)) } finally { hookName = previous }
  }
  if (node.type === Fragment) return (node.children || []).flatMap(expandNode)
  return { type: node.type, props: node.props, children: (node.children || []).flatMap(expandNode) }
}

function findElement(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, predicate)
      if (hit !== null) return hit
    }
    return null
  }
  if (predicate(node)) return node
  for (const child of node.children || []) {
    const hit = findElement(child, predicate)
    if (hit !== null) return hit
  }
  return null
}

// --- fake browser ----------------------------------------------------------

const stored = new Map()
let loaded = null
globalThis.window = {
  __ModuleLoader__: { load: ({ factory }) => { loaded = factory((name) => {
    if (name === 'react') return react
    throw new Error('unexpected require: ' + name)
  }) } },
  __DSH_BOOT__: { release: { version: '0.2.1' } },
  addEventListener() {},
  removeEventListener() {},
  localStorage: {
    getItem(key) { return stored.has(key) ? stored.get(key) : null },
    setItem(key, value) { stored.set(key, String(value)) },
  },
}
globalThis.document = {
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { append() {} },
  addEventListener() {},
  removeEventListener() {},
  visibilityState: 'visible',
}
globalThis.fetch = async () => { throw new Error('network disabled in render test') }

const bundleSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
new Function('window', bundleSource)(globalThis.window)
if (loaded === null) throw new Error('bundle did not register')

// --- fake payload and state ------------------------------------------------

const now = Date.now()
const fixture = {
  ok: true,
  signedIn: true,
  expired: false,
  updatedAt: now,
  lowBalanceChf: 2,
  floatingCard: true,
  account: {
    normal: [{ currency: 'CNY', balance: '100.00' }],
    bonus: [],
    totalCosts: [{ currency: 'CNY', amount: '12.00' }],
    usageUrl: 'https://platform.example/usage',
    topUpUrl: 'https://platform.example/top_up',
  },
  fx: {
    base: 'CHF',
    rates: { CHF: 1, CNY: 8.05, USD: 1.21 },
    date: '2026-10-29',
    source: 'frankfurter',
    stale: false,
  },
  pricing: {
    currency: 'CNY',
    defaultModel: 'deepseek-flash',
    peak: false,
    models: {
      'deepseek-flash': { cacheHit: [0.02, 0.04], cacheMiss: [1, 2], output: [4, 8] },
    },
  },
  usage: {
    label: 'October 2026',
    byCurrency: {
      CNY: {
        total: 5.5,
        byModel: [{ model: 'deepseek-flash', cost: 5.5, tokens: { cacheHit: 10, cacheMiss: 20, output: 30 } }],
        tokens: { cacheHit: 10, cacheMiss: 20, prompt: 0, output: 30, requests: 2 },
        cacheHitRate: 0.5,
        days: [
          { date: '2026-10-28', cost: 0.5 },
          { date: '2026-10-29', cost: 0.25 },
        ],
        today: 0.25,
        todayDate: '2026-10-29',
      },
    },
  },
  warnings: [],
}

function stateWith(overrides) {
  return {
    status: 'ready',
    data: fixture,
    error: null,
    refreshing: false,
    updatedAt: now,
    panelOpen: true,
    chat: null,
    cardMode: 'expanded',
    cardX: null,
    cardY: null,
    showCard: null,
    recentChats: [],
    ...overrides,
  }
}

const registrations = new Map()
const slots = {
  inject(_key, callback) { callback(); return () => {} },
  register(options, component) {
    registrations.set(options.name + ':' + options.id, component)
    return () => {}
  },
}
loaded.apply({
  slots,
  effect(callback) { return callback() },
  get(name) { return name === 'slots' ? slots : undefined },
})

function component(key) {
  const found = registrations.get(key)
  if (found === undefined) throw new Error('missing component ' + key)
  return found
}

function render(key, overrides = {}, hover = -1) {
  snapshot = stateWith(overrides)
  hookName = ''
  hoverOverride = hover
  return renderNode(react.createElement(component(key), {}))
}

// --- details panel + histogram tooltip -------------------------------------

const panel = render('shell.overlay:dsh-usage-monitor-panel')
for (const needle of ['Daily spend', 'This month by model', 'role="switch"', 'Floating card', 'dsc-spark-slot']) {
  if (!panel.includes(needle)) throw new Error('panel render missing ' + needle)
}
if (panel.includes('dsc-spark-tip')) throw new Error('tooltip must stay hidden until a bar is hovered')
if (panel.includes('title="2026-10-28')) throw new Error('histogram must not rely on native title tooltips')

const hovered = render('shell.overlay:dsh-usage-monitor-panel', {}, 1)
for (const needle of ['role="tooltip"', 'dsc-spark-tip-value', '\u00a50.25', 'CHF 0.0311']) {
  if (!hovered.includes(needle)) throw new Error('hovered tooltip missing ' + needle)
}

// --- Settings → General row ------------------------------------------------

const rowOff = render('settings.general.item:dsh-usage-monitor-floating-card', { showCard: false })
if (!rowOff.includes('role="switch"') || !rowOff.includes('data-on="false"') || !rowOff.includes('aria-checked="false"')) {
  throw new Error('settings row must render an off switch')
}
const rowOn = render('settings.general.item:dsh-usage-monitor-floating-card', { showCard: true })
if (!rowOn.includes('data-on="true"') || !rowOn.includes('aria-checked="true"')) {
  throw new Error('settings row must render an on switch')
}
// No explicit choice: the Host config decides.
const hostOn = render('settings.general.item:dsh-usage-monitor-floating-card', { showCard: null })
if (!hostOn.includes('data-on="true"')) throw new Error('Host default true must show the switch on')
const hostOff = render('settings.general.item:dsh-usage-monitor-floating-card', {
  showCard: null, data: { ...fixture, floatingCard: false },
})
if (!hostOff.includes('data-on="false"')) throw new Error('Host default false must show the switch off')

// The switch persists the device choice.
stored.clear()
snapshot = stateWith({ showCard: true })
hookName = ''
const tree = expandNode(react.createElement(component('settings.general.item:dsh-usage-monitor-floating-card'), {}))
const switchElement = findElement(tree, (node) => node.type === 'button'
  && node.props.role === 'switch')
if (switchElement === null) throw new Error('settings row has no switch element')
switchElement.props.onClick()
const saved = stored.get('dsh-usage-monitor:settings:v1')
if (saved !== JSON.stringify({ floatingCard: false })) {
  throw new Error('switch did not persist the preference: ' + String(saved))
}

// --- floating card visibility ---------------------------------------------

function card(overrides) {
  return render('shell.overlay:dsh-usage-monitor-card', overrides)
}
if (card({ showCard: false }) !== '') throw new Error('card must be hidden when the preference is off')
if (card({ showCard: true }) === '') throw new Error('card must render when the preference is on')
if (card({ showCard: null, data: { ...fixture, floatingCard: false } }) !== '') {
  throw new Error('card must be hidden when the Host disables it by default')
}
if (card({ showCard: null }) === '') throw new Error('card must render when the Host default is on')

const cardMarkup = card({ showCard: true })
if (!cardMarkup.includes('Daily spend') || !cardMarkup.includes('dsc-spark-slot')) {
  throw new Error('floating card must render the daily-spend histogram')
}
if (cardMarkup.includes('title="2026-10-28')) throw new Error('card histogram must not use native titles')

console.log('render ok; panel bytes:', panel.length, 'hovered bytes:', hovered.length, 'card bytes:', cardMarkup.length)
