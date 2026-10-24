/**
 * Tool registrations for kk_aicoin_codingAI.
 *
 * Ten tools cover the whole workflow the plugin promises:
 *   library_search / library_get / language_reference  - know the platform
 *   spec_draft / spec_status                           - objectify the request
 *   scaffold                                           - start from a valid file
 *   validate                                           - the debug loop
 *   optimize_advice                                    - review, no metrics
 *   deliver                                            - assemble the package
 *   status                                             - self-diagnosis
 *
 * Every result is a plain object `{ ok, message, data }`; `message` is the text
 * the model reads, `data` is the structured payload. Nothing here ever emits a
 * performance number.
 *
 * @module kk_aicoin_codingAI/tools
 */
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, isAbsolute, resolve, dirname } from 'node:path'
import { parse } from './aiscript/parser.js'
import { validateScript, formatDiagnostic, renderReport } from './aiscript/validate.js'
import { analyzeRequirement, renderSpecMarkdown, renderOpenQuestions, slugify, SPEC_FIELDS, VAGUE_PATTERNS, RISK_PRESETS, POSITION_MODES } from './spec.js'
import { TEMPLATES, findTemplate, resolveValues } from './templates.js'
import { buildAdvice, renderAdviceMarkdown, NO_METRICS_NOTICE } from './advice.js'
import { probeDebugPort, fetchLiveLibrary, diffLibrary, DEFAULT_PORT } from './live.js'
import { refreshLibrary } from './library-refresh.js'

/**
 * File name of the delivered script.
 *
 * Plain `.txt` on purpose: a text file cannot be mistaken for an installed
 * artifact or auto-loaded by an editor. The content is ordinary AiScript v2.
 */
const SCRIPT_FILE = 'strategy.txt'

/** Tool output envelope: model-facing text plus structured data. */
const OUTPUT = {
  schema: {
    type: 'object',
    properties: { ok: { type: 'boolean' }, message: { type: 'string' }, data: {} },
    required: ['ok', 'message'],
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
}

const ok = (message, data) => (data === undefined ? { ok: true, message } : { ok: true, message, data })
const bad = (message, data) => (data === undefined ? { ok: false, message: `[!] ${message}` } : { ok: false, message: `[!] ${message}`, data })

/** One-line summary: first sentence, trimmed. */
function firstSentence(text, max = 110) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  const cut = clean.split(/(?<=[。！？.!?])\s*/)[0] ?? clean
  return cut.length > max ? `${cut.slice(0, max - 1)}…` : cut
}

/** Compact signature rendering for a parameter list. */
function paramLine(entry) {
  if (!entry?.params?.length) return '（无参数表）'
  return entry.params
    .map((p) => `${p.name}${p.required ? '*' : ''}${p.default !== null && p.default !== '(必要参数)' && p.default !== '(非必要参数)' ? `=${p.default}` : ''}`)
    .join(', ')
}

/** Simple relevance scoring for library search. */
function scoreEntry(entry, query) {
  const q = query.toLowerCase()
  const name = entry.callName.toLowerCase()
  const alt = String(entry.name).toLowerCase()
  let score = 0
  if (name === q || alt === q) score += 100
  if (name.startsWith(q) || alt.startsWith(q)) score += 40
  if (name.includes(q) || alt.includes(q)) score += 25
  if (String(entry.signature).toLowerCase().includes(q)) score += 12
  if (String(entry.summary).toLowerCase().includes(q)) score += 8
  if (String(entry.category).toLowerCase().includes(q)) score += 6
  if (entry.params.some((p) => p.name.toLowerCase().includes(q))) score += 4
  if (entry.doc.toLowerCase().includes(q)) score += 2
  return score
}

/** Flags worth surfacing next to a library hit. */
function flagText(entry) {
  const flags = []
  if (entry.flags.singleDeclaration) flags.push('全局唯一')
  if (entry.flags.requiresUniqueId) flags.push('需要唯一id')
  if (entry.flags.rootScopeOnly) flags.push('根作用域')
  if (entry.flags.conditionFirstParam) flags.push('首参必须布尔')
  if (entry.arityUnknown) flags.push('参数表不全')
  return flags.length ? ` 〔${flags.join(' / ')}〕` : ''
}

/** Scan a script for performance claims that cannot be substantiated. */
export function scanForPerformanceClaims(source) {
  const patterns = [
    /(胜率|成功率|准确率)\s*[:：=]?\s*\d+(\.\d+)?\s*%/g,
    /(收益率|年化|回报)\s*[:：=]?\s*\d+(\.\d+)?\s*%/g,
    /(夏普|sharpe)\s*[:：=]?\s*\d+(\.\d+)?/gi,
    /(最大回撤|回撤)\s*[:：=]?\s*\d+(\.\d+)?\s*%/g,
    /(盈亏比|利润因子)\s*[:：=]?\s*\d+(\.\d+)?/g,
    /(净利润|总收益)\s*[:：=]?\s*[+-]?\d+(\.\d+)?/g,
    /回测\s*(结果|数据|报告)/g,
  ]
  const hits = []
  const lines = String(source ?? '').split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    if (!/^\s*(\/\/|\/\*|\*)/.test(line)) continue
    for (const pattern of patterns) {
      pattern.lastIndex = 0
      const match = pattern.exec(line)
      if (match) hits.push({ line: index + 1, text: line.trim().slice(0, 140), matched: match[0] })
    }
  }
  return hits
}

/**
 * Register every tool.
 *
 * @param {object} ctx - plugin context with `ctx.tools`.
 * @param {object} config - resolved plugin config.
 * @param {{ kb: object, log: object, version: string }} deps
 * @returns {Array<() => void>} disposers
 */
export function registerTools(ctx, config, deps) {
  const { kb, log, version } = deps
  const disposers = []
  const register = (definition) => {
    disposers.push(ctx.tools.register(definition))
    return definition.name
  }

  const resolveWorkspace = (value) => {
    const base = value || config.workspace || '.'
    const root = isAbsolute(base) ? base : resolve(process.cwd(), base)
    return { root, dir: join(root, config.strategyDir || 'aicoin-strategies') }
  }

  const strategyDir = (workspace, name) => join(resolveWorkspace(workspace).dir, slugify(name))

  const readSpecFile = async (workspace, name) => {
    const path = join(strategyDir(workspace, name), 'spec.json')
    if (!existsSync(path)) return null
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch {
      return null
    }
  }

  const writeStrategyFile = async (workspace, name, filename, content) => {
    const dir = strategyDir(workspace, name)
    await mkdir(dir, { recursive: true })
    const path = join(dir, filename)
    await writeFile(path, content, 'utf8')
    return path
  }

  const loadSource = async (args) => {
    if (args.source && String(args.source).trim()) return { source: String(args.source), origin: 'inline' }
    if (args.path) {
      const path = isAbsolute(args.path) ? args.path : resolve(process.cwd(), args.path)
      if (!existsSync(path)) return { error: `找不到文件：${path}` }
      return { source: await readFile(path, 'utf8'), origin: path }
    }
    return { error: '需要提供 path（脚本文件）或 source（脚本文本）其中之一' }
  }

  // ------------------------------------------------------------ 1. status
  register({
    name: 'aicoin_status',
    description:
      'kk_aicoin_codingAI 自检：数据是否加载、函数库/规则数量、默认工作目录、可用模板。安装后第一条命令就用它确认插件在位。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: OUTPUT,
    async execute() {
      const ws = resolveWorkspace()
      const lines = [
        `kk_aicoin_codingAI v${version} 状态`,
        `- 函数库：${kb.functions.length} 个函数 · ${kb.variables.length} 个行情变量 · ${kb.operatorEntries.length} 个运算符条目（共 ${kb.entries.length}）`,
        `- 规则库：${kb.rules.length} 条静态校验规则`,
        `- 内置变量：${kb.builtinVars.size} 个 · 命名空间：${[...kb.namespaces].join(', ')}`,
        `- 语言：${kb.language.languageId} ${kb.language.versionDirective ?? ''}`,
        `- 默认工作目录：${ws.root}`,
        `- 策略输出目录：${ws.dir}`,
        `- 模板：${TEMPLATES.map((t) => t.id).join(', ')}`,
        `- 回测能力：无。本插件不提供任何绩效数据。`,
      ]
      return ok(lines.join('\n'), {
        version,
        functions: kb.functions.length,
        variables: kb.variables.length,
        operators: kb.operatorEntries.length,
        rules: kb.rules.length,
        workspace: ws.root,
        strategyDir: ws.dir,
        templates: TEMPLATES.map((t) => t.id),
        metricsAvailable: false,
      })
    },
  })

  // -------------------------------------------------- 2. library_search
  register({
    name: 'aicoin_library_search',
    description:
      '在 AiCoin 内置 AiScript 函数库（334 条，来自客户端 functionLib 接口）里检索函数。写脚本前先用它确认函数真实存在与准确签名，避免凭记忆写出不存在的函数。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词：函数名、中文名或用途，例如 ma / 均线 / 突破 / 成交量' },
        category: { type: 'string', description: '限定分类，例如「指标函数」「画图函数」「交易函数」' },
        limit: { type: 'number', description: '返回条数，默认 15，最大 60' },
        withExample: { type: 'boolean', description: 'true 时附带该函数的第一段官方示例代码' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args) {
      const query = String(args.query ?? '').trim()
      if (!query) return bad('query 不能为空')
      const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 60)
      let pool = kb.entries
      if (args.category) pool = pool.filter((e) => String(e.category).includes(String(args.category)))
      const scored = pool
        .map((entry) => ({ entry, score: scoreEntry(entry, query) }))
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score || a.entry.callName.localeCompare(b.entry.callName))
        .slice(0, limit)

      if (!scored.length) {
        return bad(`函数库里没有匹配 “${query}” 的条目。试试英文函数名（ma / rsi / highest）或中文用途（均线 / 波动）。`, { query })
      }
      const lines = [`函数库检索 “${query}” → ${scored.length} 条`]
      for (const { entry } of scored) {
        lines.push(`\n■ ${entry.callName}${flagText(entry)}  「${entry.category}」`)
        lines.push(`  签名：${entry.signature}`)
        lines.push(`  参数：${paramLine(entry)}`)
        lines.push(`  说明：${firstSentence(entry.summary)}`)
        if (args.withExample && entry.examples.length) {
          lines.push('  示例：')
          for (const line of String(entry.examples[0]).split('\n').slice(0, 6)) lines.push(`    ${line}`)
        }
      }
      lines.push('\n提示：用 aicoin_library_get 取某个函数的完整参数、返回值与全部示例。')
      return ok(lines.join('\n'), { query, results: scored.map(({ entry }) => ({ name: entry.callName, category: entry.category, signature: entry.signature })) })
    },
  })

  // ------------------------------------------------------ 3. library_get
  register({
    name: 'aicoin_library_get',
    description:
      '取某个 AiScript 函数的完整条目：参数表（含是否必要、默认值）、返回值、全部官方示例、已知限制。写代码前用它锁定准确参数名（注意 camelCase，例如 lineWidth）。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '函数名，例如 ma / line.new / enterLongAmount' },
        includeDoc: { type: 'boolean', description: 'true 时附带客户端原始 Markdown 文档（较长）' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args) {
      const name = String(args.name ?? '').trim()
      const entry = kb.byCall.get(name) ?? kb.byName.get(name)
      if (!entry) {
        const guess = [...kb.byCall.keys()].filter((k) => k.includes(name.toLowerCase())).slice(0, 8)
        return bad(`函数库里没有 “${name}”。${guess.length ? `相近条目：${guess.join(', ')}` : '请用 aicoin_library_search 检索。'}`, { name })
      }
      const lines = [`■ ${entry.callName}  「${entry.category}」`]
      lines.push(`签名：${entry.signature}`)
      if (entry.flags.singleDeclaration) lines.push('限制：★ 每种指令在脚本中最多声明一次，重复声明会产生编译错误')
      if (entry.flags.rootScopeOnly) lines.push('限制：★ 必须在根作用域调用，不能放在 if / for / 自定义函数内部')
      if (entry.flags.requiresUniqueId) lines.push('限制：★ 必须提供唯一的 id 参数，可在脚本内多次使用')
      if (entry.flags.conditionFirstParam) lines.push('限制：★ 第一个参数必须是布尔条件')
      lines.push(`说明：${entry.summary}`)
      if (entry.returns) lines.push(`返回：${entry.returns}`)
      lines.push('\n参数表：')
      if (!entry.params.length) lines.push('  （客户端未提供参数表，请参考示例）')
      for (const p of entry.params) {
        const req = p.required ? '必要' : p.default === '(非必要参数)' ? '可选' : p.default !== null ? `可选，默认 ${p.default}` : '文档未标注'
        lines.push(`  - ${p.name}（${p.type || '未标注'}，${req}）${p.desc ? `：${p.desc}` : ''}`)
      }
      if (entry.arityUnknown) {
        lines.push('  ⚠ 该条目的参数表不完整（客户端只提供了部分列），参数个数仅供参考。')
      }
      if (entry.notes.length) {
        lines.push('\n注意事项：')
        for (const note of entry.notes) lines.push(`  - ${note}`)
      }
      if (entry.examples.length) {
        lines.push('\n官方示例：')
        for (const [index, example] of entry.examples.entries()) {
          lines.push(`--- 示例 ${index + 1} ---`)
          lines.push(String(example))
        }
      }
      if (args.includeDoc && entry.doc) {
        lines.push('\n--- 客户端原始文档 ---')
        lines.push(String(entry.doc).slice(0, 12000))
      }
      return ok(lines.join('\n'), { name: entry.callName, signature: entry.signature, params: entry.params, arityUnknown: entry.arityUnknown })
    },
  })

  // ------------------------------------------------ 4. language_reference
  register({
    name: 'aicoin_language_reference',
    description:
      'AiScript v2 语言速查：关键字、运算符、内置变量、语法结构（变量/if/for/函数定义/历史引用/下标/绘图/交易）、硬性上限与已知坑。写任何脚本前先读它。',
    parameters: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: ['overview', 'keywords', 'operators', 'builtins', 'syntax', 'limits', 'pitfalls', 'all'],
          description: '要看的部分，默认 all',
        },
      },
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args) {
      const section = args.section || 'all'
      const s = kb.language
      const out = []
      const want = (name) => section === 'all' || section === name

      if (want('overview')) {
        out.push('# AiScript v2 概览')
        out.push(`- 语言 id：${s.languageId} · 版本标记：${s.versionDirective}`)
        out.push(`- 脚本以「每根 K 线执行一次」的方式运行，表达式的值默认是序列（series）`)
        out.push(`- 语句结束：换行或分号；允许 \`a = 1, b = 2\` 逗号连写`)
        out.push(`- 注释：${s.comments.line} 与 ${s.comments.block.join(' ... ')}`)
        out.push('')
      }
      if (want('keywords')) {
        out.push('## 关键字')
        out.push(`${s.keywords.join(' ')}`)
        out.push('')
        out.push('> 注意：`range` / `iff` 在客户端示例里被当作普通标识符使用（`range = array_range(arr)`、`iff(a,b,c)`），本插件据此允许它们作为变量名。')
        out.push(`> 声明类型：${(s.types ?? []).join(' ')}`)
        out.push('')
      }
      if (want('operators')) {
        out.push('## 运算符')
        out.push(`${s.operators.join(' ')}`)
        out.push('')
        out.push('- `=` 声明/赋值，`:=` 修改已存在的变量（块内修改外层变量必须用 `:=`）')
        out.push('- `? :` 三元表达式；`iff(cond, a, b)` 等价')
        out.push('- 逻辑用 `and` / `or` / `not`（也接受 `&&` / `||` / `!`）')
        out.push('')
      }
      if (want('builtins')) {
        out.push('## 内置变量')
        out.push(`${[...kb.builtinVars].sort().join(' ')}`)
        out.push('')
        out.push(`命名空间：${[...kb.namespaces].join(', ')}`)
        out.push('')
      }
      if (want('syntax')) {
        out.push('## 语法结构（全部来自官方示例）')
        out.push('')
        out.push('```javascript')
        out.push(`// 版本标记（建议首行）
// @version=2

// 配置：indicator 必须放脚本最顶部且只能调用一次
indicator(precision = 2)

// 变量：var 只在第一根 K 线初始化，varip 在实时 K 线内也更新
var count = 0
varip float intra_high = high

// 类型声明与数组
int i = 10
int[] arr = [1, 2, 3, 4, 5]

// 自定义函数（注意：官方示例不带 func 关键字）
my_avg(a, b) {
    res = (a + b) / 2
    return res
}

// 条件
if (close > open) {
    count := count + 1        // 修改外层变量必须用 :=
} else if (close < open) {
    count := 0
}

// 循环：C 风格（括号可省略），单次上限 500
for (i = 0; i < 10; i++) {
    total += high[i] - low[i]
}

// 遍历字典/数组
params = {"period": 20, "threshold": 15}
for key, value = range params {
    if (value > 10) { count := count + 1 }
}

// 引用：[] 是 K 线历史，{} 是数组/字典下标
prev = close[1]
first = arr{0}
data = request("largeOrder:btcswapusdt:binance")
px = data{0}.depth_price

// 多返回值解构
[dif, dea, m] = macd(close, 12, 26, 9, "EMA", "EMA")

// 三元与 iff
dir = close > open ? 1 : (close < open ? -1 : 0)

// 绘图（根作用域）
plot(ma(close, 20), title = 'MA20', color = '#26a69a', lineWidth = 2, lineDash = [0], display = true)

// 交易（必须在根作用域；enterLong/exitLong/enterShort/exitShort 各只能声明一次）
tradeConfig(price = "market", amount = 1)
enterLong(crossup(close, ma(close, 20)), price = "market", amount = 1)
stop(close < ma(close, 200))
`)
        out.push('```')
        out.push('')
        out.push('> 注意：`fill()` 在函数内只能用三元运算符取色，不能把颜色写成 `iff(...)` 或含逗号的表达式。')
        out.push('')
      }
      if (want('limits')) {
        out.push('## 硬性上限')
        out.push(`- for 循环：单次最多 ${s.limits.forLoopMaxIterations} 次，超出直接报错`)
        out.push(`- 历史引用 \`[]\`：最多回溯最近 ${s.limits.historyLookbackMax} 个数据点`)
        out.push(`- 数组 / 字典下标 \`{}\`：最大长度 ${s.limits.indexLengthMax}，下标从 0 开始`)
        out.push('- 命名参数大小写敏感：`lineWidth` 写成 `linewidth` 直接编译错误')
        out.push('- 每种 enter/exit 指令最多声明一次；需要多次下单用带唯一 id 的 `*Amount` / `*Percent` 系列')
        out.push('- `label.new` / `line.new` / `box.new` 与交易函数必须在根作用域')
        out.push('')
      }
      if (want('pitfalls')) {
        out.push('## 已知坑（写代码时逐条对照）')
        out.push('1. `=` 在块内是「新建局部变量」，要改外层变量必须用 `:=`')
        out.push('2. `[]` 与 `{}` 是两个不同的运算符，混用是最常见的错误')
        out.push('3. `highest(high, N)` 含当前根；做突破判断应用 `highest(high[1], N)`')
        out.push('4. 除法分母可能为 0 时先用 `nz()` 兜底，否则结果是 nan 且所有比较为 false')
        out.push('5. `nan` 不能用 `==` 判断，要用 `na()`')
        out.push('6. 只有 `var` 声明的变量才能跨 K 线保持并累加')
        out.push('7. `plot` 之后不要再修改同名变量，绘图取的是当根的值')
        out.push('8. `for i = 0 to 10` 不被支持，必须写 `for (init; condition; step)`')
        out.push('')
      }
      return ok(out.join('\n'), { section, rules: kb.rules.length })
    },
  })

  // --------------------------------------------------------- 5. spec_draft
  register({
    name: 'aicoin_spec_draft',
    description:
      `把用户口语化、模糊的需求改写成可计算的量化规格，并列出必须向用户确认的问题。用法：先用 need 传入用户的原始表述，工具会识别“涨得猛 / 放量 / 超买 / 突破 / 稳赚”等模糊说法并给出量化改写；确认到的取值放进 values 反复调用，直到 readyToCode = true 再写代码。输出会写到工作目录的 spec.md / spec.json。必填槽位：${SPEC_FIELDS.filter((f) => f.required).map((f) => f.id).join(', ')}。`,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '策略名称，例如「BTC 15m 双均线趋势」' },
        need: { type: 'string', description: '用户的原话，未加工的需求描述' },
        values: {
          type: 'object',
          description:
            `已确认的槽位取值。可用键：${SPEC_FIELDS.map((f) => f.id).join(', ')}；` +
            `模糊表述确认后的回答用 vague:<id> 作为键，例如 vague:big-rise。`,
          additionalProperties: true,
        },
        workspace: { type: 'string', description: '工作目录（绝对路径最稳），默认取插件配置' },
        write: { type: 'boolean', description: '是否把规格写到磁盘，默认 true' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args) {
      const name = String(args.name ?? '').trim()
      if (!name) return bad('name 不能为空')
      const values = args.values && typeof args.values === 'object' ? args.values : {}
      const need = String(args.need ?? '')

      let previous = null
      if (!need) previous = await readSpecFile(args.workspace, name)
      const mergedNeed = need || previous?.need || ''
      const merged = { ...(previous?.values ?? {}), ...values }
      const analysis = analyzeRequirement(mergedNeed, merged)

      const lines = [`# 需求客观化：${name}`]
      lines.push(`完成度 ${analysis.completeness.percent}%（${analysis.completeness.filledFields}/${analysis.completeness.totalFields} 个槽位；必答项还剩 ${analysis.completeness.requiredOpen} 个）`)
      lines.push(analysis.completeness.readyToCode ? '状态：✅ 需求已满足编码条件，可以进入写代码阶段。' : '状态：⛔ 还有必答项未确认，先向用户提问，不要开始写代码。')

      if (analysis.recognised.length) {
        lines.push('\n## 识别到的模糊表述 → 量化改写')
        for (const item of analysis.recognised) {
          lines.push(`- 原文「${item.matched}」${item.answered ? `✅ 已确认：${item.answer}` : '⛔ 未确认'}`)
          lines.push(`  - 可计算写法：${item.rewrite}`)
          if (!item.answered) lines.push(`  - 要问：${item.question}`)
          if (!item.answered && item.options?.length) lines.push(`  - 建议选项：${item.options.join(' / ')}`)
        }
      } else if (mergedNeed) {
        lines.push('\n## 未识别到已知模糊词')
        lines.push('原文里没有命中内置的模糊词表；仍请逐条核对下面的必答项。')
      }

      const mode = analysis.positionMode
      lines.push('\n## 仓位运行模式（决定状态变量，必须由用户选择）')
      if (mode.chosen) {
        lines.push(`✅ 已选择：**${mode.chosenLabel ?? mode.chosen}**${mode.template ? `　→ 模板 ${mode.template}` : '（自定义）'}`)
        if (mode.stateVariables?.length) lines.push(`　需要记录的状态变量：${mode.stateVariables.join('、')}`)
        if (mode.risk) lines.push(`　风险提示：${mode.risk}`)
      } else {
        lines.push('⛔ 尚未选择。**这一项定不下来就不要开始写代码**——脚本会不知道自己是否已持仓，')
        lines.push('   结果是重复开仓、平仓失效、止损按错误基准计算：能跑，但交易行为是错的。')
      }
      lines.push('')
      lines.push('| 模式 | 运行方式 | 对应模板 | 需要的状态变量 | 风险 |')
      lines.push('| --- | --- | --- | --- | --- |')
      for (const option of POSITION_MODES) {
        const mark = mode.chosen === option.id ? ' ✅' : ''
        lines.push(
          `| ${option.label}${mark} | ${option.question} | ${option.template ?? '（自定义）'} | ` +
            `${option.state.length ? option.state.join(', ') : '—'} | ${option.risk} |`,
        )
      }
      if (mode.suggested?.length) {
        lines.push('')
        lines.push(`根据用户原话，可能想要：${mode.suggested.map((s) => `${s.label}（模板 ${s.template ?? '自定义'}）`).join(' / ')}`)
        lines.push('请把这个猜测当成一个问题去确认，不要直接替他决定。')
      }

      lines.push('\n## 必须向用户确认的问题')
      lines.push(renderOpenQuestions(analysis))

      if (analysis.openQuestions.some((q) => q.id === 'vague:profit-guarantee' || q.id === 'vague:backtest-request')) {
        lines.push('\n## 能力边界提醒')
        lines.push(NO_METRICS_NOTICE)
      }

      lines.push('\n## 参考风控档位')
      for (const preset of RISK_PRESETS) {
        lines.push(`- ${preset.label}：单笔风险 ${preset.riskPerTrade} · 仓位 ${preset.positionSize} · 止损 ${preset.stop}`)
      }

      let written = null
      if (args.write !== false) {
        const rendered = renderSpecMarkdown({ name, need: mergedNeed, spec: merged, analysis })
        written = {
          spec: await writeStrategyFile(args.workspace, name, 'spec.md', rendered),
          json: await writeStrategyFile(
            args.workspace,
            name,
            'spec.json',
            `${JSON.stringify({ name, need: mergedNeed, values: merged, completeness: analysis.completeness, updatedAt: new Date().toISOString() }, null, 2)}\n`,
          ),
        }
        lines.push(`\n已写入：\n- ${written.spec}\n- ${written.json}`)
      }

      return ok(lines.join('\n'), {
        name,
        completeness: analysis.completeness,
        readyToCode: analysis.completeness.readyToCode,
        openQuestions: analysis.openQuestions,
        recognised: analysis.recognised,
        positionMode: analysis.positionMode,
        metricsAvailable: false,
        files: written,
      })
    },
  })

  // -------------------------------------------------------- 6. spec_status
  register({
    name: 'aicoin_spec_status',
    description: '读取已保存的策略规格，报告还缺哪些必答项。开始写代码或交付前用它复查。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '策略名称（与 aicoin_spec_draft 一致）' },
        workspace: { type: 'string', description: '工作目录' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args) {
      const saved = await readSpecFile(args.workspace, args.name)
      if (!saved) return bad(`没有找到 ${args.name} 的规格文件；先调用 aicoin_spec_draft。`)
      const analysis = analyzeRequirement(saved.need ?? '', saved.values ?? {})
      const lines = [`# 规格状态：${args.name}`]
      lines.push(`完成度 ${analysis.completeness.percent}% · 必答项剩余 ${analysis.completeness.requiredOpen}`)
      lines.push(analysis.completeness.readyToCode ? '状态：✅ 可以写代码' : '状态：⛔ 仍需确认')
      lines.push('')
      lines.push('| 槽位 | 取值 |')
      lines.push('| --- | --- |')
      for (const field of SPEC_FIELDS) {
        const value = saved.values?.[field.id]
        lines.push(`| ${field.label} | ${value ? String(value) : '（未填）'} |`)
      }
      lines.push('')
      lines.push(renderOpenQuestions(analysis))
      return ok(lines.join('\n'), { completeness: analysis.completeness, openQuestions: analysis.openQuestions })
    },
  })

  // ----------------------------------------------------------- 7. validate
  register({
    name: 'aicoin_validate',
    description:
      'AI 自校验 / 自动 debug 的核心工具：对 AiScript 源码做词法 + 语法 + 语义静态校验，规则来自 AiCoin 客户端自己的函数库与语言定义（334 条函数签名、11 个内置变量、9 条已知坑）。返回带行列的错误/警告/提示。修改脚本后反复调用，直到 error 为 0。注意：这是静态代码逻辑校验，不是回测。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '脚本文件路径' },
        source: { type: 'string', description: '直接给脚本内容（与 path 二选一）' },
        includeInfo: { type: 'boolean', description: '是否包含 info 级提示，默认 false' },
        writeReport: { type: 'boolean', description: 'true 时把报告写到脚本同目录的 validation-report.md' },
        savePath: { type: 'string', description: '报告写入路径（可选，覆盖默认位置）' },
      },
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args) {
      const loaded = await loadSource(args)
      if (loaded.error) return bad(loaded.error)
      const includeInfo = args.includeInfo === true
      const result = validateScript(loaded.source, kb, { includeInfo })

      const head = result.ok
        ? `✅ 静态校验通过：${result.stats.lines} 行，错误 0，警告 ${result.stats.warnings}`
        : `⛔ 静态校验未通过：${result.stats.lines} 行，错误 ${result.stats.errors}，警告 ${result.stats.warnings}`
      const lines = [head, `来源：${loaded.origin}`, '校验方式：词法 / 语法 / 语义 / 函数库签名比对（离线，无回测）', '']
      if (!result.diagnostics.length) {
        lines.push('没有任何发现。注意：这代表代码逻辑在静态层面自洽，不代表策略有效。')
      } else {
        for (const d of result.diagnostics) {
          lines.push(formatDiagnostic(d, loaded.source))
          lines.push('')
        }
        lines.push('修正建议：按上面的行列位置逐条改；改完再跑一次 aicoin_validate，直到错误数为 0。')
      }

      const claims = scanForPerformanceClaims(loaded.source)
      if (claims.length) {
        lines.push('')
        lines.push('⚠ 脚本注释里出现了无法验证的绩效数字（本插件不会为它们背书）：')
        for (const claim of claims) lines.push(`  - 第 ${claim.line} 行：「${claim.matched}」 → ${claim.text}`)
      }

      let reportPath = null
      if (args.writeReport || args.savePath) {
        const target = args.savePath
          ? isAbsolute(args.savePath)
            ? args.savePath
            : resolve(process.cwd(), args.savePath)
          : join(dirname(isAbsolute(loaded.origin) ? loaded.origin : resolve(process.cwd(), loaded.origin)), 'validation-report.md')
        const body = `${renderReport(result, { source: loaded.source })}\n`
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, body, 'utf8')
        reportPath = target
        lines.push(`\n报告已写入：${target}`)
      }

      return ok(lines.join('\n'), {
        // `passed` is the SCRIPT verdict; the envelope's own `ok` only says the
        // tool itself ran.
        passed: result.ok,
        stats: result.stats,
        diagnostics: result.diagnostics,
        performanceClaims: claims,
        reportPath,
        metricsAvailable: false,
      })
    },
  })

  // ---------------------------------------------------------- 8. scaffold
  register({
    name: 'aicoin_scaffold',
    description:
      `从内置模板生成一个「保证能通过静态校验」的 AiScript 策略骨架，写到工作目录。可用模板：${TEMPLATES.map((t) => `${t.id}（${t.title}）`).join('；')}。生成后务必按需求改写参数，并再次运行 aicoin_validate。`,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '策略名称，也用作目录名' },
        template: { type: 'string', enum: TEMPLATES.map((t) => t.id), description: '模板 id' },
        values: { type: 'object', description: '模板参数覆盖，例如 {"fastLen": 8, "slowLen": 21}', additionalProperties: true },
        workspace: { type: 'string', description: '工作目录' },
        force: { type: 'boolean', description: 'true 时覆盖已存在的 strategy.txt' },
      },
      required: ['name', 'template'],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args) {
      const template = findTemplate(String(args.template))
      if (!template) return bad(`未知模板 “${args.template}”；可用：${TEMPLATES.map((t) => t.id).join(', ')}`)
      const source = template.build(resolveValues(template, args.values ?? {}), String(args.name))
      const result = validateScript(source, kb, { includeInfo: true })
      if (!result.ok) {
        return bad('内部错误：模板本身未通过校验，请把这条报告给插件作者', { diagnostics: result.diagnostics })
      }
      const dir = strategyDir(args.workspace, args.name)
      const target = join(dir, SCRIPT_FILE)
      if (existsSync(target) && args.force !== true) {
        return bad(`${target} 已存在；要覆盖请传 force = true`, { path: target })
      }
      await mkdir(dir, { recursive: true })
      await writeFile(target, source, 'utf8')

      const lines = [
        `已生成策略骨架：${target}`,
        `模板：${template.id} —— ${template.title}`,
        `说明：${template.description}`,
        `静态校验：✅ 通过（${result.stats.lines} 行，错误 0，警告 ${result.stats.warnings}）`,
        '',
        '模板参数（可用 values 覆盖）：',
      ]
      for (const spec of template.values) lines.push(`  - ${spec.id}：${spec.label}，默认 ${spec.default}（${spec.desc}）`)
      lines.push('')
      lines.push('下一步：')
      lines.push('1. 用 aicoin_spec_draft 把需求量化，确认必答项。')
      lines.push(`2. 读 ${target}，按需求改写条件与参数。`)
      lines.push('3. 运行 aicoin_validate 校验，直到错误为 0。')
      lines.push('4. 用 aicoin_optimize_advice 做结构审查，最后 aicoin_deliver 交付。')
      if (template.requiresTrade) {
        lines.push('')
        lines.push('⚠ 本模板包含 enterLong/exitLong 交易指令，会真实下单；参数必须由用户确认后再用。')
      }
      return ok(lines.join('\n'), { path: target, template: template.id, stats: result.stats })
    },
  })

  // --------------------------------------------------- 9. optimize_advice
  register({
    name: 'aicoin_optimize_advice',
    description:
      '以量化工程师视角审查脚本结构并给出优化方向：止损/熔断/仓位缺失、未来函数（highest 含当前根）、重绘风险（varip）、除零与 nan 未保护、参数过多导致的过拟合、外部数据依赖、验收方式缺失。本工具不接收也不输出任何绩效指标——它给的是结构与逻辑层面的建议。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '脚本文件路径' },
        source: { type: 'string', description: '直接给脚本内容（与 path 二选一）' },
        name: { type: 'string', description: '策略名称，用于读取已保存的规格' },
        workspace: { type: 'string', description: '工作目录' },
        save: { type: 'boolean', description: 'true 时把建议写到 optimization-advice.md' },
      },
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args) {
      const loaded = await loadSource(args)
      if (loaded.error) return bad(loaded.error)
      const parsed = parse(loaded.source)
      const result = validateScript(loaded.source, kb, { includeInfo: true })
      const saved = args.name ? await readSpecFile(args.workspace, args.name) : null
      const specValues = saved?.values ?? {}
      const analysis = analyzeRequirement(saved?.need ?? '', specValues)
      const review = buildAdvice({
        source: loaded.source,
        ast: parsed.ast,
        spec: specValues,
        analysis: saved ? analysis : null,
        diagnostics: result.diagnostics,
      })

      const lines = ['# 策略优化建议（静态分析）']
      lines.push(`脚本：${loaded.origin} · ${result.stats.lines} 行`)
      lines.push('')
      lines.push(`> ${NO_METRICS_NOTICE}`)
      lines.push('')
      lines.push(`## 结构概览`)
      if (review.facts) {
        lines.push(`- 函数调用 ${review.facts.calls} 次（${review.facts.distinctCalls} 个不同函数）· 交易指令 ${review.facts.trades} 条 · 绘图 ${review.facts.plots} 条`)
        lines.push(
          `- 仓位状态变量：${review.facts.stateVariables.length ? review.facts.stateVariables.join('、') : '**无**'}` +
            `${review.facts.hasStrategyPosition ? '（另有 strategy.position 引用）' : ''}`,
        )
        lines.push(`- 循环 ${review.facts.loops} 个 · 除法 ${review.facts.divisions} 处 · varip ${review.facts.varip} 处 · 数值字面量 ${review.facts.numericLiterals} 个`)
        if (review.facts.namedPeriods.length) lines.push(`- 周期类参数：${review.facts.namedPeriods.join(', ')}`)
      }
      lines.push('')
      lines.push('## 建议清单')
      if (!review.advice.length) {
        lines.push('未发现结构性风险。这不代表策略有效——有效性只能由你在客户端验证。')
      }
      const badge = { high: '高', medium: '中', low: '低' }
      for (const item of review.advice) {
        lines.push(`\n### [${badge[item.severity] ?? item.severity}] ${item.title}`)
        lines.push(`- 现象：${item.finding}`)
        lines.push(`- 为什么重要：${item.why}`)
        lines.push(`- 建议动作：${item.action}`)
      }
      lines.push('')
      lines.push('## 明确不会提供的东西')
      lines.push('- 不会给出收益率、胜率、夏普、最大回撤、盈亏比等任何绩效数字。')
      lines.push('- 拆包的 AiCoin 编辑器没有回测功能，所以这类数字不可能来自真实计算。')
      lines.push('- 想要量化评估，请在你自己的回测环境里跑，或参考 AiCoin 实盘交易模块产出的真实成交记录。')

      const high = review.advice.filter((a) => a.severity === 'high').length
      const medium = review.advice.filter((a) => a.severity === 'medium').length
      lines.unshift(`结论：${high} 个高优先级、${medium} 个中优先级问题。`)

      let savedPath = null
      if (args.save !== false && args.name) {
        savedPath = await writeStrategyFile(
          args.workspace,
          args.name,
          'optimization-advice.md',
          renderAdviceMarkdown({ advice: review.advice, facts: review.facts, source: loaded.source }),
        )
        lines.push(`\n建议已写入：${savedPath}`)
      }

      return ok(lines.join('\n'), {
        advice: review.advice,
        facts: review.facts,
        metricsAvailable: false,
        noMetricsNotice: NO_METRICS_NOTICE,
        savedPath,
      })
    },
  })

  // ------------------------------------------------------------ 10. deliver
  register({
    name: 'aicoin_deliver',
    description:
      '交付最终代码：先做静态校验（有 error 会拒绝交付），再把最终脚本、量化需求规格、静态校验报告、优化建议、使用说明与免责声明打包写到工作目录。交付物里不包含任何回测或绩效数据。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '策略名称' },
        path: { type: 'string', description: '最终脚本路径' },
        source: { type: 'string', description: '最终脚本内容（与 path 二选一）' },
        workspace: { type: 'string', description: '工作目录' },
        summary: { type: 'string', description: '给用户的交付说明（策略思路、参数含义、使用步骤）' },
        allowWithErrors: { type: 'boolean', description: '默认 false；为 true 时即使有 error 也交付，并在报告中标注未通过' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args) {
      const loaded = await loadSource(args)
      if (loaded.error) return bad(loaded.error)
      const name = String(args.name).trim()
      const result = validateScript(loaded.source, kb, { includeInfo: true })
      const parsed = parse(loaded.source)
      const saved = await readSpecFile(args.workspace, name)
      const analysis = analyzeRequirement(saved?.need ?? '', saved?.values ?? {})
      const review = buildAdvice({
        source: loaded.source,
        ast: parsed.ast,
        spec: saved?.values ?? {},
        analysis: saved ? analysis : null,
        diagnostics: result.diagnostics,
      })

      if (!result.ok && args.allowWithErrors !== true) {
        const errors = result.diagnostics.filter((d) => d.severity === 'error')
        return bad(
          `拒绝交付：脚本还有 ${errors.length} 个 error 级问题。先修掉再交付，或显式传 allowWithErrors = true。\n\n` +
            errors.slice(0, 10).map((d) => formatDiagnostic(d, loaded.source)).join('\n'),
          { errors: errors.map((d) => ({ ruleId: d.ruleId, line: d.line, message: d.message })) },
        )
      }

      const generatedAt = new Date().toISOString()
      const claims = scanForPerformanceClaims(loaded.source)

      const written = {}
      written.script = await writeStrategyFile(args.workspace, name, SCRIPT_FILE, loaded.source)
      written.validation = await writeStrategyFile(
        args.workspace,
        name,
        'validation-report.md',
        `${renderReport(result, { source: loaded.source })}\n`,
      )
      written.advice = await writeStrategyFile(
        args.workspace,
        name,
        'optimization-advice.md',
        renderAdviceMarkdown({ advice: review.advice, facts: review.facts, source: loaded.source, generatedAt }),
      )
      if (saved) {
        written.spec = await writeStrategyFile(
          args.workspace,
          name,
          'spec.md',
          renderSpecMarkdown({ name, need: saved.need, spec: saved.values ?? {}, analysis, createdAt: generatedAt }),
        )
      }

      const readme = buildDeliveryReadme({ name, summary: args.summary, analysis, result, review, generatedAt, claims, saved })
      written.readme = await writeStrategyFile(args.workspace, name, 'README.md', readme)

      const dir = strategyDir(args.workspace, name)
      const lines = [
        `# 交付：${name}`,
        '',
        `输出目录：${dir}`,
        '',
        '| 文件 | 内容 |',
        '| --- | --- |',
        '| ' + SCRIPT_FILE + ' | 最终脚本（纯文本，可直接粘贴到 AiCoin 指标编辑器） |',
        '| spec.md | 量化后的需求规格 |',
        '| validation-report.md | 静态校验报告 |',
        '| optimization-advice.md | 结构审查与优化建议 |',
        '| README.md | 使用说明与免责声明 |',
        '',
        `静态校验：${result.ok ? '✅ 通过（error 0）' : `⚠ 未通过（error ${result.stats.errors}）`} · 警告 ${result.stats.warnings}`,
        `高优先级建议：${review.advice.filter((a) => a.severity === 'high').length} 条`,
        '',
        `> ${NO_METRICS_NOTICE}`,
      ]
      if (claims.length) {
        lines.push('')
        lines.push('⚠ 脚本注释里含有无法验证的绩效数字，已在交付说明中标注：')
        for (const claim of claims) lines.push(`  - 第 ${claim.line} 行：${claim.text}`)
      }
      if (!saved) {
        lines.push('')
        lines.push('提示：没有找到该策略的规格文件（spec.json）。建议先跑 aicoin_spec_draft 把需求固定下来，交付物会更完整。')
      }

      return ok(lines.join('\n'), {
        dir,
        files: written,
        stats: result.stats,
        suggestions: review.advice.length,
        highPriority: review.advice.filter((a) => a.severity === 'high').length,
        performanceClaims: claims,
        metricsAvailable: false,
      })
    },
  })

  // ------------------------------------------------------- 11. live_check
  register({
    name: 'aicoin_live_check',
    description:
      '只读地检查本机正在运行的 AiCoin 客户端：(1) probe —— 调试端口是否开放；(2) library-diff —— 通过客户端自己的 axios 拉取线上函数库，与本插件内置的 334 条比对，报告客户端版本是否更新。' +
      '本工具只读，不会写入任何数据。它故意不提供“保存即编译”的在线校验：客户端没有本地编译器，真正的编译发生在 POST customIndicator/script/save 时，而那会在用户账号里新建或覆盖一条真实指标并占用配额——真正的编译校验应该由用户自己在客户端点“保存并校验”。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['probe', 'library-diff'], description: 'probe 只探测端口；library-diff 还会拉取线上函数库做比对' },
        port: { type: 'number', description: `CDP 调试端口，默认 ${DEFAULT_PORT}` },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args) {
      const port = Number(args.port) || DEFAULT_PORT
      const probe = await probeDebugPort(port)
      const lines = [`AiCoin 调试端口 ${port}：${probe.open ? '✅ 已开放' : '⛔ 不可达'}`]
      if (!probe.open) {
        lines.push(`原因：${probe.reason ?? '未监听'}`)
        lines.push('')
        lines.push('开启方法（Electron 的 CDP 只能在启动时开启，事后无法附加，必须重启一次客户端）：')
        if (process.platform === 'darwin') {
          lines.push('  1. 完全退出 AiCoin（⌘Q，不要只关窗口）。')
          lines.push(`  2. 终端执行：open -a AiCoin --args --remote-debugging-port=${port}`)
          lines.push('     （或者让 aicoin_mcp 面板的「以调试模式重启 / 连上」按钮代劳，效果相同）')
        } else if (process.platform === 'win32') {
          lines.push('  1. 完全退出 AiCoin。')
          lines.push(`  2. 用带调试端口的方式启动：AiCoin.exe --remote-debugging-port=${port}`)
        } else {
          lines.push('  1. 完全退出 AiCoin。')
          lines.push(`  2. 用带调试端口的方式启动：<AiCoin 可执行文件> --remote-debugging-port=${port}`)
        }
        lines.push('  3. 重新运行本工具（或 aicoin_live_check）。')
        lines.push('')
        lines.push('注意：正式版里环境变量 ELECTRON_REMOTE_DEBUGGING_PORT 已失效，必须用命令行参数。')
        lines.push('')
        lines.push('即使端口不可达也不影响主流程：本插件的静态校验完全离线，不依赖客户端。')
        return ok(lines.join('\n'), { open: false, port, reason: probe.reason })
      }

      lines.push(`页面目标 ${probe.targets.length} 个：`)
      for (const target of probe.targets) lines.push(`  - [${target.type}] ${target.title || '(无标题)'} ${target.url}`)

      if (args.action === 'probe') {
        return ok(lines.join('\n'), { open: true, port, targets: probe.targets })
      }

      lines.push('')
      lines.push('正在通过客户端自己的 axios 读取线上函数库（只读）…')
      const live = await fetchLiveLibrary(port)
      if (!live.ok) {
        lines.push(`⛔ 读取失败：${live.message}`)
        lines.push('可能原因：AiCoin 未登录、函数库接口变更、或页面结构随版本变化。这不影响离线静态校验。')
        return ok(lines.join('\n'), { open: true, port, liveOk: false, message: live.message })
      }
      lines.push(`✅ ${live.message}`)
      const diff = diffLibrary(live.entries, kb)
      lines.push('')
      lines.push(`内置函数库：${diff.bundledCount} 条 · 客户端线上：${diff.liveCount} 条`)
      if (diff.inSync) {
        lines.push('结论：两者条目一致，本插件的函数库与你的客户端同步。')
      } else {
        if (diff.missingLocally.length) {
          lines.push(`⚠ 客户端有、本插件没有的条目 ${diff.missingLocally.length} 个（插件可能略旧）：`)
          lines.push(`  ${diff.missingLocally.slice(0, 40).join(', ')}${diff.missingLocally.length > 40 ? ' …' : ''}`)
        }
        if (diff.extraLocally.length) {
          lines.push(`⚠ 本插件有、客户端没有的条目 ${diff.extraLocally.length} 个（该客户端版本可能已移除）：`)
          lines.push(`  ${diff.extraLocally.slice(0, 40).join(', ')}${diff.extraLocally.length > 40 ? ' …' : ''}`)
        }
        lines.push('')
        lines.push('处理方式：以客户端为准。用 node tools/build_data.mjs --source <函数库资料包目录> 重新生成内置数据。')
      }
      lines.push('')
      lines.push('提醒：真正的编译校验只有客户端能做（保存时服务端返回 compileResult.pass / errLine / errColumn / warnMessage）。')
      lines.push('本插件不代为保存——那会在你的账号里真的新建一条指标。请在客户端里自行点“保存并校验”。')
      return ok(lines.join('\n'), { open: true, port, diff })
    },
  })

  log.info?.(`kk_aicoin_codingAI: ${disposers.length} tools registered`)
  // -------------------------------------------------- 12. library_refresh
  register({
    name: 'aicoin_library_refresh',
    description:
      '把内置函数库与客户端实时函数库对齐（refresh 通道）。默认只比对并回报差异；apply:true 时留存客户端原始快照，并把「客户端有、插件没有」的条目写成 data/live-extra.json —— 重载后这些函数不再被误报为 UNKNOWN_FUNCTION，文档仍可由 aicoin_library_get 读到。只读，不写账号。',
    parameters: {
      type: 'object',
      properties: {
        port: { type: 'number', description: 'CDP 调试端口，默认 9222' },
        apply: { type: 'boolean', description: 'true 时落盘（原始快照 + live-extra.json），默认 false 只比对' },
      },
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args) {
      const port = Number(args.port) || DEFAULT_PORT
      const apply = args.apply === true
      const result = await refreshLibrary({ port, kb, dataDir: kb.dataDir, apply })
      if (!result.ok) {
        return ok(
          [
            `⛔ 读取客户端函数库失败：${result.message}`,
            '',
            '端口不可达时先运行 aicoin_live_check 看具体原因：',
            `  open -a AiCoin --args --remote-debugging-port=${port}`,
            '不刷新也不影响主流程：静态校验完全离线，函数库与规则库都能用。',
          ].join('\n'),
          result,
        )
      }
      const lines = [
        '函数库对齐结果',
        '',
        `- 内置函数库：${result.bundledCount} 条`,
        `- 客户端线上：${result.liveTotal ?? result.liveCount} 条（去重后 ${result.liveCount}）`,
        `- 结论：${result.inSync ? '✅ 一致，无需刷新' : '⚠ 存在差异'}`,
      ]
      if (result.missingLocally.length) {
        lines.push(`- 客户端有、插件没有：${result.missingLocally.length} 个`)
        lines.push(`  ${result.missingLocally.slice(0, 40).join(', ')}${result.missingLocally.length > 40 ? ' …' : ''}`)
      }
      if (result.extraLocally.length) {
        lines.push(`- 插件有、客户端没有：${result.extraLocally.length} 个（该版本可能已移除）`)
        lines.push(`  ${result.extraLocally.slice(0, 40).join(', ')}${result.extraLocally.length > 40 ? ' …' : ''}`)
      }
      lines.push('')
      if (result.applied) {
        lines.push(`✅ 已写盘：${result.extraPath}`)
        lines.push(`✅ 原始快照：${result.rawPath}`)
        lines.push('重载插件后，这些条目以 stub 并入知识库：名字可解析、参数个数未知（不误报 ARITY），文档原文仍可读。')
        lines.push('不重写 aiscript_functions.json —— 从 markdown 反推参数表需要离线抽取器，把签名降级成猜测比留 stub 更糟。')
      } else if (!result.inSync) {
        lines.push('要落盘请再调用一次并传 apply:true。')
      } else {
        lines.push('无需落盘。（本工具只读，不写账号、不动客户端数据）')
      }
      return ok(lines.join('\n'), result)
    },
  })

  return disposers
}

/** Assemble the human-facing delivery README. */
function buildDeliveryReadme({ name, summary, analysis, result, review, generatedAt, claims, saved }) {
  const lines = []
  lines.push(`# ${name}`)
  lines.push('')
  lines.push(`由 kk_aicoin_codingAI 生成 · ${generatedAt}`)
  lines.push('')
  lines.push('## 一、这份交付里有什么')
  lines.push('')
  lines.push(`- \`${SCRIPT_FILE}\` —— 最终脚本（纯文本），直接粘贴进 AiCoin 的指标编辑器即可。`)
  lines.push('- `spec.md` —— 把你的口头需求改写成的量化规格与待确认问题。')
  lines.push('- `validation-report.md` —— 离线静态校验报告（词法 / 语法 / 语义 / 函数库签名比对）。')
  lines.push('- `optimization-advice.md` —— 结构审查与优化方向。')
  lines.push('')
  const mode = analysis?.positionMode
  lines.push('## 二、仓位状态机（这份脚本为什么不会重复下单）')
  lines.push('')
  if (mode?.chosen) {
    lines.push(`仓位运行模式：**${mode.chosenLabel ?? mode.chosen}**${mode.template ? `（对应模板 ${mode.template}）` : ''}`)
    if (mode.stateVariables?.length) {
      lines.push('')
      lines.push(`本模式靠这些变量记住仓位：\`${mode.stateVariables.join('`、`')}\``)
    }
    if (mode.risk) {
      lines.push('')
      lines.push(`该模式的风险：${mode.risk}`)
    }
  } else {
    lines.push('⚠ 需求规格里没有选择仓位运行模式。请务必人工确认脚本里的仓位状态变量是否够用。')
  }
  lines.push('')
  lines.push('脚本遵守三条不变量，这也是它区别于「能跑但交易行为错误」的写法：')
  lines.push('')
  lines.push('1. **有跨 K 线的仓位状态**：只有 `var` / `varip` 声明的变量能跨 K 线保存，脚本用它记录是否持仓、入场价、入场 K 线。')
  lines.push('2. **每笔下单都是边沿触发或状态保护**：条件要么是 `crossup` / `crossdown` 这类边沿信号，要么显式判断了「当前是否已持仓」，因此不会在条件成立的每一根 K 线上重复下单。')
  lines.push('3. **状态先于交易更新、平仓后复位**：状态更新写在交易调用之前；平仓分支把状态置回空仓，否则脚本会一直以为自己仍持仓。')
  lines.push('')
  lines.push('## 三、必须有的一句话说清楚：没有回测')
  lines.push('')
  lines.push('> **本交付不含任何回测数据。**')
  lines.push('>')
  lines.push('> 拆包的 AiCoin 编辑器里**不存在回测功能**，因此本插件不会、也不能提供收益率、胜率、夏普比率、')
  lines.push('> 最大回撤、盈亏比等任何绩效数字。校验报告里的结论只描述「代码逻辑是否自洽、')
  lines.push('> 是否违反客户端文档里的硬性规则」，不描述策略赚不赚钱。')
  lines.push('')
  lines.push('## 四、静态校验结果')
  lines.push('')
  lines.push(`- 源码：${result.stats.lines} 行`)
  lines.push(`- 错误：${result.stats.errors} · 警告：${result.stats.warnings} · 提示：${result.stats.infos}`)
  lines.push(`- 结论：${result.ok ? '通过（无 error 级问题）' : '未通过，请先修正错误'}`)
  lines.push('')
  lines.push('## 五、优化方向摘要')
  lines.push('')
  if (!review.advice.length) {
    lines.push('未发现结构性风险。这不代表策略有效。')
  } else {
    const badge = { high: '高', medium: '中', low: '低' }
    for (const item of review.advice) {
      lines.push(`- **[${badge[item.severity] ?? item.severity}] ${item.title}**：${item.finding}`)
      lines.push(`  - 建议：${item.action}`)
    }
  }
  lines.push('')
  if (analysis && analysis.openQuestions.length) {
    lines.push('## 六、仍然需要你确认的问题')
    lines.push('')
    for (const question of analysis.openQuestions) {
      lines.push(`- [${question.required ? '必答' : '建议'}] **${question.label}**：${question.question}`)
    }
    lines.push('')
  }
  if (claims.length) {
    lines.push('## 七、关于脚本注释里的绩效数字')
    lines.push('')
    lines.push('脚本注释中出现了下列无法验证的绩效表述，本插件不为它们背书，建议删除或改成可核对的记录：')
    lines.push('')
    for (const claim of claims) lines.push(`- 第 ${claim.line} 行：\`${claim.text}\``)
    lines.push('')
  }
  lines.push('## 八、怎么用')
  lines.push('')
  lines.push('1. 打开 AiCoin 客户端 → 指标编辑器，新建自定义指标。')
  lines.push(`2. 用记事本打开 \`${SCRIPT_FILE}\`，全选复制，粘贴进去。`)
  lines.push('3. 先看图表上的信号位置是否符合预期，再考虑是否接入实盘（脚本里含 `tradeConfig` / `enter*` 会真实下单）。')
  lines.push('4. 参数都在脚本顶部，逐个确认取值是否有市场含义，不要为了好看而调参。')
  lines.push('5. 真正能否编译，以客户端里点「保存并校验」的结果为准；本插件的静态校验不能替代服务端编译器。')
  lines.push('')
  if (summary) {
    lines.push('## 九、交付说明')
    lines.push('')
    lines.push(summary)
    lines.push('')
  }
  if (saved?.need) {
    lines.push('## 附：你最初的需求原文')
    lines.push('')
    lines.push('> ' + String(saved.need).replace(/\n/g, '\n> '))
    lines.push('')
  }
  return lines.join('\n')
}

export { VAGUE_PATTERNS, SPEC_FIELDS, TEMPLATES, stat }
