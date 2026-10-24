// Manual MCP stdio handshake check (Lead's integration test, not part of test/).
// usage: node scripts/mcp-handshake.mjs [--server <path>] [--port 9222]
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const root = resolve(HERE, '..')
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const serverPath = arg('server', join(root, 'src', 'server.mjs'))
const port = Number(arg('port', 9222))

if (!existsSync(serverPath)) {
  console.error(`[x] no server at ${serverPath}`)
  process.exit(2)
}

const child = spawn(process.execPath, [serverPath, '--port', String(port)], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buffer = ''
const pending = new Map()
let nextId = 1
const log = []
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const i = buffer.indexOf('\n')
    if (i === -1) break
    const line = buffer.slice(0, i).trim()
    buffer = buffer.slice(i + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      console.error('[non-JSON stdout]', line.slice(0, 200))
      continue
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    } else if (msg.method) {
      log.push(`notification: ${msg.method}`)
    }
  }
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', (c) => {
  const text = String(c).trimEnd()
  if (text) log.push(`stderr: ${text}`)
})

const request = (method, params, timeoutMs = 20000) =>
  new Promise((res, rej) => {
    const id = nextId++
    const timer = setTimeout(() => rej(new Error(`${method} timeout`)), timeoutMs)
    pending.set(id, (msg) => {
      clearTimeout(timer)
      res(msg)
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })

const main = async () => {
  const fail = (message) => {
    console.error(`[x] ${message}`)
    process.exitCode = 1
  }
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: { tools: {} },
    clientInfo: { name: 'lead-verify', version: '0' },
  })
  if (init.error) return fail(`initialize error: ${JSON.stringify(init.error)}`)
  console.log('[ok] initialize:', JSON.stringify(init.result?.serverInfo), 'proto=', init.result?.protocolVersion)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')

  const ping = await request('ping', {})
  console.log(ping.result !== undefined ? '[ok] ping' : `[x] ping: ${JSON.stringify(ping)}`)

  const list = await request('tools/list', {})
  const tools = list.result?.tools ?? []
  console.log(`[ok] tools/list: ${tools.length} tools`)
  for (const tool of tools) {
    const props = Object.keys(tool.inputSchema?.properties ?? {})
    console.log(`   - ${tool.name}  [${props.join(', ') || 'no args'}]`)
  }

  const bad = await request('no/such_method', {})
  console.log(bad.error?.code === -32601 ? '[ok] unknown method -> -32601' : `[x] unknown method -> ${JSON.stringify(bad.error)}`)

  if (tools.length) {
    const target = tools.find((t) => /status/.test(t.name)) ?? tools[0]
    const call = await request('tools/call', { name: target.name, arguments: {} }, 60000)
    if (call.error) {
      fail(`tools/call ${target.name} error: ${JSON.stringify(call.error)}`)
    } else {
      const text = (call.result?.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n')
      console.log(`[ok] tools/call ${target.name} isError=${Boolean(call.result?.isError)}`)
      console.log(text.split('\n').map((l) => `     | ${l}`).join('\n').slice(0, 2500))
    }
  }

  if (log.length) console.log('\n[server log]\n' + log.join('\n').slice(0, 2000))
  child.stdin.end()
  await new Promise((r) => child.once('exit', r))
  console.log(process.exitCode ? '\nRESULT: FAIL' : '\nRESULT: PASS')
}

main().catch((error) => {
  console.error('[x]', error?.message ?? error)
  process.exitCode = 1
  try {
    child.kill()
  } catch {
    /* ignore */
  }
})
