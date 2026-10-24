/**
 * Strategy review and optimization advice.
 *
 * This module is deliberately a STATIC reviewer. It reads the script structure
 * and the quantified spec, and reports structural risks: missing risk control,
 * look-ahead patterns, repainting hazards, parameter sprawl, unsafe division.
 *
 * It produces NO performance figures and cannot produce any: the unpacked
 * AiCoin editor has no backtest engine, so a win rate, return, Sharpe or
 * drawdown number from this plugin would be fabricated by construction. Every
 * response carries an explicit `metricsAvailable: false` marker, and the
 * advisor refuses a `metrics` input outright.
 *
 * @module kk_aicoin_codingAI/advice
 */

/** Hard statement attached to every advice payload. */
export const NO_METRICS_NOTICE =
  '本插件不提供也不推测任何回测绩效数据（收益率 / 胜率 / 夏普 / 最大回撤 / 盈亏比统计）。' +
  '拆包的 AiCoin 编辑器中没有回测功能，任何此类数字都只能是编造的。' +
  '以下建议全部来自脚本结构与需求规格的静态检查。'

/** Calls that place or manage a real position. */
const TRADE_CALL_NAMES = new Set([
  'enterLong', 'exitLong', 'enterShort', 'exitShort',
  'enterLongAmount', 'exitLongAmount', 'enterShortAmount', 'exitShortAmount',
  'enterLongPercent', 'exitLongPercent', 'enterShortPercent', 'exitShortPercent',
])

/** Collection of counting/flagging facts gathered from the AST. */
export function collectFacts(ast) {
  const facts = {
    calls: [],
    callNames: new Set(),
    numericLiterals: [],
    varip: 0,
    varDecls: 0,
    typeofHazards: new Set(),
    hasStop: false,
    hasPositionCheck: false,
    hasNaGuard: false,
    hasWarmupGuard: false,
    tradeCalls: [],
    plotCalls: 0,
    highestLowestCurrentBar: [],
    divisionCount: 0,
    loopCount: 0,
    largestLoopBound: 0,
    requestCalls: 0,
    funcCount: 0,
    identifiers: new Set(),
    periodLikeNumbers: [],
    /** Names declared with var / varip. */
    varNames: new Set(),
    /** Names written with := or a compound assignment. */
    assignedNames: new Set(),
    /** Their intersection: actual cross-bar position state. */
    stateVariables: [],
    /** Reads strategy.position, which is a state source in its own right. */
    hasStrategyPosition: false,
  }

  const PERIOD_HINT = /(len|length|period|bars|lookback|window|_n$|^n$)/i

  const walk = (node, context = {}) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item, context)
      return
    }
    if (typeof node.kind !== 'string') {
      for (const key of Object.keys(node)) walk(node[key], context)
      return
    }

    switch (node.kind) {
      case 'Call': {
        const name = node.calleeText ?? ''
        facts.calls.push({ name, node })
        facts.callNames.add(name)
        if (name === 'stop') facts.hasStop = true
        if (name === 'na' || name === 'nz') facts.hasNaGuard = true
        if (name === 'request' || name === 'security') facts.requestCalls += 1
        if (
          [
            'plot', 'plotColumn', 'plotHist', 'plotText', 'plotShape', 'plotCandle', 'plotOhlc', 'fill',
            'line.new', 'label.new', 'box.new',
          ].includes(name)
        ) {
          facts.plotCalls += 1
        }
        if (TRADE_CALL_NAMES.has(name)) facts.tradeCalls.push(name)
        if (name === 'highest' || name === 'lowest' || name === 'highestbars' || name === 'lowestbars') {
          const first = node.args.find((a) => a.kind !== 'NamedArg')
          const source = first?.kind === 'History' ? first.object : first
          // highest(high, N) includes the current bar; highest(high[1], N) does not.
          const offset = first?.kind === 'History'
          if (!offset) facts.highestLowestCurrentBar.push({ name, line: node.loc?.line ?? 0 })
          void source
        }
        break
      }
      case 'Binary':
        if (node.op === '/' || node.op === '%') facts.divisionCount += 1
        break
      case 'VarDecl':
        if (node.keyword === 'varip') facts.varip += 1
        if (node.keyword === 'var' || node.keyword === 'varip') {
          facts.varDecls += 1
          facts.varNames.add(node.name)
        }
        break
      case 'Assign':
        if (node.target?.kind === 'Identifier' && node.op !== '=') facts.assignedNames.add(node.target.name)
        break
      case 'FuncDecl':
        facts.funcCount += 1
        break
      case 'ForC':
      case 'ForIn':
        facts.loopCount += 1
        break
      case 'Literal':
        if (node.literalType === 'number') {
          facts.numericLiterals.push({ value: node.value, line: node.loc?.line ?? 0 })
        }
        break
      case 'Member': {
        const path = memberPath(node)
        if (path === 'strategy.position') facts.hasPositionCheck = true
        if (path.startsWith('strategy.')) facts.hasStrategyPosition = true
        if (path && path.startsWith('barstate.')) facts.typeofHazards.add(path)
        break
      }
      case 'Identifier': {
        facts.identifiers.add(node.name)
        if (node.name === 'bar_index') facts.hasWarmupGuard = true
        break
      }
      default:
        break
    }

    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'token' || key === 'opToken' || key === 'nameToken') continue
      walk(node[key], context)
    }
  }
  walk(ast)
  facts.stateVariables = [...facts.varNames].filter((name) => facts.assignedNames.has(name)).sort()

  // Period-looking literals: numbers bound to `*len*`-ish names, or 2..500 ints.
  for (const statement of ast?.body ?? []) {
    if (statement.kind !== 'VarDecl' && statement.kind !== 'Assign') continue
    const name = statement.target?.kind === 'Identifier' ? statement.target.name : statement.name
    if (!name) continue
    const value = statement.kind === 'VarDecl' ? statement.init : statement.value
    if (value?.kind === 'Literal' && value.literalType === 'number' && PERIOD_HINT.test(name)) {
      facts.periodLikeNumbers.push({ name, value: value.value, line: statement.loc?.line ?? 0 })
    }
  }

  // Largest literal loop bound is the closest static proxy for loop cost.
  const boundRe = /<\s*(\d+)/g
  void boundRe
  return facts
}

function memberPath(node) {
  if (!node) return ''
  if (node.kind === 'Identifier') return node.name
  if (node.kind === 'Member') {
    const base = memberPath(node.object)
    return base ? `${base}.${node.name}` : node.name
  }
  return ''
}

/**
 * Build the advice list.
 *
 * @param {object} input - `{ source, ast, spec, analysis, diagnostics }`.
 * @returns {{ advice: Array<object>, facts: object, metricsAvailable: false, noMetricsNotice: string }}
 */
export function buildAdvice({ source, ast, spec = {}, analysis, diagnostics = [] }) {
  const facts = ast ? collectFacts(ast) : null
  const advice = []
  const push = (id, severity, title, finding, why, action) => {
    advice.push({ id, severity, title, finding, why, action })
  }
  const has = (...names) => facts && names.some((n) => facts.callNames.has(n))

  // ---------------------------------------------------- position state machine
  const stateVars = facts ? facts.stateVariables : []
  const tradeCount = facts ? facts.tradeCalls.length : 0

  if (facts && tradeCount > 0 && stateVars.length === 0 && !facts.hasStrategyPosition) {
    push(
      'no-state-machine',
      'high',
      '脚本没有记录仓位状态，交易指令会重复执行',
      '脚本里有交易指令，但没有任何 var / varip 声明的仓位状态变量，也没有读取 strategy.position。',
      '脚本因此不知道当前是否已经持仓：只要开仓条件成立，它会在每一根 K 线上都下令开仓；平仓条件也会在无仓的情况下反复触发。' +
        '这正是「代码能跑、但交易行为是错的」的典型来源。',
      '加一组状态变量，例如 var in_long = false、var entry_price = 0.0、var entry_bar = 0；' +
        '开仓分支写 in_long := true / entry_price := close / entry_bar := bar_index，平仓分支写 in_long := false，' +
        '并让下单条件引用 in_long。可以直接用 aicoin_scaffold 里任一交易模板作为起点。',
    )
  }

  if (facts && tradeCount > 0 && !facts.hasStop && stateVars.length === 0 && !facts.hasStrategyPosition) {
    push(
      'no-state-and-no-stop',
      'high',
      '既没有状态变量也没有熔断',
      '脚本既没有跨 K 线的 `var` 仓位状态，也没有读取 strategy.position，同时也没有 stop() 熔断。',
      '三个保护一个都不存在时，一次异常行情就可能让脚本连续下单并把仓位堆到不可控。',
      '先补仓位状态（var 变量，或读 strategy.position 的持仓量与持仓均价），再加 stop(bar_index < warmup) 与账户级熔断条件。',
    )
  }

  const repeatedRisks = diagnostics.filter((d) => d.ruleId === 'REPEATED_TRADE_RISK')
  if (repeatedRisks.length) {
    push(
      'repeated-order-risk',
      'high',
      '有下单条件会在每根 K 线重复触发',
      `静态校验发现 ${repeatedRisks.length} 处下单条件既不是边沿信号、也没有状态保护（第 ${repeatedRisks
        .slice(0, 6)
        .map((d) => d.line)
        .join('、')} 行）。`,
      '这些条件只要成立就每根 K 线都会下单，不是「一次信号一次成交」。',
      '把条件改成「边沿信号 + 状态保护」，例如 crossup(fast, slow) and not in_long；并在平仓分支里把状态复位。',
    )
  }

  if (facts && tradeCount > 0 && stateVars.length > 0 && !stateVars.some((n) => /(entry|avg|cost|hold)/i.test(n)) && !facts.hasStrategyPosition) {
    push(
      'no-entry-price-record',
      'medium',
      '没有记录入场价',
      '脚本有仓位状态，但没有任何变量记录入场价。',
      '止盈止损如果按百分比算，基准会随当前价漂移——跳空之后止损位就不再是当初那个位置。',
      '开仓分支里记 entry_price := close，止损止盈一律写成 entry_price * (1 ± x / 100)。',
    )
  }

  const hasLayerState = stateVars.some((n) => /(layer|grid|add)/i.test(n))
  if (hasLayerState && !/\bmax_layers\b|\bmaxLayers\b|\bmax_grid\b/i.test(source)) {
    push(
      'unguarded-averaging',
      'high',
      '分层加仓没有层数上限',
      '脚本里有 layer / grid 一类的加仓计数变量，但看不到 max_layers 之类的上限。',
      '不加限制的亏损加仓在单边行情里会把仓位和回撤同时放大，是爆仓最常见的成因。',
      '定义 max_layers 并在加仓条件里硬性判断 layer < max_layers，同时给出总止损。',
    )
  }
  if (hasLayerState && !(facts && facts.hasStop)) {
    push(
      'averaging-without-stop',
      'high',
      '加仓模式没有全局止损',
      '脚本使用分层加仓，但没有调用 stop()。',
      '加仓策略一旦遇到持续单边行情，必须有全局熔断把损失截断。',
      '加 stop(回撤或亏损条件)，并把“按加权均价的总止损”写进交易条件里。',
    )
  }

  if (analysis && facts && tradeCount > 0 && !analysis.positionMode?.chosen) {
    push(
      'no-position-mode',
      'high',
      '没有先确定仓位运行模式',
      `这是一个含交易指令的脚本，但需求规格里的 positionMode 还是空的（可选：一开一平 / 反手 / 分批止盈 / 马丁加仓 / 移动止盈 / 自定义）。`,
      '仓位模式决定了脚本需要哪些状态变量。先补齐这一项，再据此检查开平仓逻辑，否则后面所有风控讨论都缺一个基准。',
      '用 aicoin_spec_draft 把 positionMode 传给用户确认；每种模式都有对应的可运行模板，确认后直接对照改写。',
    )
  }

  // ------------------------------------------------------------- risk control
  const hasStopLossSpec = Boolean(spec.stopLoss)
  const usesAtr = has('atr', 'tr', 'atr')
  const trailingLogic = has('highest', 'lowest') && has('exitLong', 'exitLongAmount', 'exitLongPercent')
  if (!hasStopLossSpec && !usesAtr && !trailingLogic) {
    push(
      'no-stop-loss',
      'high',
      '没有可识别的止损逻辑',
      '脚本里没有 atr()/tr() 止损，也没有基于结构位的移动止损；需求规格里 stopLoss 为空。',
      '没有止损的实盘策略在极端行情下会出现无法承受的单笔亏损，而这一点只能靠规则约束，不能靠“感觉”。',
      '在根作用域加一条：exitLong(close < entry_ref * (1 - stop_pct / 100), ...)，或按 ATR 倍数动态计算止损位。',
    )
  }
  if (!facts || !facts.hasStop) {
    push(
      'no-global-stop',
      'medium',
      '没有全局熔断 stop()',
      '脚本没有调用 stop(cond)。',
      'stop() 是策略级的熔断开关，用于在账户回撤或信号失效时整体停止实盘运行。',
      '建议加：stop(drawdown_cond)，例如连续 N 次亏损或权益跌破阈值时停止。',
    )
  }
  if (!facts || !facts.hasPositionCheck) {
    push(
      'no-position-check',
      'medium',
      '没有读取持仓状态',
      '脚本没有引用 strategy.position，入场条件不依赖当前是否已有仓位。',
      '入场信号在每根 K 线都可能为真，没有持仓判断就可能反复加仓或在已持仓时重复触发。',
      '用 strategy.position 的 long_amount / short_amount 做门槛，例如 stop(long_amt > 0) 或把入场条件与持仓状态做 and。',
    )
  }

  // ------------------------------------------------------------ look-ahead risk
  if (facts && facts.highestLowestCurrentBar.length) {
    push(
      'lookahead-current-bar',
      'high',
      '突破条件可能把当前 K 线算进去了',
      `highest()/lowest() 被直接用于判断，共 ${facts.highestLowestCurrentBar.length} 处（第 ${facts.highestLowestCurrentBar.slice(0, 4).map((h) => h.line).join('、')} 行）。`,
      'highest(high, N) 含当前根，用它生成“突破”信号会在同一根 K 线上用到了当根的最终高低点，历史与实时表现可能不一致。',
      '改写成 highest(high[1], N) / lowest(low[1], N)，即只回看已收盘的 K 线。',
    )
  }
  if (!facts || !facts.hasWarmupGuard) {
    push(
      'no-warmup-guard',
      'medium',
      '缺少历史数据不足时的保护',
      '脚本没有出现 bar_index 判断。',
      '脚本开头若干根 K 线历史不足，指标会返回 nan，条件判断可能出现意外结果甚至立即下单。',
      '加：stop(bar_index < warmup_bars) 或把入场条件与 bar_index >= N 相与。',
    )
  }
  if (facts && facts.divisionCount > 0 && !facts.hasNaGuard) {
    push(
      'unguarded-division',
      'medium',
      '除法没有 nan / 0 保护',
      `脚本有 ${facts.divisionCount} 处除法或取模，但没有使用 na()/nz()。`,
      '分母为 0 或 nan 时结果会变成 nan，后续比较全部为 false，信号会静默消失。',
      '用 nz(x, fallback) 包住可能无效的值；如果你已经用「分母 > 0」手工判断过，请逐处确认每个除法都有对应判断，否则可忽略此条。',
    )
  }

  // --------------------------------------------------------------- repainting
  if (facts && facts.varip > 0) {
    push(
      'varip-repaint',
      'medium',
      'varip 变量会影响实时与历史的一致性',
      `脚本使用了 ${facts.varip} 处 varip。`,
      'varip 在同一根实时 K 线内持续更新，历史回放时却是逐根收盘的结果，信号可能“重绘”。',
      '仅在确实需要盘中实时状态时使用 varip；若用于生成交易信号，请先用 barstate.isconfirmed 之类的条件把它限制在收盘后。',
    )
  }
  if (facts && facts.typeofHazards.size) {
    push(
      'realtime-branch',
      'low',
      'barstate.* 被引用',
      `引用了 ${[...facts.typeofHazards].join('、')}。`,
      'barstate.isrealtime / islast 分支在实时与历史下走不同路径，容易造成信号只在实时出现。',
      '确认这些分支只用于绘图或提示，不参与交易信号判定。',
    )
  }

  // ----------------------------------------------------------- overfitting risk
  const params = facts ? facts.periodLikeNumbers : []
  if (params.length >= 5) {
    push(
      'parameter-sprawl',
      'medium',
      '可调参数偏多，存在过拟合风险',
      `识别到 ${params.length} 个以周期命名的数值参数：${params.slice(0, 8).map((p) => `${p.name}=${p.value}`).join(', ')}${params.length > 8 ? ' …' : ''}。`,
      '参数越多，越容易在历史上被调成“刚好合适”，但换个品种或周期就失效。',
      '把参数集中到脚本顶部的参数区，逐个问“这个数字为什么是它”，并优先用能解释的市场含义（如 20 日、55 根）而不是拟合出来的数值。',
    )
  }
  const magic = facts ? facts.numericLiterals.filter((n) => ![0, 1, -1, 2, 100].includes(n.value)) : []
  if (magic.length >= 12) {
    push(
      'magic-numbers',
      'low',
      '散落的魔法数字较多',
      `脚本中有 ${magic.length} 个非平凡数值字面量。`,
      '阈值散落在各处会让后续调整变得困难，也掩盖了哪个数字真正驱动策略。',
      '把关键阈值提取为顶部具名参数，例如 rsi_ob = 70 / vol_mult = 1.5。',
    )
  }

  // ---------------------------------------------------------------- robustness
  if (facts && facts.requestCalls > 0) {
    push(
      'external-data-dependency',
      'medium',
      '依赖外部数据源',
      `脚本调用了 ${facts.requestCalls} 次 request()/security()。`,
      '跨品种、跨周期或大单资金流数据需要客户端实际可用，且不同周期的对齐方式会影响结果。',
      '先在客户端确认该数据源能取到（len() > 0），并显式处理取不到时的分支。',
    )
  }
  if (facts && facts.tradeCalls.length === 0 && facts.plotCalls === 0) {
    push(
      'no-output',
      'high',
      '脚本没有任何输出',
      '既没有交易函数也没有绘图函数。',
      '这样的脚本在图表上看不到任何东西，也无法产生信号。',
      '至少加一条 plot 或 alertcondition，或明确说明这是纯计算型脚本。',
    )
  }

  // ------------------------------------------------------------------- spec gaps
  if (analysis) {
    const missingRequired = analysis.openQuestions.filter((q) => q.required)
    if (missingRequired.length) {
      push(
        'spec-incomplete',
        'high',
        '需求规格还没填完',
        `还有 ${missingRequired.length} 个必答项未确认：${missingRequired.map((q) => q.label).join('、')}。`,
        '缺少这些取值时，脚本里的阈值只能由我猜，猜出来的数字没有依据，也一定需要你再改。',
        '先把 aicoin_spec_draft 列出的必答项确认掉，再生成代码。',
      )
    }
    if (!spec.positionSize) {
      push(
        'no-position-sizing',
        'high',
        '没有确定下单量',
        '需求规格里 positionSize 为空。',
        'AiCoin 的交易函数必须给出 amount 或 percent，否则生成的脚本无法运行，或只能填一个我编的数字。',
        '确定用固定张数还是账户百分比，例如 percent = 20。',
      )
    }
    if (!spec.evaluation) {
      push(
        'no-acceptance',
        'medium',
        '没有明确验收方式',
        '需求规格里 evaluation 为空。',
        '本插件不能回测，所以“怎么算成功”必须由你定义，否则交付后无法判断是否达标。',
        '写清楚你打算怎么验证：观察信号位置、手工统计、还是接入自己的回测工具。',
      )
    }
  }

  const hasErrors = diagnostics.some((d) => d.severity === 'error')
  if (hasErrors) {
    push(
      'must-fix-errors',
      'high',
      '先修掉静态校验的错误',
      `当前还有 ${diagnostics.filter((d) => d.severity === 'error').length} 个 error 级问题。`,
      'error 级问题对应的是官方文档明确说明会编译失败或必然无效的写法。',
      '逐条按 aicoin_validate 的提示修正后重新校验，直到 error 为 0。',
    )
  }

  const order = { high: 0, medium: 1, low: 2 }
  advice.sort((a, b) => order[a.severity] - order[b.severity] || a.id.localeCompare(b.id))

  return {
    advice,
    facts: facts
      ? {
          calls: facts.calls.length,
          distinctCalls: facts.callNames.size,
          divisions: facts.divisionCount,
          loops: facts.loopCount,
          trades: facts.tradeCalls.length,
          plots: facts.plotCalls,
          varip: facts.varip,
          numericLiterals: facts.numericLiterals.length,
          namedPeriods: facts.periodLikeNumbers.map((p) => `${p.name}=${p.value}`),
          stateVariables: facts.stateVariables,
          hasStrategyPosition: facts.hasStrategyPosition,
        }
      : null,
    metricsAvailable: false,
    noMetricsNotice: NO_METRICS_NOTICE,
  }
}

/** Render the advice as Markdown for the delivery package. */
export function renderAdviceMarkdown({ advice, facts, source, generatedAt }) {
  const lines = []
  lines.push('# 策略优化建议（静态分析）')
  lines.push('')
  lines.push(`- 生成时间：${generatedAt ?? new Date().toISOString()}`)
  lines.push(`- 分析方式：词法 / 语法 / 语义 / 函数库签名比对 + 结构审查`)
  lines.push('')
  lines.push(`> **没有回测数据。** ${NO_METRICS_NOTICE}`)
  lines.push('')
  if (facts) {
    lines.push('## 结构概览')
    lines.push('')
    lines.push(`- 函数调用：${facts.calls} 次，涉及 ${facts.distinctCalls} 个不同函数`)
    lines.push(`- 交易指令：${facts.trades} 条 · 绘图调用：${facts.plots} 条 · 循环：${facts.loops} 个`)
    lines.push(
      `- 仓位状态变量：${facts.stateVariables.length ? `\`${facts.stateVariables.join('`、`')}\`` : '**无**'}` +
        `${facts.hasStrategyPosition ? '（另有 strategy.position 引用）' : ''}`,
    )
    lines.push(`- 数值字面量：${facts.numericLiterals} 个 · varip：${facts.varip} 处`)
    if (facts.namedPeriods.length) lines.push(`- 周期类参数：${facts.namedPeriods.join(', ')}`)
    lines.push('')
  }
  lines.push('## 建议清单')
  lines.push('')
  if (!advice.length) {
    lines.push('未发现结构性风险。这并不等于策略有效——有效性必须由你在客户端验证。')
  }
  for (const item of advice) {
    const badge = { high: '高', medium: '中', low: '低' }[item.severity] ?? item.severity
    lines.push(`### [${badge}] ${item.title}`)
    lines.push('')
    lines.push(`- **现象**：${item.finding}`)
    lines.push(`- **为什么重要**：${item.why}`)
    lines.push(`- **建议动作**：${item.action}`)
    lines.push('')
  }
  if (source) {
    lines.push('## 附：被分析的脚本')
    lines.push('')
    lines.push('```javascript')
    lines.push(source)
    lines.push('```')
  }
  return lines.join('\n')
}
