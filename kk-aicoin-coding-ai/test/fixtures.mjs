/**
 * Test fixtures for the AiScript validator.
 *
 * Every fixture is a script plus the diagnostics it must produce. The negative
 * cases are taken straight from the platform's documented pitfalls (README
 * 「已知坑」), from the parameter tables in the function library, and from the
 * position-state rules that separate "compiles" from "trades correctly".
 */

/**
 * Rules that police strategy hygiene rather than language/function syntax.
 * They fire on the platform's own one-line trading-function examples (which are
 * function demos, not strategies), so the corpus test treats them separately.
 */
export const HYGIENE_RULES = [
  'NO_POSITION_STATE',
  'REPEATED_TRADE_RISK',
  'STATE_NEVER_RESET',
  'EXIT_WITHOUT_ENTRY_RECORD',
  'NO_ENTRY_BAR_RECORD',
]

/** @type {Array<{name: string, why: string, source: string, expect: string[], forbidErrors?: boolean}>} */
export const fixtures = [
  {
    name: 'clean-ma-cross-strategy',
    why: 'A complete, correct strategy with a position state machine must be completely clean.',
    expect: [],
    forbidErrors: true,
    source: `// @version=2
// 双均线趋势策略 —— 带仓位状态机，用于验证校验器不会误报
indicator(precision = 2)

fast_len = 12
slow_len = 26
stop_pct = 2.0
tp_pct = 4.0
max_hold_bars = 48
cooldown_bars = 3
warmup = 60

fast = ma(close, fast_len)
slow = ma(close, slow_len)
golden = crossup(fast, slow)
dead = crossdown(fast, slow)

// 仓位状态：只有 var 才能跨 K 线保存
var in_long = false
var entry_price = 0.0
var entry_bar = 0
var last_exit_bar = 0

stop_hit = in_long and entry_price > 0 and close <= entry_price * (1 - stop_pct / 100)
tp_hit = in_long and entry_price > 0 and close >= entry_price * (1 + tp_pct / 100)
timeout = in_long and entry_bar > 0 and bar_index - entry_bar >= max_hold_bars
cooled = bar_index - last_exit_bar >= cooldown_bars

open_long = golden and not in_long and cooled
close_long = in_long and (dead or stop_hit or tp_hit or timeout)

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

tradeConfig(price = "market", amount = 1)
enterLong(open_long, price = "market", amount = 1)
exitLong(close_long, price = "market", amount = 1)
stop(bar_index < warmup)

plot(fast, title = 'MA12', color = '#26a69a', lineWidth = 1, lineDash = [0], display = true)
plot(slow, title = 'MA26', color = '#ef5350', lineWidth = 1, lineDash = [0], display = true)
plotShape(open_long, title = '金叉', refSeries = low, shape = 'arrowUp', color = '#26a69a', fill = true, placement = 'bottom', display = true)
`,
  },
  {
    name: 'naive-trade-without-state',
    why:
      'The exact failure mode this plugin exists to catch: level-triggered orders with no position state. ' +
      'It compiles, and then opens on every bar the condition holds.',
    expect: ['REPEATED_TRADE_RISK', 'NO_POSITION_STATE'],
    source: `// @version=2
indicator(precision = 2)
ma20 = ma(close, 20)
enterLong(close > ma20, price = "market", amount = 1)
exitLong(close < ma20, price = "market", amount = 1)
plot(ma20, title = 'MA20', color = '#ef5350', lineWidth = 2, lineDash = [0], display = true)
`,
  },
  {
    name: 'state-never-reset',
    why: 'A state machine that can never return to flat stops trading forever after the first entry.',
    expect: ['STATE_NEVER_RESET'],
    source: `// @version=2
indicator(precision = 2)
ma20 = ma(close, 20)

var in_long = false
open_long = crossup(close, ma20) and not in_long

if (open_long) {
    in_long := true
}

tradeConfig(price = "market", amount = 1)
enterLong(open_long, price = "market", amount = 1)
plot(ma20, title = 'MA20', color = '#ef5350', lineWidth = 2, lineDash = [0], display = true)
`,
  },
  {
    name: 'percent-stop-without-entry-price',
    why: 'A percentage stop measured against the CURRENT price drifts on every gap; it needs a recorded entry price.',
    expect: ['EXIT_WITHOUT_ENTRY_RECORD'],
    source: `// @version=2
indicator(precision = 2)
ma20 = ma(close, 20)

var in_long = false
open_long = crossup(close, ma20) and not in_long
close_long = in_long and close <= close * 0.98

if (open_long) {
    in_long := true
}
if (close_long) {
    in_long := false
}

tradeConfig(price = "market", amount = 1)
enterLong(open_long, price = "market", amount = 1)
exitLong(close_long, price = "market", amount = 1)
plot(ma20, title = 'MA20', color = '#ef5350', lineWidth = 2, lineDash = [0], display = true)
`,
  },
  {
    name: 'trading-declared-twice',
    why: 'README 已知坑 2: enterLong/exitLong/enterShort/exitShort may each be declared once.',
    expect: ['SINGLE_DECLARATION'],
    source: `// @version=2
indicator(precision = 2)
ma20 = ma(close, 20)
enterLong(crossup(close, ma20), price = "market", amount = 1)
enterLong(crossdown(close, ma20), price = "market", amount = 1)
plot(ma20, title = 'MA20', color = '#ef5350', lineWidth = 2, lineDash = [0], display = true)
`,
  },
  {
    name: 'named-argument-case',
    why: 'README 已知坑 1: lineWidth must be camelCase; `linewidth` is a compile error.',
    expect: ['NAMED_ARG_CASE'],
    source: `// @version=2
plot(close, title = 'case', linewidth = 2)
`,
  },
  {
    name: 'root-scope-violation',
    why: 'README 已知坑 3: label.new must be called at root scope, not inside an if.',
    expect: ['ROOT_SCOPE_REQUIRED'],
    source: `// @version=2
if (close > open) {
    label.new([time, high], title = 'Tag', text = 'UP', refSeries = high, color = 'red')
}
plot(close, title = 'close')
`,
  },
  {
    name: 'unknown-function',
    why: 'A name outside the 334-entry library must be reported.',
    expect: ['UNKNOWN_FUNCTION'],
    source: `// @version=2
x = maa(close, 20)
plot(x, title = 'x')
`,
  },
  {
    name: 'for-loop-over-limit',
    why: 'README 已知坑 4: a single for loop may not exceed 500 iterations.',
    expect: ['FOR_LOOP_LIMIT'],
    source: `// @version=2
total = 0.0
for (i = 0; i < 600; i++) {
    total += close[i]
}
plot(total, title = 'sum')
`,
  },
  {
    name: 'history-lookback-over-limit',
    why: 'README 已知坑 5: [] may look back at most 500 data points.',
    expect: ['HISTORY_LOOKBACK_LIMIT'],
    source: `// @version=2
x = close[520]
plot(x, title = 'x')
`,
  },
  {
    name: 'index-over-limit',
    why: 'README 已知坑 6: array/dict index stops at 1000.',
    expect: ['INDEX_LENGTH_LIMIT'],
    source: `// @version=2
ary = array_range([1, 2, 3])
x = ary{1200}
plot(x, title = 'x')
`,
  },
  {
    name: 'nan-compared-with-equals',
    why: 'nan == nan is always false; na() is the documented test.',
    expect: ['NAN_COMPARISON'],
    source: `// @version=2
x = close == nan
plot(x ? 1 : 0, title = 'x')
`,
  },
  {
    name: 'division-by-zero',
    why: 'A literal zero divisor is always a defect.',
    expect: ['SUSPICIOUS_DIVISION'],
    source: `// @version=2
x = close / 0
plot(x, title = 'x')
`,
  },
  {
    name: 'assign-in-block-shadows',
    why: 'Inside a block, `=` creates a local; modifying an outer variable needs `:=`.',
    expect: ['ASSIGN_IN_BLOCK_SHADOWS'],
    source: `// @version=2
count = 0
if (close > open) {
    count = count + 1
}
plot(count, title = 'count')
`,
  },
  {
    name: 'array-indexed-with-brackets',
    why: 'README 已知坑 7: [] is history, {} is the array index operator.',
    expect: ['INDEX_ON_NON_COLLECTION'],
    source: `// @version=2
arr = [1, 2, 3]
x = arr[1]
plot(x, title = 'x')
`,
  },
  {
    name: 'unterminated-block',
    why: 'A missing brace must be a syntax error, not a crash.',
    expect: ['PARSE_ERROR'],
    source: `// @version=2
if (close > open) {
    x = 1
plot(close, title = 'c')
`,
  },
  {
    name: 'too-many-arguments',
    why: 'ma(source, length) accepts exactly two arguments.',
    expect: ['ARITY_TOO_MANY'],
    source: `// @version=2
x = ma(close, 20, 30)
plot(x, title = 'x')
`,
  },
  {
    name: 'unknown-named-argument',
    why: 'A parameter the entry does not declare.',
    expect: ['UNKNOWN_NAMED_ARG'],
    source: `// @version=2
p = plot(close, title = 'c', bogusParam = 1)
`,
  },
  {
    name: 'duplicate-trade-id',
    why: 'The *Amount / *Percent trading functions require a unique id.',
    expect: ['DUPLICATE_TRADE_ID'],
    source: `// @version=2
tradeConfig(price = "market", amount = 1)
enterLongAmount(close > open, id = "same_id", price = "market", amount = 100)
exitLongAmount(close < open, id = "same_id", price = "market", amount = 100)
plot(close, title = 'close')
`,
  },
  {
    name: 'config-called-twice',
    why: 'indicator() and tradeConfig() may each be called once.',
    expect: ['CONFIG_ONCE'],
    source: `// @version=2
indicator(precision = 2)
indicator(precision = 4)
plot(close, title = 'close')
`,
  },
  {
    name: 'variadic-and-nested-constructs',
    why: 'Regression: tuple destructuring, for-in over a dict, {} index on a request result, custom function.',
    expect: [],
    forbidErrors: true,
    source: `// @version=2
indicator(precision = 4)

my_avg(a, b) {
    return (a + b) / 2
}

params = {"fast": 12, "slow": 26}
var total = 0
for key, value = range params {
    total := total + value
}

[dif, dea, m] = macd(close, 12, 26, 9, "EMA", "EMA")
avg = my_avg(dif, dea)

data = request("largeOrder:btcswapusdt:binance")
first_price = len(data) > 0 ? data{0}.depth_price : 0
line.new([time[2], open[2], time, close], title = 'TrendLine', refSeries = close, color = 'blue', lineWidth = 2)
plot(avg, title = 'avg', color = '#26a69a', lineWidth = 1, lineDash = [0], display = true)
plot(m, title = 'macd', color = '#ef5350', lineWidth = 1, lineDash = [0], display = true)
alertcondition(crossup(dif, dea), title = 'MACD金叉', direction = 'buy')
`,
  },
]

/** Scripts that must contain at least one diagnostic of each listed kind. */
export const expectations = fixtures.filter((f) => f.expect.length > 0)

/** Scripts that must produce zero error-severity diagnostics. */
export const mustBeErrorFree = fixtures.filter((f) => f.forbidErrors)
