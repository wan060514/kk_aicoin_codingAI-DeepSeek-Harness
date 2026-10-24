#!/usr/bin/env node
/**
 * server.mjs — MCP (Model Context Protocol) stdio 服务器。
 *
 * 传输层：stdin/stdout 上按行分隔的 JSON-RPC 2.0（MCP stdio transport）。
 *   - stdout **只允许**出现协议帧（一行一个 JSON），任何日志/调试输出都走 stderr；
 *     为了兜住队友工具里误用的 console.log，本文件在启动时把 console.log/info/debug
 *     重定向到 stderr。
 *   - stdin 每读到一行就独立处理；坏 JSON 回 -32700，未知方法回 -32601。
 *
 * 启动参数（也可用环境变量）：
 *   --port <n>        CDP 端口，默认 9222         env: AICOIN_CDP_PORT
 *   --app-path <p>    AiCoin.exe 路径（给 launch 工具用）  env: AICOIN_APP_PATH
 *   --tools-dir <p>   工具模块目录（默认 src/tools）       env: AICOIN_TOOLS_DIR
 *   --log-level <l>   debug|info|warn|error，默认 info     env: AICOIN_LOG_LEVEL
 *   --help | --version
 *
 * 用法：node src/server.mjs [--port 9222]
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, createLogger } from './context.mjs'
import { ToolRegistry, ToolError } from './registry.mjs'
import { loadTools, DEFAULT_TOOLS_DIR } from './tools/index.mjs'

export const SERVER_NAME = 'aicoin-mcp'
export const SERVER_VERSION = '0.5.0'

/** 服务端支持的 MCP 协议版本，按新到旧排列。 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2025-01-26', '2024-11-05']

// JSON-RPC 2.0 错误码
export const PARSE_ERROR = -32700
export const INVALID_REQUEST = -32600
export const METHOD_NOT_FOUND = -32601
export const INVALID_PARAMS = -32602
export const INTERNAL_ERROR = -32603

/* ------------------------------------------------------------------ *
 * 保护 stdout：只留协议帧
 * ------------------------------------------------------------------ */

function formatConsoleArgs(args) {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg
      if (arg instanceof Error) return arg.stack ?? arg.message
      try {
        return JSON.stringify(arg)
      } catch {
        return String(arg)
      }
    })
    .join(' ')
}

/** 把 console.log/info/debug 重定向到 stderr，防止污染 MCP 协议通道。 */
export function protectStdout() {
  const write = (s) => {
    try {
      process.stderr.write(s)
    } catch {
      /* ignore */
    }
  }
  const redirect = (...args) => write(`${formatConsoleArgs(args)}\n`)
  console.log = redirect
  console.info = redirect
  console.debug = redirect
}

/* ------------------------------------------------------------------ *
 * 参数解析
 * ------------------------------------------------------------------ */

/**
 * 解析命令行参数。
 * @param {string[]} argv
 */
export function parseArgs(argv = []) {
  /** @type {any} */
  const options = {
    port: undefined,
    appPath: undefined,
    toolsDir: undefined,
    logLevel: undefined,
    help: false,
    version: false,
  }
  const takeValue = (i, arg) => {
    const eq = arg.indexOf('=')
    if (eq !== -1) return { value: arg.slice(eq + 1), next: i }
    const value = argv[i + 1]
    if (value === undefined || (typeof value === 'string' && value.startsWith('--'))) return { value: undefined, next: i }
    return { value, next: i + 1 }
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i])
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--version' || arg === '-v') {
      options.version = true
    } else if (arg === '--port' || arg.startsWith('--port=')) {
      const { value, next } = takeValue(i, arg)
      if (value !== undefined) {
        const port = Number(value)
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          throw new ToolError(`--port 不是合法端口：${value}`, { code: 'BAD_ARGS' })
        }
        options.port = port
      }
      i = next
    } else if (arg === '--app-path' || arg.startsWith('--app-path=')) {
      const { value, next } = takeValue(i, arg)
      if (value !== undefined) options.appPath = value
      i = next
    } else if (arg === '--tools-dir' || arg.startsWith('--tools-dir=')) {
      const { value, next } = takeValue(i, arg)
      if (value !== undefined) options.toolsDir = value
      i = next
    } else if (arg === '--log-level' || arg.startsWith('--log-level=')) {
      const { value, next } = takeValue(i, arg)
      if (value !== undefined) options.logLevel = value
      i = next
    } else {
      throw new ToolError(`未知参数：${arg}（用 --help 看用法）`, { code: 'BAD_ARGS' })
    }
  }
  return options
}

/** 合并命令行 / 环境变量 / 默认值。 */
export function resolveConfig(options = {}, env = process.env) {
  const port = Number(options.port ?? env.AICOIN_CDP_PORT ?? 9222)
  return {
    port: Number.isFinite(port) && port > 0 ? Math.trunc(port) : 9222,
    appPath: options.appPath ?? env.AICOIN_APP_PATH ?? null,
    toolsDir: options.toolsDir ?? env.AICOIN_TOOLS_DIR ?? DEFAULT_TOOLS_DIR,
    logLevel: options.logLevel ?? env.AICOIN_LOG_LEVEL ?? 'info',
  }
}

const USAGE = `${SERVER_NAME} ${SERVER_VERSION} — 通过 CDP 驱动 AiCoin 桌面客户端的 MCP 服务器（零依赖）

用法：node src/server.mjs [选项]

选项：
  --port <n>         CDP 调试端口（默认 9222，env AICOIN_CDP_PORT）
  --app-path <p>     AiCoin.exe 路径，供 launch 工具使用（env AICOIN_APP_PATH）
  --tools-dir <p>    工具模块目录（默认 src/tools，env AICOIN_TOOLS_DIR）
  --log-level <l>    debug|info|warn|error（默认 info，env AICOIN_LOG_LEVEL）
  -h, --help         显示帮助（输出到 stderr）
  -v, --version      显示版本（输出到 stderr）

说明：stdout 只用于 MCP JSON-RPC 协议帧，日志全部写 stderr。`

/* ------------------------------------------------------------------ *
 * JSON-RPC / MCP 服务器
 * ------------------------------------------------------------------ */

/**
 * 创建 MCP 服务器实例（不接管进程 IO，方便测试）。
 *
 * @param {{config?: object, log?: Function, registry?: ToolRegistry, stdin?: NodeJS.ReadableStream, stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream}} [options]
 */
export function createServer({
  config = {},
  log,
  registry,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const logger = /** @type {any} */ (
    typeof log === 'function'
      ? log
      : createLogger({
          level: config.logLevel ?? 'info',
          write: (line) => {
            try {
              stderr.write(`${line}\n`)
            } catch {
              /* ignore */
            }
          },
        })
  )

  const ctx = createContext({ config, log: logger })
  const tools = registry ?? new ToolRegistry({ log: logger })

  /** @type {any} */
  const state = {
    initialized: false,
    clientInfo: null,
    protocolVersion: null,
    closing: false,
    pendingWrites: 0,
    finished: false,
    /** @type {(code: number) => void} */
    exit: () => {},
  }

  function writeFrame(frame) {
    const text = `${JSON.stringify(frame)}\n`
    state.pendingWrites += 1
    stdout.write(text, () => {
      state.pendingWrites -= 1
      if (state.closing && state.pendingWrites === 0) finish(0)
    })
  }

  function errorFrame(id, code, message, data) {
    /** @type {any} */
    const error = { code, message }
    if (data !== undefined) error.data = data
    return { jsonrpc: '2.0', id: id === undefined ? null : id, error }
  }

  function writeError(id, code, message, data) {
    writeFrame(errorFrame(id, code, message, data))
  }

  function finish(code) {
    if (state.finished) return
    state.finished = true
    state.exit(code)
  }
  /** 协商协议版本：客户端给的支持就原样回；否则回我们最新的。 */
  function negotiateProtocol(requested) {
    if (typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) return requested
    if (typeof requested === 'string') {
      logger.warn(`客户端请求的 MCP 协议版本 ${requested} 不受支持，回退到 ${SUPPORTED_PROTOCOL_VERSIONS[0]}`)
    }
    return SUPPORTED_PROTOCOL_VERSIONS[0]
  }

  async function handleInitialize(params) {
    const requested = params?.protocolVersion
    const protocolVersion = negotiateProtocol(requested)
    state.protocolVersion = protocolVersion
    state.clientInfo = params?.clientInfo ?? null
    // 不强制要求 initialized 通知，但记录下来便于排查
    state.initialized = true
    logger.info(
      `MCP initialize：client=${state.clientInfo?.name ?? '未知'} ${state.clientInfo?.version ?? ''} ` +
        `protocol=${protocolVersion}（请求 ${requested ?? '未提供'}）`,
    )
    return {
      protocolVersion,
      capabilities: {
        tools: { listChanged: false },
        logging: {},
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      instructions:
        '这个服务器通过 Chrome DevTools Protocol 驱动本机 AiCoin 桌面客户端（Electron）。' +
        '工具名以 aicoin_ 开头；首次使用页面相关工具前，若客户端未启动请先调用 aicoin_launch。',
    }
  }

  async function handleToolsCall(params) {
    if (!params || typeof params !== 'object') {
      throw new RpcError(INVALID_PARAMS, 'tools/call 需要 params 对象')
    }
    const name = params.name
    if (typeof name !== 'string' || name.length === 0) {
      throw new RpcError(INVALID_PARAMS, 'tools/call 需要 params.name（工具名字符串）')
    }
    const args = params.arguments === undefined || params.arguments === null ? {} : params.arguments
    if (typeof args !== 'object' || Array.isArray(args)) {
      throw new RpcError(INVALID_PARAMS, `工具 ${name} 的 arguments 必须是对象`)
    }
    try {
      logger.debug(`tools/call ${name}`, { args })
      return await tools.call(name, args, ctx)
    } catch (err) {
      if (err instanceof ToolError) {
        throw new RpcError(INVALID_PARAMS, err.message, { tool: name, code: err.code })
      }
      throw new RpcError(INTERNAL_ERROR, `工具 ${name} 内部错误：${err?.message ?? err}`)
    }
  }

  async function dispatch(method, params) {
    switch (method) {
      case 'initialize':
        return handleInitialize(params)
      case 'notifications/initialized':
        state.initialized = true
        logger.debug('收到 notifications/initialized')
        return undefined
      case 'notifications/cancelled':
        logger.debug('收到 notifications/cancelled', { requestId: params?.requestId })
        return undefined
      case 'ping':
        return {}
      case 'tools/list':
        return tools.toToolList()
      case 'tools/call':
        return handleToolsCall(params)
      case 'resources/list':
        return { resources: [] }
      case 'prompts/list':
        return { prompts: [] }
      case 'logging/setLevel':
        return {}
      case 'shutdown':
        return {}
      default:
        throw new RpcError(METHOD_NOT_FOUND, `未知方法：${method}`)
    }
  }

  /**
   * 构造单条 JSON-RPC 消息的响应帧。
   * @returns {Promise<object|null>} null 表示这是通知、或解析错误已单独写出（不回包）
   */
  async function buildOne(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return errorFrame(null, INVALID_REQUEST, 'JSON-RPC 消息必须是对象')
    }
    const isNotification = !Object.hasOwn(message, 'id')
    const id = isNotification ? undefined : message.id
    const method = message.method

    if (typeof method !== 'string') {
      if (isNotification) {
        logger.warn('收到没有 method 的通知，已忽略')
        return null
      }
      return errorFrame(id, INVALID_REQUEST, '缺少 method 字段')
    }

    try {
      const result = await dispatch(method, message.params)
      if (isNotification) return null
      return { jsonrpc: '2.0', id: id === undefined ? null : id, result: result === undefined ? {} : result }
    } catch (err) {
      if (isNotification) {
        logger.warn(`通知 ${method} 处理失败：${err?.message ?? err}`)
        return null
      }
      if (err instanceof RpcError) {
        return errorFrame(id, err.code, err.message, err.data)
      }
      logger.error(`处理 ${method} 时内部错误`, err)
      return errorFrame(id, INTERNAL_ERROR, `内部错误：${err?.message ?? err}`)
    }
  }

  /** 处理一行输入（可能是单条消息，也可能是 JSON-RPC 批量数组）。 */
  async function handleLine(line) {
    const text = line.trim()
    if (text.length === 0) return
    let payload
    try {
      payload = JSON.parse(text)
    } catch (err) {
      logger.warn(`JSON 解析失败：${err?.message ?? err}`)
      writeError(null, PARSE_ERROR, `JSON 解析失败：${err?.message ?? err}`)
      return
    }

    if (Array.isArray(payload)) {
      if (payload.length === 0) {
        writeError(null, INVALID_REQUEST, '空的 JSON-RPC 批量请求')
        return
      }
      const frames = (await Promise.all(payload.map((item) => buildOne(item)))).filter(Boolean)
      // JSON-RPC 2.0：批量请求用一个数组帧回应
      if (frames.length > 0) writeFrame(frames)
      return
    }

    const frame = await buildOne(payload)
    if (frame) writeFrame(frame)
  }

  /* ---------------- stdin 行读取 ---------------- */

  let buffer = ''
  let queue = Promise.resolve()

  function onData(chunk) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    for (;;) {
      const idx = buffer.indexOf('\n')
      if (idx === -1) break
      const line = buffer.slice(0, idx).replace(/\r$/, '')
      buffer = buffer.slice(idx + 1)
      // 串行处理，保证同一连接上的响应顺序稳定
      queue = queue.then(() => handleLine(line)).catch((err) => {
        logger.error(`处理输入行时出错：${err?.message ?? err}`, err)
      })
    }
  }

  async function shutdown(code = 0) {
    if (state.closing) return
    state.closing = true
    logger.debug('开始关闭：等待输入队列排空')
    try {
      await queue
    } catch {
      /* ignore */
    }
    if (buffer.trim().length > 0) {
      // stdin 结束时最后一行可能没有换行符
      try {
        await handleLine(buffer)
      } catch {
        /* ignore */
      }
      buffer = ''
    }
    try {
      await ctx.close()
    } catch {
      /* ignore */
    }
    if (state.pendingWrites === 0) finish(code)
    else {
      // 兜底：写回调迟迟不来也不能挂住进程
      const timer = setTimeout(() => finish(code), 1000)
      timer.unref?.()
    }
  }

  function start() {
    stdin.setEncoding?.('utf8')
    stdin.on('data', onData)
    stdin.on('end', () => {
      logger.debug('stdin 已结束')
      void shutdown(0)
    })
    stdin.on('error', (err) => {
      logger.error('stdin 读取错误', err)
      void shutdown(1)
    })
    stdout.on?.('error', (err) => {
      logger.error('stdout 写入错误', err)
      finish(0)
    })
    return api
  }

  const api = {
    state,
    ctx,
    registry: tools,
    logger,
    start,
    handleLine,
    shutdown,
    /** 内部用：让调用方控制退出行为（测试里替换成 noop）。 */
    setExit(fn) {
      state.exit = typeof fn === 'function' ? fn : () => {}
    },
    stop: shutdown,
  }
  return api
}

/** 需要以 JSON-RPC error 形式回给客户端的异常。 */
export class RpcError extends Error {
  constructor(code, message, data) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.data = data
  }
}

/* ------------------------------------------------------------------ *
 * CLI 入口
 * ------------------------------------------------------------------ */

async function main(argv = process.argv.slice(2), env = process.env) {
  protectStdout()
  let options
  try {
    options = parseArgs(argv)
  } catch (err) {
    process.stderr.write(`${err.message}\n`)
    process.exitCode = 2
    return
  }
  if (options.help) {
    process.stderr.write(`${USAGE}\n`)
    return
  }
  if (options.version) {
    process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION}\n`)
    return
  }

  const config = resolveConfig(options, env)
  const logger = createLogger({ level: config.logLevel })
  logger.info(`${SERVER_NAME} ${SERVER_VERSION} 启动：CDP 端口 ${config.port}，工具目录 ${config.toolsDir}`)

  const registry = new ToolRegistry({ log: logger })
  try {
    const loaded = await loadTools({ registry, log: logger, dir: config.toolsDir })
    logger.info(
      `工具加载完成：${loaded.tools.length} 个工具 / ${loaded.modules.length} 个模块` +
        (loaded.failed.length ? `，${loaded.failed.length} 个失败` : ''),
    )
    if (loaded.failed.length) {
      for (const item of loaded.failed) logger.warn(`  跳过：${item.file ?? item.name} → ${item.reason}`)
    }
  } catch (err) {
    logger.error('工具加载阶段异常（服务器继续启动，只是没有工具）', err)
  }

  const server = createServer({ config, log: logger, registry })
  server.setExit((code) => {
    process.exitCode = code
    // 协议通道已排空。先给事件循环一个自然结束的机会（unref 计时器不会拖住进程），
    // 万一还有残留句柄再强制退出。
    const force = setTimeout(() => process.exit(code), 30)
    force.unref?.()
  })
  server.start()

  const onSignal = (signal) => {
    logger.info(`收到 ${signal}，正在关闭`)
    void server.shutdown(0)
  }
  process.on('SIGINT', () => onSignal('SIGINT'))
  process.on('SIGTERM', () => onSignal('SIGTERM'))
  process.on('uncaughtException', (err) => {
    logger.error('未捕获异常（服务器继续运行）', err)
  })
  process.on('unhandledRejection', (err) => {
    logger.error('未处理的 Promise rejection（服务器继续运行）', err)
  })

  return server
}

const isDirectRun = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
  } catch {
    return false
  }
})()

if (isDirectRun) {
  void main()
}

export { main }
export default createServer
