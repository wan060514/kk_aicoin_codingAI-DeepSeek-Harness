import { fileURLToPath } from 'node:url'
import { loadKnowledge } from '../lib/data.js'
import { validateScript, formatDiagnostic } from '../lib/aiscript/validate.js'
import { TEMPLATES, resolveValues } from '../lib/templates.js'

const kb = loadKnowledge(fileURLToPath(new URL('../data/', import.meta.url)))
let bad = 0
for (const template of TEMPLATES) {
  const source = template.build(resolveValues(template), template.title)
  const result = validateScript(source, kb, { includeInfo: true })
  const errors = result.diagnostics.filter((d) => d.severity === 'error')
  const warnings = result.diagnostics.filter((d) => d.severity === 'warning')
  console.log(`${errors.length || warnings.length ? 'ISSUE' : 'ok   '} ${template.id}: errors=${errors.length} warnings=${warnings.length} infos=${result.stats.infos}`)
  for (const d of [...errors, ...warnings]) console.log('   ' + formatDiagnostic(d, source).split('\n')[0])
  if (errors.length) bad += 1
}
console.log(bad === 0 ? 'ALL TEMPLATES VALID' : `${bad} template(s) with errors`)
