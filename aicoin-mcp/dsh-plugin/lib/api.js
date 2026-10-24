/**
 * Same-origin JSON API that backs the sidebar panel.
 *
 * A Harness client bundle cannot declare `ctx.remote.*` endpoints, so the panel
 * talks to its own Host half over a named HTTP route served by `ctx.webServer`.
 * Every path lives under one prefix owned by this plugin.
 *
 * The route is a thin adapter: parsing, method/route dispatch, error mapping and
 * the JSON envelope live here; the bridge state machine lives in index.js.
 *
 * @module dsh-plugin-aicoin-mcp/api
 */
import { URL } from 'node:url'

/** Prefix owned by this plugin; must match the client module's fetch paths. */
export const API_PREFIX = '/plugins/aicoin-mcp'

/** Largest accepted request body. */
const MAX_BODY_BYTES = 64 * 1024

/** Write one JSON response. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    // The socket may already be gone; nothing useful to do.
  }
}

/** Read and parse a JSON request body. */
function readJsonBody(req) {
  return new Promise((resolvePromise, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body larger than ${MAX_BODY_BYTES} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', (error) => reject(error))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) {
        resolvePromise({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('request body must be a JSON object'))
          return
        }
        resolvePromise(parsed)
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`))
      }
    })
  })
}

/**
 * Build the request handler for the named route.
 *
 * @param {{state: Function, action: Function, tools: Function}} handlers
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function createApiHandler(handlers) {
  return async function handleApiRequest(req, res) {
    let url
    try {
      url = new URL(req.url ?? API_PREFIX, 'http://127.0.0.1')
    } catch {
      sendJson(res, 400, { ok: false, error: 'malformed request URL' })
      return
    }
    const route = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) || '/' : url.pathname
    const method = (req.method ?? 'GET').toUpperCase()

    try {
      if (method === 'GET' && (route === '/state' || route === '/')) {
        sendJson(res, 200, await handlers.state())
        return
      }
      if (method === 'GET' && route === '/tools') {
        sendJson(res, 200, await handlers.tools())
        return
      }
      if (method === 'POST' && route === '/action') {
        const body = await readJsonBody(req)
        sendJson(res, 200, await handlers.action(body))
        return
      }
      sendJson(res, 404, { ok: false, error: `no route for ${method} ${url.pathname}` })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : 500
      const payload =
        error && typeof error === 'object' && error.payload && typeof error.payload === 'object' ? error.payload : {}
      sendJson(res, typeof status === 'number' ? status : 500, { ok: false, error: message, ...payload })
    }
  }
}

/**
 * Create an error that carries an HTTP status code.
 *
 * @param {number} statusCode
 * @param {string} message
 * @param {object} [payload]
 */
export function apiError(statusCode, message, payload) {
  const error = new Error(message)
  error.statusCode = statusCode
  if (payload && typeof payload === 'object') error.payload = payload
  return error
}
