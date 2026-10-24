/**
 * dsh-plugin-aicoin-mcp — bridge between DeepSeek Harness and a local AiCoin
 * desktop client, plus the Host half of the sidebar control panel.
 *
 * The plugin owns exactly one child process: the `aicoin-mcp` stdio server
 * (`node <serverRoot>/src/server.mjs`). It completes the MCP handshake, reads
 * `tools/list`, and registers every tool into the Harness tool registry so the
 * model can drive AiCoin over Chrome DevTools Protocol without knowing any of
 * this plumbing.
 *
 * Two identities are reported on purpose: MCP tool names already start with
 * `aicoin_`, so the registered names are stable whether you call the server
 * from Harness, Claude Desktop, or `mcp-cli`.
 *
 * The same file also serves a tiny same-origin JSON API under
 * `/plugins/aicoin-mcp` for the browser half (`client.js`): one place for panel
 * state and for the panel's start/stop/probe buttons.
 *
 * Design rule for safety: nothing in here may throw out of `apply()`. A broken
 * panel API or a missing MCP server must degrade to a readable status, never
 * take the Harness down with it.
 *
 * @module dsp-plugin-aicoin-mcp
 */
import { existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StdioMcpClient } from './mcp-client.js'
import { API_PREFIX, apiError, createApiHandler } from './api.js'

/** Plugin name, as the loader reports it. */
export const name = 'aicoin-mcp'

/** The tool registry is the only hard dependency; the panel degrades without webServer. */
export const inject = ['tools']

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, '..')

/** Schemastery is optional: without it the loader receives plain defaults. */
let z
try {
  z = (await import('@deepseek-ai/schemastery')).default
} catch {
  z = undefined
}

const DEFAULTS = {
  enabled: true,
  serverRoot: '',
  port: 9222,
  appPath: '',
  autoStart: true,
  requestTimeoutMs: 120000,
  maxTools: 64,
  allowMutating: true,
  panel: true,
}

/** Tool output envelope expected by the Harness: model text + structured data. */
const OUTPUT = {
  schema: {
    type: 'object',
    properties: { ok: { type: 'boolean' }, message: { type: 'string' }, data: {} },
    required: ['ok', 'message'],
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
}

export const Config = z
  ? z.object({
      enabled: z.boolean().default(true).description('Register anything at all.'),
      serverRoot: z.string().default('').description('Absolute path to the aicoin-mcp package root.'),
      port: z.number().default(9222).description('CDP port the MCP server connects to.'),
      appPath: z.string().default('').description('AiCoin.exe path override; empty uses the server default.'),
      autoStart: z.boolean().default(true).description('Start the MCP server when the plugin loads.'),
      requestTimeoutMs: z.number().default(120000).description('Per tool-call deadline in milliseconds.'),
      maxTools: z.number().default(64).description('Hard cap on registered tools.'),
      allowMutating: z.boolean().default(true).description('Allow tools that mutate the client (launch/stop/save).'),
      panel: z.boolean().default(true).description('Serve the sidebar panel JSON API (/plugins/aicoin-mcp).'),
    })
  : DEFAULTS

/** Turn an MCP `CallToolResult` into the Harness `{ ok, message, data }` shape. */
function fromCallResult(result) {
  const content = Array.isArray(result?.content) ? result.content : []
  const texts = content
    .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
  const message = texts.join('\n\n').trim() || (result?.isError ? 'MCP 工具返回错误，但没有文本内容。' : '（无文本输出）')
  const data = {
    isError: Boolean(result?.isError),
    ...(result?.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
  }
  return { ok: !result?.isError, message, data }
}

/** Resolve the server package root from config or this plugin's neighbourhood. */
function resolveServerRoot(config) {
  const explicit = String(config.serverRoot ?? '').trim()
  if (explicit) {
    const path = isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit)
    return { path, from: 'config' }
  }
  const candidates = [join(PLUGIN_ROOT, '..'), join(PLUGIN_ROOT, '..', '..', 'aicoin-mcp'), join(process.cwd(), 'aicoin-mcp')]
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'src', 'server.mjs'))) return { path: resolve(candidate), from: 'fallback' }
  }
  return { path: resolve(candidates[0]), from: 'missing' }
}

/** GET a JSON document with a hard deadline; resolves null instead of throwing. */
function httpJson(port, path, timeoutMs = 1500) {
  return new Promise((resolvePromise) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolvePromise(value)
    }
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', agent: false, timeout: timeoutMs }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        if (res.statusCode !== 200) {
          finish(null)
          return
        }
        try {
          finish(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          finish(null)
        }
      })
    })
    req.on('timeout', () => {
      req.destroy()
      finish(null)
    })
    req.on('error', () => finish(null))
    req.end()
  })
}

/** Hash fragment of a target url, for display. */
function hashOf(url) {
  const text = String(url ?? '')
  const index = text.indexOf('#')
  return index === -1 ? '' : text.slice(index)
}

/** 拿首个 text 内容并尝试 JSON.parse（供 MCP 工具的 JSON 文本输出使用）。 */
function parseToolJson(result) {
  const content = Array.isArray(result?.content) ? result.content : []
  const text = content.find((item) => item?.type === 'text' && typeof item.text === 'string')?.text
  if (typeof text !== 'string') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Register the AiCoin tools and serve the panel API.
 *
 * @param {object} ctx - plugin context carrying the tool registry.
 * @param {object} rawConfig - resolved {@link Config}.
 */
export async function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) }
  const log = ctx.logger ?? console
  const disposers = []
  const startedAt = new Date().toISOString()

  if (!config.enabled) {
    log.info?.('dsh-plugin-aicoin-mcp loaded with enabled=false; nothing registered')
    return
  }

  const serverRoot = resolveServerRoot(config)
  const serverEntry = join(serverRoot.path, 'src', 'server.mjs')
  const serverArgs = [serverEntry, '--port', String(config.port)]
  if (config.appPath) serverArgs.push('--app-path', String(config.appPath))

  /** @type {StdioMcpClient|null} */
  let client = null
  /** Registered tool names (public Harness names). */
  const registered = []
  /** name → disposer，便于热重载时只撤 MCP 工具（本地诊断工具保留）。 */
  const toolDisposers = new Map()
  /** 由本插件直接定义、不随 MCP 子进程变化的工具名。 */
  const LOCAL_TOOLS = new Set()
  /** Tool metadata for the panel. */
  let advertised = []
  let lastError = null
  /** Most recent `tool.run` outcome, surfaced in the panel. */
  let lastToolResult = null

  /** Live bridge state mirrored into the panel API. */
  const state = {
    phase: 'stopped',
    lastError: null,
    startupError: null,
    serverInfo: null,
    pid: null,
    connectedAt: null,
    aicoin: null,
    lastProbeAt: null,
  }

  /** Names whose execution changes AiCoin state (blocked when allowMutating=false). */
  const MUTATING = new Set()

  const register = (definition) => {
    const dispose = ctx.tools.register(definition)
    disposers.push(dispose)
    toolDisposers.set(definition.name, dispose)
    registered.push(definition.name)
    return definition.name
  }

  /** Record one failure without throwing. */
  const fail = (phase, error) => {
    const message = error instanceof Error ? error.message : String(error)
    state.lastError = message
    if (phase) state.phase = phase
    lastError = message
    log.warn?.(`aicoin-mcp: ${message}`)
    return message
  }

  /** Build the Harness tool definition for one MCP tool. */
  const toDefinition = (tool) => {
    const mutating = /launch|stop|restart|connect|save|apply|del|write|navigate|publish/.test(tool.name)
    if (mutating) MUTATING.add(tool.name)
    return {
      name: tool.name,
      description: String(tool.description ?? tool.title ?? tool.name).slice(0, 4000),
      parameters:
        tool.inputSchema && typeof tool.inputSchema === 'object'
          ? tool.inputSchema
          : { type: 'object', properties: {}, additionalProperties: false },
      output: OUTPUT,
      async execute(args) {
        if (mutating && !config.allowMutating) {
          return {
            ok: false,
            message: `[!] 工具 ${tool.name} 会改动 AiCoin 状态，但配置里 allowMutating=false。`,
            data: { blocked: true },
          }
        }
        try {
          const live = await ensureClient()
          const result = await live.callTool(tool.name, args ?? {}, { timeoutMs: config.requestTimeoutMs })
          return fromCallResult(result)
        } catch (error) {
          return {
            ok: false,
            message: `[!] 调用 ${tool.name} 失败：${error?.message ?? error}`,
            data: { error: String(error?.message ?? error) },
          }
        }
      },
    }
  }

  /** Start the MCP server once and cache it. Throws on failure (callers catch). */
  async function ensureClient() {
    if (client?.running) return client
    if (!existsSync(serverEntry)) {
      throw new Error(`找不到 aicoin-mcp 服务器入口：${serverEntry}（在插件配置里设置 serverRoot）`)
    }
    state.phase = 'starting'
    const next = new StdioMcpClient({
      command: process.execPath,
      args: serverArgs,
      cwd: serverRoot.path,
      // The MCP server is plain Node; ELECTRON_RUN_AS_NODE is required when
      // process.execPath is the Harness' own Electron binary. The server strips
      // it again for the AiCoin child process it may launch.
      env: { ELECTRON_RUN_AS_NODE: '1', AICOIN_CDP_PORT: String(config.port) },
      requestTimeoutMs: config.requestTimeoutMs,
      clientName: 'dsh-plugin-aicoin-mcp',
      clientVersion: '0.2.0',
      log: (line) => log.info?.(line),
      onExit: () => {
        log.warn?.('aicoin-mcp: server process exited; the tools will restart it on next call')
        client = null
        state.phase = 'stopped'
        state.pid = null
      },
    })
    const info = await next.start()
    client = next
    state.phase = 'ready'
    state.serverInfo = info?.serverInfo ?? null
    state.pid = next.pid ?? null
    state.connectedAt = new Date().toISOString()
    state.lastError = null
    lastError = null
    log.info?.(
      `aicoin-mcp: 已连接 ${info?.serverInfo?.name ?? 'aicoin-mcp'} v${info?.serverInfo?.version ?? '?'}（node ${process.version}）`,
    )
    return client
  }

  /** Stop the child process and mark the bridge disconnected. */
  async function stopClient() {
    const current = client
    client = null
    state.phase = 'stopped'
    state.pid = null
    state.serverInfo = null
    if (!current) return
    try {
      await current.stop()
    } catch (error) {
      fail(null, error)
    }
  }

  /** Restart the child process (used after an upgrade or a hung server). */
  async function restartClient() {
    await stopClient()
    try {
      await ensureClient()
    } catch (error) {
      fail('error', error)
      throw error
    }
    // 子进程换了版本/工具集时，就地换掉 Harness 侧的工具注册（否则要重启整个 App）。
    try {
      await resyncTools()
    } catch (error) {
      log.warn?.(`aicoin-mcp: 重启后重同步工具失败：${error?.message ?? error}`)
    }
  }

  /**
   * 按 MCP 子进程当前的 tools/list 重新注册 Harness 工具。
   *
   * 为什么需要：工具注册发生在插件加载时（apply），而 `mcp.restart` 只换子进程。
   * 子进程升级后新增的工具（比如 `aicoin_app_indicator_publish`）以前必须**重启整个
   * DeepSeek Harness** 才能被模型看到。有了这一步，「重连」就能就地换上新工具。
   */
  async function resyncTools() {
    const live = client
    if (!live || state.phase !== 'ready') throw new Error('MCP 子进程还没连上，先 mcp.start')
    const tools = await live.listTools()
    const wanted = tools
      .filter((tool) => tool && typeof tool.name === 'string' && !LOCAL_TOOLS.has(tool.name))
      .slice(0, Math.max(1, config.maxTools))
    const removed = []
    for (const [name, dispose] of [...toolDisposers.entries()]) {
      if (LOCAL_TOOLS.has(name)) continue
      try {
        dispose()
      } catch (error) {
        log.warn?.(`aicoin-mcp: 撤销工具 ${name} 失败（忽略）：${error?.message ?? error}`)
      }
      toolDisposers.delete(name)
      const index = registered.indexOf(name)
      if (index >= 0) registered.splice(index, 1)
      removed.push(name)
    }
    advertised = wanted.map((tool) => ({ name: tool.name, description: String(tool.description ?? '').slice(0, 400) }))
    const added = []
    const failed = []
    for (const tool of wanted) {
      try {
        register(toDefinition(tool))
        added.push(tool.name)
      } catch (error) {
        failed.push(tool.name)
        log.warn?.(`aicoin-mcp: 工具 ${tool.name} 注册失败（跳过）：${error?.message ?? error}`)
      }
    }
    log.info?.(`aicoin-mcp: 工具已重同步（总数 ${registered.length}，新增 ${added.length}，撤销 ${removed.length}）`)
    return {
      ok: true,
      total: registered.length,
      added,
      removed,
      failed,
      serverInfo: state.serverInfo,
    }
  }

  /** Call one MCP tool through the live bridge. */
  async function callMcp(toolName, args) {
    const live = await ensureClient()
    return live.callTool(toolName, args ?? {}, { timeoutMs: config.requestTimeoutMs })
  }

  /**
   * Probe the AiCoin client.
   *
   * Raw CDP probe first so the panel works even while the MCP server is stopped;
   * when the bridge is up, the richer `aicoin_app_status` result is merged in
   * (login heuristic, process verdict, window list).
   */
  async function probeAiCoin() {
    const port = config.port
    const version = await httpJson(port, '/json/version')
    const list = await httpJson(port, '/json/list')
    const pages = Array.isArray(list)
      ? list
          .filter((target) => target && target.type === 'page')
          .map((target, index) => ({
            index,
            hash: hashOf(target.url),
            title: String(target.title ?? ''),
            url: String(target.url ?? ''),
          }))
      : []
    const probe = {
      port,
      reachable: Boolean(version),
      browser: version?.Browser ?? null,
      userAgent: version?.['User-Agent'] ?? null,
      pageCount: pages.length,
      pages,
      mainPage: pages.find((page) => page.hash.includes('#/main')) ?? pages[0] ?? null,
      mcpSource: false,
      error: version ? null : `127.0.0.1:${port} 不可连（AiCoin 未启动或没开调试端口）`,
    }

    // Richer view from the MCP server when it is already up (best effort).
    if (client?.running) {
      try {
        const result = await client.callTool('aicoin_app_status', { port }, { timeoutMs: 20000 })
        const data = parseToolJson(result)
        if (data && typeof data === 'object') {
          probe.mcpSource = true
          probe.reachable = data.cdp?.available === true
          probe.verdict = data.process?.verdict ?? null
          probe.mainPids = data.process?.mainPids ?? []
          probe.debugPorts = data.process?.debugPorts ?? []
          probe.nextAction = data.nextAction ?? null
          probe.launchRecordStale = data.launchRecordStale ?? null
          probe.login = data.login?.loggedIn ?? null
          probe.pageCount = data.pageCount ?? probe.pageCount
          if (data.message) probe.message = data.message
        }
      } catch {
        /* panel keeps the raw probe result */
      }
    }
    state.aicoin = probe
    state.lastProbeAt = new Date().toISOString()
    return probe
  }

  /** Everything the panel renders. Never throws. */
  function buildState() {
    return {
      ok: true,
      generatedAt: Date.now(),
      pid: process.pid,
      phase: state.phase,
      lastError: state.lastError,
      startupError: state.startupError,
      config: {
        enabled: config.enabled,
        port: config.port,
        appPath: config.appPath || null,
        autoStart: config.autoStart,
        allowMutating: config.allowMutating,
        requestTimeoutMs: config.requestTimeoutMs,
        maxTools: config.maxTools,
        serverRoot: serverRoot.path,
        serverRootSource: serverRoot.from,
        serverEntry,
      },
      mcp: {
        running: Boolean(client?.running),
        pid: state.pid,
        serverInfo: state.serverInfo,
        connectedAt: state.connectedAt,
        toolsRegistered: registered.length,
        toolsAdvertised: advertised.length,
      },
      tools: advertised.slice(0, 64).map((item) => ({ ...item, mutating: MUTATING.has(item.name) })),
      lastToolResult,
      aicoin: state.aicoin,
      lastProbeAt: state.lastProbeAt,
      panel: { apiBase: API_PREFIX, refreshMs: 3000 },
    }
  }

  /** Actions the panel may trigger. Unknown ones are rejected by the API. */
  const ACTIONS = new Map([
    ['refresh', async () => {}],
    ['mcp.start', async () => { await ensureClient() }],
    ['mcp.stop', async () => { await stopClient() }],
    ['mcp.restart', async () => { await restartClient() }],
    ['aicoin.probe', async () => { await probeAiCoin() }],
    ['mcp.resync', async () => { await resyncTools() }],
    [
      'aicoin.launch',
      async () => {
        if (!config.allowMutating) throw apiError(403, '配置 allowMutating=false，禁止启动 AiCoin')
        await callMcp('aicoin_app_launch', { port: config.port, waitMs: 45000 })
        await probeAiCoin()
      },
    ],
    [
      // 「没通过 aicoin mcp 打开就连不通」的唯一正解：Electron 的 CDP 只能在进程
      // 启动时开启，已在跑的窗口无法事后附加，所以这里显式做一次「带调试端口重启」。
      'aicoin.connect',
      async () => {
        if (!config.allowMutating) throw apiError(403, '配置 allowMutating=false，禁止启动/重启 AiCoin')
        await callMcp('aicoin_app_connect', { port: config.port, allowRestart: true, waitMs: 45000 })
        await probeAiCoin()
      },
    ],
    [
      'aicoin.restartDebug',
      async () => {
        if (!config.allowMutating) throw apiError(403, '配置 allowMutating=false，禁止重启 AiCoin')
        await callMcp('aicoin_app_restart', { port: config.port, force: true, waitMs: 45000 })
        await probeAiCoin()
      },
    ],
    [
      'aicoin.stop',
      async () => {
        if (!config.allowMutating) throw apiError(403, '配置 allowMutating=false，禁止停止 AiCoin')
        await callMcp('aicoin_app_stop', { port: config.port })
        await probeAiCoin()
      },
    ],
    [
      // 面板的工具台：跑任意一个已注册工具（含 AiCoin 控制、截图、指标读写…），
      // 让「所有 aicoin 功能」都能在这一页里点到，而不只是列个名字。
      'tool.run',
      async (body) => {
        const name = typeof body?.tool === 'string' ? body.tool.trim() : ''
        if (!name) throw apiError(400, 'tool.run 需要参数 tool（工具名）')
        if (!advertised.some((item) => item.name === name)) {
          throw apiError(400, `未知工具 "${name}"`, { tools: advertised.map((item) => item.name) })
        }
        if (MUTATING.has(name) && !config.allowMutating) {
          throw apiError(403, `配置 allowMutating=false，禁止执行会改动状态的工具 "${name}"`)
        }
        const args = body?.args && typeof body.args === 'object' ? body.args : {}
        const startedAt = Date.now()
        const result = await callMcp(name, args)
        const parsed = parseToolJson(result)
        lastToolResult = {
          tool: name,
          args,
          at: new Date().toISOString(),
          tookMs: Date.now() - startedAt,
          ok: !(parsed && parsed.ok === false),
          result: parsed ?? result ?? null,
          raw: parsed ? null : String(result ?? '').slice(0, 4000),
        }
        await probeAiCoin()
      },
    ],
  ])

  // -------------------------------------------------- diagnostic tool (always)
  LOCAL_TOOLS.add('aicoin_mcp_status')
  register({
    name: 'aicoin_mcp_status',
    description:
      'AiCoin MCP 桥自检：插件是否启用、MCP 服务器路径与运行状态、CDP 端口、已注册工具数量、面板 API 地址、最近一次错误。安装/排查时第一条就用它。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: OUTPUT,
    async execute() {
      const lines = [
        'dsh-plugin-aicoin-mcp 状态',
        `- 阶段：${state.phase}${state.phase === 'ready' ? `（已连接 ${state.serverInfo?.name ?? 'aicoin-mcp'} ${state.serverInfo?.version ?? ''}）` : ''}`,
        `- 已注册工具：${registered.length} 个`,
        `- MCP 服务器：${serverEntry}`,
        `- serverRoot 来源：${serverRoot.from}`,
        `- CDP 端口：${config.port}`,
        `- 子进程：${client?.running ? `running (pid ${client.pid})` : 'not started'}`,
        `- 允许改动类工具：${config.allowMutating ? '是' : '否'}`,
        `- 面板 API：${API_PREFIX}/state`,
        `- 启动时间：${startedAt}`,
        ...(state.lastError ? [`- 最近错误：${state.lastError}`] : []),
      ]
      return {
        ok: true,
        message: lines.join('\n'),
        data: {
          registered,
          serverEntry,
          serverRoot: serverRoot.path,
          port: config.port,
          phase: state.phase,
          running: Boolean(client?.running),
          pid: client?.pid ?? null,
          apiBase: API_PREFIX,
          lastError: state.lastError,
        },
      }
    },
  })

  // ---------------------------------------------------------------- MCP tools
  if (config.autoStart) {
    try {
      const live = await ensureClient()
      const tools = await live.listTools()
      advertised = tools
        .filter((tool) => tool && typeof tool.name === 'string' && tool.name !== 'aicoin_mcp_status')
        .slice(0, Math.max(1, config.maxTools))
        .map((tool) => ({ name: tool.name, description: String(tool.description ?? '').slice(0, 400) }))
      for (const tool of tools.filter((item) => item && typeof item.name === 'string' && item.name !== 'aicoin_mcp_status').slice(0, Math.max(1, config.maxTools))) {
        try {
          register(toDefinition(tool))
        } catch (error) {
          log.warn?.(`aicoin-mcp: 工具 ${tool.name} 注册失败（跳过）：${error?.message ?? error}`)
        }
      }
      log.info?.(`aicoin-mcp: ${registered.length - 1} 个 MCP 工具已注册`)
    } catch (error) {
      state.startupError = fail('error', error)
      log.warn?.(`aicoin-mcp: MCP 服务器启动失败（工具暂不可用，首次调用会重试）：${state.startupError}`)
    }
  }

  // ---------------------------------------------------- panel API (best effort)
  if (config.panel) {
    const handler = createApiHandler({
      state: async () => buildState(),
      tools: async () => ({ ok: true, total: registered.length, items: advertised }),
      action: async (body) => {
        const action = typeof body?.action === 'string' ? body.action : ''
        const run = ACTIONS.get(action)
        if (!run) throw apiError(400, `unknown action "${action}"`, { state: buildState() })
        try {
          await run(body)
        } catch (error) {
          // A failed action still returns live state so the panel shows why.
          fail(state.phase === 'starting' ? 'error' : null, error)
          return { ...buildState(), ok: false, action, error: state.lastError }
        }
        return { ...buildState(), ok: true, action }
      },
    })

    const attachRoute = (webServer, owner) => {
      try {
        owner.effect(
          () => webServer.register({ kind: 'prefix', path: API_PREFIX, handler }),
          'aicoin-mcp: panel http route',
        )
        log.info?.(`aicoin-mcp: 面板 API 已挂载 ${API_PREFIX}`)
      } catch (error) {
        log.warn?.(`aicoin-mcp: 面板 API 挂载失败（面板不可用，工具不受影响）：${error?.message ?? error}`)
      }
    }

    try {
      const existingWebServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
      if (existingWebServer && typeof existingWebServer.register === 'function') {
        attachRoute(existingWebServer, ctx)
      } else if (typeof ctx.inject === 'function') {
        ctx.inject(['webServer'], (webCtx) => attachRoute(webCtx.webServer, webCtx))
      } else {
        log.warn?.('aicoin-mcp: 没有 webServer 服务，面板 API 不可用（无头 profile 下工具照常可用）')
      }
    } catch (error) {
      log.warn?.(`aicoin-mcp: 面板 API 初始化失败（工具不受影响）：${error?.message ?? error}`)
    }
  }

  // Prime the AiCoin probe once so the panel opens with data instead of a spinner.
  probeAiCoin().catch(() => {
    /* probe failure is already represented as reachable:false */
  })

  const disposeAll = () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* already gone */
      }
    }
    try {
      client?.stop()
    } catch {
      /* ignore */
    }
    client = null
  }
  if (ctx.on) ctx.on('dispose', disposeAll)

  log.info?.(`dsh-plugin-aicoin-mcp ready (phase=${state.phase}, tools=${registered.length}, port=${config.port})`)
  return disposeAll
}
