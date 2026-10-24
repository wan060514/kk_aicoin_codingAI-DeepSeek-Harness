/**
 * Toggle the `disabled` flag of one loader row in a DSH profile patch file.
 *
 * This is the safe switch used during install: the plugin is written to disk
 * with the row DISABLED first, the host is verified, and only then enabled.
 * The same command flips it back (`--disabled true`) as a one-command rollback.
 *
 * usage:
 *   node scripts/profile-row.mjs --show
 *   node scripts/profile-row.mjs --disabled true
 *   node scripts/profile-row.mjs --disabled false --id aicoin-mcp
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const next = process.argv[i + 1]
  return next && !next.startsWith('--') ? next : true
}
const flag = (name) => process.argv.includes(`--${name}`)

const dshHome = String(arg('dsh-home', join(homedir(), '.dsh')))
const profile = String(arg('profile', 'desktop'))
const id = String(arg('id', 'aicoin-mcp'))
const patchPath = join(dshHome, 'profiles', profile, 'cordis.patch.yml')

if (!existsSync(patchPath)) {
  console.error(`[x] patch file not found: ${patchPath}`)
  process.exit(1)
}

const text = readFileSync(patchPath, 'utf8').replace(/^\\uFEFF/, '')
const lines = text.split('\n')

/** Locate the row block: from its `id:` line back to the enclosing `- insert:` entry. */
function findRowRange(list, rowId) {
  const idPattern = new RegExp(`^\\s*-?\\s*id:\\s*${rowId}\\s*$`)
  const idIndex = list.findIndex((line) => idPattern.test(line.trim()))
  if (idIndex === -1) return null
  let start = idIndex
  while (start > 0 && !/^-\s/.test(list[start])) start -= 1
  let end = idIndex + 1
  while (end < list.length && !/^-\s/.test(list[end])) end += 1
  return { start, end, idIndex }
}

const range = findRowRange(lines, id)
if (!range) {
  console.error(`[x] row id "${id}" not found in ${patchPath}`)
  process.exit(2)
}

if (flag('show')) {
  console.log(lines.slice(range.start, range.end).join('\n'))
  process.exit(0)
}

const wanted = arg('disabled', undefined)
if (wanted === undefined) {
  console.error('[x] pass --show, or --disabled true|false')
  process.exit(1)
}
const value = String(wanted) === 'true'

let changed = false
for (let i = range.start; i < range.end; i += 1) {
  const match = /^(\s*)disabled:\s*.*$/.exec(lines[i])
  if (!match) continue
  const next = `${match[1]}disabled: ${value ? 'true' : 'false'}`
  if (lines[i] !== next) {
    lines[i] = next
    changed = true
  }
}
if (!changed) {
  console.log(`[=] row "${id}" is already disabled: ${value ? 'true' : 'false'}`)
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupPath = `${patchPath}.bak-${stamp}`
copyFileSync(patchPath, backupPath)
writeFileSync(patchPath, lines.join('\n'), 'utf8')
console.log(`[ok] row "${id}" -> disabled: ${value ? 'true' : 'false'}`)
console.log(`[ok] backup: ${backupPath}`)
console.log('[i] the patch layer hot-reloads; give it a few seconds.')
