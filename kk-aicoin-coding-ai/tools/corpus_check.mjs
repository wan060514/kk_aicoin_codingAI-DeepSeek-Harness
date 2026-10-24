/**
 * Corpus regression: run the validator over every official example block in the
 * function library. These examples are the platform's own documentation, so any
 * ERROR raised on them is a false positive that must be fixed or downgraded.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadKnowledge } from '../lib/data.js'
import { validateScript } from '../lib/aiscript/validate.js'

const dataDir = fileURLToPath(new URL('../data/', import.meta.url))
const kb = loadKnowledge(dataDir)
const raw = JSON.parse(readFileSync('C:/Users/11/Desktop/AiScript编辑器架构与函数库/结构化数据/函数库结构化数据.json', 'utf8'))
const all = raw.categories.flatMap((c) => c.items)

const results = []
const errorBuckets = new Map()
const warningBuckets = new Map()
let clean = 0
let total = 0

for (const item of all) {
  for (const [index, example] of (item.examples ?? []).entries()) {
    total += 1
    let result
    try {
      result = validateScript(example, kb, { includeInfo: false })
    } catch (error) {
      results.push({ name: item.name, index, crash: `${error?.message}` })
      continue
    }
    const errors = result.diagnostics.filter((d) => d.severity === 'error')
    const warnings = result.diagnostics.filter((d) => d.severity === 'warning')
    if (errors.length === 0 && warnings.length === 0) clean += 1
    for (const d of errors) {
      const key = `${d.ruleId} :: ${d.message.slice(0, 90)}`
      const bucket = errorBuckets.get(key) ?? { count: 0, samples: [] }
      bucket.count += 1
      if (bucket.samples.length < 3) bucket.samples.push(`${item.name}[${index}] L${d.line}: ${d.message.slice(0, 140)}`)
      errorBuckets.set(key, bucket)
    }
    for (const d of warnings) {
      const key = `${d.ruleId} :: ${d.message.slice(0, 90)}`
      const bucket = warningBuckets.get(key) ?? { count: 0, samples: [] }
      bucket.count += 1
      if (bucket.samples.length < 3) bucket.samples.push(`${item.name}[${index}] L${d.line}: ${d.message.slice(0, 140)}`)
      warningBuckets.set(key, bucket)
    }
    if (errors.length || warnings.length) {
      results.push({ name: item.name, index, errors: errors.map((d) => d.ruleId), warnings: warnings.map((d) => d.ruleId) })
    }
  }
}

const crashes = results.filter((r) => r.crash)
console.log(`examples=${total} clean=${clean} withFindings=${total - clean} crashes=${crashes.length}`)
for (const c of crashes.slice(0, 10)) console.log(`  CRASH ${c.name}[${c.index}]: ${c.crash}`)

console.log('\n=== ERROR buckets ===')
for (const [key, bucket] of [...errorBuckets].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`\n[${bucket.count}] ${key}`)
  for (const s of bucket.samples) console.log(`    ${s}`)
}
console.log('\n=== WARNING buckets ===')
for (const [key, bucket] of [...warningBuckets].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`\n[${bucket.count}] ${key}`)
  for (const s of bucket.samples) console.log(`    ${s}`)
}

writeFileSync(new URL('./corpus_report.json', import.meta.url), JSON.stringify({
  total, clean, errorBuckets: [...errorBuckets], warningBuckets: [...warningBuckets],
}, null, 2), 'utf8')
