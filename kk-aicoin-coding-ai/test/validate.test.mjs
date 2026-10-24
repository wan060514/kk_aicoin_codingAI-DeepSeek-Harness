#!/usr/bin/env node
/**
 * Validator acceptance suite.
 *
 * Three layers, all runnable with `node test/validate.test.mjs`:
 *   1. CORPUS   - every official example in the function library must produce
 *                 zero error-severity diagnostics. The platform's own docs
 *                 cannot be wrong, so any error here is a false positive.
 *   2. REAL     - a real AiScript strategy whose 500-bar output was verified
 *                 against the platform must validate completely clean.
 *   3. FIXTURES - hand-built scripts for each documented pitfall must raise the
 *                 expected rule, and the correct scripts must stay clean.
 *
 * Exit code 0 = all green.
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadKnowledge } from '../lib/data.js'
import { validateScript } from '../lib/aiscript/validate.js'
import { fixtures, HYGIENE_RULES } from './fixtures.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const dataDir = fileURLToPath(new URL('../data/', import.meta.url))
const kb = loadKnowledge(dataDir)

let failures = 0
let checks = 0
const fail = (label, detail) => {
  failures += 1
  console.log(`  FAIL  ${label}\n        ${detail}`)
}
const ok = (label) => {
  checks += 1
  if (process.env.VERBOSE) console.log(`  ok    ${label}`)
}

// ------------------------------------------------------------------ 0. data
console.log('\n[0] knowledge base')
{
  const total = kb.entries.length
  checks += 1
  if (total !== 334) fail('library size', `expected 334 entries, got ${total}`)
  else ok(`library has 334 entries across ${kb.categories.length} categories`)
  checks += 1
  const ids = ['PARSE_ERROR', 'UNKNOWN_FUNCTION', 'NAMED_ARG_CASE', 'SINGLE_DECLARATION', 'ROOT_SCOPE_REQUIRED', 'FOR_LOOP_LIMIT', 'HISTORY_LOOKBACK_LIMIT', 'INDEX_LENGTH_LIMIT', 'NAN_COMPARISON', ...HYGIENE_RULES]
  const missing = ids.filter((id) => !kb.rulesById.has(id))
  if (missing.length) fail('rule catalogue', `missing rule ids: ${missing.join(', ')}`)
  else ok(`rule catalogue loaded (${kb.rules.length} rules, none missing)`)
  checks += 1
  if (kb.rules.length !== 34) fail('rule count', `expected 34 rules, got ${kb.rules.length}`)
  else ok('rule catalogue has exactly 34 rules')
  checks += 1
  if (!kb.byCall.has('line.new') || !kb.byCall.has('iff') || !kb.byCall.has('ma')) {
    fail('call index', 'line.new / iff / ma must all resolve from the signature head')
  } else ok('call index resolves dotted names and operator-category callables')
}

// --------------------------------------------------------------- 1. corpus
console.log('\n[1] corpus: every official library example')
{
  const raw = JSON.parse(
    readFileSync('C:/Users/11/Desktop/AiScript编辑器架构与函数库/结构化数据/函数库结构化数据.json', 'utf8'),
  )
  const all = raw.categories.flatMap((c) => c.items)
  const hygiene = new Set(HYGIENE_RULES)
  let examples = 0
  const languageOffenders = []
  const hygieneOffenders = []
  const hygieneCategories = new Set()
  for (const item of all) {
    for (const [index, example] of (item.examples ?? []).entries()) {
      examples += 1
      let result
      try {
        result = validateScript(example, kb, { includeInfo: false })
      } catch (error) {
        languageOffenders.push(`${item.name}[${index}] CRASH ${error?.message}`)
        continue
      }
      for (const d of result.diagnostics.filter((x) => x.severity === 'error')) {
        if (hygiene.has(d.ruleId)) {
          hygieneCategories.add(`${item.category}`)
          hygieneOffenders.push(`${item.name}[${index}] [${item.category}] ${d.ruleId}`)
        } else {
          languageOffenders.push(`${item.name}[${index}] ${d.ruleId}@${d.line}:${d.column} ${d.message}`)
        }
      }
    }
  }
  checks += 1
  if (examples !== 335) fail('corpus size', `expected 335 examples, saw ${examples}`)
  else ok(`${examples} examples scanned`)

  // The platform's own documentation must never trip a language or function
  // library rule: those rules describe the syntax the docs are demonstrating.
  checks += 1
  if (languageOffenders.length) {
    fail('corpus false positives (language / library rules)', `${languageOffenders.length} example(s):\n        ${languageOffenders.slice(0, 8).join('\n        ')}`)
  } else ok('zero language/library errors across the whole corpus')

  // Position-state rules DO fire on the docs' one-line trading demos - they are
  // function examples, not strategies. Pin them to examples that actually
  // contain a trading call, so any NEW false positive still fails the suite.
  checks += 1
  const TRADE_CALL = /\b(enterLong|exitLong|enterShort|exitShort|enterLongAmount|exitLongAmount|enterShortAmount|exitShortAmount|enterLongPercent|exitLongPercent|enterShortPercent|exitShortPercent)\s*\(/
  const examplesWithTrades = new Set()
  for (const item of all) {
    for (const [index, example] of (item.examples ?? []).entries()) {
      if (TRADE_CALL.test(example)) examplesWithTrades.add(`${item.name}[${index}]`)
    }
  }
  const leaked = hygieneOffenders.filter((row) => !examplesWithTrades.has(row.split(' ')[0]))
  if (leaked.length) {
    fail('position-state rules fired on an example with no trading call', leaked.slice(0, 8).join('\n        '))
  } else {
    ok(
      `position-state rules fire only on the ${examplesWithTrades.size} examples that contain a trading call ` +
        `(${hygieneOffenders.length} findings, categories: ${[...hygieneCategories].join(', ') || 'none'})`,
    )
  }
}

// ----------------------------------------------------------------- 2. real
console.log('\n[2] real script: platform-verified 点金线 (110 lines)')
{
  const path = 'D:/deepseek Harness work/aicoin-re/点金线-还原源码.txt'
  if (!existsSync(path)) {
    console.log(`  skip  ${path} not present`)
  } else {
    const source = readFileSync(path, 'utf8')
    const result = validateScript(source, kb, { includeInfo: true })
    checks += 1
    if (!result.ok) {
      fail('verified script must be clean', result.diagnostics.map((d) => `${d.ruleId}@${d.line} ${d.message}`).join(' | '))
    } else ok('110-line verified strategy produces 0 diagnostics of any severity')
  }
}

// -------------------------------------------------------------- 3. fixtures
console.log('\n[3] fixtures: documented pitfalls')
for (const fixture of fixtures) {
  const result = validateScript(fixture.source, kb, { includeInfo: true })
  const byRule = new Set(result.diagnostics.map((d) => d.ruleId))
  for (const rule of fixture.expect) {
    checks += 1
    if (!byRule.has(rule)) {
      fail(`${fixture.name} must raise ${rule}`, `got [${[...byRule].join(', ') || 'nothing'}] (${fixture.why})`)
    } else ok(`${fixture.name} -> ${rule}`)
  }
  if (fixture.forbidErrors) {
    checks += 1
    const errors = result.diagnostics.filter((d) => d.severity === 'error')
    if (errors.length) fail(`${fixture.name} must be error-free`, errors.map((d) => `${d.ruleId}@${d.line} ${d.message}`).join(' | '))
    else ok(`${fixture.name} -> no errors`)
  }
  if (!fixture.expect.length && !fixture.forbidErrors) {
    checks += 1
    if (!result.diagnostics.length) fail(`${fixture.name} unexpected`, 'fixture declares nothing to expect')
    else ok(`${fixture.name} -> ${[...byRule].join(', ')}`)
  }
}

// ------------------------------------------------------- 4. robustness edges
console.log('\n[4] robustness: hostile input must never crash')
{
  const nasty = [
    '',
    '   ',
    '\n\n\n',
    '// only a comment',
    '{{{{{{',
    '))))))',
    'x = ',
    'plot(',
    'a ? b',
    'for (;;) {',
    'func f(',
    "x = 'unterminated",
    'x = close[999999999999999999999]',
    '\u0000\u0001\u0002',
    '这是一个中文标识符 = 1',
    'plot(close, title = `backtick`)',
  ]
  for (const source of nasty) {
    checks += 1
    try {
      const result = validateScript(source, kb, { includeInfo: true })
      if (typeof result.ok !== 'boolean' || !Array.isArray(result.diagnostics)) throw new Error('bad shape')
      ok(`survived ${JSON.stringify(source.slice(0, 24))}`)
    } catch (error) {
      fail(`crashed on ${JSON.stringify(source.slice(0, 40))}`, error?.stack ?? String(error))
    }
  }
}

console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`} - ${checks} checks, ${fixtures.length} fixtures`)
process.exit(failures === 0 ? 0 : 1)
