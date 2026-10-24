// Pre-install smoke test for the browser half (client.js).
//
// Loads the plugin bundle the same way the Harness module loader does, but with
// stubbed `window`, React and plugin `ctx`, then renders the sidebar icon and the
// panel once. This catches syntax errors, missing dictionaries, bad style
// objects and "throw during apply" before anything touches the live profile.
//
// usage: node scripts/client-smoke.mjs
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const root = resolve(HERE, '..')
const failures = []
const fail = (message) => {
  failures.push(message)
  console.error(`[x] ${message}`)
}

// ---- mini React + renderer ------------------------------------------------
let renderDepth = 0
const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props || {}), ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) } }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useCallback(fn) {
    return fn
  },
  useMemo(fn) {
    return fn()
  },
  useRef(value) {
    return { current: value }
  },
  Fragment: Symbol('Fragment'),
}

function render(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (Array.isArray(node)) return node.map(render).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node !== 'object') return ''
  const { type, props } = node
  if (typeof type === 'function') {
    if (renderDepth > 60) throw new Error('render depth exceeded (possible infinite recursion)')
    renderDepth += 1
    try {
      return render(type(props))
    } finally {
      renderDepth -= 1
    }
  }
  if (type === React.Fragment) return render(props.children)
  // Host element: keep the tag name so "an <svg> was rendered" is checkable.
  return '<' + String(type) + '>' + render(props.children)
}

// ---- loader + plugin context stubs ---------------------------------------
const loaded = []
let registered = []
let localeCalls = []
const slotCalls = []

globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loaded.push(spec)
    },
  },
}
// Node 24 exposes a read-only `navigator`; override it only if the platform allows.
try {
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
} catch {
  /* keep the platform navigator (fallback dictionary becomes the English one) */
}
globalThis.fetch = () => Promise.reject(new Error('fetch must not run during the smoke render'))

const requireStub = (id) => {
  if (id === 'react') return React
  throw new Error(`client.js required a package that is not provided: ${id}`)
}

const registerReturn = () => () => {}

const ctx = {
  effect(fn) {
    const dispose = typeof fn === 'function' ? fn() : undefined
    return typeof dispose === 'function' ? dispose : registerReturn()
  },
  locale: {
    register(namespace, dictionaries) {
      localeCalls.push({ namespace, dictionaries })
      return registerReturn()
    },
    bind() {
      // Simulate an unregistered namespace so the local dictionaries are used.
      return (key) => key
    },
  },
  slots: {
    inject(_name, factory) {
      return factory()
    },
    register(seat, component) {
      slotCalls.push({ seat, component })
      return registerReturn()
    },
  },
}

// ---- load and apply -------------------------------------------------------
const clientPath = join(root, 'dsh-plugin', 'client.js')
await import(pathToFileURL(clientPath).href)

if (loaded.length !== 1) fail(`expected exactly one module registration, got ${loaded.length}`)
const spec = loaded[0]
if (!spec) {
  console.error('RESULT: FAIL')
  process.exit(1)
}
if (spec.id !== 'dsh-plugin-aicoin-mcp') fail(`module id must equal the package name, got ${spec.id}`)

let plugin
try {
  plugin = spec.factory(requireStub)
} catch (error) {
  fail(`factory() threw: ${error?.message ?? error}`)
}
if (!plugin) {
  console.error('RESULT: FAIL')
  process.exit(1)
}
if (!Array.isArray(plugin.inject) || !plugin.inject.includes('slots')) fail('plugin.inject must include slots')
if (typeof plugin.apply !== 'function') fail('plugin.apply must be a function')

try {
  plugin.apply(ctx)
} catch (error) {
  fail(`apply() threw: ${error?.message ?? error}`)
}

// ---- assertions -----------------------------------------------------------
if (localeCalls.length !== 1) fail(`expected one locale registration, got ${localeCalls.length}`)
const dict = localeCalls[0]?.dictionaries
if (!dict || !dict.zh || !dict.en) fail('locale dictionaries must carry zh and en')
if (dict?.zh && dict?.en) {
  const missingEn = Object.keys(dict.zh).filter((key) => !(key in dict.en))
  const missingZh = Object.keys(dict.en).filter((key) => !(key in dict.zh))
  if (missingEn.length) fail(`en is missing ${missingEn.length} key(s): ${missingEn.slice(0, 5).join(', ')}`)
  if (missingZh.length) fail(`zh is missing ${missingZh.length} key(s): ${missingZh.slice(0, 5).join(', ')}`)
}

if (slotCalls.length !== 2) fail(`expected two slot registrations, got ${slotCalls.length}`)
const sidebar = slotCalls.find((call) => call.seat?.name === 'sidebar.panellist')
const main = slotCalls.find((call) => call.seat?.name === 'main')
if (!sidebar) fail('sidebar.panellist slot was not registered')
if (!main) fail('main slot was not registered')
if (sidebar && sidebar.seat.id !== 'aicoin-mcp') fail(`sidebar id must be aicoin-mcp, got ${sidebar.seat.id}`)
if (sidebar && typeof sidebar.seat.label !== 'function') fail('sidebar seat must expose label()')
if (main && main.seat.key !== 'aicoin-mcp') fail(`main key must be aicoin-mcp, got ${main.seat.key}`)

let iconHtml = ''
try {
  iconHtml = render(React.createElement(sidebar.component, { size: 20, active: false }))
} catch (error) {
  fail(`icon render threw: ${error?.message ?? error}`)
}
if (!iconHtml.includes('svg')) fail('icon did not render an <svg>')

let panelHtml = ''
try {
  panelHtml = render(React.createElement(main.component, {}))
} catch (error) {
  fail(`panel render threw: ${error?.stack ?? error}`)
}
for (const needle of ['AiCoin MCP', '/plugins/aicoin-mcp']) {
  if (!panelHtml.includes(needle)) fail(`panel output is missing "${needle}"`)
}
for (const needle of ['MCP', 'AiCoin']) {
  if (!panelHtml.includes(needle)) fail(`panel output is missing section "${needle}"`)
}

// ---- populated render: the new cards must survive a full state ------------
const CannedState = {
  ok: true,
  phase: 'ready',
  updatedAt: '2026-10-24T09:50:00.000Z',
  mcp: { pid: 8696, serverInfo: { name: 'aicoin-mcp', version: '0.3.0' }, toolsRegistered: 18, toolsAdvertised: 17, port: 9222 },
  aicoin: {
    reachable: false,
    verdict: 'running-without-debug-port',
    process: { mainPids: [13686] },
    nextAction: { tool: 'aicoin_app_connect', args: { port: 9222, allowRestart: true } },
  },
  tools: [
    { name: 'aicoin_app_connect', description: 'connect', mutating: true },
    { name: 'aicoin_app_status', description: 'status', mutating: false },
  ],
  lastToolResult: { tool: 'aicoin_app_status', ok: true, result: { verdict: 'running-without-debug-port' } },
}
let richHtml = ''
try {
  richHtml = render(React.createElement(main.component, { initialData: CannedState }))
} catch (error) {
  fail(`populated panel render threw: ${error?.stack ?? error}`)
}
// The panel falls back to the built-in ZH dictionary, so assert on the strings.
const zh = (key) => dict?.zh?.[key] ?? key
for (const key of ['section.run', 'btn.run', 'section.script', 'btn.validate', 'row.scriptPath', 'row.args', 'btn.advice', 'btn.specStatus', 'row.specName']) {
  if (!richHtml.includes(zh(key))) fail(`populated panel is missing "${key}" (${zh(key)})`)
}
if (!richHtml.includes('<select>')) fail('tool runner did not render a <select>')
if (!richHtml.includes('<textarea>')) fail('tool runner did not render a <textarea>')
for (const key of ['banner.needsRestart', 'btn.restartDebug']) {
  if (!richHtml.includes(zh(key))) fail(`needs-restart hint is missing "${key}" (${zh(key)})`)
}
// Publish card must be present (write-into-AiCoin path).
for (const key of ['section.publish', 'btn.publish', 'btn.verifyOnly']) {
  if (!richHtml.includes(zh(key))) fail(`publish card is missing "${key}" (${zh(key)})`)
}
// Market card (Open Data) must be present and carry its buttons.
for (const key of ['section.market', 'btn.quote', 'btn.kline']) {
  if (!richHtml.includes(zh(key))) fail(`market card is missing "${key}" (${zh(key)})`)
}
if (!richHtml.includes('aicoin_app_status')) fail('tool runner does not show lastToolResult')
if (richHtml.includes('undefined')) fail('populated panel rendered a literal "undefined"')

console.log(`[ok] module id        ${spec.id}`)
console.log(`[ok] inject           ${plugin.inject.join(', ')}`)
console.log(`[ok] locale keys      zh=${Object.keys(dict?.zh ?? {}).length} en=${Object.keys(dict?.en ?? {}).length}`)
console.log(`[ok] slots            ${slotCalls.map((call) => call.seat?.name).join(', ')}`)
console.log(`[ok] icon render      ${iconHtml.length} chars`)
console.log(`[ok] panel render     ${panelHtml.length} chars`)
console.log(`[ok] populated render ${richHtml.length} chars`)
console.log(failures.length ? `\nRESULT: FAIL (${failures.length})` : '\nRESULT: PASS')
process.exit(failures.length ? 1 : 0)
