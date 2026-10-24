// Resync self-test: proves that restarting the MCP child re-registers the Harness
// tools in place, so a newly added MCP tool shows up without restarting the whole
// DeepSeek Harness app.
//
// usage: node scripts/resync-selftest.mjs
import { dirname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const root = resolve(HERE, '..')

const registered = []
const logs = []
let route = null

const ctx = {
  logger: {
    info: (...a) => logs.push(['info', a.join(' ')]),
    warn: (...a) => logs.push(['warn', a.join(' ')]),
    error: (...a) => logs.push(['error', a.join(' ')]),
  },
  tools: {
    register(definition) {
      if (registered.some((d) => d.name === definition.name)) throw new Error(`duplicate tool name: ${definition.name}`)
      registered.push(definition)
      return () => {
        const index = registered.indexOf(definition)
        if (index >= 0) registered.splice(index, 1)
      }
    },
  },
  get: (name) => (name === 'webServer' ? { register: (spec) => { route = spec; return () => { route = null } } } : undefined),
  inject: (deps, fn) => fn(ctx),
  effect: (fn) => { const out = fn(); return () => { if (typeof out === 'function') out() } },
  on: () => {},
}

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 直接调面板 handler：req 用真的可读流，否则 api.js 会一直等 body。 */
async function call(method, path, body) {
  const raw = body === undefined ? '' : JSON.stringify(body)
  const req = Readable.from(raw ? [Buffer.from(raw)] : [])
  req.method = method
  req.url = path
  req.headers = { 'content-type': 'application/json' }
  let statusCode = 0
  let payload = ''
  const res = {
    statusCode: 0,
    setHeader: () => {},
    getHeader: () => undefined,
    end: (text) => {
      payload = String(text ?? '')
      statusCode = res.statusCode
    },
    on: () => {},
    writeHead: (code) => {
      res.statusCode = code
    },
  }
  await route.handler(req, res)
  let parsed = null
  try {
    parsed = payload ? JSON.parse(payload) : null
  } catch {
    parsed = { raw: payload }
  }
  return { status: statusCode, body: parsed }
}

const main = async () => {
  const { apply } = await import(pathToFileURL(resolve(root, 'dsh-plugin', 'lib', 'index.js')).href)
  const dispose = await apply(ctx, {
    enabled: true,
    serverRoot: root,
    port: 9222,
    autoStart: true,
    requestTimeoutMs: 120000,
    maxTools: 64,
    allowMutating: true,
  })

  const names = () => registered.map((d) => d.name)
  const baseline = registered.length
  check('apply() 注册了工具', baseline > 0, `${baseline} 个`)
  check('新工具 aicoin_app_indicator_publish 已注册', names().includes('aicoin_app_indicator_publish'))
  check('新工具 aicoin_app_indicator_del 已注册', names().includes('aicoin_app_indicator_del'))
  check('面板路由已挂载', Boolean(route), route?.path ?? 'none')

  // 造一个「子进程升级后多了一把工具」的场景：手动卸掉 publish，模拟旧注册集。
  const publish = registered.find((d) => d.name === 'aicoin_app_indicator_publish')
  const index = registered.indexOf(publish)
  if (index >= 0) registered.splice(index, 1)
  check('模拟旧注册集（临时移出 publish）', !names().includes('aicoin_app_indicator_publish'), `剩 ${registered.length} 个`)

  // 面板上的「重连」= mcp.restart；它应该在重启子进程后把工具集重新对齐。
  const restarted = await call('POST', '/plugins/aicoin-mcp/action', { action: 'mcp.restart' }).catch((error) => ({ status: 0, body: { ok: false, error: String(error) } }))
  check('mcp.restart 调用成功', restarted.body?.ok === true, JSON.stringify(restarted.body?.serverInfo ?? restarted.body?.error ?? '').slice(0, 120))
  check('重启后 publish 自动回到工具集', names().includes('aicoin_app_indicator_publish'), `${registered.length} 个工具`)
  check('工具总数与基线一致（没有漏注册/重复注册）', registered.length === baseline, `${registered.length} vs ${baseline}`)
  check('没有出现 duplicate tool name 报错', !logs.some(([, line]) => /duplicate tool name/.test(line)))

  const resyncLog = logs.find(([, line]) => /工具已重同步/.test(line))
  check('日志记录了重同步', Boolean(resyncLog), resyncLog?.[1] ?? 'none')

  const stateAfter = await call('GET', '/plugins/aicoin-mcp/state')
  check('面板 state 能读到最新工具数', (stateAfter.body?.tools?.length ?? 0) > 0, `${stateAfter.body?.tools?.length} 个`)

  try {
    dispose()
  } catch {}
  const failed = results.filter((item) => !item.ok)
  console.log(`\nRESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${results.length - failed.length}/${results.length})`)
  if (failed.length > 0) process.exitCode = 1
  // MCP 子进程会拖住事件循环，显式退出。
  setTimeout(() => process.exit(failed.length === 0 ? 0 : 1), 50)
}

main().catch((error) => {
  console.error('[x]', error?.stack ?? error)
  process.exitCode = 1
})
