/**
 * test/helpers/mock-mcp-client.mjs — 伪 MCP 客户端：spawn 真实 server.mjs，
 * 通过 stdin/stdout 按行收发 JSON-RPC 2.0，用来做真正的端到端测试。
 */

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withTimeout } from './harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = resolve(HERE, '../..')
export const SERVER_PATH = resolve(PROJECT_ROOT, 'src/server.mjs')

/**
 * @param {{args?: string[], env?: object, cwd?: string, serverPath?: string}} [options]
 */
export async function startMockMcpClient({ args = [], env = {}, cwd = PROJECT_ROOT, serverPath = SERVER_PATH } = {}) {
  const child = spawn(process.execPath, [serverPath, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  /** 所有 stdout 原始行（用来断言「stdout 只有协议帧」）。 */
  const rawLines = []
  /** 所有解析成功的 JSON-RPC 消息。 */
  const messages = []
  /** 无法解析成 JSON 的 stdout 行（应为空）。 */
  const nonJsonLines = []
  let stderr = ''
  let buffer = ''
  let nextId = 1
  let closed = false

  /** @type {Map<number, {resolve: Function, reject: Function, timer: any}>} */
  const pending = new Map()
  /** @type {Array<{predicate: Function, resolve: Function, timer: any}>} */
  const waiters = []

  const exitPromise = new Promise((resolveExit) => {
    child.on('close', (code, signal) => {
      closed = true
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer)
        entry.reject(new Error(`server 进程已退出（code=${code}），请求 ${id} 未响应`))
        pending.delete(id)
      }
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error(`server 进程已退出（code=${code}）`))
      }
      resolveExit({ code, signal })
    })
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    for (;;) {
      const idx = buffer.indexOf('\n')
      if (idx === -1) break
      const line = buffer.slice(0, idx).replace(/\r$/, '')
      buffer = buffer.slice(idx + 1)
      handleLine(line)
    }
  })

  function handleLine(line) {
    if (line.trim().length === 0) return
    rawLines.push(line)
    let message
    try {
      message = JSON.parse(line)
    } catch {
      nonJsonLines.push(line)
      return
    }
    messages.push(message)
    if (message && Object.hasOwn(message, 'id') && message.id !== null && pending.has(message.id)) {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      clearTimeout(entry.timer)
      entry.resolve(message)
      return
    }
    for (const waiter of waiters.slice()) {
      if (waiter.predicate(message)) {
        waiters.splice(waiters.indexOf(waiter), 1)
        clearTimeout(waiter.timer)
        waiter.resolve(message)
      }
    }
  }

  function writeRaw(text) {
    if (closed) throw new Error('server 进程已退出，无法写入')
    child.stdin.write(text)
  }

  function send(message) {
    writeRaw(`${JSON.stringify(message)}\n`)
  }

  /**
   * 发一条请求并等 id 匹配的响应。
   * @param {string} method
   * @param {object} [params]
   * @param {{timeoutMs?: number, id?: number}} [options]
   */
  async function request(method, params, { timeoutMs = 15000, id } = {}) {
    const requestId = id === undefined ? nextId++ : id
    /** @type {any} */
    const payload = { jsonrpc: '2.0', id: requestId, method }
    if (params !== undefined) payload.params = params
    const wait = new Promise((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        rejectResponse(new Error(`等待 ${method} 响应超时（${timeoutMs}ms）`))
      }, timeoutMs)
      timer.unref?.()
      pending.set(requestId, { resolve: resolveResponse, reject: rejectResponse, timer })
    })
    send(payload)
    const response = await wait
    if (response.error) {
      const err = new Error(`JSON-RPC 错误 ${response.error.code}: ${response.error.message}`)
      err.rpcError = response.error
      err.response = response
      throw err
    }
    return response
  }

  function notify(method, params) {
    /** @type {any} */
    const payload = { jsonrpc: '2.0', method }
    if (params !== undefined) payload.params = params
    send(payload)
  }

  /** 等一条满足 predicate 的服务器消息（含通知）。 */
  function waitForMessage(predicate, { timeoutMs = 5000, label = '服务器消息' } = {}) {
    return new Promise((resolveMessage, rejectMessage) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === resolveMessage)
        if (idx !== -1) waiters.splice(idx, 1)
        rejectMessage(new Error(`等待${label}超时（${timeoutMs}ms）`))
      }, timeoutMs)
      timer.unref?.()
      waiters.push({ predicate, resolve: resolveMessage, reject: rejectMessage, timer })
    })
  }

  /** 结束 stdin，等进程退出。 */
  async function close({ timeoutMs = 10000 } = {}) {
    try {
      child.stdin.end()
    } catch {
      /* ignore */
    }
    return withTimeout(exitPromise, timeoutMs, '等待 server 进程退出')
  }

  function kill() {
    try {
      child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }

  /** 轮询等待 stderr 出现某段文本（日志是异步写的）。 */
  async function waitForStderr(needle, { timeoutMs = 5000 } = {}) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (stderr.includes(needle)) return stderr
      if (Date.now() > deadline) throw new Error(`等待 stderr 出现「${needle}」超时；当前 stderr：\n${stderr.slice(0, 3000)}`)
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  // 等 server 打出启动日志，确保工具已加载完再发请求（initialize 不依赖这个，但更稳）
  return {
    child,
    send,
    request,
    notify,
    writeRaw,
    waitForMessage,
    waitForStderr,
    close,
    kill,
    get stderr() {
      return stderr
    },
    get rawLines() {
      return rawLines
    },
    get messages() {
      return messages
    },
    get nonJsonLines() {
      return nonJsonLines
    },
    get exited() {
      return closed
    },
  }
}
