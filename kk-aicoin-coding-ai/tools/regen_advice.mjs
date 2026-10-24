/**
 * Regenerate the optimisation advice for an existing strategy folder using the
 * CURRENT (fixed) module, so the file on disk is not left with the pre-fix text.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadKnowledge } from '../lib/data.js'
import { parse } from '../lib/aiscript/parser.js'
import { validateScript } from '../lib/aiscript/validate.js'
import { analyzeRequirement } from '../lib/spec.js'
import { buildAdvice, renderAdviceMarkdown } from '../lib/advice.js'

const dir = process.argv[2]
if (!dir) {
  console.error('用法: node tools/regenerate_advice.mjs <策略目录>')
  process.exit(1)
}

const kb = loadKnowledge(fileURLToPath(new URL('../data/', import.meta.url)))
const scriptPath = `${dir}/strategy.aiscript`
const source = readFileSync(scriptPath, 'utf8')
const parsed = parse(source)
const result = validateScript(source, kb, { includeInfo: true })

let specValues = {}
try {
  specValues = JSON.parse(readFileSync(`${dir}/spec.json`, 'utf8')).values ?? {}
} catch {
  /* no spec saved */
}
const analysis = analyzeRequirement('', specValues)
const review = buildAdvice({ source, ast: parsed.ast, spec: specValues, analysis, diagnostics: result.diagnostics })

const out = renderAdviceMarkdown({ advice: review.advice, facts: review.facts, source })
writeFileSync(`${dir}/optimization-advice.md`, out, 'utf8')

console.log(`已重新生成 ${dir}/optimization-advice.md`)
console.log(`建议 ${review.advice.length} 条：`)
for (const item of review.advice) console.log(`  [${item.severity}] ${item.id} — ${item.title}`)
console.log(`\n仓位状态变量：${review.facts.stateVariables.length ? review.facts.stateVariables.join(', ') : '无'}`)
console.log(`读取 strategy.position：${review.facts.hasStrategyPosition ? '是' : '否'}`)
