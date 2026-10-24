#!/usr/bin/env node
/**
 * demo.mjs - end-to-end demonstration of kk_aicoin_codingAI without DSH.
 *
 * Registers the plugin against a fake harness context (the same contract the
 * real loader uses), then drives the whole workflow once:
 *
 *   1. aicoin_status          the plugin is loaded and the data is intact
 *   2. aicoin_spec_draft      a vague request -> quantified slots + open questions
 *                             + the position-mode menu (this is the new part)
 *   3. aicoin_scaffold        generate a real state machine from a mode template
 *   4. aicoin_validate        show the checker catching a naive trade script
 *   5. aicoin_optimize_advice structural review
 *   6. aicoin_deliver         produce strategy.txt and the delivery package
 *
 * Everything runs offline. No AiCoin, no network, no backtest numbers.
 *
 *   node tools/demo.mjs [--keep]
 */
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../lib/index.js'

const keep = process.argv.includes('--keep')
const workspace = mkdtempSync(join(tmpdir(), 'kk-aicoin-demo-'))

/** Minimal stand-in for the harness plugin context. */
function makeContext() {
  const tools = new Map()
  const skills = []
  const sections = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      schemas: () => [...tools.values()].map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
    },
    get(name) {
      if (name === 'skills') return { register: (s) => (skills.push(s), () => {}) }
      if (name === 'systemPrompt') return { section: (s) => (sections.push(s), () => {}) }
      return undefined
    },
    on() {},
    effect() {},
  }
  return { ctx, tools, skills, sections }
}

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`)

console.log(`kk_aicoin_codingAI demo · workspace: ${workspace}`)

const { ctx, tools, skills } = makeContext()
const dispose = await plugin.apply(ctx, { enabled: true, workspace })
const run = async (name, args = {}) => {
  const definition = tools.get(name)
  if (!definition) throw new Error(`tool ${name} not registered`)
  const value = await definition.execute(args)
  return String(definition.output.render(args, value)[0].text)
}

rule('0. 注册结果')
console.log(`插件名        : ${plugin.name}`)
console.log(`工具（${tools.size}）: ${[...tools.keys()].join(', ')}`)
console.log(`技能（${skills.length}）: ${skills.map((s) => s.name).join(', ')}`)

rule('1. aicoin_status')
console.log(await run('aicoin_status'))

rule('2. aicoin_spec_draft —— 把「加仓、涨得猛就买、最好稳赚」翻译成可计算条件')
console.log(await run('aicoin_spec_draft', {
  name: 'demo-马丁',
  need: 'BTC 15分钟，涨得猛就买，亏了就加仓摊平，反转了要反手，最好稳赚不亏',
  workspace,
}))

rule('3. aicoin_scaffold —— 用「马丁加仓」模式模板生成带状态机的脚本')
console.log(await run('aicoin_scaffold', { name: 'demo-马丁', template: 'mode-martingale', workspace }))
const martingale = readFileSync(join(workspace, 'aicoin-strategies', 'demo-马丁', 'strategy.txt'), 'utf8')
console.log('\n--- 生成脚本里的仓位状态机（节选）---')
console.log(
  martingale
    .split('\n')
    .filter((line) => /^var |^\s*var |layer :=|avg_price :=|last_add_price :=|in_long :=|enterLongAmount|exitLong\(/.test(line))
    .join('\n'),
)

rule('4. aicoin_validate —— 拦住「能跑但会重复下单」的写法')
const naive = `// @version=2
indicator(precision = 2)
ma20 = ma(close, 20)
enterLong(close > ma20, price = "market", amount = 1)
exitLong(close < ma20, price = "market", amount = 1)
plot(ma20, title = 'MA20', color = '#ef5350', lineWidth = 2, lineDash = [0], display = true)
`
console.log(await run('aicoin_validate', { source: naive, includeInfo: true }))

rule('4b. 同一份脚本，加了状态机之后再校验')
console.log(await run('aicoin_validate', { source: martingale, includeInfo: true }))

rule('5. aicoin_optimize_advice —— 结构审查')
console.log(await run('aicoin_optimize_advice', { source: naive, name: 'demo-马丁', workspace, save: false }))

rule('6. aicoin_deliver —— 交付 strategy.txt')
console.log(await run('aicoin_deliver', {
  name: 'demo-马丁',
  source: martingale,
  workspace,
  summary: '马丁加仓示例：首仓用金叉，每跌 1.5% 加一层，最多 4 层，按加权均价止盈止损。',
}))

rule('7. 交付目录内容')
const dir = join(workspace, 'aicoin-strategies', 'demo-马丁')
for (const file of readdirSync(dir)) {
  console.log(`  ${file.padEnd(24)} ${readFileSync(join(dir, file), 'utf8').length} 字符`)
}
console.log(`\n脚本文件名：${existsSync(join(dir, 'strategy.txt')) ? 'strategy.txt ✅' : '❌ 缺失'}`)
console.log(`是否误产出 .aiscript：${existsSync(join(dir, 'strategy.aiscript')) ? '是 ❌' : '否 ✅'}`)

dispose()
if (keep) console.log(`\n(已保留工作目录：${workspace})`)
else rmSync(workspace, { recursive: true, force: true })
console.log('\ndemo 完成。')
