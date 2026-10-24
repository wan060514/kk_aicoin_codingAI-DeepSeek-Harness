/**
 * Minimal MCP stdio client.
 *
 * Implements the slice of Model Context Protocol this bridge needs over
 * newline-delimited JSON-RPC 2.0 (the framing the spec defines for stdio):
 * `initialize`, `notifications/initialized`, `tools/list` (with cursor
 * pagination), `tools/call` and the `tools/list_changed` notification.
 *
 * Dependency-free on purpose: a plugin must not break because of a module
 * resolution mismatch inside a user's profile.
 *
 * @module dsh-plugin-aicoin-mcp/mcp-client
 */

/** Protocol revision this client speaks; a server may answer with an older one. */
export const PROTOCOL_VERSION = '2025-06-18'

export class StdioMcpClient {
  #child = null
  #buffer = ''
  #nextId = 1
  #pending = new Map()
  #closed = false
  #serverInfo = null
  #capabilities = null
  #instructions = ''

  constructor(options) {
    this.command = options.command
    this.args = options.args ?? []
    this.cwd = options.cwd
    this.env = options.env
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60000
    this.clientName = options.clientName ?? 'dsh-plugin-aicoin-mcp'
    this.clientVersion = options.clientVersion ?? '0.1.0'
    this.log = options.log ?? (() => {})
    this.onExit = options.onExit
    this.onToolsChanged = options.onToolsChanged
  }

  get serverInfo() {
    return this.#serverInfo
  }

  get capabilities() {
    return this.#capabilities
  }

  get instructions() {
    return this.#instructions
  }

  get pid() {
    return this.#child?.pid ?? null
  }

  get running() {
    return this.#child !== null && !this.#closed
  }

  /** Spawn the server and complete the MCP handshake. */
  async start() {
    if (this.#child) throw new Error('mcp client already started')
    const { spawn } = await import('node:child_process')
    this.#closed = false

    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...(this.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.#child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onData(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) this.log(`[aicoin-mcp stderr] ${text}`)
    })
    child.on('error', (error) => {
      this.log(`[aicoin-mcp] spawn failed: ${error?.message ?? error}`)
      this.#failAll(error)
    })
    child.on('exit', (code, signal) => {
      const wasClosed = this.#closed
      this.#closed = true
      this.#failAll(new Error(`mcp server exited (code=${code}, signal=${signal})`))
      if (!wasClosed) this.onExit?.({ code, signal })
    })

    const init = await this.#request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: this.clientName, version: this.clientVersion },
    })
    this.#serverInfo = init?.serverInfo ?? null
    this.#capabilities = init?.capabilities ?? null
    this.#instructions = init?.instructions ?? ''
    this.#notify('notifications/initialized', {})
    return {
      serverInfo: this.#serverInfo,
      capabilities: this.#capabilities,
      instructions: this.#instructions,
    }
  }

  /** Read the complete tool list, following `nextCursor`. */
  async listTools() {
    const tools = []
    let cursor
    for (let page = 0; page < 20; page += 1) {
      const result = await this.#request('tools/list', cursor ? { cursor } : {})
      for (const tool of result?.tools ?? []) if (tool && typeof tool.name === 'string') tools.push(tool)
      cursor = result?.nextCursor
      if (!cursor) break
    }
    return tools
  }

  /** Call one tool and return the raw `CallToolResult`. */
  async callTool(name, args, { timeoutMs } = {}) {
    return this.#request('tools/call', { name, arguments: args ?? {} }, timeoutMs)
  }

  /** Stop the child process. Idempotent. */
  async stop() {
    if (!this.#child) return
    this.#closed = true
    const child = this.#child
    this.#child = null
    this.#failAll(new Error('mcp client stopped'))
    try {
      child.stdin.end()
    } catch {
      /* already gone */
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        resolve()
      }, 3000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        child.kill()
      } catch {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  // -------------------------------------------------------------- internals

  #onData(chunk) {
    this.#buffer += chunk
    for (;;) {
      const index = this.#buffer.indexOf('\n')
      if (index === -1) return
      const line = this.#buffer.slice(0, index).trim()
      this.#buffer = this.#buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        this.log(`[aicoin-mcp] non-JSON line on stdout: ${line.slice(0, 200)}`)
        continue
      }
      this.#dispatch(message)
    }
  }

  #dispatch(message) {
    if (message.id !== undefined && this.#pending.has(message.id)) {
      const pending = this.#pending.get(message.id)
      this.#pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) {
        const error = new Error(message.error.message ?? 'mcp error')
        error.code = message.error.code
        error.data = message.error.data
        pending.reject(error)
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (message.method === 'notifications/tools/list_changed') this.onToolsChanged?.()
    // Notifications and stray responses are ignored on purpose.
  }

  #write(payload) {
    const child = this.#child
    if (!child || this.#closed) throw new Error('mcp server is not running')
    child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  #notify(method, params) {
    try {
      this.#write({ jsonrpc: '2.0', method, params })
    } catch {
      /* a notification may be lost when the child is going away */
    }
  }

  #request(method, params, timeoutMs) {
    const id = this.#nextId++
    const deadline = timeoutMs ?? this.requestTimeoutMs
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`mcp request ${method} timed out after ${deadline} ms`))
      }, deadline)
      this.#pending.set(id, { resolve, reject, timer })
      try {
        this.#write({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(error)
      }
    })
  }

  #failAll(error) {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }
}
