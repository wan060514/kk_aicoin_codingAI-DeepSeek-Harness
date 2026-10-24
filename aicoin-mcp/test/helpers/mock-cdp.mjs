/**
 * test/helpers/mock-cdp.mjs — 假 CDP 端点（HTTP /json/* + WebSocket + Runtime.evaluate）。
 *
 * 刻意用**独立实现**的 WS 帧编解码（不复用 src/cdp.mjs 的代码），这样测试才
 * 真正在验证客户端的帧处理，而不是自证。
 *
 * 目标拓扑模仿真实 AiCoin：4 个 page 目标，顺序里 #/main 故意不排第一
 * （真实 /json/list 的顺序并不稳定），用来验证 attach 的默认选窗策略。
 */

import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const OP_CONT = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

const APP_BASE = 'file:///D:/Program%20Files/AiCoin/resources/app.asar/dist/renderer/index.html'

/**
 * 模仿 AiCoin 的 page 目标列表。注意 #/main 排在第三位（真实顺序不稳定）。
 */
export const MOCK_TARGETS = [
  { id: 'MOCKCHAT000000000000000000000001', type: 'page', title: 'AiCoin', url: `${APP_BASE}#/chat` },
  { id: 'MOCKASSET00000000000000000000002', type: 'page', title: 'AiCoin', url: `${APP_BASE}#/asset-sync` },
  {
    id: 'MOCKMAIN000000000000000000000003',
    type: 'page',
    title: '2413.36 ETH/USDT永续 币安USDT永续',
    url: `${APP_BASE}#/main/exchange`,
  },
  { id: 'MOCKNOTICE00000000000000000000004', type: 'page', title: 'AiCoin', url: `${APP_BASE}#/notice` },
  { id: 'MOCKWORKER0000000000000000000005', type: 'worker', title: '', url: '' },
]

/* ------------------------------------------------------------------ *
 * 帧编解码（服务端侧：发不掩码、收客户端掩码帧）
 * ------------------------------------------------------------------ */

function encodeServerFrame(opcode, payload, fin = true) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  let header
  if (body.length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0x00) | opcode, body.length])
  } else if (body.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = (fin ? 0x80 : 0x00) | opcode
    header[1] = 126
    header.writeUInt16BE(body.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = (fin ? 0x80 : 0x00) | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(body.length), 2)
  }
  return Buffer.concat([header, body])
}

class MockConnection {
  constructor(socket, mock, target) {
    this.socket = socket
    this.mock = mock
    this.target = target
    this.buffer = Buffer.alloc(0)
    this.closed = false
    this.fragment = null
    socket.on('data', (chunk) => this.onData(chunk))
    socket.on('error', () => this.dispose())
    socket.on('close', () => this.dispose())
  }

  dispose() {
    this.closed = true
    try {
      this.socket.destroy()
    } catch {
      /* ignore */
    }
  }

  write(opcode, payload, fin = true) {
    if (this.closed) return
    try {
      this.socket.write(encodeServerFrame(opcode, payload, fin))
    } catch {
      this.dispose()
    }
  }

  sendText(text) {
    this.write(OP_TEXT, text)
  }

  sendPing(payload = 'mock-ping') {
    this.mock.stats.pingsSent += 1
    this.write(OP_PING, payload)
  }

  sendClose(code = 1000) {
    const payload = Buffer.alloc(2)
    payload.writeUInt16BE(code, 0)
    this.write(OP_CLOSE, payload)
  }

  onData(chunk) {
    if (this.closed) return
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      if (this.buffer.length < 2) return
      const fin = (this.buffer[0] & 0x80) !== 0
      const opcode = this.buffer[0] & 0x0f
      const masked = (this.buffer[1] & 0x80) !== 0
      let length = this.buffer[1] & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        length = Number(this.buffer.readBigUInt64BE(2))
        offset = 10
      }
      const maskLength = masked ? 4 : 0
      const total = offset + maskLength + length
      if (this.buffer.length < total) return
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null
      const payload = Buffer.from(this.buffer.subarray(offset + maskLength, total))
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3]
      this.buffer = this.buffer.subarray(total)
      this.mock.stats.maxClientFrameBytes = Math.max(this.mock.stats.maxClientFrameBytes, payload.length)
      this.mock.stats.framesReceived += 1
      this.onFrame(fin, opcode, payload)
    }
  }

  onFrame(fin, opcode, payload) {
    if (opcode === OP_PING) {
      this.write(OP_PONG, payload)
      this.mock.stats.pingsReceived += 1
      return
    }
    if (opcode === OP_PONG) {
      this.mock.stats.gotPong = true
      this.mock.stats.pongsReceived += 1
      return
    }
    if (opcode === OP_CLOSE) {
      this.mock.stats.closeFrames += 1
      if (!this.closed) {
        this.write(OP_CLOSE, payload.subarray(0, Math.min(payload.length, 125)))
      }
      setTimeout(() => this.dispose(), 10)
      return
    }
    if (opcode === OP_TEXT || opcode === OP_BINARY) {
      if (!fin) {
        this.fragment = { opcode, parts: [payload] }
        return
      }
      this.handleMessage(payload.toString('utf8'))
      return
    }
    if (opcode === OP_CONT && this.fragment) {
      this.fragment.parts.push(payload)
      if (fin) {
        const fragment = this.fragment
        this.fragment = null
        this.handleMessage(Buffer.concat(fragment.parts).toString('utf8'))
      }
    }
  }

  async handleMessage(text) {
    let message
    try {
      message = JSON.parse(text)
    } catch {
      this.sendText(JSON.stringify({ id: null, error: { code: -32700, message: 'mock: 不是合法 JSON' } }))
      return
    }
    this.mock.stats.messages.push({ id: message.id, method: message.method, params: message.params, targetId: this.target?.id })
    try {
      await this.dispatch(message)
    } catch (err) {
      this.sendText(JSON.stringify({ id: message.id, error: { code: -32603, message: `mock 内部错误：${err?.message ?? err}` } }))
    }
  }

  async dispatch(message) {
    const { id, method, params = {} } = message
    switch (method) {
      case 'Runtime.enable': {
        this.sendText(JSON.stringify({ id, result: {} }))
        // 模拟页面 console：客户端应转成 'console' 事件
        this.sendText(
          JSON.stringify({
            method: 'Runtime.consoleAPICalled',
            params: {
              type: 'log',
              args: [
                { type: 'string', value: 'mock-console-hello' },
                { type: 'number', value: 42 },
                { type: 'object', description: 'Object {a: 1}' },
              ],
            },
          }),
        )
        return
      }
      case 'Page.enable': {
        this.sendText(JSON.stringify({ id, result: {} }))
        return
      }
      case 'Page.captureScreenshot': {
        // 模仿真实 Chromium：后台窗口（#/notice）永不出帧 → 挂起直到客户端超时
        if (this.target?.url?.includes('#/notice')) {
          this.mock.stats.screenshotHangs += 1
          return
        }
        const data = Buffer.from(`PNG-MOCK:${this.target?.id ?? 'none'}`).toString('base64')
        this.sendText(JSON.stringify({ id, result: { data } }))
        return
      }
      case 'Mock.slow': {
        const ms = Number(params.ms ?? 300)
        setTimeout(() => {
          this.sendText(JSON.stringify({ id, result: { slept: ms } }))
        }, ms)
        return
      }
      case 'Mock.drop': {
        // 永不回应，用来测客户端超时
        return
      }
      case 'Mock.crash': {
        this.dispose()
        return
      }
      case 'Runtime.evaluate': {
        return this.handleEvaluate(id, params.expression ?? '', params)
      }
      default: {
        this.sendText(
          JSON.stringify({ id, error: { code: -32601, message: `mock: 未知方法 ${method}`, data: method } }),
        )
      }
    }
  }

  handleEvaluate(id, expression, params) {
    this.mock.stats.evaluated.push({ expression: expression.slice(0, 80), length: expression.length, targetId: this.target?.id })

    const reply = (result) => this.sendText(JSON.stringify({ id, result: { result } }))
    const replyRaw = (result, extra = {}) => this.sendText(JSON.stringify({ id, result: { ...result, ...extra } }))

    if (expression === '1+1') return reply({ type: 'number', value: 2 })
    if (expression === 'document.title') return reply({ type: 'string', value: this.target?.title ?? '' })
    if (expression === 'location.href') return reply({ type: 'string', value: this.target?.url ?? '' })
    if (expression === 'THROW') {
      return replyRaw(
        { type: 'object', subtype: 'error', description: 'Error: mock-boom' },
        {
          exceptionDetails: {
            exceptionId: 1,
            text: 'Uncaught (in promise)',
            lineNumber: 0,
            columnNumber: 0,
            exception: { type: 'object', subtype: 'error', description: 'Error: mock-boom\n    at <anonymous>:1:1' },
          },
        },
      )
    }
    if (expression === 'BIG') {
      return reply({ type: 'string', value: 'x'.repeat(this.mock.bigBytes) })
    }
    if (expression.startsWith('ECHO_LEN:')) {
      return reply({ type: 'number', value: expression.length })
    }
    if (expression === 'FRAGMENT') {
      // 分片响应：一首一续一续，验证客户端重组
      const json = JSON.stringify({ id, result: { result: { type: 'string', value: 'fragmented-ok' } } })
      const third = Math.ceil(json.length / 3)
      this.write(OP_TEXT, json.slice(0, third), false)
      this.write(OP_CONT, json.slice(third, third * 2), false)
      this.write(OP_CONT, json.slice(third * 2), true)
      return undefined
    }
    if (expression === 'SLOW') {
      setTimeout(() => reply({ type: 'string', value: 'slow-ok' }), this.mock.slowMs)
      return undefined
    }
    if (expression === 'MALFORMED') {
      this.sendText('{not json at all')
      return undefined
    }
    return reply({ type: 'undefined' })
  }
}

/* ------------------------------------------------------------------ *
 * 启动 / 关闭
 * ------------------------------------------------------------------ */

/**
 * @param {{port?: number, bigBytes?: number, slowMs?: number}} [options]
 */
export async function startMockCdp({ port = 0, bigBytes = 17 * 1024 * 1024, slowMs = 400 } = {}) {
  /** @type {any} */
  const stats = {
    httpRequests: [],
    connections: 0,
    framesReceived: 0,
    maxClientFrameBytes: 0,
    messages: [],
    evaluated: [],
    pingsSent: 0,
    pingsReceived: 0,
    pongsReceived: 0,
    gotPong: false,
    closeFrames: 0,
    screenshotHangs: 0,
  }

  /** @type {Set<MockConnection>} */
  const connections = new Set()

  const server = createServer((req, res) => {
    stats.httpRequests.push(req.url)
    if (req.url === '/json/version') {
      const body = JSON.stringify({
        Browser: 'Chrome/150.0.7871.129',
        'Protocol-Version': '1.3',
        'User-Agent': 'mock aicoin/2.16.27 Chrome/150.0.7871.129 Electron/43.2.0',
        webSocketDebuggerUrl: `ws://127.0.0.1:${actualPort}/devtools/browser/mock`,
      })
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      res.end(body)
      return
    }
    if (req.url === '/json/list' || req.url === '/json') {
      const body = JSON.stringify(
        MOCK_TARGETS.map((t) => ({
          description: '',
          devtoolsFrontendUrl: `/devtools/inspector.html?ws=127.0.0.1:${actualPort}/devtools/page/${t.id}`,
          id: t.id,
          title: t.title,
          type: t.type,
          url: t.url,
          webSocketDebuggerUrl: `ws://127.0.0.1:${actualPort}/devtools/page/${t.id}`,
        })),
      )
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      res.end(body)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('mock: not found')
  })

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    const path = String(req.url ?? '')
    const targetId = /\/devtools\/(?:page|browser)\/([^/?]+)/.exec(path)?.[1]
    const target = MOCK_TARGETS.find((t) => t.id === targetId) ?? null
    const conn = new MockConnection(socket, mock, target)
    connections.add(conn)
    stats.connections += 1
    // 握手后立刻发一个 ping，验证客户端会自动回 pong
    conn.sendPing()
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(undefined))
  })
  const actualPort = server.address().port

  const mock = {
    port: actualPort,
    targets: MOCK_TARGETS,
    stats,
    bigBytes,
    slowMs,
    get url() {
      return `http://127.0.0.1:${actualPort}`
    },
    /** 主动断掉所有 ws 连接（测 'disconnect'）。 */
    destroyConnections() {
      for (const conn of connections) conn.dispose()
    },
    /** 给某个目标推一条原始文本帧（用于制造坏 JSON 等异常输入）。 */
    pushRaw(text) {
      for (const conn of connections) conn.sendText(text)
    },
    /** 给某个目标推一条 console 事件。 */
    pushConsole(targetId, value = 'pushed-console') {
      for (const conn of connections) {
        if (targetId && conn.target?.id !== targetId) continue
        conn.sendText(
          JSON.stringify({
            method: 'Runtime.consoleAPICalled',
            params: { type: 'info', args: [{ type: 'string', value }] },
          }),
        )
      }
    },
    async close() {
      for (const conn of connections) conn.dispose()
      connections.clear()
      await new Promise((resolve) => server.close(() => resolve(undefined)))
    },
  }

  return mock
}

/** 测「端口没人监听」用的空闲端口：开一个再关掉，保证拿到的是空号。 */
export async function findDeadPort() {
  const server = createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const port = server.address().port
  await new Promise((resolve) => server.close(() => resolve(undefined)))
  return port
}
