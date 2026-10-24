/**
 * cdp.mjs - a dependency-free Chrome DevTools Protocol client.
 *
 * AiCoin is an Electron app, so once it is started with
 * `--remote-debugging-port=<port>` every renderer can be driven from Node:
 * `http://127.0.0.1:<port>/json/list` enumerates page targets and each one
 * exposes a `webSocketDebuggerUrl` that speaks JSON-RPC 2.0.
 *
 * Design notes that matter for this project:
 *
 *  - AiCoin opens SEVERAL page targets at once (`#/main/exchange`, `#/chat`,
 *    `#/asset-sync`, `#/notice`). Each is a separate renderer with its own
 *    store, so attaching to the "first page" silently drives the wrong window.
 *    `attach()` therefore selects a target explicitly and defaults to the
 *    `#/main` window; the chosen target is exposed as `client.target`.
 *  - Only the WebSocket client side is implemented (masking, fragmentation,
 *    ping/pong, close) because CDP servers always speak unmasked frames.
 *  - Errors carry a stable `code` so tools can tell "port closed" from
 *    "page threw" without parsing messages.
 *
 * The source stays ASCII on purpose: this file is written through several
 * Windows toolchains and multi-byte text has been corrupted before. The one
 * user-facing Chinese word needed by the screenshot timeout is expressed as a
 * unicode escape so the bytes on disk are still 7-bit.
 *
 * @module aicoin-mcp/cdp
 */
import { request as httpRequest } from 'node:http'
import { Socket } from 'node:net'
import { randomBytes } from 'node:crypto'

/** Default CDP port used by the launcher and the MCP server. */
export const DEFAULT_PORT = 9222

/** Upper bound for a single CDP message (CDP itself caps strings around 256MB). */
export const MAX_PAYLOAD = 256 * 1024 * 1024

/** URL fragment that identifies the K-line / main workspace window. */
export const MAIN_WINDOW_URL_HINT = '#/main'

/** Timeout used when a call does not specify one. */
const DEFAULT_TIMEOUT = 15000

/** The Chinese word "timeout", kept escaped so this file stays ASCII. */
const WORD_TIMEOUT = '\u8d85\u65f6'

/** Raised for every predictable CDP failure. */
export class CdpError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, method?: string, data?: unknown, details?: object,
   *   exceptionDetails?: object, cause?: unknown}} [options]
   */
  constructor(message, options = {}) {
    super(message)
    this.name = 'CdpError'
    this.code = options.code ?? 'CDP_ERROR'
    this.method = options.method ?? null
    this.data = options.data ?? null
    this.details = options.details ?? null
    this.exceptionDetails = options.exceptionDetails ?? null
    if (options.cause !== undefined) this.cause = options.cause
  }

  /** Serialise only the safe, serialisable fields (never the cause chain). */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      method: this.method,
      message: this.message,
      data: this.data,
      details: this.details,
      exceptionDetails: this.exceptionDetails,
    }
  }
}

/** GET a JSON document from the devtools HTTP endpoint. */
function httpJson(port, path, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', agent: false, timeout: timeoutMs },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode !== 200) {
            reject(
              new CdpError(`devtools http ${path} returned ${res.statusCode}`, {
                code: 'HTTP_STATUS',
                details: { status: res.statusCode, body: body.slice(0, 400) },
              }),
            )
            return
          }
          try {
            resolve(JSON.parse(body))
          } catch (error) {
            reject(new CdpError(`devtools http ${path} returned non-JSON`, { code: 'HTTP_BAD_JSON', cause: error }))
          }
        })
      },
    )
    req.on('timeout', () => {
      req.destroy(new CdpError(`devtools http ${path} timed out after ${timeoutMs}ms`, { code: 'HTTP_TIMEOUT' }))
    })
    req.on('error', (error) => {
      reject(
        new CdpError(`cannot reach devtools endpoint on 127.0.0.1:${port} (${error.code ?? error.message})`, {
          code: 'PORT_CLOSED',
          cause: error,
        }),
      )
    })
    req.end()
  })
}

/** Encode a client-to-server frame (always masked, per RFC 6455). */
function encodeFrame(opcode, payload) {
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = 0x80 | length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  const mask = randomBytes(4)
  const masked = Buffer.allocUnsafe(length)
  for (let i = 0; i < length; i += 1) masked[i] = payload[i] ^ mask[i % 4]
  return Buffer.concat([header, mask, masked])
}

/** Parse the fragment part of a target url, for nicer reporting. */
function hashOf(url) {
  const text = String(url ?? '')
  const index = text.indexOf('#')
  return index === -1 ? '' : text.slice(index)
}

/** Normalise a raw `/json/list` entry into the shape tools consume. */
function normalizeTarget(raw) {
  return {
    id: String(raw?.id ?? ''),
    type: String(raw?.type ?? ''),
    title: String(raw?.title ?? ''),
    url: String(raw?.url ?? ''),
    hash: hashOf(raw?.url),
    webSocketDebuggerUrl: raw?.webSocketDebuggerUrl ?? null,
  }
}

/** True when the url looks like the K-line / main workspace window. */
function isMainWindow(target) {
  const url = String(target?.url ?? '')
  return url.includes(MAIN_WINDOW_URL_HINT) || url.includes('/main')
}

/**
 * One WebSocket connection to a CDP target.
 *
 * Emits decoded text frames; the client below layers JSON-RPC on top.
 */
export class WebSocketConnection {
  #socket
  #buffer = Buffer.alloc(0)
  #fragments = []
  #closed = false

  constructor(socket, leftover) {
    this.#socket = socket
    if (leftover?.length) this.#buffer = Buffer.from(leftover)
    socket.setNoDelay(true)
    socket.on('data', (chunk) => this.#onData(chunk))
    socket.on('close', () => this.#emitClose({ code: 1006, reason: 'socket closed' }))
    socket.on('error', (error) => this.#emitClose({ code: 1006, reason: error?.message ?? 'socket error' }))
    this.onmessage = null
    this.onclose = null
    if (this.#buffer.length) queueMicrotask(() => this.#drain())
  }

  get open() {
    return !this.#closed && !this.#socket.destroyed
  }

  static connect(wsUrl, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      let url
      try {
        url = new URL(wsUrl)
      } catch (error) {
        reject(new CdpError(`invalid webSocketDebuggerUrl: ${wsUrl}`, { code: 'BAD_WS_URL', cause: error }))
        return
      }
      if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
        reject(new CdpError(`not a websocket url (protocol ${url.protocol}): ${wsUrl}`, { code: 'BAD_WS_URL' }))
        return
      }
      const key = randomBytes(16).toString('base64')
      let settled = false
      const socket = new Socket()
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        socket.destroy()
        reject(new CdpError(`WebSocket handshake timed out after ${timeoutMs}ms`, { code: 'WS_HANDSHAKE_TIMEOUT' }))
      }, timeoutMs)

      socket.connect(Number(url.port || 80), url.hostname, () => {
        socket.write(
          `GET ${url.pathname}${url.search || ''} HTTP/1.1\r\n` +
            `Host: ${url.hostname}:${url.port}\r\n` +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Key: ${key}\r\n` +
            'Sec-WebSocket-Version: 13\r\n\r\n',
        )
      })

      let handshake = Buffer.alloc(0)
      const onData = (chunk) => {
        handshake = Buffer.concat([handshake, chunk])
        const end = handshake.indexOf('\r\n\r\n')
        if (end === -1) {
          if (handshake.length > 64 * 1024) {
            settled = true
            clearTimeout(timer)
            socket.destroy()
            reject(new CdpError('WebSocket handshake response exceeded 64KB', { code: 'WS_HANDSHAKE_TOO_LARGE' }))
          }
          return
        }
        settled = true
        clearTimeout(timer)
        socket.removeListener('data', onData)
        const head = handshake.subarray(0, end).toString('latin1')
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0)
        if (status !== 101) {
          socket.destroy()
          reject(
            new CdpError(`WebSocket upgrade rejected with HTTP ${status}`, {
              code: 'WS_HANDSHAKE_REJECTED',
              details: { head: head.slice(0, 300) },
            }),
          )
          return
        }
        resolve(new WebSocketConnection(socket, handshake.subarray(end + 4)))
      }
      socket.on('data', onData)
      socket.on('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new CdpError(`WebSocket connect failed: ${error?.message ?? error}`, { code: 'WS_CONNECT_FAILED', cause: error }))
      })
    })
  }

  sendText(text) {
    if (!this.open) throw new CdpError('WebSocket is not open', { code: 'DISCONNECTED' })
    this.#socket.write(encodeFrame(0x1, Buffer.from(text, 'utf8')))
  }

  close(code = 1000) {
    if (!this.open) return
    try {
      const payload = Buffer.alloc(2)
      payload.writeUInt16BE(code, 0)
      this.#socket.write(encodeFrame(0x8, payload))
    } catch {
      /* the socket is going away anyway */
    }
    this.#closed = true
    this.#socket.end()
  }

  #emitClose(info) {
    if (this.#closed) return
    this.#closed = true
    this.onclose?.(info)
  }

  #onData(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    this.#drain()
  }

  #drain() {
    for (;;) {
      if (this.#buffer.length < 2) return
      const first = this.#buffer[0]
      const second = this.#buffer[1]
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.#buffer.length < 4) return
        length = this.#buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.#buffer.length < 10) return
        const big = this.#buffer.readBigUInt64BE(2)
        if (big > BigInt(MAX_PAYLOAD)) {
          this.#socket.destroy()
          this.#emitClose({ code: 1009, reason: 'frame too large' })
          return
        }
        length = Number(big)
        offset = 10
      }
      const maskOffset = offset
      if (masked) offset += 4
      if (this.#buffer.length < offset + length) return
      let payload = this.#buffer.subarray(offset, offset + length)
      if (masked) {
        const mask = this.#buffer.subarray(maskOffset, maskOffset + 4)
        const unmasked = Buffer.allocUnsafe(length)
        for (let i = 0; i < length; i += 1) unmasked[i] = payload[i] ^ mask[i % 4]
        payload = unmasked
      }
      this.#buffer = this.#buffer.subarray(offset + length)

      if (opcode === 0x0) {
        this.#fragments.push(Buffer.from(payload))
        if (fin) {
          const joined = Buffer.concat(this.#fragments)
          this.#fragments = []
          this.onmessage?.(joined.toString('utf8'))
        }
        continue
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (!fin) {
          this.#fragments = [Buffer.from(payload)]
          continue
        }
        this.onmessage?.(payload.toString('utf8'))
        continue
      }
      if (opcode === 0x8) {
        let code = 1005
        let reason = ''
        if (payload.length >= 2) {
          code = payload.readUInt16BE(0)
          reason = payload.subarray(2).toString('utf8')
        }
        this.#socket.end()
        this.#emitClose({ code, reason })
        return
      }
      if (opcode === 0x9) {
        try {
          this.#socket.write(encodeFrame(0xa, payload))
        } catch {
          /* ignore */
        }
        continue
      }
      // 0xa (pong) needs no handling.
    }
  }
}

/** A CDP connection bound to exactly one page target. */
export class CdpClient {
  #connection
  #pending = new Map()
  #nextId = 1
  #handlers = new Map()
  #closed = false
  #enabled = new Set()

  constructor(connection, target, { port = DEFAULT_PORT } = {}) {
    this.#connection = connection
    this.target = target
    this.port = port
    connection.onmessage = (text) => this.#onMessage(text)
    connection.onclose = (info) => {
      this.#closed = true
      this.#failAll(
        new CdpError(`CDP connection closed (code ${info?.code ?? '?'} ${info?.reason ?? ''})`, { code: 'DISCONNECTED' }),
      )
      this.#emit('disconnect', info)
    }
  }

  /** Whether the underlying socket is still usable. */
  get connected() {
    return !this.#closed && this.#connection.open
  }

  /** Whether close() has been called or the socket dropped. */
  get closed() {
    return !this.connected
  }

  /** Subscribe to 'protocol' | 'console' | 'exception' | 'disconnect'. */
  on(event, handler) {
    const list = this.#handlers.get(event) ?? []
    list.push(handler)
    this.#handlers.set(event, list)
    return () => {
      const next = (this.#handlers.get(event) ?? []).filter((item) => item !== handler)
      this.#handlers.set(event, next)
    }
  }

  #emit(event, payload) {
    for (const handler of this.#handlers.get(event) ?? []) {
      try {
        handler(payload)
      } catch {
        /* a listener must not break the protocol loop */
      }
    }
  }

  #onMessage(text) {
    let message
    try {
      message = JSON.parse(text)
    } catch {
      // A malformed frame must not kill the connection: surface it, resolve the
      // oldest in-flight request (one unparseable answer for the request in
      // flight) and keep serving the stream.
      this.#emit('protocol', text)
      const oldest = this.#pending.entries().next()
      if (!oldest.done) {
        const [id, pending] = oldest.value
        this.#pending.delete(id)
        clearTimeout(pending.timer)
        pending.resolve(undefined)
      }
      return
    }
    if (message.id !== undefined && this.#pending.has(message.id)) {
      const pending = this.#pending.get(message.id)
      this.#pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) {
        pending.reject(
          new CdpError(`${pending.method}: ${message.error.message ?? 'CDP error'}`, {
            code: 'CDP_METHOD_ERROR',
            method: pending.method,
            data: message.error.data ?? null,
            details: { rpcCode: message.error.code ?? null },
          }),
        )
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      const args = Array.isArray(message.params?.args) ? message.params.args : []
      const values = args.map((arg) => arg?.value ?? arg?.description ?? arg?.unserializableValue ?? '')
      this.#emit('console', { type: message.params?.type, args: values, text: values.join(' ') })
      return
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params?.exceptionDetails
      this.#emit('exception', {
        text: details?.exception?.description ?? details?.text ?? '',
        url: details?.url,
        line: details?.lineNumber,
      })
      return
    }
    this.#emit('protocol', text)
  }

  #failAll(error) {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }

  /** Issue one CDP command and resolve with its result payload. */
  send(method, params = {}, { timeoutMs = DEFAULT_TIMEOUT } = {}) {
    if (!this.connected) return Promise.reject(new CdpError('CDP connection is closed', { code: 'DISCONNECTED', method }))
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new CdpError(`${method} timed out after ${timeoutMs}ms`, { code: 'METHOD_TIMEOUT', method }))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer, method })
      try {
        this.#connection.sendText(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(
          error instanceof CdpError
            ? error
            : new CdpError(String(error?.message ?? error), { code: 'WS_WRITE_FAILED', method, cause: error }),
        )
      }
    })
  }

  /**
   * Enable a protocol domain at most once per connection.
   *
   * `required` domains (Runtime) must succeed; optional ones (Page) are
   * best-effort because some Electron builds do not implement every method and
   * screenshot still works without the enable handshake.
   */
  async ensure(domain, { required = true } = {}) {
    if (this.#enabled.has(domain)) return
    this.#enabled.add(domain)
    try {
      await this.send(`${domain}.enable`, {})
    } catch (error) {
      if (required) {
        this.#enabled.delete(domain)
        throw error
      }
    }
  }

  /**
   * Evaluate an expression in the page and return its value.
   *
   * A page-side exception is surfaced as a CdpError whose message starts with
   * the thrown description, so tools can show the real reason instead of
   * "undefined".
   */
  async evaluate(expression, { awaitPromise = true, returnByValue = true, timeoutMs = 20000, userGesture = false } = {}) {
    if (typeof expression !== 'string') {
      throw new CdpError('evaluate() requires a string expression', { code: 'BAD_ARGUMENT', method: 'Runtime.evaluate' })
    }
    await this.ensure('Runtime')
    const result = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise, returnByValue, userGesture, includeCommandLineAPI: true },
      { timeoutMs },
    )
    if (result?.exceptionDetails) {
      const details = result.exceptionDetails
      const text = details.exception?.description ?? details.text ?? 'page threw an exception'
      const description = details.exception?.description ?? text
      throw new CdpError(`page exception: ${description}`, {
        code: 'PAGE_EXCEPTION',
        method: 'Runtime.evaluate',
        details: {
          text: details.text && details.text !== description ? `${details.text}: ${description}` : description,
          description,
          url: details.url ?? null,
          line: details.lineNumber ?? null,
          column: details.columnNumber ?? null,
        },
      })
    }
    return result?.result?.value
  }

  /**
   * Capture a screenshot and return the base64 payload.
   *
   * Measured on 2.16.27: only the main window paints. Background renderers
   * (`#/chat`, `#/notice`, `#/asset-sync`) never answer, so the timeout is
   * reported as SCREENSHOT_TIMEOUT with an actionable hint instead of a
   * generic method timeout.
   */
  async screenshot({ format = 'png', quality, clip, captureBeyondViewport, fromSurface = true, timeoutMs = 30000 } = {}) {
    await this.ensure('Page', { required: false })
    const params = { format, fromSurface }
    if (quality !== undefined && format !== 'png') params.quality = quality
    if (clip) params.clip = clip
    if (captureBeyondViewport) params.captureBeyondViewport = true
    let result
    try {
      result = await this.send('Page.captureScreenshot', params, { timeoutMs })
    } catch (error) {
      if (error?.code === 'TIMEOUT') {
        throw new CdpError(
          `screenshot ${WORD_TIMEOUT} (Page.captureScreenshot did not answer in ${timeoutMs}ms). ` +
            'This AiCoin build only paints the main window: pass target="main" / the #/main target ' +
            'instead of a background renderer.',
          { code: 'SCREENSHOT_TIMEOUT', method: 'Page.captureScreenshot', details: { target: this.target?.hash ?? null } },
        )
      }
      throw error
    }
    if (!result?.data) throw new CdpError('Page.captureScreenshot returned no data', { code: 'SCREENSHOT_EMPTY' })
    return result.data
  }

  /** Current document title, or '' when the page has none. */
  async title() {
    const value = await this.evaluate('document.title')
    return String(value ?? '')
  }

  /** Current document location href. */
  async location() {
    const value = await this.evaluate('location.href')
    return String(value ?? '')
  }

  async close() {
    if (this.#closed) return
    this.#closed = true
    this.#failAll(new CdpError('CDP client closed', { code: 'DISCONNECTED' }))
    try {
      this.#connection.close()
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------------ static

  /**
   * Enumerate targets on the devtools HTTP endpoint.
   *
   * `version` is the raw `/json/version` payload (callers read
   * `version.Browser`, `version['Protocol-Version']`, `webSocketDebuggerUrl`).
   *
   * @returns {Promise<{ok: boolean, port: number, version: object|null, targets: object[],
   *   pages: object[], reason: string|null}>}
   */
  static async discover({ port = DEFAULT_PORT, timeoutMs = 2500 } = {}) {
    try {
      const version = await httpJson(port, '/json/version', timeoutMs)
      const list = await httpJson(port, '/json/list', timeoutMs)
      const targets = Array.isArray(list) ? list.map(normalizeTarget) : []
      const pages = targets.filter((target) => target.type === 'page')
      pages.forEach((page, index) => {
        page.index = index
        page.isMain = isMainWindow(page)
      })
      return {
        ok: true,
        port,
        version,
        browser: version?.Browser ?? null,
        userAgent: version?.['User-Agent'] ?? null,
        webSocketDebuggerUrl: version?.webSocketDebuggerUrl ?? null,
        targets,
        pages,
        reason: null,
      }
    } catch (error) {
      return {
        ok: false,
        port,
        version: null,
        browser: null,
        userAgent: null,
        targets: [],
        pages: [],
        reason: error?.message ?? String(error),
        code: error instanceof CdpError ? error.code : 'DISCOVER_FAILED',
      }
    }
  }

  /** Convenience wrapper that throws instead of returning `ok: false`. */
  static async listTargets(options = {}) {
    const result = await CdpClient.discover(options)
    if (!result.ok) {
      throw new CdpError(`cannot list CDP targets on port ${result.port}: ${result.reason}`, { code: 'PORT_CLOSED' })
    }
    return result
  }

  /**
   * Pick one target from a list (or a discover() result).
   *
   * Selector forms: target id, url/hash/title substring, `{id}`, `{urlIncludes}`,
   * `{titleIncludes}`, `{index}`, or a whole target object returned by discover().
   * `null`, `'page'` and `'main'` all mean "use the default strategy".
   */
  static pickTarget(targetsOrDiscovery, selector = null) {
    const list = Array.isArray(targetsOrDiscovery)
      ? targetsOrDiscovery
      : Array.isArray(targetsOrDiscovery?.targets)
        ? targetsOrDiscovery.targets
        : []
    const pages = list.filter((target) => target.type === 'page')
    if (!pages.length) return null
    const match = (predicate) => pages.find(predicate) ?? null

    if (selector && typeof selector === 'object') {
      if (selector.id) {
        const byId = list.find((target) => target.id === String(selector.id))
        if (byId) return byId
      }
      if (selector.urlIncludes) return match((page) => page.url.includes(selector.urlIncludes))
      if (selector.titleIncludes) return match((page) => page.title.includes(selector.titleIncludes))
      if (Number.isInteger(selector.index)) return pages[selector.index] ?? null
      return null
    }
    if (typeof selector === 'number') return pages[selector] ?? null
    if (typeof selector === 'string') {
      const text = selector.trim()
      if (!text || text === 'page' || text === 'main' || text === 'default') {
        return pages.find((page) => isMainWindow(page)) ?? pages[0]
      }
      if (/^\d+$/.test(text)) return pages[Number(text)] ?? null
      const byId = list.find((target) => target.id === text)
      if (byId) return byId
      const byUrl = match((page) => page.url.includes(text))
      if (byUrl) return byUrl
      const byHash = match((page) => page.hash.includes(text))
      if (byHash) return byHash
      return match((page) => page.title.includes(text))
    }
    // Default: the main K-line window, else the first page.
    return pages.find((page) => isMainWindow(page)) ?? pages[0]
  }

  /**
   * Attach to one page target.
   *
   * @param {{port?: number, target?: string|number|object|null, urlIncludes?: string,
   *   titleIncludes?: string, index?: number, timeoutMs?: number, discoverTimeoutMs?: number}} [options]
   */
  static async attach(options = {}) {
    const port = Number(options.port ?? DEFAULT_PORT)
    const timeoutMs = Number(options.timeoutMs ?? 8000)
    const discovery = await CdpClient.discover({ port, timeoutMs: Number(options.discoverTimeoutMs ?? 2500) })
    if (!discovery.ok) {
      throw new CdpError(`cannot reach the AiCoin debug port ${port}: ${discovery.reason}`, {
        code: 'PORT_CLOSED',
        details: { port, reason: discovery.reason },
      })
    }
    if (!discovery.pages.length) {
      throw new CdpError(`debug port ${port} is open but exposes no page target`, {
        code: 'NO_PAGE_TARGET',
        details: { targets: discovery.targets.map((target) => target.type) },
      })
    }
    let selector = options.target ?? null
    if (!selector) {
      if (options.urlIncludes) selector = { urlIncludes: options.urlIncludes }
      else if (options.titleIncludes) selector = { titleIncludes: options.titleIncludes }
      else if (options.index !== undefined) selector = { index: options.index }
    }
    const picked = CdpClient.pickTarget(discovery, selector)
    if (!picked) {
      // An explicit selector that matches nothing must not silently fall back.
      const hint = typeof selector === 'string' ? selector : JSON.stringify(selector)
      throw new CdpError(
        `no page target matched ${hint}; available: ${discovery.pages.map((page) => `${page.index}:${page.hash || page.url}`).join(', ')}`,
        {
          code: 'TARGET_NOT_FOUND',
          details: { selector: hint, pages: discovery.pages.map((page) => ({ index: page.index, title: page.title, url: page.url })) },
        },
      )
    }
    if (!picked.webSocketDebuggerUrl) {
      throw new CdpError(`target ${picked.id} has no webSocketDebuggerUrl`, { code: 'TARGET_NO_WS' })
    }
    const connection = await WebSocketConnection.connect(picked.webSocketDebuggerUrl, timeoutMs)
    const client = new CdpClient(connection, picked, { port })
    try {
      await client.ensure('Runtime')
    } catch (error) {
      await client.close()
      throw error
    }
    return client
  }
}

/** Standalone target selector, sharing the logic used by attach(). */
export function pickTarget(targetsOrDiscovery, selector = null) {
  return CdpClient.pickTarget(targetsOrDiscovery, selector)
}

export default CdpClient
