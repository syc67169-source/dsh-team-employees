import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
function setup() {
  const cells = [], effects = [], timers = new Map(), calls = []
  let cursor = 0, timerId = 0, entry, component
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: initial => {
      const i = cursor++
      if (!(i in cells)) cells[i] = { value: initial }
      return [cells[i].value, value => { cells[i].value = typeof value === 'function' ? value(cells[i].value) : value }]
    },
    useCallback: fn => { cursor++; return fn },
    useEffect: (fn, deps) => {
      const i = cursor++, prev = cells[i]
      if (!prev || deps.some((value, j) => value !== prev.deps[j])) {
        prev?.cleanup?.()
        const cell = cells[i] = { deps }
        effects.push(() => { cell.cleanup = fn() })
      }
    }
  }
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: value => { entry = value } } },
    AbortController,
    fetch: (url, options) => new Promise((resolve, reject) => {
      calls.push({ url, options, resolve, reject })
      options.signal.addEventListener('abort', () => reject(new Error('aborted')))
    }),
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id },
    clearTimeout: id => timers.delete(id)
  })
  const mod = entry.factory(() => react)
  mod.apply({ slots: { inject: (_, fn) => fn(), register: (spec, value) => { if (spec.name === 'main') component = value } } })
  const render = () => { cursor = 0; const tree = component(); while (effects.length) effects.shift()(); return tree }
  const unmount = () => { for (const cell of cells) cell?.cleanup?.() }
  const fire = delay => { const pair = [...timers].find(([, timer]) => timer.delay === delay); assert.ok(pair, `missing ${delay}ms timer`); timers.delete(pair[0]); pair[1].fn() }
  return { render, unmount, timers, calls, fire }
}
function text(tree) { if (!tree) return ''; if (typeof tree === 'string') return tree; if (Array.isArray(tree)) return tree.map(text).join(' '); return text(tree.children) }
function refresh(tree) { return tree.children[0].children.find(node => node?.type === 'button').props.onClick }
const payload = { team: 'test', office: null, content: null }
const response = raw => ({ ok: true, status: 200, text: async () => raw })

test('slow requests do not schedule overlapping polls; completion starts next poll', async () => {
  const app = setup(); app.render()
  assert.equal(app.calls.length, 1)
  assert.equal([...app.timers.values()].some(timer => timer.delay === 5000), false)
  app.calls[0].resolve(response(JSON.stringify(payload))); await flush()
  assert.equal([...app.timers.values()].filter(timer => timer.delay === 5000).length, 1)
  app.fire(5000); app.render()
  assert.equal(app.calls.length, 2)
  app.unmount(); await flush(); assert.equal(app.timers.size, 0)
})
test('manual refresh aborts prior request; unmount cancels request and timers', async () => {
  const app = setup(); const tree = app.render()
  refresh(tree)(); app.render()
  assert.equal(app.calls.length, 2); assert.equal(app.calls[0].options.signal.aborted, true)
  app.unmount(); await flush()
  assert.equal(app.calls[1].options.signal.aborted, true); assert.equal(app.timers.size, 0)
})
test('timeout reports failure and retry poll instead of permanent refreshing', async () => {
  const app = setup(); app.render(); app.fire(15000); await flush()
  assert.match(text(app.render()), /请求超时/)
  assert.equal(app.calls[0].options.signal.aborted, true)
  assert.equal([...app.timers.values()].filter(timer => timer.delay === 5000).length, 1)
  app.unmount()
})
test('invalid successful JSON is visible as a service error', async () => {
  const app = setup(); app.render(); app.calls[0].resolve(response('<html>wrong page</html>')); await flush()
  assert.match(text(app.render()), /无效 JSON/); app.unmount()
})
