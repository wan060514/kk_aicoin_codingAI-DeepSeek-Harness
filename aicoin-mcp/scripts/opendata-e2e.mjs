// End-to-end sweep of the Open Data tools over the REAL MCP server (stdio JSON-RPC).
// Proves the tools are registered and callable through the protocol, not just as
// imported handlers. Read-only; network calls go to open.aicoin.com.
//
// usage: node scripts/opendata-e2e.mjs
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const root = resolve(HERE, '..')

const child = spawn(process.execPath, [join(root, 'src', 'server.mjs')], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buffer = ''
const pending = new Map()
let nextId = 1
const stderrLines = []

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const index = buffer.indexOf('\n')
    if (index === -1) break
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  }
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => stderrLines.push(...String(chunk).split('\n').filter(Boolean)))

function send(method, params) {
  const id = nextId++
  const payload = { jsonrpc: '2.0', id, method, params }
  child.stdin.write(`${JSON.stringify(payload)}\n`)
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      rejectPromise(new Error(`timeout: ${method}`))
    }, 60000)
    pending.set(id, (message) => {
      clearTimeout(timer)
      resolvePromise(message)
    })
  })
}

const results = []
function record(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 取 tools/call 的文本结果并解析成对象（server 把对象 JSON 美化后塞进 text）。 */
function payloadOf(response) {
  const text = response?.result?.content?.[0]?.text
  if (typeof text !== 'string') return null
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

try {
  const init = await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'opendata-e2e', version: '1.0.0' },
  })
  record('initialize', init?.result?.serverInfo?.name === 'aicoin-mcp', `${init?.result?.serverInfo?.name} ${init?.result?.serverInfo?.version}`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

  const list = await send('tools/list', {})
  const names = (list?.result?.tools ?? []).map((tool) => tool.name)
  const wanted = [
    'aicoin_data_catalog',
    'aicoin_data_capabilities',
    'aicoin_data_query',
    'aicoin_quote',
    'aicoin_kline',
    'aicoin_indicator_kline',
    'aicoin_derivatives',
    'aicoin_news',
  ]
  const missing = wanted.filter((name) => !names.includes(name))
  record('tools/list 含 8 个新工具', missing.length === 0, `${names.length} 个工具${missing.length ? `，缺 ${missing.join(',')}` : ''}`)

  const catalog = payloadOf(await send('tools/call', { name: 'aicoin_data_catalog', arguments: {} }))
  record('aicoin_data_catalog', catalog?.ok === true && Array.isArray(catalog.groups) && catalog.groups.length > 5, `groups=${catalog?.groups?.length} source=${catalog?.source}`)

  const group = payloadOf(await send('tools/call', { name: 'aicoin_data_catalog', arguments: { group: 'market' } }))
  record('aicoin_data_catalog group=market', group?.ok === true && Array.isArray(group.endpoints) && group.endpoints.length > 5, `${group?.count} 个接口`)

  const quote = payloadOf(await send('tools/call', { name: 'aicoin_quote', arguments: { coins: 'bitcoin', view: 'both' } }))
  record('aicoin_quote', quote?.ok === true && quote?.ticker?.last_usd > 0, `last=${quote?.ticker?.last_usd}`)

  const kline = payloadOf(await send('tools/call', { name: 'aicoin_kline', arguments: { coin_key: 'bitcoin', interval: '1h', limit: 3 } }))
  record('aicoin_kline', kline?.ok === true && kline?.count === 3 && typeof kline?.summary?.last_close === 'number', `bars=${kline?.count}`)

  const query = payloadOf(await send('tools/call', { name: 'aicoin_data_query', arguments: { endpoint: 'market/tickers', params: { market: 'binance' }, maxItems: 2 } }))
  record('aicoin_data_query 透传', query?.ok === true, `endpoint=${query?.endpoint}`)

  const unknown = payloadOf(await send('tools/call', { name: 'aicoin_data_query', arguments: { endpoint: 'not/a/endpoint' } }))
  record('aicoin_data_query 拒绝未知接口', unknown?.ok === false && unknown?.error?.code === 'UNKNOWN_ENDPOINT', unknown?.error?.code)

  const news = payloadOf(await send('tools/call', { name: 'aicoin_news', arguments: { view: 'flash', limit: 2 } }))
  const newsOk = news?.ok === true || news?.needs_paid_key === true
  record('aicoin_news（免费档 403 也算正常）', newsOk, news?.ok ? `${news?.count} 条` : 'needs_paid_key')

  const caps = payloadOf(await send('tools/call', { name: 'aicoin_data_capabilities', arguments: {} }))
  record('aicoin_data_capabilities', caps?.ok === true && Array.isArray(caps?.available), `available=${caps?.available?.length}`)
} catch (error) {
  record('e2e', false, String(error?.message ?? error))
} finally {
  child.stdin.end()
  child.kill()

  const failed = results.filter((item) => !item.ok)
  const loadLine = stderrLines.find((line) => line.includes('工具加载完成'))
  if (loadLine) console.log(`\n[server] ${loadLine.replace(/^.*\]\s*/, '')}`)
  console.log(`RESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${results.length - failed.length}/${results.length})`)
  if (failed.length > 0) {
    process.exitCode = 1
    for (const line of stderrLines.slice(-5)) console.log(`[stderr] ${line}`)
  }
}
