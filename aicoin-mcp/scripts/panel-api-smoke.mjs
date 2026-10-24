// Pre-install smoke test for the panel HTTP API adapter (lib/api.js).
//
// Feeds fake req/res objects through createApiHandler so routing, JSON
// envelopes, status codes and error mapping are verified without a live host.
//
// usage: node scripts/panel-api-smoke.mjs
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PassThrough } from 'node:stream'

const HERE = dirname(fileURLToPath(import.meta.url))
const root = resolve(HERE, '..')
const { API_PREFIX, apiError, createApiHandler } = await import(
  pathToFileURL(resolve(root, 'dsh-plugin', 'lib', 'api.js')).href
)

const failures = []
const check = (label, condition, detail) => {
  if (!condition) failures.push(label)
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

/** Fake response that records status/headers/body. */
function makeRes() {
  const captured = { status: 0, headers: {}, body: '' }
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers || {}
    },
    end(body) {
      captured.body = body === undefined ? '' : String(body)
    },
  }
}

/** Run one request against the handler. */
async function call(handler, method, url, jsonBody) {
  const req = new PassThrough()
  req.method = method
  req.url = url
  if (jsonBody !== undefined) {
    req.write(typeof jsonBody === 'string' ? jsonBody : JSON.stringify(jsonBody))
  }
  req.end()
  const res = makeRes()
  await handler(req, res)
  return res.captured
}

const handler = createApiHandler({
  state: async () => ({ ok: true, phase: 'ready', tools: [{ name: 'aicoin_app_status' }] }),
  tools: async () => ({ ok: true, total: 1, items: [{ name: 'aicoin_app_status' }] }),
  action: async (body) => {
    if (body.action === 'refresh') return { ok: true, action: 'refresh', phase: 'ready' }
    throw apiError(400, `unknown action "${body.action}"`)
  },
})

// 1. state
const stateRes = await call(handler, 'GET', `${API_PREFIX}/state`)
check('GET /state -> 200 json', stateRes.status === 200 && /application\/json/.test(stateRes.headers['content-type'] ?? ''), `${stateRes.status} ${stateRes.headers['content-type']}`)
let parsed = null
try {
  parsed = JSON.parse(stateRes.body)
} catch {
  /* reported below */
}
check('GET /state body is the state object', parsed?.ok === true && parsed?.phase === 'ready')

// 2. tools
const toolsRes = await call(handler, 'GET', `${API_PREFIX}/tools`)
check('GET /tools -> 200', toolsRes.status === 200 && JSON.parse(toolsRes.body).total === 1)

// 3. action ok
const okRes = await call(handler, 'POST', `${API_PREFIX}/action`, { action: 'refresh' })
check('POST /action -> 200 echo', okRes.status === 200 && JSON.parse(okRes.body).action === 'refresh')

// 4. action unknown -> mapped 400
const badRes = await call(handler, 'POST', `${API_PREFIX}/action`, { action: 'nope' })
check('POST /action unknown -> 400 + error', badRes.status === 400 && JSON.parse(badRes.body).ok === false, `${badRes.status}`)

// 5. bad json -> 500 with error
const badJsonRes = await call(handler, 'POST', `${API_PREFIX}/action`, '{not json')
check('POST /action bad json -> error envelope', badJsonRes.status >= 400 && JSON.parse(badJsonRes.body).ok === false, `${badJsonRes.status}`)

// 6. unknown route -> 404
const missRes = await call(handler, 'GET', `${API_PREFIX}/nope`)
check('GET unknown route -> 404', missRes.status === 404)

// 7. method mismatch -> 404 (never 405 without a body)
const postStateRes = await call(handler, 'POST', `${API_PREFIX}/state`, {})
check('POST /state -> 404', postStateRes.status === 404)

// 8. path outside prefix falls through to route match (defensive)
const outsideRes = await call(handler, 'GET', '/somewhere/else')
check('GET outside prefix -> 404', outsideRes.status === 404)

console.log(failures.length ? `\nRESULT: FAIL (${failures.join('; ')})` : '\nRESULT: PASS')
process.exit(failures.length ? 1 : 0)
