/**
 * context.mjs — 工具 handler 拿到的运行上下文（ctx）。
 *
 * 每次 tools/call 都会把同一个 ctx 传给 handler：`handler(args, ctx)`。
 * ctx 负责「懒连接」：服务器启动时不要求 AiCoin 在跑，只有真正需要页面的工具
 * 调用 ctx.attach() / ctx.evaluate() 时才去连 CDP，连不上就抛一条带中文提示的
 * CdpError（提示先运行 aicoin_launch）。
 *
 * 目标（窗口）选择：
 *   - 同一个 ctx 里复用一条 CDP 连接；
 *   - 但**带选择器**再调用 attach（target / urlIncludes / titleIncludes / index）
 *     且当前连接的目标不匹配时，会先 close 再重新 attach —— 避免「切窗口后静默
 *     连的还是旧窗口」这个坑（lifecycle-dev 的 system.mjs 依赖这个语义）；
 *   - 省略选择器 → 复用当前活连接；若没连接则交给 CdpClient 的默认策略
 *     （优先 URL 含 `#/main` 的主窗口）。
 *
 * 公开字段/方法见 research/framework-contract.md。
 */

import { CdpClient, CdpError, DEFAULT_PORT } from './cdp.mjs'

export { CdpError, DEFAULT_PORT }

/** AiCoin 主窗口 URL 特征（K 线窗口，也是唯一真正出帧、可截图的窗口）。 */
export const MAIN_WINDOW_URL_HINT = '#/main'

/** 日志级别权重。 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

/**
 * 创建一个写 stderr 的日志器（stdout 是 MCP 协议通道，绝不能被日志污染）。
 *
 * 用法：`log('info', '已加载 3 个工具')` 与 `log.info('已加载 3 个工具')` 都支持。
 *
 * @param {{level?: string, write?: (line: string) => void, prefix?: string}} [options]
 */
export function createLogger({ level = 'info', write, prefix = 'aicoin-mcp' } = {}) {
  const threshold = LEVELS[String(level).toLowerCase()] ?? LEVELS.info
  const sink =
    typeof write === 'function'
      ? write
      : (line) => {
          try {
            process.stderr.write(`${line}\n`)
          } catch {
            /* stderr 也断了就只能放弃 */
          }
        }

  const fmt = (extra) => {
    if (extra === undefined) return ''
    if (extra instanceof Error) return ` ${extra.message}`
    try {
      return ` ${JSON.stringify(extra)}`
    } catch {
      return ` ${String(extra)}`
    }
  }

  /** @type {any} */
  const log = (lvl, message, extra) => {
    const name = String(lvl ?? 'info').toLowerCase()
    if ((LEVELS[name] ?? LEVELS.info) < threshold) return
    sink(`[${prefix}][${name}] ${message === undefined ? '' : String(message)}${fmt(extra)}`)
  }
  for (const lvl of Object.keys(LEVELS)) {
    log[lvl] = (message, extra) => log(lvl, message, extra)
  }
  log.level = String(level).toLowerCase()
  log.enabled = (lvl) => (LEVELS[String(lvl).toLowerCase()] ?? LEVELS.info) >= threshold
  return log
}

/**
 * 把外部传入的 log 归一化成同时支持 `log(level, msg)` 和 `log.info(msg)` 两种写法。
 * （工具层/测试可能只传一个普通函数，ctx 内部用的是 log.info 之类的方法。）
 */
function normalizeLogger(input) {
  if (typeof input !== 'function') return createLogger()
  if (typeof input.info === 'function' && typeof input.warn === 'function') return input
  /** @type {any} */
  const wrapped = (lvl, message, extra) => input(lvl, message, extra)
  for (const lvl of Object.keys(LEVELS)) {
    wrapped[lvl] = (message, extra) => input(lvl, message, extra)
  }
  wrapped.level = input.level ?? 'custom'
  wrapped.enabled = (lvl) => (typeof input.enabled === 'function' ? input.enabled(lvl) : true)
  return wrapped
}

/** 把 attach 失败包成对模型友好的错误（带「先运行 aicoin_launch」的操作指引）。 */
function attachFailure(port, err) {
  const reason = err?.message ?? String(err ?? '未知原因')
  const hint =
    `无法连接 AiCoin 调试端口 ${port}：${reason}\n` +
    `请先运行 aicoin_launch 启动带调试端口的 AiCoin 客户端` +
    `（或手动用 --remote-debugging-port=${port} 启动 AiCoin），然后重试。`
  return new CdpError(hint, { code: 'ATTACH_FAILED', cause: err })
}

/** 客户端是否还活着（不依赖 CdpClient 一定实现 connected getter）。 */
function isClientAlive(client) {
  if (!client) return false
  if (typeof client.connected === 'boolean') return client.connected
  return !client.closed
}

/**
 * 从 attach 参数里抽出选择器（保留 undefined 语义：没给就是不选）。
 * @param {object} options
 */
function pickSelector(options = {}) {
  /** @type {any} */
  const selector = {}
  if (options.target !== undefined && options.target !== null && options.target !== '') selector.target = options.target
  if (options.urlIncludes !== undefined && options.urlIncludes !== null && options.urlIncludes !== '') {
    selector.urlIncludes = String(options.urlIncludes)
  }
  if (options.titleIncludes !== undefined && options.titleIncludes !== null && options.titleIncludes !== '') {
    selector.titleIncludes = String(options.titleIncludes)
  }
  if (options.index !== undefined && options.index !== null && options.index !== '') {
    const index = Number(options.index)
    if (Number.isInteger(index)) selector.index = index
  }
  return selector
}

/** 选择器是否为空（空 = 复用当前连接 / 走默认策略）。 */
function hasSelector(selector) {
  return (
    selector.target !== undefined ||
    selector.urlIncludes !== undefined ||
    selector.titleIncludes !== undefined ||
    selector.index !== undefined
  )
}

/** 判断一个已附加目标是否满足选择器。 */
function targetMatchesSelector(target, selector) {
  if (!target) return false
  const wanted = selector.target
  if (wanted !== undefined) {
    if (typeof wanted === 'string') {
      if (String(target.id ?? '') === wanted) return true
      if ((target.url ?? '').includes(wanted)) return true
      if ((target.hash ?? '').includes(wanted)) return true
      if ((target.title ?? '').includes(wanted)) return true
      return false
    }
    if (typeof wanted === 'object' && wanted !== null) {
      if (wanted.id !== undefined && wanted.id !== null && String(target.id ?? '') === String(wanted.id)) return true
      if (wanted.urlIncludes && (target.url ?? '').includes(wanted.urlIncludes)) return true
      if (wanted.titleIncludes && (target.title ?? '').includes(wanted.titleIncludes)) return true
      if (wanted.url && target.url === wanted.url) return true
      return false
    }
  }
  if (selector.urlIncludes && !(target.url ?? '').includes(selector.urlIncludes)) return false
  if (selector.titleIncludes && !(target.title ?? '').includes(selector.titleIncludes)) return false
  return true
}

/**
 * 创建工具运行上下文。
 *
 * @param {{config?: object, log?: Function, client?: CdpClient|null}} [options]
 */
export function createContext({ config = {}, log, client = null } = {}) {
  const cfg = { ...config }

  const envPort = process.env.AICOIN_CDP_PORT
  const resolvedPort = Number(cfg.port ?? envPort ?? DEFAULT_PORT)
  cfg.port = Number.isFinite(resolvedPort) && resolvedPort > 0 ? Math.trunc(resolvedPort) : DEFAULT_PORT
  if (cfg.appPath === undefined) cfg.appPath = process.env.AICOIN_APP_PATH ?? null
  // 默认 null = 走 CdpClient 的默认策略（优先 URL 含 #/main 的主窗口）
  if (cfg.target === undefined) cfg.target = process.env.AICOIN_CDP_TARGET ?? null

  const logger = normalizeLogger(log)
  const logFn = /** @type {any} */ (logger)
  const defaultTimeout = Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 8000

  /** 解析本次调用目标端口：显式 options.port 优先，其次 ctx 配置端口。 */
  function resolvePort(options = {}) {
    const value = Number(options.port ?? cfg.port)
    return Number.isInteger(value) && value > 0 ? value : cfg.port
  }

  /** @type {CdpClient|null} */
  let current = client ?? null
  /** index 选择器的解析缓存：{index, id}，避免每次 attach 都重连。 */
  /** @type {{index: number, id: string} | null} */
  let indexCache = null

  /** 用 discover 把「抽象选择器」解析成具体目标对象（index / 字符串子串等）。 */
  async function resolveSelector(selector, port = cfg.port) {
    let info
    try {
      info = await CdpClient.discover({ port, timeoutMs: defaultTimeout })
    } catch {
      return null
    }
    if (!info?.ok || !Array.isArray(info.targets)) return null
    const pages = Array.isArray(info.pages) && info.pages.length > 0 ? info.pages : info.targets.filter((t) => t.type === 'page')
    const pool = pages.length > 0 ? pages : info.targets
    const wanted = selector.target
    if (Number.isInteger(selector.index)) return pool[selector.index] ?? null
    if (typeof wanted === 'object' && wanted !== null) {
      if (wanted.id) return pool.find((t) => String(t.id) === String(wanted.id)) ?? wanted
      return wanted
    }
    if (typeof wanted === 'string') {
      return (
        pool.find((t) => String(t.id) === wanted) ??
        pool.find((t) => (t.url ?? '').includes(wanted)) ??
        pool.find((t) => (t.hash ?? '').includes(wanted)) ??
        pool.find((t) => (t.title ?? '').includes(wanted)) ??
        null
      )
    }
    if (selector.urlIncludes) return pool.find((t) => (t.url ?? '').includes(selector.urlIncludes)) ?? null
    if (selector.titleIncludes) return pool.find((t) => (t.title ?? '').includes(selector.titleIncludes)) ?? null
    return null
  }

  /** 当前连接是否就是选择器要的目标。 */
  function currentMatches(selector) {
    if (!current) return false
    const target = current.target ?? null
    if (!target) return false
    // index 选择器：先看缓存，再决定是否需要重新解析
    if (Number.isInteger(selector.index)) {
      if (!indexCache || indexCache.index !== selector.index) return false
      return String(target.id ?? '') === indexCache.id
    }
    return targetMatchesSelector(target, selector)
  }

  /**
   * 附加到 AiCoin 页面目标。
   *
   * @param {{port?: number, target?: string|number|object, urlIncludes?: string, titleIncludes?: string, index?: number, timeoutMs?: number, [key: string]: any}} [options]
   *   省略选择器时复用当前活连接（没有连接则走默认策略：#/main 主窗口优先）。
   *   给了 `port` / 选择器且与当前连接不一致时，会先关闭旧连接再重新附加
   *   （这就是 aicoin_app_eval {port:9339} 不会串台的原因）。
   * @returns {Promise<CdpClient>}
   */
  async function attach(options = {}) {
    const selector = pickSelector(options)
    const port = resolvePort(options)
    const explicitPort = options.port !== undefined && options.port !== null && options.port !== ''
    const currentPort = current?.port ?? null
    // 只有**显式**指定了不同的端口才算换端口；省略端口时应复用当前连接，
    // 否则 ctx.attach({port:9339}) 之后任何一次 evaluate 都会偷偷跳回配置端口。
    const portChanged = explicitPort && currentPort !== null && Number(currentPort) !== port

    if (current && isClientAlive(current)) {
      if (!portChanged && (!hasSelector(selector) || currentMatches(selector))) return current
      logFn.debug(
        portChanged
          ? `attach 的目标端口从 ${currentPort} 变成 ${port}，重建连接`
          : 'attach 的目标与当前连接不同，切换窗口（先关闭旧连接）',
      )
      await close().catch(() => {})
    } else if (current) {
      await close().catch(() => {})
    }

    let resolved = selector.target
    if (Number.isInteger(selector.index) || selector.urlIncludes || selector.titleIncludes) {
      const picked = await resolveSelector(selector, port)
      if (picked) resolved = picked
      // 解析失败也继续：把原始选择器透传给 CdpClient.attach，让它给出更准确的报错
    }

    /** @type {Record<string, any>} */
    const attachOptions = { port, timeoutMs: defaultTimeout }
    if (resolved !== undefined && resolved !== null) attachOptions.target = resolved
    else if (cfg.target !== null && cfg.target !== undefined) attachOptions.target = cfg.target
    if (selector.urlIncludes) attachOptions.urlIncludes = selector.urlIncludes
    if (selector.titleIncludes) attachOptions.titleIncludes = selector.titleIncludes
    if (Number.isInteger(selector.index)) attachOptions.index = selector.index
    for (const [key, value] of Object.entries(options)) {
      if (!['target', 'urlIncludes', 'titleIncludes', 'index', 'port', 'timeoutMs'].includes(key)) {
        attachOptions[key] = value
      }
    }

    try {
      const created = await CdpClient.attach(attachOptions)
      current = created
      if (Number.isInteger(selector.index) && created.target?.id) {
        indexCache = { index: selector.index, id: String(created.target.id) }
      } else {
        indexCache = null
      }
      created.on?.('disconnect', (info) => {
        logFn.debug(`CDP 连接断开：${info?.code ?? '?'} ${info?.reason ?? ''}`)
        if (current === created) current = null
      })
      const where = created.target?.hash || created.target?.url || created.target?.id || '未知'
      logFn.info(`已附加到 AiCoin 目标：${created.target?.title || where}（端口 ${port}，窗口 ${where}）`)
      return created
    } catch (err) {
      const wrapped = err instanceof CdpError && err.code === 'ATTACH_FAILED' ? err : attachFailure(port, err)
      ctx.lastError = wrapped.message
      throw wrapped
    }
  }

  /**
   * 确保有一个可用连接：已有活连接直接复用（**不会**因为配置端口变化去重连），
   * 没有才新建。evaluate / screenshot 走这里。
   */
  async function ensureAttached(options = {}) {
    if (current && isClientAlive(current)) return current
    return attach(options)
  }

  /** 求值（会自动 attach；页面内异常由 CdpClient 如实抛出 PAGE_EXCEPTION）。 */
  async function evaluate(expression, options = {}) {
    const active = await ensureAttached()
    return active.evaluate(expression, { timeoutMs: Math.max(defaultTimeout, 20000), ...options })
  }

  /**
   * 截图（会自动 attach）。返回值形状跟随 CdpClient.screenshot：
   * **裸 base64 字符串**（src/tools/system.mjs 就是这么用的）。
   */
  async function screenshot(options = {}) {
    const active = await ensureAttached()
    return active.screenshot(options)
  }

  /** 探测端口（不附加）：{ok, port, version, userAgent, targets, pages, reason?}。 */
  async function discover(options = {}) {
    return CdpClient.discover({ port: resolvePort(options), timeoutMs: defaultTimeout, ...options })
  }

  /** 关闭当前 CDP 连接（幂等）。 */
  async function close() {
    const active = current
    current = null
    indexCache = null
    if (active) {
      try {
        await active.close()
      } catch (err) {
        logFn.debug(`关闭 CDP 连接时出错：${err?.message ?? err}`)
      }
    }
  }

  const ctx = {
    config: cfg,
    log: logger,
    /** 当前连接端口；未附加时回退到配置端口（方便工具层展示/探测）。 */
    get port() {
      return current?.port ?? cfg.port
    },
    get appPath() {
      return cfg.appPath ?? null
    },
    get client() {
      return current
    },
    /** 当前附加的目标（{id,type,title,url,hash}），未附加为 null。 */
    get target() {
      return current?.target ?? null
    },
    get isAttached() {
      return isClientAlive(current)
    },
    lastError: null,
    attach,
    ensureAttached,
    evaluate,
    screenshot,
    discover,
    close,
  }

  return ctx
}

export default createContext
