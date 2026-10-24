// Bridge self-test: load the DSH plugin's `apply()` with a stubbed plugin
// context, so registration + tool execution can be checked without installing
// it into the live profile.
//
// usage: node scripts/bridge-selftest.mjs [--port 9222]
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const root = resolve(HERE, '..')
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const port = Number(arg('port', 9222))

const registered = []
const logs = []

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
  on: () => {},
  get: () => undefined,
}

const fail = (message) => {
  console.error(`[x] ${message}`)
  process.exitCode = 1
}

const main = async () => {
  const { apply } = await import(pathToFileURL(resolve(root, 'dsh-plugin', 'lib', 'index.js')).href)
  const dispose = await apply(ctx, {
    enabled: true,
    serverRoot: root,
    port,
    autoStart: true,
    requestTimeoutMs: 120000,
    maxTools: 64,
    allowMutating: true,
  })

  console.log(`[ok] apply() registered ${registered.length} tools:`)
  for (const definition of registered) {
    const props = Object.keys(definition.parameters?.properties ?? {})
    const schemaOk = definition.parameters?.type === 'object'
    console.log(`   - ${definition.name}${schemaOk ? '' : ' (BAD SCHEMA)'}  [${props.join(', ') || 'no args'}]`)
    if (!definition.description) fail(`${definition.name} has no description`)
    if (typeof definition.execute !== 'function') fail(`${definition.name} has no execute()`)
    if (typeof definition.output?.render !== 'function') fail(`${definition.name} has no output.render`)
  }

  const status = registered.find((d) => d.name === 'aicoin_mcp_status')
  if (!status) return fail('aicoin_mcp_status is missing')
  const statusResult = await status.execute({})
  console.log('\n[ok] aicoin_mcp_status →')
  console.log(String(statusResult.message).split('\n').map((l) => `   | ${l}`).join('\n'))
  if (!statusResult.ok) fail('aicoin_mcp_status returned ok=false')

  // Exercise one proxied MCP tool end-to-end (framework_info always exists).
  const proxied = registered.find((d) => d.name === 'framework_info')
  if (proxied) {
    const result = await proxied.execute({})
    console.log(`\n[ok] proxied framework_info ok=${result.ok}`)
    console.log(String(result.message).split('\n').slice(0, 12).map((l) => `   | ${l}`).join('\n'))
    if (!result.ok) fail('proxied tool call failed')
  } else {
    console.log('\n[=] no proxied tool modules yet (framework_info absent); skipping proxy check')
  }

  const bad = await registered[0].execute({ __unexpected: true })
  if (!bad || typeof bad.ok !== 'boolean') fail('execute() must return { ok, message }')

  // Safe lifecycle probe: dry-run stop must never touch the running client.
  const stop = registered.find((d) => d.name === 'aicoin_app_stop')
  if (stop) {
    // Only meaningful when a client is attachable beforehand: if the port was
    // already closed (client running without a debug port), the post-check
    // would fail for the wrong reason.
    const portWasUp = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok).catch(() => false)
    const before = await stop.execute({ dryRun: true })
    console.log(`\n[ok] aicoin_app_stop { dryRun: true } ok=${before.ok}`)
    console.log(String(before.message).split('\n').slice(0, 10).map((l) => `   | ${l}`).join('\n'))
    if (!portWasUp) {
      console.log(`   | 跳过断言：测试开始时端口 ${port} 本来就不可连（客户端未开调试端口）`)
    } else {
      const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => null)
      if (!version) fail('dry-run stop actually stopped the client — that must not happen')
      else console.log(`   | 客户端仍在：${String(version.Browser).split(' ')[0]}`)
    }
  }

  dispose()
  const afterDispose = registered.length
  console.log(`\n[ok] dispose() removed ${afterDispose === 0 ? 'all tools' : `${afterDispose} tools (LEAK)`}`)
  if (afterDispose !== 0) fail('dispose did not unregister tools')

  if (logs.some(([level]) => level === 'error')) {
    console.log('\n[server log]')
    for (const [level, line] of logs.slice(-15)) console.log(`   ${level}: ${line}`)
  }
  console.log(process.exitCode ? '\nRESULT: FAIL' : '\nRESULT: PASS')
}

main().catch((error) => {
  console.error('[x]', error?.stack ?? error)
  process.exitCode = 1
})
