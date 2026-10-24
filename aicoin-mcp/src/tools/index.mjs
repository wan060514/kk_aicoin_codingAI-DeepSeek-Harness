/**
 * tools/index.mjs — 工具模块动态加载器。
 *
 * 约定：本目录下每个 `*.mjs`（除本文件、以及以 `_` 开头的辅助文件）都是一个工具
 * 模块，导出 `export const tools = [ ...defineTool 形状的对象... ]`。
 * 服务器启动时自动扫描并注册，新增工具只要**往这个目录丢一个文件**，不需要改
 * 这里的代码。
 *
 * 加载容错：单个模块 import 失败 / 单个工具定义不合法，只 warn 到 stderr，不会
 * 让服务器崩掉，也不会影响其他工具。
 *
 * @module tools/index
 */

import { readdir } from 'node:fs/promises'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { defineTool } from '../registry.mjs'

/** 默认工具目录 = 本文件所在目录。 */
export const DEFAULT_TOOLS_DIR = dirname(fileURLToPath(import.meta.url))

/** 本文件名（扫描时要跳过）。 */
const SELF_BASENAME = 'index.mjs'

/**
 * 扫描工具目录，返回待加载的文件绝对路径（已排序，保证加载顺序稳定）。
 *
 * 跳过规则：非 `.mjs`、本 `index.mjs`、以 `_` 开头的辅助模块、点文件、子目录。
 *
 * @param {string} [dir]
 * @returns {Promise<string[]>}
 */
export async function discoverToolFiles(dir = DEFAULT_TOOLS_DIR) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    throw new Error(`无法读取工具目录 ${dir}：${err?.message ?? err}`)
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith('.mjs'))
    .filter((name) => name !== SELF_BASENAME)
    .filter((name) => !name.startsWith('_'))
    .filter((name) => !name.startsWith('.'))
    .sort()
    .map((name) => join(resolve(dir), name))
}

/**
 * 从模块命名空间里取出工具数组。支持三种写法：
 *   export const tools = [...]
 *   export default { tools: [...] }
 *   export default [...]
 */
export function extractToolSpecs(mod) {
  if (!mod) return []
  if (Array.isArray(mod.tools)) return mod.tools
  const def = mod.default
  if (Array.isArray(def)) return def
  if (def && Array.isArray(def.tools)) return def.tools
  return []
}

/**
 * 内置框架工具：tools/list 永远至少有一条可调用记录，方便自检。
 * 只在同名工具尚未注册时添加。
 */
function makeFrameworkInfoTool({ registry, dir, log }) {
  return {
    name: 'framework_info',
    title: '框架自检信息',
    description:
      '返回 aicoin-mcp 框架自身的运行信息（版本、CDP 端口、已加载工具清单、CDP 附加状态）。' +
      '不连接 AiCoin，可用于排查 MCP 是否正常工作。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_args, ctx) => {
      const info = {
        name: 'aicoin-mcp',
        version: '0.5.0',
        node: process.version,
        platform: process.platform,
        toolsDir: dir,
        toolCount: registry.size,
        tools: registry.names(),
        cdp: {
          port: ctx?.port ?? null,
          appPath: ctx?.appPath ?? null,
          attached: ctx?.isAttached === true,
        },
      }
      log?.('debug', 'framework_info 被调用')
      return info
    },
  }
}

/**
 * 扫描目录并注册全部工具。
 *
 * @param {{registry: import('../registry.mjs').ToolRegistry, log?: Function, dir?: string, fresh?: boolean, builtins?: boolean}} options
 *   fresh=true 时给 import URL 加时间戳绕过模块缓存（开发热重载用）
 * @returns {Promise<{
 *   dir: string,
 *   files: string[],
 *   modules: Array<{file: string, tools: number}>,
 *   tools: string[],
 *   failed: Array<{file?: string, name?: string, reason: string}>,
 *   builtin: string[],
 * }>}
 */
export async function loadTools({ registry, log, dir = DEFAULT_TOOLS_DIR, fresh = false, builtins = true } = {}) {
  if (!registry || typeof registry.register !== 'function') {
    throw new Error('loadTools 需要一个 ToolRegistry 实例')
  }
  const logger = typeof log === 'function' ? log : null
  const targetDir = resolve(dir)
  const summary = {
    dir: targetDir,
    /** @type {string[]} */
    files: [],
    /** @type {Array<{file: string, tools: number}>} */
    modules: [],
    /** @type {string[]} */
    tools: [],
    /** @type {Array<{file?: string, name?: string, reason: string}>} */
    failed: [],
    /** @type {string[]} */
    builtin: [],
  }

  let files
  try {
    files = await discoverToolFiles(targetDir)
  } catch (err) {
    summary.failed.push({ reason: err?.message ?? String(err) })
    logger?.('warn', `工具目录不可用：${err?.message ?? err}`)
    // 目录坏了也要继续注册内置工具，保证 tools/list 至少有一条可用记录
    files = []
  }
  summary.files = files

  for (const file of files) {
    const source = basename(file)
    let mod
    try {
      const url = pathToFileURL(file).href + (fresh ? `?v=${Date.now()}` : '')
      mod = await import(url)
    } catch (err) {
      const reason = `模块加载失败：${err?.message ?? err}`
      summary.failed.push({ file: source, reason })
      logger?.('warn', `工具模块 ${source} ${reason}`)
      continue
    }

    const specs = extractToolSpecs(mod)
    if (specs.length === 0) {
      logger?.('debug', `工具模块 ${source} 没有导出 tools（跳过）`)
      continue
    }
    const result = registry.registerAll(specs, { source, log: logger })
    for (const item of result.failed) {
      summary.failed.push({ file: source, name: item.name, reason: item.reason })
    }
    const names = result.registered.map((tool) => tool.name)
    summary.tools.push(...names)
    summary.modules.push({ file: source, tools: names.length })
    logger?.('debug', `工具模块 ${source} 注册了 ${names.length} 个工具：${names.join(', ')}`)
  }

  if (builtins) {
    const builtinSpec = makeFrameworkInfoTool({ registry, dir: targetDir, log: logger })
    try {
      const tool = defineTool(builtinSpec, { source: 'tools/index.mjs' })
      if (!registry.has(tool.name)) {
        registry.register(builtinSpec, { source: 'tools/index.mjs' })
        summary.builtin.push(tool.name)
        summary.tools.push(tool.name)
      }
    } catch (err) {
      logger?.('warn', `内置工具注册失败：${err?.message ?? err}`)
    }
  }

  summary.tools.sort()
  return summary
}

export default loadTools
