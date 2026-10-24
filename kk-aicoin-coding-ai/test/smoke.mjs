#!/usr/bin/env node
/**
 * Plugin smoke test.
 *
 * Loads `lib/index.js` with a fake harness context (the real plugin contract:
 * `ctx.tools.register`, `ctx.get('skills')`, `ctx.get('systemPrompt')`,
 * `ctx.on`), asserts everything registers, then CALLS every tool and checks the
 * envelope. This is what proves the plugin actually works before it is installed
 * into a profile.
 *
 * Usage: node test/smoke.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../lib/index.js'

let failures = 0
let checks = 0
const check = (label, condition, detail = '') => {
  checks += 1
  if (condition) {
    if (process.env.VERBOSE) console.log(`  ok    ${label}`)
    return true
  }
  failures += 1
  console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  return false
}

function makeContext() {
  const tools = new Map()
  const skills = []
  const sections = []
  const listeners = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      get(n) {
        return tools.get(n)
      },
      schemas() {
        return [...tools.values()].map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
      },
    },
    get(name) {
      if (name === 'skills') return { register: (skill) => (skills.push(skill), () => {}) }
      if (name === 'systemPrompt') return { section: (section) => (sections.push(section), () => {}) }
      return undefined
    },
    on(event, handler) {
      listeners.set(event, handler)
    },
    effect(fn) {
      listeners.set('effect', fn)
      return () => {}
    },
  }
  return { ctx, tools, skills, sections, listeners }
}

const call = async (tools, name, args = {}) => {
  const definition = tools.get(name)
  if (!definition) throw new Error(`tool ${name} is not registered`)
  const value = await definition.execute(args)
  // The harness renders whatever `output.render` returns; make sure that works.
  const rendered = definition.output.render(args, value)
  if (!Array.isArray(rendered) || typeof rendered[0]?.text !== 'string') {
    throw new Error(`tool ${name} produced an invalid render`)
  }
  return { value, text: rendered[0].text }
}

const EXPECTED_TOOLS = [
  'aicoin_status',
  'aicoin_library_search',
  'aicoin_library_get',
  'aicoin_language_reference',
  'aicoin_spec_draft',
  'aicoin_spec_status',
  'aicoin_validate',
  'aicoin_scaffold',
  'aicoin_optimize_advice',
  'aicoin_deliver',
  'aicoin_live_check',
  'aicoin_library_refresh',
]

const workspace = mkdtempSync(join(tmpdir(), 'kk-aicoin-smoke-'))
console.log(`smoke workspace: ${workspace}`)

try {
  console.log('\n[1] registration')
  const { ctx, tools, skills, sections } = makeContext()
  const dispose = await plugin.apply(ctx, { enabled: true, workspace })
  check('plugin exports inject = ["tools"]', Array.isArray(plugin.inject) && plugin.inject.includes('tools'))
  check('plugin exports a name', typeof plugin.name === 'string' && plugin.name.length > 0)
  check('exports a Config', Boolean(plugin.Config))
  check(`registered ${EXPECTED_TOOLS.length} tools`, tools.size === EXPECTED_TOOLS.length, `got ${tools.size}: ${[...tools.keys()].join(', ')}`)
  for (const expected of EXPECTED_TOOLS) check(`tool ${expected} present`, tools.has(expected))
  check('exactly one skill registered', skills.length === 1, `got ${skills.length}`)
  if (skills.length) {
    check('skill name is kebab-case', /^[a-z0-9]+(-[a-z0-9]+)*$/.test(skills[0].name), skills[0].name)
    check('skill has a description', typeof skills[0].description === 'string' && skills[0].description.length > 20)
    check('skill has content', typeof skills[0].content === 'string' && skills[0].content.length > 500)
    check('skill declares whenToUse', typeof skills[0].whenToUse === 'string' && skills[0].whenToUse.length > 10)
  }
  check('one prompt section registered', sections.length === 1, `got ${sections.length}`)
  if (sections.length) {
    check('prompt section forbids backtest claims', /回测/.test(sections[0].text))
    check('prompt section has a finite order', Number.isFinite(sections[0].order))
  }

  console.log('\n[2] tool behaviour')
  {
    const { text, value } = await call(tools, 'aicoin_status')
    check('status reports the library size', /334/.test(text), text.slice(0, 200))
    check('status states metricsAvailable=false', value.data.metricsAvailable === false)
  }
  {
    const { text, value } = await call(tools, 'aicoin_library_search', { query: 'ma', limit: 5 })
    check('library_search finds ma', /■ ma\b/.test(text), text.slice(0, 300))
    check('library_search returns structured results', Array.isArray(value.data.results) && value.data.results.length > 0)
  }
  {
    const { text } = await call(tools, 'aicoin_library_search', { query: 'crossup', withExample: true })
    check('library_search honours withExample', /示例/.test(text))
  }
  {
    const { text } = await call(tools, 'aicoin_library_search', { query: 'zzzzz-not-a-function' })
    check('library_search misses gracefully', /没有匹配/.test(text))
  }
  {
    const { text } = await call(tools, 'aicoin_library_get', { name: 'line.new' })
    check('library_get resolves the dotted name line.new', /line\.new/.test(text) && /lineWidth/.test(text), text.slice(0, 300))
    check('library_get marks root-scope limit', /根作用域/.test(text))
  }
  {
    const { text } = await call(tools, 'aicoin_library_get', { name: 'enterLong' })
    check('library_get marks single-declaration limit', /最多声明一次/.test(text))
  }
  {
    const { text } = await call(tools, 'aicoin_language_reference', { section: 'limits' })
    check('language_reference lists the 500 loop cap', /500/.test(text))
    check('language_reference lists the 1000 index cap', /1000/.test(text))
  }
  {
    const { text, value } = await call(tools, 'aicoin_spec_draft', {
      name: 'smoke-spec',
      need: 'BTC 15分钟 涨得猛就买，放量突破更好，最好稳赚不亏',
      workspace,
    })
    check('spec_draft flags the vague phrase 涨得猛', /涨得猛/.test(text))
    check('spec_draft flags the profit-guarantee request', /稳赚|高胜率/.test(text))
    check('spec_draft refuses backtest data', /不提供回测|不提供任何回测|回测/.test(text))
    check('spec_draft is not ready to code', value.data.readyToCode === false)
    check('spec_draft offers the position modes', /一开一平/.test(text) && /马丁加仓/.test(text) && /移动止盈/.test(text))
    check('spec_draft lists the state variables per mode', /in_long/.test(text) && /peak_price/.test(text))
    check('spec_draft reports positionMode as unchosen', value.data.positionMode?.chosen === null)
    check('spec_draft wrote spec.md', existsSync(join(workspace, 'aicoin-strategies', 'smoke-spec', 'spec.md')))
  }
  {
    const { text, value } = await call(tools, 'aicoin_spec_draft', {
      name: 'smoke-spec',
      values: {
        market: 'binance BTCUSDT 永续',
        timeframe: '15m',
        direction: '只做多',
        positionMode: 'one-to-one',
        entry: 'close 上穿 ma(close,20) 且 volume > ma(volume,20)*1.5',
        exit: 'close 下穿 ma(close,20)',
        stopLoss: '入场价下方 2%',
        positionSize: 'percent = 20',
        evaluation: '客户端图表观察信号位置',
        'vague:big-rise': '3 根 K 线内 ≥ 3%',
        'vague:volume-up': '> ma(volume,20) * 1.5',
        'vague:breakout': '前 20 根高点',
        'vague:profit-guarantee': '改为明确的技术条件',
      },
      workspace,
    })
    check('spec_draft becomes readyToCode once answered', value.data.readyToCode === true, JSON.stringify(value.data.completeness))
    check('spec_draft resolves the chosen mode to a template', value.data.positionMode?.template === 'ma-cross', JSON.stringify(value.data.positionMode))
    check('spec_draft reports the mode state variables', (value.data.positionMode?.stateVariables ?? []).includes('in_long'))
    void text
  }
  {
    const { value } = await call(tools, 'aicoin_spec_status', { name: 'smoke-spec', workspace })
    check('spec_status reads the saved spec', value.data.completeness?.readyToCode === true)
  }
  {
    const { text, value } = await call(tools, 'aicoin_scaffold', {
      name: 'smoke-tpl',
      template: 'ma-cross',
      values: { fastLen: 8, slowLen: 21 },
      workspace,
    })
    check('scaffold writes strategy.txt', existsSync(join(workspace, 'aicoin-strategies', 'smoke-tpl', 'strategy.txt')))
    check('scaffold reports a clean validation', /通过/.test(text))
    check('scaffold applied the override', readFileSync(join(workspace, 'aicoin-strategies', 'smoke-tpl', 'strategy.txt'), 'utf8').includes('fast_len = 8'))
    void value
  }
  {
    const broken = `// @version=2
plot(close, title = 'case', linewidth = 2)
x = maa(close, 20)
`
    const { text, value } = await call(tools, 'aicoin_validate', { source: broken, includeInfo: true })
    check('validate catches NAMED_ARG_CASE', /NAMED_ARG_CASE/.test(text))
    check('validate catches UNKNOWN_FUNCTION', /UNKNOWN_FUNCTION/.test(text))
    check('validate reports ok=false', value.data.passed === false)
    check('validate never claims backtest', !/回测(通过|结果)/.test(text))
  }
  {
    const clean = readFileSync(join(workspace, 'aicoin-strategies', 'smoke-tpl', 'strategy.txt'), 'utf8')
    const { text, value } = await call(tools, 'aicoin_validate', { source: clean })
    check('validate passes a scaffolded script', value.data.passed === true, text.slice(0, 400))
  }
  {
    const risky = `// @version=2
indicator(precision = 2)
// 回测胜率 78%，年化收益 120%
upper = highest(high, 20)
entry_signal = close > upper
tradeConfig(price = "market", amount = 1)
enterLong(entry_signal, price = "market", amount = 1)
plot(upper, title = '上轨', color = '#ef5350', lineWidth = 1, lineDash = [0], display = true)
`
    const { text, value } = await call(tools, 'aicoin_optimize_advice', { source: risky, name: 'smoke-nospec', workspace, save: true })
    check('advice flags the look-ahead highest(high, N)', /highest\(high\[1\]/.test(text))
    check('advice flags the missing stop', /止损/.test(text))
    check('advice states metricsAvailable=false', value.data.metricsAvailable === false)
    check('advice carries the no-metrics notice', /不提供也不推测任何回测/.test(text))
    check('advice flags the unverifiable comment claim', /无法验证的绩效数字|绩效/.test(text))
  }
  {
    const { text } = await call(tools, 'aicoin_validate', {
      source: "// @version=2\n// 回测胜率 78%\nplot(close, title = 'c')\n",
    })
    check('validate reports performance claims in comments', /胜率|绩效/.test(text))
  }
  {
    const failing = "// @version=2\nplot(close, title = 'c', linewidth = 2)\n"
    const { text, value } = await call(tools, 'aicoin_deliver', { name: 'smoke-fail', source: failing, workspace })
    check('deliver refuses a script with errors', value.ok === false && /拒绝交付/.test(text))
  }
  {
    const { text, value } = await call(tools, 'aicoin_spec_draft', {
      name: 'smoke-tpl',
      need: '双均线金叉做多，15m，BTC',
      values: {
        market: 'binance BTCUSDT 永续',
        timeframe: '15m',
        direction: '只做多',
        positionMode: 'one-to-one',
        entry: 'crossup(ma(close,8), ma(close,21))',
        exit: 'crossdown(ma(close,8), ma(close,21))',
        stopLoss: '入场价下方 2%',
        positionSize: 'amount = 1',
        evaluation: '客户端图表观察信号位置',
        'vague:cross': 'ma(close,8) 上穿 ma(close,21)',
      },
      workspace,
    })
    check('second spec is ready to code', value.data.readyToCode === true, JSON.stringify(value.data.completeness))
    void text
  }
  {
    const clean = readFileSync(join(workspace, 'aicoin-strategies', 'smoke-tpl', 'strategy.txt'), 'utf8')
    const { text, value } = await call(tools, 'aicoin_deliver', {
      name: 'smoke-tpl',
      source: clean,
      workspace,
      summary: '双均线趋势跟随，参数在顶部。',
    })
    check('deliver succeeds on a clean script', value.ok === true, text.slice(0, 400))
    check('deliver names the script strategy.txt', /strategy\.txt/.test(text))
    const dir = join(workspace, 'aicoin-strategies', 'smoke-tpl')
    for (const file of ['strategy.txt', 'spec.md', 'validation-report.md', 'optimization-advice.md', 'README.md']) {
      check(`deliver wrote ${file}`, existsSync(join(dir, file)))
    }
    check('deliver does NOT write strategy.aiscript', !existsSync(join(dir, 'strategy.aiscript')))
    const readme = readFileSync(join(dir, 'README.md'), 'utf8')
    check('delivery README states there is no backtest', /不含任何回测数据|没有回测/.test(readme))
    check('delivery README documents the position state machine', /仓位状态机/.test(readme) && /不会重复下单|重复下单/.test(readme))
    check('delivery README names the chosen mode', /一开一平/.test(readme))
    check('delivery README does not fabricate a win rate', !/(胜率|收益率|夏普|最大回撤)\s*[:：]?\s*\d/.test(readme.replace(/不会提供|不提供|不含|不算|没有/g, '')))
  }
  {
    const { text, value } = await call(tools, 'aicoin_scaffold', {
      name: 'smoke-trailing',
      template: 'mode-trailing',
      workspace,
    })
    check('scaffold builds a trailing-stop template', /通过/.test(text))
    const source = readFileSync(join(workspace, 'aicoin-strategies', 'smoke-trailing', 'strategy.txt'), 'utf8')
    check('trailing template records peak_price', /var peak_price/.test(source))
    check('trailing template guards entry with state', /not in_long/.test(source))
    const validated = await call(tools, 'aicoin_validate', { source, includeInfo: true })
    check('trailing template validates with zero diagnostics', validated.value.data.diagnostics.length === 0, JSON.stringify(validated.value.data.diagnostics))
  }
  {
    const naive = `// @version=2
indicator(precision = 2)
ma20 = ma(close, 20)
enterLong(close > ma20, price = "market", amount = 1)
exitLong(close < ma20, price = "market", amount = 1)
plot(ma20, title = 'MA20', color = '#ef5350', lineWidth = 2, lineDash = [0], display = true)
`
    const { text, value } = await call(tools, 'aicoin_validate', { source: naive, includeInfo: true })
    check('validate catches level-triggered orders', /REPEATED_TRADE_RISK/.test(text))
    check('validate catches missing position state', /NO_POSITION_STATE/.test(text))
    const { text: adviceText, value: adviceValue } = await call(tools, 'aicoin_optimize_advice', { source: naive, workspace })
    check('advice flags the missing state machine', /no-state-machine|没有记录仓位状态/.test(adviceText))
    check('advice flags the repeat-order risk', /repeated-order-risk|重复触发/.test(adviceText))
    check('advice reports no state variables', Array.isArray(adviceValue.data.facts?.stateVariables) && adviceValue.data.facts.stateVariables.length === 0)
  }
  {
    // Regression: a script whose state comes from strategy.position instead of
    // `var` flags must NOT be accused of having no position state.
    const viaPosition = `// @version=2
indicator(precision = 2)
ma20 = ma(close, 20)

pos = strategy.position
long_amt = nz(pos{"long_amount"})
long_px = nz(pos{"long_price"})
is_flat = long_amt <= 0
is_long = long_amt > 0

entry_long = crossup(close, ma20) and is_flat
exit_long = is_long and long_px > 0 and close < long_px * 0.98

tradeConfig(price = "market", amount = 1)
enterLong(entry_long, price = "market", amount = 1)
exitLong(exit_long, price = "market", amount = 1)
plot(ma20, title = 'MA20', color = '#ef5350', lineWidth = 2, lineDash = [0], display = true)
`
    const validated = await call(tools, 'aicoin_validate', { source: viaPosition, includeInfo: true })
    check('strategy.position counts as position state', validated.value.data.passed === true, JSON.stringify(validated.value.data.diagnostics))
    const { text, value } = await call(tools, 'aicoin_optimize_advice', { source: viaPosition, workspace })
    check('advice recognises strategy.position as state', value.data.facts?.hasStrategyPosition === true)
    check('advice does NOT claim there is no position state', !/没有记录仓位状态/.test(text) && !/既没有状态变量/.test(text), text.slice(0, 400))
  }
  {
    const { text, value } = await call(tools, 'aicoin_live_check', { action: 'probe', port: 9222 })
    check('live_check probe degrades gracefully', typeof text === 'string' && text.length > 0)
    check('live_check reports the port state', value.data.port === 9222)
    check('live_check never writes', typeof value.data.open === 'boolean')
  }

  console.log('\n[3] teardown')
  {
    const before = tools.size
    dispose()
    check('disposer unregisters every tool', tools.size === 0, `${before} -> ${tools.size}`)
    const dirs = readdirSync(join(workspace, 'aicoin-strategies'))
    check('workspace contains the strategy folders', dirs.includes('smoke-spec') && dirs.includes('smoke-tpl'), dirs.join(', '))
  }
} finally {
  rmSync(workspace, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'SMOKE ALL GREEN' : `${failures} FAILURE(S)`} - ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
