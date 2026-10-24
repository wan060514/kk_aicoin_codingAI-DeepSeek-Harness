import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadKnowledge } from '../lib/data.js'
import { validateScript, formatDiagnostic } from '../lib/aiscript/validate.js'

const kb = loadKnowledge(fileURLToPath(new URL('../data/', import.meta.url)))
const path = process.argv[2]
const source = readFileSync(path, 'utf8')
const result = validateScript(source, kb, { includeInfo: true })
console.log(`file: ${path}`)
console.log(`stats: ${JSON.stringify(result.stats)}`)
for (const d of result.diagnostics) console.log(formatDiagnostic(d, source) + '\n')
if (!result.diagnostics.length) console.log('(no findings)')
