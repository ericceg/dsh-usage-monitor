// Evaluate the browser bundle in Node with a fake module loader, React, DOM,
// and slot service. Catches factory/apply wiring mistakes without a browser.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const fakeRequire = (name) => {
  if (name === 'react') return react
  throw new Error('unexpected require: ' + name)
}

const registrations = []
let loaded = null
globalThis.window = {
  __ModuleLoader__: { load: ({ factory }) => { loaded = factory(fakeRequire) } },
  __DSH_BOOT__: { release: { version: '0.2.1' } },
  addEventListener() {},
  removeEventListener() {},
}
const styles = []
globalThis.document = {
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { append(node) { styles.push(node) } },
  addEventListener() {},
  removeEventListener() {},
  visibilityState: 'visible',
}
globalThis.fetch = async () => { throw new Error('network disabled in smoke test') }

const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useEffect() {},
  useMemo(fn) { return fn() },
  useSyncExternalStore() { return {} },
}

// The loader facade receives the bundle through window.__ModuleLoader__.load;
// evaluate the file so it registers the factory.
const bundleSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
new Function('window', bundleSource)(globalThis.window)
if (loaded === null) throw new Error('bundle did not register')
console.log('exports:', Object.keys(loaded).sort().join(', '))
if (loaded.name !== 'dsh-usage-monitor') throw new Error('bad name')
if (!Array.isArray(loaded.inject)) throw new Error('bad inject')

const slots = {
  inject(key, callback) { callback(); return () => {} },
  register(options, component) {
    registrations.push({ key: options.name, id: options.id, component })
    return () => {}
  },
}
const ctx = {
  slots,
  effect(callback) { const dispose = callback(); return dispose },
  get(name) { return name === 'slots' ? slots : undefined },
}
loaded.apply(ctx)

const keys = registrations.map(r => r.key + ':' + r.id)
console.log('registrations:', keys.join(', '))
for (const expected of [
  'sidebar.footer.action:dsh-usage-monitor',
  'conversation.composer.dock:dsh-usage-monitor-pill',
  'shell.overlay:dsh-usage-monitor-card',
  'shell.overlay:dsh-usage-monitor-panel',
  'settings.general.item:dsh-usage-monitor-floating-card',
]) {
  if (!keys.includes(expected)) throw new Error('missing registration ' + expected)
}
if (styles.length !== 1) throw new Error('expected one style element, got ' + styles.length)
const css = styles[0].textContent
for (const needle of [
  '.dsc-card ', '.dsc-card-moving', '.dsc-card-chevron', '.dsc-card-chat-meta',
  '.dsc-card-body', '@keyframes dsc-card-in', 'z-index:100;', 'width:308px',
  '.dsc-spark-slot', '.dsc-spark-tip', '.dsc-spark-tip-date', '.dsc-spark-tip-sub',
  '.dsc-setting-row', '.dsc-switch[data-on="true"]', '.dsc-panel-setting',
]) {
  if (!css.includes(needle)) throw new Error('missing card style ' + needle)
}
if (css.includes('width:242px')) throw new Error('collapsing must not change the card width')
for (const needle of ["className: 'dsc-spark-tip'", 'isCardVisible', 'formatExact', 'showCard']) {
  if (!bundleSource.includes(needle)) throw new Error('missing bundle feature ' + needle)
}
// The whole extension is monochrome: no brand colours, no state colours.
if (/brand-primary|state-(warn|error|success)-primary/.test(css)) {
  throw new Error('extension must stay monochrome (no brand or state colours)')
}
if (/#f5a623|#f56c6c|#3ecf8e|#4d6bfe|#ffb4b4/i.test(css)) {
  throw new Error('extension must stay monochrome (no hard-coded accent colours)')
}
console.log('smoke ok; style bytes:', css.length)
