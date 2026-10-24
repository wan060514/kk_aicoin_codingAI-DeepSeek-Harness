// End-to-end tool sweep over the real MCP server against the live AiCoin client.
// Read-only by design: the only mutating tool is exercised with confirm:false to
// prove the guard refuses to write the user's account.
//
// usage: node scripts/e2e-tools.mjs [--port 9222]
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const root = resolve(HERE, '..')
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const port = Number(arg('port', 9222))

const child = spawn(process.execPath, [join(root, 'src', 'server.mjs'), '--port', String(port)], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let buffer = ''
const pending = new Map()
let nextId = 1
const stderr = []
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
      continue
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', (c) => stderr.push(String(c).trimEnd()))

const request = (method, params, timeoutMs = 90000) =>
  new Promise((res, rej) => {
    const id = nextId++
    const timer = setTimeout(() => rej(new Error(`${method} timeout`)), timeoutMs)
    pending.set(id, (msg) => {
      clearTimeout(timer)
      res(msg)
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })

const call = async (name, args = {}) => {
  const reply = await request('tools/call', { name, arguments: args })
  if (reply.error) return { ok: false, message: `JSON-RPC error: ${JSON.stringify(reply.error)}`, raw: reply.error }
  const content = (reply.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text)
  return { ok: !reply.result?.isError, message: content.join('\n'), isError: Boolean(reply.result?.isError) }
}

const results = []
const check = (label, condition, detail) => {
  results.push({ label, pass: Boolean(condition), detail })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const short = (text, n = 260) => String(text ?? '').replace(/\s+/g, ' ').slice(0, n)

const main = async () => {
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: { tools: {} },
    clientInfo: { name: 'lead-e2e', version: '0' },
  })
  if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')
  const list = await request('tools/list', {})
  const names = (list.result?.tools ?? []).map((t) => t.name)
  check('tools/list exposes the control surface', names.length >= 12, `${names.length} tools: ${names.join(', ')}`)

  // --- read-only status and windows -------------------------------------
  const status = await call('aicoin_app_status', {})
  check('aicoin_app_status', status.ok && /page target|page 目标/.test(status.message), short(status.message, 160))

  const targets = await call('aicoin_app_targets', {})
  check('aicoin_app_targets', targets.ok && /#\/main/.test(targets.message), short(targets.message, 160))

  const windows = await call('aicoin_app_windows', {})
  check('aicoin_app_windows', windows.ok, short(windows.message, 160))

  const snapshot = await call('aicoin_app_snapshot', {})
  check('aicoin_app_snapshot', snapshot.ok, short(snapshot.message, 200))

  // --- indicators -------------------------------------------------------
  const indicators = await call('aicoin_app_indicators_list', { limit: 5 })
  check('aicoin_app_indicators_list (summary)', indicators.ok, short(indicators.message, 220))
  let firstId = null
  try {
    const parsed = JSON.parse(indicators.message)
    const found = parsed?.rows ?? parsed?.data?.rows ?? parsed?.data?.list ?? parsed?.list
    const first = Array.isArray(found) ? found[0] : null
    firstId = first?.id ?? null
  } catch {
    const m = /"id"\s*:\s*"?(\d+)"?/.exec(indicators.message)
    if (m) firstId = Number(m[1])
  }
  if (firstId) {
    const one = await call('aicoin_app_indicators_get', { id: firstId })
    check('aicoin_app_indicators_get (AiScript source)', one.ok && /@version|plot\(|\bif\b|=>|\w+\(/.test(one.message), `id=${firstId}, ${short(one.message, 200)}`)
  } else {
    check('aicoin_app_indicators_get (AiScript source)', false, 'no indicator id parsed from the list output')
  }

  // --- client's own API -------------------------------------------------
  const apiCall = await call('aicoin_app_api', { method: 'post', path: 'upgrade/customIndicator/script/list', includeData: false })
  check('aicoin_app_api (script/list, read-only)', apiCall.ok || /success|status/i.test(apiCall.message), short(apiCall.message, 260))

  // --- page-side helpers ------------------------------------------------
  const evalResult = await call('aicoin_app_eval', { expression: '({hash: location.hash, hasWebpack: Object.keys(window).some(function(k){return /^webpackChunk/.test(k)})})' })
  check('aicoin_app_eval', evalResult.ok && /webpackChunk|hash/.test(evalResult.message), short(evalResult.message, 200))

  const consoleResult = await call('aicoin_app_console', { ms: 600 })
  check('aicoin_app_console', consoleResult.ok, short(consoleResult.message, 200))

  const shot = await call('aicoin_app_screenshot', { path: 'e2e-tool-sweep.png' })
  check('aicoin_app_screenshot', shot.ok && /shots[\\/]e2e-tool-sweep\.png/.test(shot.message) && !/"base64"\s*:/.test(shot.message), short(shot.message, 220))

  // --- write guard: preview only, must not touch the account ------------
  const preview = await call('aicoin_app_indicator_save', { name: 'e2e-guard', value: '// @version=2\nplot(close)', confirm: false })
  let previewParsed = null
  try {
    previewParsed = JSON.parse(preview.message)
  } catch {
    /* keep null */
  }
  check(
    'aicoin_app_indicator_save without confirm is a dry run (no account write)',
    previewParsed?.dryRun === true && previewParsed?.executed === false && /wouldPost|script\/save/.test(preview.message),
    short(preview.message, 220),
  )
  const missingValue = await call('aicoin_app_indicator_save', { name: 'e2e-guard', confirm: true })
  check('aicoin_app_indicator_save refuses confirm:true without value', !missingValue.ok, short(missingValue.message, 180))

  // --- stop must stay a dry run ----------------------------------------
  const stop = await call('aicoin_app_stop', { dryRun: true })
  const stillUp = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => null)
  check('aicoin_app_stop dryRun does not stop the client', stop.ok && Boolean(stillUp), `dryRun ok=${stop.ok}, client still up=${Boolean(stillUp)}`)

  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`)
  if (failed.length) {
    console.log('failed:', failed.map((f) => f.label).join('; '))
    if (stderr.length) console.log('\n[server stderr tail]\n' + stderr.slice(-12).join('\n'))
    process.exitCode = 1
  }
  child.stdin.end()
  await new Promise((r) => child.once('exit', r))
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
