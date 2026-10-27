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
new Function('window', readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))(globalThis.window)
if (loaded === null) throw new Error('bundle did not register')
console.log('exports:', Object.keys(loaded).sort().join(', '))
if (loaded.name !== 'dsh-credits') throw new Error('bad name')
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
for (const expected of ['sidebar.footer.action:dsh-credits', 'conversation.composer.dock:credits', 'shell.overlay:dsh-credits-panel']) {
  if (!keys.includes(expected)) throw new Error('missing registration ' + expected)
}
if (styles.length !== 1) throw new Error('expected one style element, got ' + styles.length)
console.log('smoke ok; style bytes:', styles[0].textContent.length)
