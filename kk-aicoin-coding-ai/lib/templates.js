/**
 * Strategy scaffolds.
 *
 * These are NOT "a strategy that happens to compile". Every trading template
 * carries an explicit position state machine:
 *
 *   - `var` variables record whether we hold a position, the entry price, the
 *     entry bar and any per-mode counters (take-profit stage, averaging layer,
 *     trailing peak);
 *   - every order condition is EITHER edge-triggered (crossup/crossdown) OR
 *     guarded by that recorded state, so it cannot fire twice on the same setup;
 *   - the state is updated BEFORE the trade calls, in the same bar;
 *   - the state is reset on exit, so the machine can return to flat.
 *
 * Without those properties a script compiles fine and then opens and closes on
 * every bar the condition happens to hold. The bundled validator enforces this
 * via REPEATED_TRADE_RISK / NO_POSITION_STATE, and the test suite runs every
 * template through it.
 *
 * @module kk_aicoin_codingAI/templates
 */

/** Shared footer explaining what was generated and what it cannot promise. */
const FOOTER = `
// ---------------------------------------------------------------------------
// 仓位状态机说明（改代码前务必先读）
//   仓位状态变量   —— var 声明的变量才能跨 K 线保存，是本模板不重复下单的关键
//   entry_price    —— 记录入场价，止损止盈都基于它计算
//   entry_bar      —— 记录入场 K 线，用于时间止损与冷却
//   状态更新必须写在交易调用之前；平仓分支必须把状态复位，否则会一直认为
//   自己仍持仓，或者反过来在每根 K 线重复开仓。
//
// 本脚本由 kk_aicoin_codingAI 生成，仅做代码层面的静态校验。
// 本插件不提供回测，也不输出收益率 / 胜率 / 夏普 / 最大回撤等任何绩效数字。
// 参数取值需要你在客户端图表上确认后自行调整。
// ---------------------------------------------------------------------------`

/**
 * @typedef {object} Template
 * @property {string} id
 * @property {string} title
 * @property {string} description
 * @property {boolean} requiresTrade
 * @property {string|null} mode  position-management mode this template implements
 * @property {string[]} stateVariables  state the machine keeps
 * @property {Array<object>} values
 * @property {(values: Record<string, string|number>, name: string) => string} build
 */

/** @type {Template[]} */
export const TEMPLATES = [
  // ======================================================= 一开一平 family
  {
    id: 'ma-cross',
    title: '双均线趋势跟随 + 一开一平状态机',
    description:
      '金叉开多、死叉平多，同一时间只持一仓，带止损、止盈、时间止损与平仓冷却。仓位状态由 var 变量记录，不会重复开仓。',
    requiresTrade: true,
    mode: 'one-to-one',
    stateVariables: ['in_long', 'entry_price', 'entry_bar', 'last_exit_bar'],
    values: [
      { id: 'fastLen', label: '快线周期', default: 12, desc: '较短周期的均线长度' },
      { id: 'slowLen', label: '慢线周期', default: 26, desc: '较长周期的均线长度' },
      { id: 'stopPct', label: '止损百分比(%)', default: 2.0, desc: '相对记录下来的入场价' },
      { id: 'takeProfitPct', label: '止盈百分比(%)', default: 4.0, desc: '相对入场价' },
      { id: 'maxHoldBars', label: '最长持仓(根)', default: 48, desc: '超过则时间止损' },
      { id: 'cooldownBars', label: '平仓后冷却(根)', default: 3, desc: '避免刚平完就立刻重开' },
      { id: 'warmup', label: '预热根数', default: 60, desc: '历史不足时停止实盘' },
    ],
    build: (v, name) => `// @version=2
// ${name} —— 双均线趋势跟随（一开一平）
indicator(precision = 2)

// ---------------------------- 参数 ----------------------------
fast_len = ${v.fastLen}
slow_len = ${v.slowLen}
stop_pct = ${v.stopPct}
tp_pct = ${v.takeProfitPct}
max_hold_bars = ${v.maxHoldBars}
cooldown_bars = ${v.cooldownBars}
warmup = ${v.warmup}

// ---------------------------- 信号 ----------------------------
fast = ma(close, fast_len)
slow = ma(close, slow_len)
golden = crossup(fast, slow)
dead = crossdown(fast, slow)

// ------------------ 仓位状态（跨 K 线保持） ------------------
var in_long = false
var entry_price = 0.0
var entry_bar = 0
var last_exit_bar = 0

// ------------------------- 状态机条件 -------------------------
stop_hit = in_long and entry_price > 0 and close <= entry_price * (1 - stop_pct / 100)
tp_hit = in_long and entry_price > 0 and close >= entry_price * (1 + tp_pct / 100)
timeout = in_long and entry_bar > 0 and bar_index - entry_bar >= max_hold_bars
cooled = bar_index - last_exit_bar >= cooldown_bars

// 开仓必须同时满足：边沿信号 + 当前空仓 + 冷却结束
open_long = golden and not in_long and cooled
close_long = in_long and (dead or stop_hit or tp_hit or timeout)

// ---------- 状态更新（必须写在交易调用之前） ----------
if (open_long) {
    in_long := true
    entry_price := close
    entry_bar := bar_index
}
if (close_long) {
    in_long := false
    entry_price := 0.0
    last_exit_bar := bar_index
}

// ---------- 交易（根作用域；每个指令只声明一次） ----------
tradeConfig(price = "market", amount = 1)
enterLong(open_long, price = "market", amount = 1)
exitLong(close_long, price = "market", amount = 1)
stop(bar_index < warmup)

// ---------------------------- 绘图 ----------------------------
plot(fast, title = '快线MA', color = '#26a69a', lineWidth = 1, lineDash = [0], display = true)
plot(slow, title = '慢线MA', color = '#ef5350', lineWidth = 1, lineDash = [0], display = true)
plotShape(open_long, title = '开多', refSeries = low, shape = 'arrowUp', color = '#26a69a', fill = true, placement = 'bottom', display = true)
plotShape(close_long, title = '平多', refSeries = high, shape = 'arrowDown', color = '#ef5350', fill = true, placement = 'top', display = true)
${FOOTER}`,
  },
  {
    id: 'donchian-breakout',
    title: '唐奇安通道突破 + 一开一平状态机',
    description:
      '收盘价上穿前 N 根高点开多，下穿出场均线平多，带止损/止盈/时间止损/冷却。通道用 [1] 排除当前根，避免未来函数。',
    requiresTrade: true,
    mode: 'one-to-one',
    stateVariables: ['in_long', 'entry_price', 'entry_bar', 'last_exit_bar'],
    values: [
      { id: 'lookback', label: '通道回看根数', default: 55, desc: '不含当前根' },
      { id: 'exitMaLen', label: '出场均线周期', default: 20, desc: '跌破它即平仓' },
      { id: 'stopPct', label: '止损百分比(%)', default: 2.0, desc: '相对入场价' },
      { id: 'takeProfitPct', label: '止盈百分比(%)', default: 6.0, desc: '相对入场价' },
      { id: 'maxHoldBars', label: '最长持仓(根)', default: 96, desc: '超过则时间止损' },
      { id: 'cooldownBars', label: '平仓后冷却(根)', default: 3, desc: '避免反复进出' },
      { id: 'warmup', label: '预热根数', default: 80, desc: '历史不足时停止实盘' },
    ],
    build: (v, name) => `// @version=2
// ${name} —— 唐奇安通道突破（一开一平）
indicator(precision = 2)

// ---------------------------- 参数 ----------------------------
lookback = ${v.lookback}
exit_ma_len = ${v.exitMaLen}
stop_pct = ${v.stopPct}
tp_pct = ${v.takeProfitPct}
max_hold_bars = ${v.maxHoldBars}
cooldown_bars = ${v.cooldownBars}
warmup = ${v.warmup}

// --------------------------- 通道 ---------------------------
// 用 [1] 取「前一根」为止的高低价，避免把当前根算进通道造成未来函数
upper = highest(high[1], lookback)
lower = lowest(low[1], lookback)
exit_ma = ma(close, exit_ma_len)

breakout = crossup(close, upper)
dead = crossdown(close, exit_ma)

// ------------------ 仓位状态（跨 K 线保持） ------------------
var in_long = false
var entry_price = 0.0
var entry_bar = 0
var last_exit_bar = 0

// ------------------------- 状态机条件 -------------------------
stop_hit = in_long and entry_price > 0 and close <= entry_price * (1 - stop_pct / 100)
tp_hit = in_long and entry_price > 0 and close >= entry_price * (1 + tp_pct / 100)
timeout = in_long and entry_bar > 0 and bar_index - entry_bar >= max_hold_bars
cooled = bar_index - last_exit_bar >= cooldown_bars

open_long = breakout and not in_long and cooled
close_long = in_long and (dead or stop_hit or tp_hit or timeout)

// ---------- 状态更新（必须写在交易调用之前） ----------
if (open_long) {
    in_long := true
    entry_price := close
    entry_bar := bar_index
}
if (close_long) {
    in_long := false
    entry_price := 0.0
    last_exit_bar := bar_index
}

// ---------- 交易（根作用域；每个指令只声明一次） ----------
tradeConfig(price = "market", amount = 1)
enterLong(open_long, price = "market", amount = 1)
exitLong(close_long, price = "market", amount = 1)
stop(bar_index < warmup)

// ---------------------------- 绘图 ----------------------------
plot(upper, title = '上轨', color = '#ef5350', lineWidth = 1, lineDash = [0], display = true)
plot(lower, title = '下轨', color = '#26a69a', lineWidth = 1, lineDash = [0], display = true)
plot(exit_ma, title = '出场MA', color = '#9e9e9e', lineWidth = 1, lineDash = [5, 5], display = true)
plotShape(open_long, title = '突破开多', refSeries = low, shape = 'arrowUp', color = '#ef5350', fill = true, placement = 'bottom', display = true)
plotShape(close_long, title = '平多', refSeries = high, shape = 'arrowDown', color = '#26a69a', fill = true, placement = 'top', display = true)
${FOOTER}`,
  },
  {
    id: 'rsi-reversal',
    title: 'RSI 超卖反转 + 一开一平状态机',
    description: 'RSI 上穿超卖线开多、下穿超买线平多，带止损/止盈/时间止损/冷却。',
    requiresTrade: true,
    mode: 'one-to-one',
    stateVariables: ['in_long', 'entry_price', 'entry_bar', 'last_exit_bar'],
    values: [
      { id: 'rsiLen', label: 'RSI 周期', default: 14, desc: 'RSI 计算长度' },
      { id: 'osLevel', label: '超卖阈值', default: 30, desc: '自下方上穿即开仓' },
      { id: 'obLevel', label: '超买阈值', default: 70, desc: '自上方下穿即平仓' },
      { id: 'stopPct', label: '止损百分比(%)', default: 2.5, desc: '相对入场价' },
      { id: 'takeProfitPct', label: '止盈百分比(%)', default: 4.0, desc: '相对入场价' },
      { id: 'maxHoldBars', label: '最长持仓(根)', default: 36, desc: '超过则时间止损' },
      { id: 'cooldownBars', label: '平仓后冷却(根)', default: 2, desc: '避免反复进出' },
      { id: 'warmup', label: '预热根数', default: 40, desc: '历史不足时停止实盘' },
    ],
    build: (v, name) => `// @version=2
// ${name} —— RSI 超卖反转（一开一平）
indicator(precision = 2)

// ---------------------------- 参数 ----------------------------
rsi_len = ${v.rsiLen}
oversold = ${v.osLevel}
overbought = ${v.obLevel}
stop_pct = ${v.stopPct}
tp_pct = ${v.takeProfitPct}
max_hold_bars = ${v.maxHoldBars}
cooldown_bars = ${v.cooldownBars}
warmup = ${v.warmup}

// ---------------------------- 指标 ----------------------------
r = rsi(close, rsi_len)
enter_sig = crossup(r, oversold)
exit_sig = crossdown(r, overbought)

// ------------------ 仓位状态（跨 K 线保持） ------------------
var in_long = false
var entry_price = 0.0
var entry_bar = 0
var last_exit_bar = 0

// ------------------------- 状态机条件 -------------------------
stop_hit = in_long and entry_price > 0 and close <= entry_price * (1 - stop_pct / 100)
tp_hit = in_long and entry_price > 0 and close >= entry_price * (1 + tp_pct / 100)
timeout = in_long and entry_bar > 0 and bar_index - entry_bar >= max_hold_bars
cooled = bar_index - last_exit_bar >= cooldown_bars

open_long = enter_sig and not in_long and cooled
close_long = in_long and (exit_sig or stop_hit or tp_hit or timeout)

// ---------- 状态更新（必须写在交易调用之前） ----------
if (open_long) {
    in_long := true
    entry_price := close
    entry_bar := bar_index
}
if (close_long) {
    in_long := false
    entry_price := 0.0
    last_exit_bar := bar_index
}

// ---------- 交易（根作用域；每个指令只声明一次） ----------
tradeConfig(price = "market", amount = 1)
enterLong(open_long, price = "market", amount = 1)
exitLong(close_long, price = "market", amount = 1)
stop(bar_index < warmup)

// ---------------------------- 绘图 ----------------------------
plot(r, title = 'RSI', color = '#42a5f5', lineWidth = 1, lineDash = [0], display = true)
plotShape(open_long, title = '超卖反转', refSeries = low, shape = 'arrowUp', color = '#26a69a', fill = true, placement = 'bottom', display = true)
plotShape(close_long, title = '平多', refSeries = high, shape = 'arrowDown', color = '#ef5350', fill = true, placement = 'top', display = true)
alertcondition(open_long, title = 'RSI超卖开多', direction = 'buy')
${FOOTER}`,
  },

  // ========================================================== 反手模式
  {
    id: 'mode-reverse',
    title: '反手模式（平多即开空 / 平空即开多）',
    description:
      '用单个 pos 变量记录 1 / -1 / 0 三态：持多遇到空信号直接反手做空，持空遇到多信号直接反手做多。四个交易指令各声明一次，靠状态区分。',
    requiresTrade: true,
    mode: 'reverse',
    stateVariables: ['pos', 'entry_price', 'entry_bar', 'last_exit_bar'],
    values: [
      { id: 'fastLen', label: '快线周期', default: 12, desc: '较短周期的均线长度' },
      { id: 'slowLen', label: '慢线周期', default: 26, desc: '较长周期的均线长度' },
      { id: 'stopPct', label: '止损百分比(%)', default: 2.0, desc: '多空对称，相对入场价' },
      { id: 'maxHoldBars', label: '最长持仓(根)', default: 48, desc: '超过则时间止损' },
      { id: 'cooldownBars', label: '平仓后冷却(根)', default: 3, desc: '避免原地打转' },
      { id: 'warmup', label: '预热根数', default: 60, desc: '历史不足时停止实盘' },
    ],
    build: (v, name) => `// @version=2
// ${name} —— 反手模式（双向）
indicator(precision = 2)

// ---------------------------- 参数 ----------------------------
fast_len = ${v.fastLen}
slow_len = ${v.slowLen}
stop_pct = ${v.stopPct}
max_hold_bars = ${v.maxHoldBars}
cooldown_bars = ${v.cooldownBars}
warmup = ${v.warmup}

// ---------------------------- 信号 ----------------------------
fast = ma(close, fast_len)
slow = ma(close, slow_len)
long_sig = crossup(fast, slow)
short_sig = crossdown(fast, slow)

// -------- 仓位状态：1 = 持多，-1 = 持空，0 = 空仓 --------
var pos = 0
var entry_price = 0.0
var entry_bar = 0
var last_exit_bar = 0

// ---------------------- 状态机条件 ----------------------
stop_long = pos == 1 and entry_price > 0 and close <= entry_price * (1 - stop_pct / 100)
stop_short = pos == -1 and entry_price > 0 and close >= entry_price * (1 + stop_pct / 100)
timeout_long = pos == 1 and entry_bar > 0 and bar_index - entry_bar >= max_hold_bars
timeout_short = pos == -1 and entry_bar > 0 and bar_index - entry_bar >= max_hold_bars
cooled = bar_index - last_exit_bar >= cooldown_bars

enter_long_cond = long_sig and pos != 1 and cooled
enter_short_cond = short_sig and pos != -1 and cooled

// 反手：持多时出现空信号 → 平多；持空时出现多信号 → 平空
exit_long_cond = pos == 1 and (short_sig or stop_long or timeout_long)
exit_short_cond = pos == -1 and (long_sig or stop_short or timeout_short)

// ---------- 状态更新（必须写在交易调用之前） ----------
// 反手时「平旧仓」和「开新仓」在同一根 K 线发生，所以先写开仓，
// 再用 not enter_* 保护平仓分支，保证 pos 落在正确的方向上。
if (enter_long_cond) {
    pos := 1
    entry_price := close
    entry_bar := bar_index
}
if (enter_short_cond) {
    pos := -1
    entry_price := close
    entry_bar := bar_index
}
if (exit_long_cond and not enter_short_cond) {
    pos := 0
    last_exit_bar := bar_index
}
if (exit_short_cond and not enter_long_cond) {
    pos := 0
    last_exit_bar := bar_index
}

// ---------- 交易（根作用域；四个指令各声明一次） ----------
tradeConfig(price = "market", amount = 1)
enterLong(enter_long_cond, price = "market", amount = 1)
exitLong(exit_long_cond, price = "market", amount = 1)
enterShort(enter_short_cond, price = "market", amount = 1)
exitShort(exit_short_cond, price = "market", amount = 1)
stop(bar_index < warmup)

// ---------------------------- 绘图 ----------------------------
plot(fast, title = '快线MA', color = '#26a69a', lineWidth = 1, lineDash = [0], display = true)
plot(slow, title = '慢线MA', color = '#ef5350', lineWidth = 1, lineDash = [0], display = true)
plotShape(enter_long_cond, title = '开多/反手多', refSeries = low, shape = 'arrowUp', color = '#26a69a', fill = true, placement = 'bottom', display = true)
plotShape(enter_short_cond, title = '开空/反手空', refSeries = high, shape = 'arrowDown', color = '#ef5350', fill = true, placement = 'top', display = true)
${FOOTER}`,
  },

  // ======================================================== 分批止盈模式
  {
    id: 'mode-scaled-tp',
    title: '分批止盈（到价分批减仓）',
    description:
      '持仓后按 +X% / +Y% / +Z% 三档分批减仓，用 tp_stage 变量记录已执行到第几档。每根 K 线最多减一档，最后一批减完即回到空仓。',
    requiresTrade: true,
    mode: 'scaled-tp',
    stateVariables: ['in_long', 'entry_price', 'entry_bar', 'tp_stage', 'last_exit_bar'],
    values: [
      { id: 'fastLen', label: '快线周期', default: 12, desc: '开仓信号快线' },
      { id: 'slowLen', label: '慢线周期', default: 26, desc: '开仓信号慢线' },
      { id: 'tp1Pct', label: '第一档止盈(%)', default: 3.0, desc: '减第一批' },
      { id: 'tp2Pct', label: '第二档止盈(%)', default: 6.0, desc: '减第二批' },
      { id: 'tp3Pct', label: '第三档止盈(%)', default: 9.0, desc: '清掉剩余仓位' },
      { id: 'tp1Percent', label: '第一档减仓比例(%)', default: 30, desc: '占当前持仓' },
      { id: 'tp2Percent', label: '第二档减仓比例(%)', default: 30, desc: '占当前持仓' },
      { id: 'tp3Percent', label: '第三档减仓比例(%)', default: 40, desc: '三档合计 100' },
      { id: 'stopPct', label: '止损百分比(%)', default: 2.0, desc: '相对入场价' },
      { id: 'maxHoldBars', label: '最长持仓(根)', default: 72, desc: '超过则时间止损' },
      { id: 'cooldownBars', label: '平仓后冷却(根)', default: 3, desc: '' },
      { id: 'warmup', label: '预热根数', default: 60, desc: '历史不足时停止实盘' },
    ],
    build: (v, name) => `// @version=2
// ${name} —— 分批止盈
indicator(precision = 2)

// ---------------------------- 参数 ----------------------------
fast_len = ${v.fastLen}
slow_len = ${v.slowLen}
tp1_pct = ${v.tp1Pct}
tp2_pct = ${v.tp2Pct}
tp3_pct = ${v.tp3Pct}
tp1_percent = ${v.tp1Percent}
tp2_percent = ${v.tp2Percent}
tp3_percent = ${v.tp3Percent}
stop_pct = ${v.stopPct}
max_hold_bars = ${v.maxHoldBars}
cooldown_bars = ${v.cooldownBars}
warmup = ${v.warmup}

// ---------------------------- 信号 ----------------------------
fast = ma(close, fast_len)
slow = ma(close, slow_len)
open_sig = crossup(fast, slow)
dead = crossdown(fast, slow)

// ------------------ 仓位状态（跨 K 线保持） ------------------
var in_long = false
var entry_price = 0.0
var entry_bar = 0
// tp_stage：0 = 未止盈，1 = 已减第一批，2 = 已减第二批，3 = 已清仓
var tp_stage = 0
var last_exit_bar = 0

// ---------------------- 状态机条件 ----------------------
// 用 stage 相等判断，保证每根 K 线最多触发一档，不会重复减仓
tp1_cond = in_long and tp_stage == 0 and entry_price > 0 and close >= entry_price * (1 + tp1_pct / 100)
tp2_cond = in_long and tp_stage == 1 and entry_price > 0 and close >= entry_price * (1 + tp2_pct / 100)
tp3_cond = in_long and tp_stage == 2 and entry_price > 0 and close >= entry_price * (1 + tp3_pct / 100)

stop_hit = in_long and entry_price > 0 and close <= entry_price * (1 - stop_pct / 100)
timeout = in_long and entry_bar > 0 and bar_index - entry_bar >= max_hold_bars
exit_all = in_long and (stop_hit or dead or timeout)

cooled = bar_index - last_exit_bar >= cooldown_bars
open_long = open_sig and not in_long and cooled

// ---------- 状态更新（必须写在交易调用之前） ----------
if (open_long) {
    in_long := true
    entry_price := close
    entry_bar := bar_index
    tp_stage := 0
}
if (tp1_cond) {
    tp_stage := 1
}
if (tp2_cond) {
    tp_stage := 2
}
if (tp3_cond) {
    tp_stage := 3
}
// 第三档减完、止损或反向信号 → 回到空仓
if (tp3_cond or exit_all) {
    in_long := false
    entry_price := 0.0
    tp_stage := 0
    last_exit_bar := bar_index
}

// ---------- 交易（根作用域） ----------
// enterLong / exitLong 各只能声明一次；分批减仓用带唯一 id 的 exitLongPercent
tradeConfig(price = "market", amount = 1)
enterLong(open_long, price = "market", amount = 1)
exitLongPercent(tp1_cond, id = "tp_stage1", price = "market", percent = tp1_percent)
exitLongPercent(tp2_cond, id = "tp_stage2", price = "market", percent = tp2_percent)
exitLongPercent(tp3_cond, id = "tp_stage3", price = "market", percent = tp3_percent)
exitLong(exit_all, price = "market", amount = 1)
stop(bar_index < warmup)

// ---------------------------- 绘图 ----------------------------
plot(fast, title = '快线MA', color = '#26a69a', lineWidth = 1, lineDash = [0], display = true)
plot(slow, title = '慢线MA', color = '#ef5350', lineWidth = 1, lineDash = [0], display = true)
plotShape(open_long, title = '开多', refSeries = low, shape = 'arrowUp', color = '#26a69a', fill = true, placement = 'bottom', display = true)
plotShape(tp1_cond, title = '止盈1', refSeries = high, shape = 'circle', color = '#42a5f5', fill = true, placement = 'top', display = true)
plotShape(tp2_cond, title = '止盈2', refSeries = high, shape = 'circle', color = '#7e57c2', fill = true, placement = 'top', display = true)
plotShape(tp3_cond, title = '止盈3', refSeries = high, shape = 'circle', color = '#ef5350', fill = true, placement = 'top', display = true)
${FOOTER}`,
  },

  // ======================================================== 马丁加仓模式
  {
    id: 'mode-martingale',
    title: '马丁加仓（逆势分层加仓）',
    description:
      '首仓后每下跌 X% 加一层，最多 N 层；用 layer 记录层数、avg_price 记录加权均价，按均价统一止盈止损。风险很高：亏损加仓会放大回撤。',
    requiresTrade: true,
    mode: 'martingale',
    stateVariables: ['in_long', 'layer', 'avg_price', 'last_add_price', 'entry_bar', 'last_exit_bar'],
    values: [
      { id: 'fastLen', label: '首仓信号快线', default: 12, desc: '首仓用金叉进入' },
      { id: 'slowLen', label: '首仓信号慢线', default: 26, desc: '' },
      { id: 'maxLayers', label: '最大加仓层数', default: 4, desc: '含首仓' },
      { id: 'layerDropPct', label: '每层加仓跌幅(%)', default: 1.5, desc: '相对上一次加仓价' },
      { id: 'stopPct', label: '总止损(%)', default: 8.0, desc: '相对加权均价，务必按承受力设' },
      { id: 'takeProfitPct', label: '止盈(%)', default: 3.0, desc: '相对加权均价' },
      { id: 'maxHoldBars', label: '最长持仓(根)', default: 120, desc: '超过则时间止损' },
      { id: 'cooldownBars', label: '清仓后冷却(根)', default: 5, desc: '避免立刻再进' },
      { id: 'warmup', label: '预热根数', default: 60, desc: '历史不足时停止实盘' },
    ],
    build: (v, name) => `// @version=2
// ${name} —— 马丁加仓
// ⚠ 高风险：亏损加仓会放大回撤。先把 max_layers 与 stop_pct 调到你能承受的范围再用。
indicator(precision = 2)

// ---------------------------- 参数 ----------------------------
fast_len = ${v.fastLen}
slow_len = ${v.slowLen}
max_layers = ${v.maxLayers}
layer_drop_pct = ${v.layerDropPct}
stop_pct = ${v.stopPct}
tp_pct = ${v.takeProfitPct}
max_hold_bars = ${v.maxHoldBars}
cooldown_bars = ${v.cooldownBars}
warmup = ${v.warmup}

// ---------------------------- 信号 ----------------------------
fast = ma(close, fast_len)
slow = ma(close, slow_len)

// ------------------ 仓位状态（跨 K 线保持） ------------------
var in_long = false
var layer = 0            // 已建层数，0 表示空仓
var avg_price = 0.0      // 持仓加权均价
var last_add_price = 0.0 // 上一次加仓价，决定下一层的触发位
var entry_bar = 0
var last_exit_bar = 0

// ---------------------- 状态机条件 ----------------------
cooled = bar_index - last_exit_bar >= cooldown_bars
first_entry = crossup(fast, slow) and not in_long and cooled

// 加仓：只在持仓、层数未满、且相对上一次加仓价又跌了 layer_drop_pct 时触发。
// 触发后 last_add_price 会被更新，所以同一价位不会重复加仓。
add_cond = in_long and layer < max_layers and last_add_price > 0 and close <= last_add_price * (1 - layer_drop_pct / 100)

stop_hit = in_long and avg_price > 0 and close <= avg_price * (1 - stop_pct / 100)
tp_hit = in_long and avg_price > 0 and close >= avg_price * (1 + tp_pct / 100)
timeout = in_long and entry_bar > 0 and bar_index - entry_bar >= max_hold_bars
exit_all = in_long and (stop_hit or tp_hit or timeout)

// ---------- 状态更新（必须写在交易调用之前） ----------
if (first_entry) {
    in_long := true
    layer := 1
    avg_price := close
    last_add_price := close
    entry_bar := bar_index
}
if (add_cond) {
    // 先算新层数，再按新层数加权：avg_price * (旧层数) + close，除以新层数
    layer := layer + 1
    avg_price := (avg_price * (layer - 1) + close) / layer
    last_add_price := close
}
if (exit_all) {
    in_long := false
    layer := 0
    avg_price := 0.0
    last_add_price := 0.0
    last_exit_bar := bar_index
}

// ---------- 交易（根作用域） ----------
// 首仓与加仓各用带唯一 id 的 enterLongAmount；两者都是「一次声明、多次触发」
tradeConfig(price = "market", amount = 1)
enterLongAmount(first_entry, id = "martingale_first", price = "market", amount = 1)
enterLongAmount(add_cond, id = "martingale_add", price = "market", amount = 1)
exitLong(exit_all, price = "market", amount = 1)
stop(bar_index < warmup)

// ---------------------------- 绘图 ----------------------------
plot(fast, title = '快线MA', color = '#26a69a', lineWidth = 1, lineDash = [0], display = true)
plot(slow, title = '慢线MA', color = '#ef5350', lineWidth = 1, lineDash = [0], display = true)
plotShape(first_entry, title = '首仓', refSeries = low, shape = 'arrowUp', color = '#26a69a', fill = true, placement = 'bottom', display = true)
plotShape(add_cond, title = '加仓', refSeries = low, shape = 'circle', color = '#ffa726', fill = true, placement = 'bottom', display = true)
plotShape(exit_all, title = '清仓', refSeries = high, shape = 'arrowDown', color = '#ef5350', fill = true, placement = 'top', display = true)
${FOOTER}`,
  },

  // ======================================================== 移动止盈模式
  {
    id: 'mode-trailing',
    title: '移动止盈（跟踪峰值回撤出场）',
    description:
      '盈利超过激活阈值后启动移动止盈：用 peak_price 记录持仓期间最高价，价格从峰值回撤 X% 就平仓；同时保留硬止损与时间止损。',
    requiresTrade: true,
    mode: 'trailing',
    stateVariables: ['in_long', 'entry_price', 'peak_price', 'entry_bar', 'last_exit_bar'],
    values: [
      { id: 'fastLen', label: '开仓信号快线', default: 12, desc: '' },
      { id: 'slowLen', label: '开仓信号慢线', default: 26, desc: '' },
      { id: 'activatePct', label: '激活移动止盈的盈利(%)', default: 2.0, desc: '达到后才开始跟踪' },
      { id: 'trailPct', label: '峰值回撤平仓(%)', default: 1.5, desc: '从最高价回撤多少平仓' },
      { id: 'stopPct', label: '硬止损(%)', default: 2.0, desc: '相对入场价' },
      { id: 'maxHoldBars', label: '最长持仓(根)', default: 72, desc: '超过则时间止损' },
      { id: 'cooldownBars', label: '平仓后冷却(根)', default: 3, desc: '' },
      { id: 'warmup', label: '预热根数', default: 60, desc: '历史不足时停止实盘' },
    ],
    build: (v, name) => `// @version=2
// ${name} —— 移动止盈
indicator(precision = 2)

// ---------------------------- 参数 ----------------------------
fast_len = ${v.fastLen}
slow_len = ${v.slowLen}
activate_pct = ${v.activatePct}
trail_pct = ${v.trailPct}
stop_pct = ${v.stopPct}
max_hold_bars = ${v.maxHoldBars}
cooldown_bars = ${v.cooldownBars}
warmup = ${v.warmup}

// ---------------------------- 信号 ----------------------------
fast = ma(close, fast_len)
slow = ma(close, slow_len)
open_sig = crossup(fast, slow)
dead = crossdown(fast, slow)

// ------------------ 仓位状态（跨 K 线保持） ------------------
var in_long = false
var entry_price = 0.0
var peak_price = 0.0   // 持仓期间见过的最高价
var entry_bar = 0
var last_exit_bar = 0

// ---------------------- 状态机条件 ----------------------
cooled = bar_index - last_exit_bar >= cooldown_bars
open_long = open_sig and not in_long and cooled

// 先更新峰值，再据此计算回撤，顺序不能反
if (in_long and high > peak_price) {
    peak_price := high
}

armed = in_long and entry_price > 0 and peak_price >= entry_price * (1 + activate_pct / 100)
trail_exit = armed and peak_price > 0 and close <= peak_price * (1 - trail_pct / 100)
stop_hit = in_long and entry_price > 0 and close <= entry_price * (1 - stop_pct / 100)
timeout = in_long and entry_bar > 0 and bar_index - entry_bar >= max_hold_bars
close_long = in_long and (trail_exit or stop_hit or dead or timeout)

// ---------- 状态更新（开仓写下、平仓复位） ----------
if (open_long) {
    in_long := true
    entry_price := close
    peak_price := high
    entry_bar := bar_index
}
if (close_long) {
    in_long := false
    entry_price := 0.0
    peak_price := 0.0
    last_exit_bar := bar_index
}

// ---------- 交易（根作用域；每个指令只声明一次） ----------
tradeConfig(price = "market", amount = 1)
enterLong(open_long, price = "market", amount = 1)
exitLong(close_long, price = "market", amount = 1)
stop(bar_index < warmup)

// ---------------------------- 绘图 ----------------------------
plot(fast, title = '快线MA', color = '#26a69a', lineWidth = 1, lineDash = [0], display = true)
plot(slow, title = '慢线MA', color = '#ef5350', lineWidth = 1, lineDash = [0], display = true)
plot(peak_price, title = '持仓峰值', color = '#42a5f5', lineWidth = 1, lineDash = [5, 5], display = true)
plotShape(open_long, title = '开多', refSeries = low, shape = 'arrowUp', color = '#26a69a', fill = true, placement = 'bottom', display = true)
plotShape(close_long, title = '平多', refSeries = high, shape = 'arrowDown', color = '#ef5350', fill = true, placement = 'top', display = true)
${FOOTER}`,
  },

  // ================================================== 不下单的纯信号模板
  {
    id: 'volume-spike-alert',
    title: '放量急涨预警（只出信号，不自动下单）',
    description:
      '成交量超过均量若干倍、同时价格在数根 K 线内涨幅达标时给出预警。不含任何交易指令，没有仓位风险。',
    requiresTrade: false,
    mode: null,
    stateVariables: [],
    values: [
      { id: 'volLen', label: '均量周期', default: 20, desc: '成交量均线长度' },
      { id: 'volMult', label: '放量倍数', default: 1.5, desc: 'volume >= ma(volume, volLen) * 该倍数' },
      { id: 'riseBars', label: '涨幅观察根数', default: 3, desc: '在几根 K 线内计算涨幅' },
      { id: 'risePct', label: '涨幅阈值(%)', default: 3, desc: '达到该百分比才算急涨' },
    ],
    build: (v, name) => `// @version=2
// ${name} —— 放量急涨预警（只出信号，不自动下单）
indicator(precision = 2)

// ---------------------------- 参数 ----------------------------
vol_len = ${v.volLen}
vol_mult = ${v.volMult}
rise_bars = ${v.riseBars}
rise_pct = ${v.risePct}

// ---------------------------- 条件 ----------------------------
avg_vol = ma(volume, vol_len)
volume_spike = volume >= avg_vol * vol_mult

// 注意：分母可能为 0，先判 > 0 再算涨幅
prev_close = close[rise_bars]
price_rise = prev_close > 0 and close / prev_close - 1 >= rise_pct / 100

signal = volume_spike and price_rise

// ---------------------------- 输出 ----------------------------
alertcondition(signal, title = '放量急涨', direction = 'buy')
plot(volume, title = '成交量', color = '#26a69a', lineWidth = 1, lineDash = [0], display = true)
plotShape(signal, title = '放量急涨', refSeries = high, shape = 'circle', color = '#ef5350', fill = true, placement = 'top', display = true)
${FOOTER}`,
  },
  {
    id: 'swing-structure',
    title: '摆动结构 + 支撑压力（只画图）',
    description:
      '用收盘价新高/新低确认摆动方向并连成折线，同时画出前 N 根的支撑与压力水平线。结构类指标的起点。',
    requiresTrade: false,
    mode: null,
    stateVariables: ['swing_points', 'swing_dir'],
    values: [
      { id: 'swingLen', label: '摆动确认周期', default: 30, desc: '用收盘价判定的新高/新低周期' },
      { id: 'levelLen', label: '支撑压力周期', default: 29, desc: '支撑/压力取前 N 根的高低点' },
    ],
    build: (v, name) => `// @version=2
// ${name} —— 摆动结构 + 支撑压力
indicator(precision = 2)

// ---------------------------- 参数 ----------------------------
swing_len = ${v.swingLen}
level_len = ${v.levelLen}

// ------------------------- 状态变量 --------------------------
// 摆动点坐标交替存放 [t1, p1, t2, p2, ...]
var swing_points = []
var swing_dir = 1

// ---------------------- 一、摆动线 ----------------------
if (array_size(swing_points) == 0) {
    array_append(swing_points, time)
    array_append(swing_points, high)
} else {
    if (swing_dir == 1) {
        if (high > array_last(swing_points)) {
            array_set(swing_points, array_size(swing_points) - 2, time)
            array_set(swing_points, array_size(swing_points) - 1, high)
        }
        if (low < lowest(close[1], swing_len)) {
            array_append(swing_points, time)
            array_append(swing_points, low)
            swing_dir := -1
        }
    } else {
        if (low < array_last(swing_points)) {
            array_set(swing_points, array_size(swing_points) - 2, time)
            array_set(swing_points, array_size(swing_points) - 1, low)
        }
        if (high > highest(close[1], swing_len)) {
            array_append(swing_points, time)
            array_append(swing_points, high)
            swing_dir := 1
        }
    }
}

// ---------------------- 二、支撑与压力 ----------------------
// 用 [1] 取前一根，避免把当前根算进水平位
support = lowest(low[1], level_len)
resistance = highest(high[1], level_len)

// ------------------------- 三、绘图（根作用域） -------------------------
plot(support, title = '支撑', color = '#03c903', lineWidth = 2, lineDash = [0], display = true)
plot(resistance, title = '压力', color = '#f3390a', lineWidth = 2, lineDash = [0], display = true)
line.new(swing_points, title = '摆动线', refSeries = close, color = '#00F1F2', lineWidth = 3, lineDash = [3, 4], display = true)
${FOOTER}`,
  },
]

/** Look up a template by id. */
export function findTemplate(id) {
  return TEMPLATES.find((t) => t.id === id)
}

/** Resolve a template id plus overrides into concrete values. */
export function resolveValues(template, overrides = {}) {
  const values = {}
  for (const spec of template.values) {
    const raw = overrides[spec.id]
    values[spec.id] = raw === undefined || raw === null || raw === '' ? spec.default : raw
  }
  return values
}

/** Templates that actually place orders. */
export function tradingTemplates() {
  return TEMPLATES.filter((t) => t.requiresTrade)
}
