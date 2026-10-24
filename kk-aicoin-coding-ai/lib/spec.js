/**
 * Requirement objectification.
 *
 * A trader's request ("涨得猛就买，跌了就跑") is not a specification. This module
 * turns such a request into (a) a fixed set of quantified slots, (b) a list of
 * concrete open questions the assistant MUST get answered, and (c) rewritten
 * measurable definitions for every vague phrase it recognises.
 *
 * Everything here is deterministic and inspectable: no model call, no guessing
 * about performance, no invented thresholds. Where a slot cannot be derived from
 * the user's words, it stays open and is asked about explicitly.
 *
 * @module kk_aicoin_codingAI/spec
 */

/**
 * Position-management modes the user must choose between.
 *
 * This is not cosmetic: the chosen mode determines which state variables the
 * script needs. Without one, the generated code cannot know whether it already
 * holds a position — which is exactly how "compiles fine, trades wrong" happens.
 */
export const POSITION_MODES = [
  {
    id: 'one-to-one',
    label: '一开一平',
    question: '同一时间只持一仓：出现信号开仓，反向信号 / 止损 / 止盈平仓，平掉之后才允许再开。',
    template: 'ma-cross',
    state: ['in_long', 'entry_price', 'entry_bar', 'last_exit_bar'],
    risk: '无额外风险；最适合作为起点。',
  },
  {
    id: 'reverse',
    label: '反手',
    question: '持多遇到空信号 → 平多并开空；持空遇到多信号 → 平空并开多。',
    template: 'mode-reverse',
    state: ['pos', 'entry_price', 'entry_bar', 'last_exit_bar'],
    risk: '震荡行情里会被反复打脸，手续费与滑点成本高。',
  },
  {
    id: 'scaled-tp',
    label: '分批止盈',
    question: '到达第一 / 第二 / 第三档目标价分别减仓 30% / 30% / 40%，用 tp_stage 记录已执行到第几档。',
    template: 'mode-scaled-tp',
    state: ['in_long', 'entry_price', 'tp_stage', 'last_exit_bar'],
    risk: '依赖 exitLongPercent 按比例减仓；档位设太密会频繁交易。',
  },
  {
    id: 'martingale',
    label: '马丁加仓',
    question: '首仓后每下跌 X% 加一层，最多 N 层，按加权均价统一止盈止损。',
    template: 'mode-martingale',
    state: ['layer', 'avg_price', 'last_add_price', 'entry_bar'],
    risk: '高风险：亏损加仓会成倍放大回撤，必须先定死最大层数与总止损。',
  },
  {
    id: 'trailing',
    label: '移动止盈',
    question: '盈利超过激活阈值后启动跟踪，从持仓期间最高价回撤 X% 就平仓。',
    template: 'mode-trailing',
    state: ['peak_price', 'entry_price', 'entry_bar', 'last_exit_bar'],
    risk: '需要记录持仓峰值；回撤阈值太窄会被正常波动扫出。',
  },
  {
    id: 'custom',
    label: '自定义',
    question: '你把开平仓规则描述清楚，我按你的规则设计状态变量与状态机。',
    template: null,
    state: [],
    risk: '规则必须能明确回答「当前是否持仓 / 持多少 / 什么条件进出」，否则无法保证不重复执行。',
  },
]

/** Words that hint at a particular mode, so the assistant can pre-suggest one. */
export const POSITION_MODE_HINTS = [
  { pattern: /(加仓|补仓|倍投|马丁|摊平|越跌越买)/, mode: 'martingale' },
  { pattern: /(反手|多空切换|翻仓|双向|做多做空都做)/, mode: 'reverse' },
  { pattern: /(分批止盈|分批平|减仓|部分平仓|分几次)/, mode: 'scaled-tp' },
  { pattern: /(移动止盈|跟踪止盈|回撤止盈|移动止损|跟踪止损|保本)/, mode: 'trailing' },
  { pattern: /(一开一平|只持一仓|不加仓|不反手|单仓)/, mode: 'one-to-one' },
]

/** The slots a strategy must fill before code is written. */
export const SPEC_FIELDS = [
  {
    id: 'market',
    label: '市场与品种',
    required: true,
    question: '这个策略跑在哪个市场、哪个品种上？（例：币安 BTCUSDT 永续合约 / 现货 ETHUSDT）',
    why: '不同品种的 tick 精度、手续费与波动范围不同，会直接影响阈值取值。',
    example: 'binance BTCUSDT 永续',
  },
  {
    id: 'timeframe',
    label: '周期',
    required: true,
    question: '信号在哪个 K 线周期上计算？（1m / 5m / 15m / 1h / 4h / 1d）',
    why: '同一个阈值在不同周期上的含义完全不同，周期不明确就无法写死参数。',
    example: '15m',
  },
  {
    id: 'direction',
    label: '交易方向',
    required: true,
    question: '只做多、只做空，还是双向？',
    why: '方向决定了要不要写 enterShort/exitShort，也决定风控对称性。',
    example: '只做多',
  },
  {
    id: 'positionMode',
    label: '仓位运行模式（必须选择）',
    required: true,
    question:
      '开平仓怎么运行？请从这些里选一种：' +
      POSITION_MODES.map((m) => m.label).join(' / ') +
      '。每种模式我都有对应的状态机模板：' +
      POSITION_MODES.filter((m) => m.template)
        .map((m) => `${m.label} → ${m.template}`)
        .join('、') +
      '。',
    why:
      '这一项直接决定脚本要用哪些变量记录仓位状态。不定下来，生成的代码就不知道自己是否已经持仓，' +
      '会出现重复开仓、平仓失效、止损按错误基准计算的问题——代码能跑，但交易行为是错的。',
    example: '一开一平（同一时间只持一仓，平掉之后才允许再开）',
  },
  {
    id: 'entry',
    label: '入场条件（必须可计算）',
    required: true,
    question: '什么条件成立时算入场信号？请给出指标 + 阈值 + 周期。',
    why: '这是策略的核心；「感觉要涨」无法编译成代码，必须是可计算的真假表达式。',
    example: 'close 上穿 ma(close, 20) 且 volume > ma(volume, 20) * 1.5',
  },
  {
    id: 'exit',
    label: '出场条件',
    required: true,
    question: '什么时候平仓？是反向信号、达到目标价，还是超时？',
    why: '只有入场没有出场的脚本会一直持仓，风控形同虚设。',
    example: 'close 下穿 ma(close, 20)',
  },
  {
    id: 'stopLoss',
    label: '止损',
    required: true,
    question: '止损怎么定？（固定百分比 / ATR 倍数 / 前低下方 N%）',
    why:
      '没有止损的策略在实盘中会出现无法承受的回撤；这也是必须量化的风控参数。' +
      '止损必须相对「记录下来的入场价」计算，而不是相对当前价——否则每次跳空后止损位都会跟着漂移。',
    example: '入场价下方 2%，或 1.5 * atr(close, 14)',
  },
  {
    id: 'takeProfit',
    label: '止盈',
    required: false,
    question: '有明确止盈吗？还是只靠移动止损/反向信号出场？若是分批止盈，请给出各档比例。',
    why: '止盈决定盈亏比；如果只靠反向信号，需要明确说明。',
    example: '盈亏比 1:2，即 +4% 止盈；或分三档 3%/6%/9% 减 30%/30%/40%',
  },
  {
    id: 'positionSize',
    label: '下单量',
    required: true,
    question: '每次下单多少？（固定张数 / 固定金额 / 账户百分比）',
    why: 'AiCoin 的交易函数需要 amount / percent 参数，不填写无法生成可运行脚本。',
    example: '账户余额的 20%（percent = 20）',
  },
  {
    id: 'riskPerTrade',
    label: '单笔风险上限',
    required: false,
    question: '单笔交易最多允许亏掉账户的百分之几？',
    why: '与止损距离一起决定仓位；没有它就无法判断仓位是否合理。',
    example: '账户的 1%',
  },
  {
    id: 'maxHolding',
    label: '持仓时间上限',
    required: false,
    question: '最长持仓多久？（例：24 根 K 线 / 2 天）',
    why: '时间止损可以避免信号失效后长期占用资金；实现方式是开仓时记录 entry_bar，之后比较 bar_index。',
    example: '48 根 K 线',
  },
  {
    id: 'dataDependencies',
    label: '数据依赖',
    required: false,
    question: '除了当前品种当前周期，还需要别的数据吗？（大单、资金流、多品种）',
    why: 'request() 系列函数取的是跨品种/跨周期数据，需要单独确认可用性。',
    example: 'largeOrder:btcswapusdt:binance',
  },
  {
    id: 'edgeCases',
    label: '边界处理',
    required: false,
    question: '数据不足（历史 K 线不够）、跳空、极端行情时希望怎么处理？平仓后要不要冷却几根 K 线？',
    why: '不处理边界会让脚本在开盘早期出现 nan 或异常下单；冷却可以避免刚平完就原地重开。',
    example: 'bar_index < 200 时不下单；平仓后冷却 3 根 K 线',
  },
  {
    id: 'evaluation',
    label: '验收方式（明确不做回测）',
    required: true,
    question: '你打算怎么判断这个脚本是有效的？（注意：本插件不提供回测数据，AiCoin 拆包编辑器也没有回测功能）',
    why: '本插件只能做静态代码校验与逻辑审查；策略优劣必须由你在客户端观察或自行统计，插件不会给出收益率、胜率等任何回测数字。',
    example: '我在 AiCoin 图表上看信号位置是否合理，并自行记录',
  },
]

/**
 * Vague phrase -> measurable rewrite.
 *
 * `pattern` is matched against the user's own wording. `rewrite` is a template
 * that always contains at least one explicit parameter the user must supply,
 * which is what makes the follow-up question concrete instead of "please
 * clarify".
 */
export const VAGUE_PATTERNS = [
  {
    id: 'big-rise',
    pattern: /(涨得猛|大涨|暴涨|拉盘|猛涨|急涨)/,
    rewrite: '最近 N 根 K 线涨幅 ≥ X%：close / close[N] - 1 >= X/100',
    question: '「涨得猛」需要量化：几根 K 线内涨多少算猛？（例：3 根 K 线内涨 3%）',
    options: ['1 根 K 线内 ≥ 2%', '3 根 K 线内 ≥ 3%', '5 根 K 线内 ≥ 5%'],
  },
  {
    id: 'big-drop',
    pattern: /(跌得狠|大跌|暴跌|砸盘|猛跌|急跌)/,
    rewrite: '最近 N 根 K 线跌幅 ≥ X%：1 - close / close[N] >= X/100',
    question: '「跌得狠」需要量化：几根 K 线内跌多少算狠？',
    options: ['1 根 K 线内 ≥ 2%', '3 根 K 线内 ≥ 3%', '5 根 K 线内 ≥ 5%'],
  },
  {
    id: 'volume-up',
    pattern: /(放量|成交量放大|量能起来|量增)/,
    rewrite: 'volume >= ma(volume, N) * K（N 为均量周期，K 为放量倍数）',
    question: '「放量」的基准是什么？建议用 volume >= ma(volume, 20) * 1.5，是否接受？',
    options: ['> ma(volume,20) * 1.5', '> ma(volume,20) * 2', '> ma(volume,60) * 1.5'],
  },
  {
    id: 'volume-down',
    pattern: /(缩量|成交萎缩|量能萎缩)/,
    rewrite: 'volume <= ma(volume, N) * K',
    question: '「缩量」取多少倍均量？建议 volume <= ma(volume, 20) * 0.7。',
    options: ['< ma(volume,20) * 0.7', '< ma(volume,20) * 0.5'],
  },
  {
    id: 'overbought',
    pattern: /(超买|涨太多|高位钝化)/,
    rewrite: 'rsi(close, N) > 70（或 stoch/stochrsi 的对应阈值）',
    question: '「超买」用 RSI 还是随机指标？阈值取多少？',
    options: ['rsi(close,14) > 70', 'rsi(close,14) > 80', 'stochrsi 相关阈值 > 80'],
  },
  {
    id: 'oversold',
    pattern: /(超卖|跌太多|低位钝化)/,
    rewrite: 'rsi(close, N) < 30',
    question: '「超卖」的指标与阈值取多少？',
    options: ['rsi(close,14) < 30', 'rsi(close,14) < 20', 'stochrsi 相关阈值 < 20'],
  },
  {
    id: 'cross',
    pattern: /(金叉|死叉|均线交叉|上穿|下穿)/,
    rewrite: 'crossup(fast, slow) / crossdown(fast, slow)，其中 fast、slow 为具体均线',
    question: '金叉/死叉用哪两条线、什么周期？',
    options: ['ma(close,12) 上穿 ma(close,26)', 'ma(close,5) 上穿 ma(close,20)', 'ema(close,9) 上穿 ema(close,21)'],
  },
  {
    id: 'breakout',
    pattern: /(突破|创新高|创新低|破位|新高|新低)/,
    rewrite: '突破：close > highest(high[1], N)；跌破：close < lowest(low[1], N)',
    question: '「突破」看多少根 K 线的高点？（用前 N 根而不是含当前根，避免未来函数）',
    options: ['前 20 根', '前 55 根', '前 120 根'],
  },
  {
    id: 'trend-up',
    pattern: /(趋势向上|多头排列|上升趋势|趋势行情)/,
    rewrite: 'ma(close, N1) > ma(close, N2) and close > ma(close, N1)',
    question: '趋势用什么定义？建议双均线 + 价格在均线上方，请给出周期。',
    options: ['ma20 > ma60 且 close > ma20', 'ma50 > ma200 且 close > ma50'],
  },
  {
    id: 'range',
    pattern: /(震荡|盘整|横盘|箱体)/,
    rewrite: '波动收窄：bbw(close, N, K) < X 或 atr(close, N) / close < X%',
    question: '「震荡」用什么衡量收窄？需要具体阈值。',
    options: ['atr(close,14)/close < 1%', 'bbw(close,20,2) < 5'],
  },
  {
    id: 'pullback',
    pattern: /(回调|回踩|洗盘|回撤后)/,
    rewrite: '从近期高点回落不超过 X% 后重新走强：close > lowest(low, N) * (1 + X/100)',
    question: '「回调」允许回撤多少？在几根 K 线内算有效？',
    options: ['前 20 根内回撤 ≤ 3%', '前 50 根内回撤 ≤ 5%'],
  },
  {
    id: 'support-resistance',
    pattern: /(支撑|压力|阻力)/,
    rewrite: '支撑 = lowest(low[1], N)，压力 = highest(high[1], N)（不含当前根）',
    question: '支撑/压力取多少根 K 线的高低点？',
    options: ['前 29 根（与点金线一致）', '前 20 根', '前 55 根'],
  },
  {
    id: 'fast-slow',
    pattern: /(尽快|及时|马上|迅速|立刻)/,
    rewrite: '在 N 根 K 线内完成动作，例如 barslast(cond) <= N',
    question: '「尽快」需要上限：几根 K 线内？',
    options: ['1 根 K 线内', '3 根 K 线内'],
  },
  {
    id: 'long-short-term',
    pattern: /(长线|短线|长期|短期|中线)/,
    rewrite: '把「长/短」映射为具体周期：短线 5m~15m，中线 1h~4h，长线 1d',
    question: '「长/短线」对应哪个 K 线周期？',
    options: ['5m', '15m', '1h', '4h', '1d'],
  },
  {
    id: 'position-weight',
    pattern: /(轻仓|重仓|半仓|满仓|仓位)/,
    rewrite: '用百分比下单：enterLongPercent(cond, id, price, percent)',
    question: '「轻/重仓」对应的具体百分比是多少？',
    options: ['轻仓 10%', '半仓 50%', '满仓 100%'],
  },
  {
    id: 'profit-guarantee',
    pattern: /(稳定盈利|保证盈利|只赚不亏|高胜率|必胜|稳赚)/,
    rewrite: '无法量化为可编译条件，也不会由本插件承诺',
    question:
      '「稳赚/高胜率」不是可计算的条件，也无法被验证：本插件不能回测，也不会给出任何收益率或胜率数字。请改成可量化的入场/出场规则。',
    options: ['改为明确的技术条件', '先只做信号提示（不自动下单）'],
  },
  {
    id: 'vague-degree',
    pattern: /(差不多|大概|可能|稍微|一点|有点|略微)/,
    rewrite: '需要精确阈值，不接受「差不多」',
    question: '这里需要一个明确数值：请给出具体阈值或百分比。',
    options: ['我来给具体数值', '请你按主流做法给一个默认值，我再调整'],
  },
  {
    id: 'backtest-request',
    pattern: /(回测|复盘数据|胜率多少|收益率|年化|夏普|最大回撤多少)/,
    rewrite: '本插件不提供任何回测/收益数据',
    question:
      '本插件无法提供回测数据：拆包的 AiCoin 编辑器里不存在回测功能，我也不会编造收益率、胜率、夏普或最大回撤这类数字。我可以在客户端图表上帮你确认信号位置，并给出基于代码逻辑的优化方向。',
    options: ['先要可运行的脚本，回测我自己做', '先要代码逻辑审查与优化建议'],
  },
]

/** Optional user-facing presets so the assistant can offer concrete defaults. */
export const RISK_PRESETS = [
  { id: 'conservative', label: '保守', riskPerTrade: '0.5%', positionSize: 'percent = 10', stop: '1.5 * atr(close, 14)' },
  { id: 'balanced', label: '均衡', riskPerTrade: '1%', positionSize: 'percent = 25', stop: '2% 固定止损' },
  { id: 'aggressive', label: '激进', riskPerTrade: '3%', positionSize: 'percent = 50', stop: '3.5 * atr(close, 14)' },
]

/**
 * Analyse a raw requirement together with whatever the user has already
 * answered, and report what is still missing.
 *
 * @param {string} need - the user's own words (may be empty).
 * @param {Record<string, unknown>} spec - the slot values known so far.
 * @returns {{ recognised: Array<object>, openQuestions: Array<object>, filled: object, completeness: object, unquantified: string[] }}
 */
export function analyzeRequirement(need, spec = {}) {
  const text = String(need ?? '')
  const recognised = []

  for (const rule of VAGUE_PATTERNS) {
    const match = rule.pattern.exec(text)
    if (!match) continue
    // Answers may be keyed either bare (`big-rise`) or namespaced
    // (`vague:big-rise`) - accept both so a caller cannot silently lose them.
    const raw = spec[`vague:${rule.id}`] ?? spec[rule.id]
    const answered = raw !== undefined && raw !== null && String(raw).trim() !== ''
    recognised.push({
      id: rule.id,
      matched: match[0],
      rewrite: rule.rewrite,
      question: rule.question,
      options: rule.options,
      answered,
      answer: answered ? raw : null,
    })
  }

  const filled = {}
  const openQuestions = []
  for (const field of SPEC_FIELDS) {
    const value = spec[field.id]
    const present = value !== undefined && value !== null && String(value).trim() !== ''
    filled[field.id] = present
    if (!present) {
      openQuestions.push({
        id: field.id,
        label: field.label,
        required: field.required,
        question: field.question,
        why: field.why,
        example: field.example,
      })
    }
  }

  // Vague phrases the user has not yet pinned down are their own open questions.
  for (const item of recognised) {
    if (item.answered) continue
    openQuestions.push({
      id: `vague:${item.id}`,
      label: `模糊表述「${item.matched}」`,
      required: true,
      question: item.question,
      why: `原文「${item.matched}」不是可计算条件。建议改写成：${item.rewrite}`,
      example: item.options?.[0] ?? '',
    })
  }

  const requiredOpen = openQuestions.filter((q) => q.required)
  const unquantified = recognised.filter((r) => !r.answered).map((r) => r.matched)

  // Pre-suggest a position mode from the user's own wording, so the question is
  // "is 马丁 what you mean?" rather than an open menu with no context.
  const suggestedModes = POSITION_MODE_HINTS.filter((hint) => hint.pattern.test(text)).map((hint) => {
    const mode = POSITION_MODES.find((m) => m.id === hint.mode)
    return { id: hint.mode, label: mode?.label ?? hint.mode, template: mode?.template ?? null }
  })
  const chosenMode = spec.positionMode ? POSITION_MODES.find((m) => m.id === spec.positionMode) ?? null : null

  return {
    recognised,
    openQuestions,
    filled,
    unquantified,
    positionMode: {
      chosen: chosenMode ? chosenMode.id : spec.positionMode || null,
      chosenLabel: chosenMode?.label ?? null,
      suggested: suggestedModes,
      template: chosenMode?.template ?? null,
      stateVariables: chosenMode?.state ?? [],
      risk: chosenMode?.risk ?? null,
      available: POSITION_MODES,
    },
    completeness: {
      totalFields: SPEC_FIELDS.length,
      filledFields: SPEC_FIELDS.filter((f) => filled[f.id]).length,
      requiredFields: SPEC_FIELDS.filter((f) => f.required).length,
      requiredOpen: requiredOpen.length,
      readyToCode: requiredOpen.length === 0,
      percent: Math.round((SPEC_FIELDS.filter((f) => filled[f.id]).length / SPEC_FIELDS.length) * 100),
    },
  }
}

/** Stable directory name for a strategy. */
export function slugify(value) {
  const text = String(value ?? '').trim()
  const ascii = text
    .replace(/[^\w\u4E00-\u9FAF-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
  return (ascii || 'strategy').slice(0, 48).toLowerCase()
}

/** Render the quantified specification as Markdown. */
export function renderSpecMarkdown({ name, need, spec, analysis, createdAt }) {
  const lines = []
  lines.push(`# 策略需求规格书：${name}`)
  lines.push('')
  lines.push(`- 生成时间：${createdAt ?? new Date().toISOString()}`)
  lines.push(`- 完成度：${analysis.completeness.percent}%（必填项剩余 ${analysis.completeness.requiredOpen} 个）`)
  lines.push('- 本文档由 kk_aicoin_codingAI 按「量化工程师」标准把口语需求改写为可计算条件。')
  lines.push('')
  if (need) {
    lines.push('## 用户的原始表述')
    lines.push('')
    lines.push('> ' + String(need).replace(/\n/g, '\n> '))
    lines.push('')
  }
  lines.push('## 一、已客观化的参数')
  lines.push('')
  lines.push('| 槽位 | 值 | 是否已确认 |')
  lines.push('| --- | --- | --- |')
  for (const field of SPEC_FIELDS) {
    const value = spec[field.id]
    const present = value !== undefined && value !== null && String(value).trim() !== ''
    lines.push(`| ${field.label} | ${present ? String(value).replace(/\|/g, '\\|') : '（未填写）'} | ${present ? '是' : '否'} |`)
  }
  lines.push('')
  const mode = analysis.positionMode ?? {}
  lines.push('## 二、仓位运行模式')
  lines.push('')
  lines.push(
    mode.chosen
      ? `已选择：**${mode.chosenLabel ?? mode.chosen}**${mode.template ? `（模板 ${mode.template}）` : '（自定义）'}`
      : '**尚未选择。** 这一步必须先定下来——它决定脚本用哪些变量记录仓位状态。',
  )
  if (mode.stateVariables?.length) {
    lines.push('')
    lines.push(`需要记录的状态变量：\`${mode.stateVariables.join('`、`')}\``)
  }
  if (mode.risk) {
    lines.push('')
    lines.push(`该模式风险提示：${mode.risk}`)
  }
  lines.push('')
  lines.push('| 模式 | 运行方式 | 对应模板 | 需要的状态变量 | 风险 |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const option of POSITION_MODES) {
    const mark = mode.chosen === option.id ? ' ✅' : ''
    lines.push(
      `| ${option.label}${mark} | ${option.question.replace(/\|/g, '\\|')} | ${option.template ?? '（自定义）'} | ` +
        `${option.state.length ? option.state.join(', ') : '—'} | ${option.risk.replace(/\|/g, '\\|')} |`,
    )
  }
  lines.push('')
  lines.push('## 三、模糊表述的量化改写')
  lines.push('')
  if (analysis.recognised.length) {
    lines.push('| 原文 | 判定 | 可计算的写法 | 是否已确认取值 |')
    lines.push('| --- | --- | --- | --- |')
    for (const item of analysis.recognised) {
      lines.push(
        `| ${item.matched} | ${item.id} | ${item.rewrite.replace(/\|/g, '\\|')} | ${item.answered ? '是' : '否'} |`,
      )
    }
  } else {
    lines.push('未识别到内置模糊词表中的表述。')
  }
  lines.push('')
  lines.push('## 四、待确认问题（必须回答后才能写代码）')
  lines.push('')
  if (!analysis.openQuestions.length) {
    lines.push('无。需求已满足编码条件。')
  } else {
    for (const question of analysis.openQuestions) {
      lines.push(`- [${question.required ? '必答' : '建议'}] **${question.label}**：${question.question}`)
      if (question.why) lines.push(`  - 为什么问：${question.why}`)
      if (question.example) lines.push(`  - 可接受示例：${String(question.example).replace(/\n/g, ' ')}`)
    }
  }
  lines.push('')
  lines.push('## 五、能力边界（不可协商）')
  lines.push('')
  lines.push('- 本插件**不提供回测**，也不输出收益率、胜率、夏普、最大回撤等任何绩效数字。')
  lines.push('- 拆包的 AiCoin 编辑器本身**没有回测功能**，所以任何此类数字都只能是编造的。')
  lines.push('- 插件能做的：把需求量化、按函数库生成可编译脚本、做静态逻辑校验、给出基于代码结构的优化方向。')
  return lines.join('\n')
}

/** Render the open questions as a compact, model-facing list. */
export function renderOpenQuestions(analysis) {
  if (!analysis.openQuestions.length) return '需求已完整，可以开始写代码。'
  return analysis.openQuestions
    .map((q, index) => {
      const tag = q.required ? '必答' : '建议'
      const options = q.example ? `\n   - 可选示例：${String(q.example).replace(/\n/g, ' ')}` : ''
      return `${index + 1}. [${tag}] ${q.label}：${q.question}${options}`
    })
    .join('\n')
}
