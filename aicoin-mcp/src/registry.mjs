/**
 * registry.mjs — 工具注册表 + 工具定义校验。
 *
 * 一个「工具」就是 MCP 的 tools/list 里的一条记录 + 一个 handler：
 *
 *   {
 *     name: 'aicoin_eval',                  // ^[a-z0-9_]{2,64}$，全局唯一
 *     description: '在页面里执行 JS 表达式', // 必填，给模型看的说明
 *     inputSchema: { type: 'object', properties: {...}, required: [...] }, // 必填
 *     handler: async (args, ctx) => string | object | {content, isError}  // 必填
 *   }
 *
 * handler 的返回值会被规范成 MCP CallToolResult：
 *   - 字符串           → { content: [{ type:'text', text }] }
 *   - 任何其他对象      → { content: [{ type:'text', text: JSON 美化 }] }
 *   - { content: [...] } → 原样透传（可以带 isError / structuredContent）
 *   - undefined / null → { content: [{ type:'text', text: 'ok' }] }
 *   - 抛异常           → { content: [{ type:'text', text: '错误：...' }], isError: true }
 */

/** 工具名合法字符与长度。 */
export const TOOL_NAME_PATTERN = /^[a-z0-9_]{2,64}$/

/**
 * 工具定义 / 调用相关错误。
 */
export class ToolError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, tool?: string, cause?: unknown}} [info]
   */
  constructor(message, info = {}) {
    super(message, info.cause === undefined ? undefined : { cause: info.cause })
    this.name = 'ToolError'
    /** @type {string} INVALID_TOOL | DUPLICATE_TOOL | UNKNOWN_TOOL | INVALID_ARGUMENTS */
    this.code = info.code ?? 'TOOL_ERROR'
    /** @type {string|undefined} */
    this.tool = info.tool
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * 校验并规范化一个工具定义。校验失败抛 ToolError（code=INVALID_TOOL）。
 *
 * @param {object} spec
 * @param {{source?: string}} [options]
 * @returns {{name: string, description: string, inputSchema: object, handler: Function, title?: string, annotations?: object, source?: string}}
 */
export function defineTool(spec, { source } = {}) {
  if (!isPlainObject(spec)) {
    throw new ToolError('工具定义必须是对象', { code: 'INVALID_TOOL' })
  }

  const { name, description, inputSchema, handler } = spec

  if (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name)) {
    throw new ToolError(
      `工具名不合法：${JSON.stringify(name)}（必须匹配 ${TOOL_NAME_PATTERN}，2~64 位小写字母/数字/下划线）`,
      { code: 'INVALID_TOOL', tool: typeof name === 'string' ? name : undefined },
    )
  }
  if (!nonEmptyString(description)) {
    throw new ToolError(`工具 ${name} 缺少 description（必填，给模型看的用途说明）`, { code: 'INVALID_TOOL', tool: name })
  }
  if (!isPlainObject(inputSchema)) {
    throw new ToolError(`工具 ${name} 的 inputSchema 必须是 JSON Schema 对象`, { code: 'INVALID_TOOL', tool: name })
  }
  if (inputSchema.type !== undefined && inputSchema.type !== 'object') {
    throw new ToolError(`工具 ${name} 的 inputSchema.type 必须是 'object'（收到 ${JSON.stringify(inputSchema.type)}）`, {
      code: 'INVALID_TOOL',
      tool: name,
    })
  }
  if (inputSchema.properties !== undefined && !isPlainObject(inputSchema.properties)) {
    throw new ToolError(`工具 ${name} 的 inputSchema.properties 必须是对象`, { code: 'INVALID_TOOL', tool: name })
  }
  if (typeof handler !== 'function') {
    throw new ToolError(`工具 ${name} 缺少 handler 函数`, { code: 'INVALID_TOOL', tool: name })
  }

  /** @type {any} */
  const tool = {
    name,
    description: description.trim(),
    inputSchema: {
      type: 'object',
      ...inputSchema,
      properties: inputSchema.properties ?? {},
    },
    handler,
  }
  if (typeof spec.title === 'string') tool.title = spec.title
  if (isPlainObject(spec.annotations)) tool.annotations = spec.annotations
  if (source) tool.source = source
  else if (typeof spec.source === 'string') tool.source = spec.source

  return Object.freeze(tool)
}

/** 把 handler 的返回值规范成 MCP CallToolResult。 */
export function normalizeToolResult(raw, { tool } = {}) {
  if (raw === undefined || raw === null) {
    return { content: [{ type: 'text', text: 'ok' }] }
  }
  if (typeof raw === 'string') {
    return { content: [{ type: 'text', text: raw }] }
  }
  if (Array.isArray(raw)) {
    return { content: raw }
  }
  if (isPlainObject(raw) && Array.isArray(raw.content)) {
    /** @type {any} */
    const result = { content: raw.content }
    if (raw.isError === true) result.isError = true
    if (raw.structuredContent !== undefined) result.structuredContent = raw.structuredContent
    return result
  }
  let text
  try {
    text = JSON.stringify(raw, null, 2)
  } catch {
    text = String(raw)
  }
  /** @type {any} */
  const result = { content: [{ type: 'text', text: text ?? String(raw) }] }
  // A plain object that reports `ok: false` is a failed tool run even though the
  // transport succeeded. Marking it keeps the MCP client - and the DSH bridge,
  // which maps isError to its own ok flag - from showing a failure as success.
  if (isPlainObject(raw) && raw.ok === false) result.isError = true
  return result
}

/**
 * 工具注册表。持有 name → tool 的映射，负责执行与结果规范化。
 */
export class ToolRegistry {
  /** @param {{log?: Function}} [options] */
  constructor({ log } = {}) {
    /** @type {Map<string, any>} */
    this._tools = new Map()
    this._log = typeof log === 'function' ? log : null
  }

  /** 已注册工具数量。 */
  get size() {
    return this._tools.size
  }

  /** 校验工具定义（不注册）。 */
  validate(spec, options) {
    return defineTool(spec, options)
  }

  /**
   * 注册一个工具（会先校验）。重名抛 ToolError(DUPLICATE_TOOL)。
   * @param {object} spec
   * @param {{source?: string}} [options]
   */
  register(spec, options) {
    const tool = defineTool(spec, options)
    if (this._tools.has(tool.name)) {
      const existing = this._tools.get(tool.name)
      throw new ToolError(
        `工具名重复：${tool.name}（已由 ${existing?.source ?? '未知来源'} 注册，本次来源 ${tool.source ?? '未知'}）`,
        { code: 'DUPLICATE_TOOL', tool: tool.name },
      )
    }
    this._tools.set(tool.name, tool)
    return tool
  }

  /**
   * 批量注册，逐个校验；失败项收集到返回值里，不中断其余工具。
   * @param {object[]} specs
   * @param {{source?: string, log?: Function}} [options]
   * @returns {{registered: any[], failed: Array<{name?: string, tool?: any, reason: string}>}}
   */
  registerAll(specs, { source, log } = {}) {
    if (!Array.isArray(specs)) {
      throw new ToolError(`registerAll 需要数组，收到 ${typeof specs}`, { code: 'INVALID_TOOL' })
    }
    const registered = []
    const failed = []
    const logger = log ?? this._log
    for (const spec of specs) {
      try {
        registered.push(this.register(spec, { source }))
      } catch (err) {
        const entry = {
          name: spec && typeof spec === 'object' ? spec.name : undefined,
          tool: spec,
          reason: err?.message ?? String(err),
        }
        failed.push(entry)
        if (logger) logger('warn', `工具注册失败（${source ?? '未知来源'}）：${entry.reason}`)
      }
    }
    return { registered, failed }
  }

  /** @param {string} name */
  has(name) {
    return this._tools.has(name)
  }

  /** 取一个工具（未注册返回 undefined）。 */
  get(name) {
    return this._tools.get(name)
  }

  /** 全部工具，按 name 升序（输出稳定，方便 tools/list 断言）。 */
  list() {
    return [...this._tools.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** MCP tools/list 的结果体。 */
  toToolList() {
    return {
      tools: this.list().map((tool) => {
        /** @type {any} */
        const item = {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }
        if (tool.title) item.title = tool.title
        if (tool.annotations) item.annotations = tool.annotations
        return item
      }),
    }
  }

  /** 工具名列表。 */
  names() {
    return this.list().map((tool) => tool.name)
  }

  /**
   * 调用一个工具，永远返回 MCP CallToolResult（handler 异常 → isError:true）。
   *
   * @param {string} name
   * @param {object} [args]
   * @param {object} [ctx] 传给 handler 的上下文（见 context.mjs）
   * @returns {Promise<{content: Array<object>, isError?: boolean}>}
   */
  async call(name, args, ctx) {
    const tool = this._tools.get(name)
    if (!tool) {
      throw new ToolError(`未知工具：${name}`, { code: 'UNKNOWN_TOOL', tool: name })
    }
    if (args !== undefined && args !== null && !isPlainObject(args)) {
      throw new ToolError(`工具 ${name} 的参数必须是 JSON 对象`, { code: 'INVALID_ARGUMENTS', tool: name })
    }
    let raw
    try {
      raw = await tool.handler(args ?? {}, ctx)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const code = err?.code ? ` [${err.code}]` : ''
      return {
        content: [{ type: 'text', text: `❌ ${name} 执行失败${code}：${message}` }],
        isError: true,
      }
    }
    return normalizeToolResult(raw, { tool: name })
  }
}

export default ToolRegistry
