/**
 * kk_aicoin_codingAI - a quant-engineer co-pilot for AiCoin AiScript strategies.
 *
 * What it adds to a DSH session:
 *
 *   1. ten `aicoin_*` tools that carry the whole workflow: the extracted
 *      334-entry function library, the AiScript language reference, a
 *      requirement-objectification engine, an offline static validator, strategy
 *      scaffolds, a structural reviewer and a delivery packer;
 *   2. one skill, `aicoin-strategy-engineer`, holding the methodology (ask,
 *      quantify, generate, self-verify, review, deliver);
 *   3. one short system-prompt section so the hard rules apply even before the
 *      skill is loaded.
 *
 * Hard rule enforced by design: the plugin never emits backtest or performance
 * numbers. The unpacked AiCoin editor has no backtest engine, so any such number
 * would be fabricated. Every tool result carries `metricsAvailable: false`.
 *
 * @module kk_aicoin_codingAI
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadKnowledge } from './data.js'
import { registerTools } from './tools.js'

/** Plugin name, as the loader reports it. */
export const name = 'kk-aicoin-coding-ai'

/** The tool registry is the only hard dependency; skills/prompt degrade. */
export const inject = ['tools']

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, '..')

/** Read the plugin's own package.json for the reported version. */
function readVersion() {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** Schemastery is optional: without it the loader receives plain defaults. */
let z
try {
  z = (await import('@deepseek-ai/schemastery')).default
} catch {
  z = undefined
}

const DEFAULTS = {
  enabled: true,
  workspace: '.',
  strategyDir: 'aicoin-strategies',
  dataDir: '',
  registerSkill: true,
  promptSection: true,
}

/** Deployment configuration; every field has a working default. */
export const Config = z
  ? z.object({
      enabled: z.boolean().default(true).description('Register anything at all.'),
      workspace: z
        .string()
        .default('.')
        .description('Default output root. Relative paths resolve against the HOST process cwd; pass an absolute path when in doubt.'),
      strategyDir: z.string().default('aicoin-strategies').description('Sub-directory that holds one folder per strategy.'),
      dataDir: z.string().default('').description('Override the bundled data directory (advanced).'),
      registerSkill: z.boolean().default(true).description('Register the aicoin-strategy-engineer skill.'),
      promptSection: z.boolean().default(true).description('Register the short hard-rules system-prompt section.'),
    })
  : DEFAULTS

/** Parse the small YAML front matter of a SKILL.md file. */
function parseFrontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { meta: {}, body: text }
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return { meta, body: text.slice(match[0].length) }
}

/** Short prompt section: cheap, and it carries the non-negotiable rules. */
const HARD_RULES = `## AiCoin / AiScript 脚本任务（kk_aicoin_codingAI）

当用户要求编写、修改、调试或解释 AiCoin 自定义指标（AiScript 脚本）时，先加载技能 \`aicoin-strategy-engineer\`，并按其中的六阶段流程执行：需求客观化 → 可行性核对 → 生成代码 → **用 aicoin_validate 自校验直到 error 为 0** → 结构审查 → 交付。

三条不可协商的规则：

1. **不提供回测**：不输出收益率、胜率、夏普、最大回撤、盈亏比等任何绩效数字。拆包的 AiCoin 编辑器没有回测功能，这类数字只能是编造的。
2. **不编造参数**：用户没给的阈值/周期/仓位，用 aicoin_spec_draft 列出问题并**问用户**，不要自己填一个数字当成用户的意思。
3. **不假装验证过**：宣称「校验通过」之前必须真的调用过 aicoin_validate 且 error 为 0。

函数库、语言上限、已知坑都在插件工具里（334 条函数、11 个内置变量、9 条硬约束），不要凭记忆写函数名和参数名。`

/**
 * Register the tools, skill and prompt section.
 *
 * @param {object} ctx - plugin context carrying the tool registry.
 * @param {object} rawConfig - resolved {@link Config}.
 */
export async function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) }
  const log = ctx.logger ?? console
  const disposers = []

  if (!config.enabled) {
    log.info?.('kk_aicoin_codingAI loaded with enabled=false; nothing registered')
    return
  }

  const version = readVersion()

  // ------------------------------------------------------------------ data
  const dataDir = config.dataDir
    ? isAbsolute(config.dataDir)
      ? config.dataDir
      : resolve(process.cwd(), config.dataDir)
    : join(PLUGIN_ROOT, 'data')

  const kb = loadKnowledge(dataDir)
  const workspace = isAbsolute(config.workspace || '.') ? config.workspace : resolve(process.cwd(), config.workspace || '.')
  log.info?.(
    `kk_aicoin_codingAI v${version}: 函数库 ${kb.entries.length} 条（函数 ${kb.functions.length}）· 规则 ${kb.rules.length} 条 · 工作目录 ${workspace}`,
  )

  // ----------------------------------------------------------------- tools
  disposers.push(...registerTools(ctx, config, { kb, log, version }))

  // ----------------------------------------------------------------- skill
  if (config.registerSkill) {
    const skillPath = join(PLUGIN_ROOT, 'skill', 'SKILL.md')
    const skills = ctx.get?.('skills')
    if (!skills?.register) {
      log.warn?.('kk_aicoin_codingAI: ctx.skills 不可用，跳过技能注册（工具仍然可用）')
    } else if (!existsSync(skillPath)) {
      log.warn?.(`kk_aicoin_codingAI: 找不到 ${skillPath}，跳过技能注册`)
    } else {
      const { meta, body } = parseFrontMatter(readFileSync(skillPath, 'utf8'))
      try {
        disposers.push(
          skills.register({
            name: meta.name || 'aicoin-strategy-engineer',
            description: meta.description || 'AiCoin AiScript 策略工程流程',
            whenToUse: meta.whenToUse,
            source: 'runtime',
            content: body.trim(),
            invocation: { modelInvocable: true, userInvocable: true },
            resourceBase: { kind: 'directory', path: join(PLUGIN_ROOT, 'skill') },
          }),
        )
        log.info?.(`kk_aicoin_codingAI: 技能 ${meta.name || 'aicoin-strategy-engineer'} 已注册`)
      } catch (error) {
        log.warn?.(`kk_aicoin_codingAI: 技能注册失败（工具不受影响）：${error?.message ?? error}`)
      }
    }
  }

  // --------------------------------------------------------- prompt section
  if (config.promptSection) {
    const systemPrompt = ctx.get?.('systemPrompt')
    if (!systemPrompt?.section) {
      log.warn?.('kk_aicoin_codingAI: ctx.systemPrompt 不可用，跳过提示段落')
    } else {
      try {
        disposers.push(
          systemPrompt.section({
            name: 'kk-aicoin-coding-ai',
            // Late placement: appended after the harness's own sections without
            // claiming the reserved names.
            order: 900,
            text: HARD_RULES,
          }),
        )
        log.info?.('kk_aicoin_codingAI: 提示段落已注册')
      } catch (error) {
        log.warn?.(`kk_aicoin_codingAI: 提示段落注册失败（工具不受影响）：${error?.message ?? error}`)
      }
    }
  }

  // ------------------------------------------------------------ panel API
  // The AiCoin sidebar panel renders an AiScript card; it talks to this route
  // over same-origin HTTP because one client bundle cannot call another
  // plugin's services. Best effort: no webServer (headless profile) just means
  // that card falls back to its "plugin absent" hint.
  try {
    const { createPanelHandler, API_PREFIX } = await import('./panel-api.js')
    const handler = createPanelHandler({ kb, workspace, strategyDir: config.strategyDir, version, log })
    const attachRoute = (webServer, owner) => {
      try {
        owner.effect(() => webServer.register({ kind: 'prefix', path: API_PREFIX, handler }), 'kk-aicoin: panel http route')
        log.info?.(`kk_aicoin_codingAI: 面板 API 已挂载 ${API_PREFIX}`)
      } catch (error) {
        log.warn?.(`kk_aicoin_codingAI: 面板 API 挂载失败（工具不受影响）：${error?.message ?? error}`)
      }
    }
    const existingWebServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    if (existingWebServer && typeof existingWebServer.register === 'function') {
      attachRoute(existingWebServer, ctx)
    } else if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (webCtx) => attachRoute(webCtx.webServer, webCtx))
    } else {
      log.warn?.('kk_aicoin_codingAI: 没有 webServer 服务，AiScript 面板卡片不可用（工具照常可用）')
    }
  } catch (error) {
    log.warn?.(`kk_aicoin_codingAI: 面板 API 初始化失败（工具不受影响）：${error?.message ?? error}`)
  }

  const disposeAll = () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* already gone */
      }
    }
  }
  if (ctx.on) ctx.on('dispose', disposeAll)

  log.info?.(`kk_aicoin_codingAI v${version} ready`)
  return disposeAll
}
