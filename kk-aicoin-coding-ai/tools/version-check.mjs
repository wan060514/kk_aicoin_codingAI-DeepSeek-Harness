#!/usr/bin/env node
/**
 * version-check.mjs - prove the three copies of the plugin are the same build.
 *
 *   1. SOURCE   D:/deepseek Harness work/kk_aicoin_codingAI        (what I edit)
 *   2. PROFILE  ~/.dsh/profiles/desktop/plugins/kk_aicoin_codingAI (what DSH loads)
 *   3. BUNDLE   dist/kk_aicoin_codingAI-<v>.zip                    (what others get)
 *
 * Compares SHA-256 of every shipped file and reports the marker values that
 * identify this revision (rule count, template list, script file name).
 */
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const SOURCE = 'D:/deepseek Harness work/kk_aicoin_codingAI'
const PROFILE = join(process.env.USERPROFILE ?? 'C:/Users/11', '.dsh/profiles/desktop/plugins/kk_aicoin_codingAI')

const SKIP = /(^|[\\/])(node_modules|\.git|dist)([\\/]|$)|\.bak-|\.zip$/

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP.test(full)) continue
      walk(full, base, out)
    } else if (entry.isFile()) {
      if (SKIP.test(full)) continue
      out.push(relative(base, full).replace(/\\/g, '/'))
    }
  }
  return out.sort()
}

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

function markers(root) {
  const rules = JSON.parse(readFileSync(join(root, 'data/aiscript_rules.json'), 'utf8')).rules
  const templates = JSON.parse(readFileSync(join(root, 'data/aiscript_functions.json'), 'utf8'))
  const toolsSrc = readFileSync(join(root, 'lib/tools.js'), 'utf8')
  const tplSrc = readFileSync(join(root, 'lib/templates.js'), 'utf8')
  return {
    rules: rules.length,
    hasRepeatedTradeRisk: rules.some((r) => r.id === 'REPEATED_TRADE_RISK'),
    templates: [...tplSrc.matchAll(/^\s+id: '([a-z0-9-]+)',$/gm)].map((m) => m[1]),
    scriptFile: /const SCRIPT_FILE = '([^']+)'/.exec(toolsSrc)?.[1] ?? '(missing)',
    hasPositionMode: /POSITION_MODES/.test(toolsSrc),
    libraryEntries: (templates.functions?.length ?? 0) + (templates.variables?.length ?? 0) + (templates.operators?.length ?? 0),
  }
}

console.log('=== 1. SOURCE (编辑目录) ===')
const srcFiles = walk(SOURCE)
console.log(`   files: ${srcFiles.length}`)
const srcMarkers = markers(SOURCE)
for (const [k, v] of Object.entries(srcMarkers)) console.log(`   ${k}: ${Array.isArray(v) ? v.join(', ') : v}`)

// ---------------------------------------------------------------- profile
console.log('\n=== 2. PROFILE (DSH 实际加载的副本) ===')
if (!existsSync(PROFILE)) {
  console.log(`   [x] 不存在：${PROFILE}`)
} else {
  const profFiles = walk(PROFILE)
  const srcSet = new Set(srcFiles)
  const profSet = new Set(profFiles)
  const missing = srcFiles.filter((f) => !profSet.has(f))
  const extra = profFiles.filter((f) => !srcSet.has(f))
  const differing = []
  for (const f of srcFiles) {
    if (!profSet.has(f)) continue
    if (sha(join(SOURCE, f)) !== sha(join(PROFILE, f))) differing.push(f)
  }
  console.log(`   files: ${profFiles.length}  (source ${srcFiles.length})`)
  console.log(`   内容不一致: ${differing.length}${differing.length ? ` -> ${differing.slice(0, 10).join(', ')}` : ''}`)
  console.log(`   缺失: ${missing.length}${missing.length ? ` -> ${missing.slice(0, 10).join(', ')}` : ''}`)
  console.log(`   多余: ${extra.length}${extra.length ? ` -> ${extra.slice(0, 10).join(', ')}` : ''}`)
  const profMarkers = markers(PROFILE)
  const same = JSON.stringify(profMarkers) === JSON.stringify(srcMarkers)
  console.log(`   版本标记: ${same ? '与 SOURCE 完全一致 ✅' : '与 SOURCE 不一致 ❌'}`)
  if (!same) console.log(`      profile: ${JSON.stringify(profMarkers)}`)
}

// ----------------------------------------------------------------- bundle
console.log('\n=== 3. BUNDLE (发给别人的 zip) ===')
const distDir = join(SOURCE, 'dist')
const zips = existsSync(distDir) ? readdirSync(distDir).filter((f) => f.endsWith('.zip')) : []
if (!zips.length) {
  console.log('   [x] dist/ 下没有 zip')
} else {
  for (const zip of zips) {
    const tmp = mkdtempSync(join(tmpdir(), 'kk-ver-'))
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${join(distDir, zip)}' -DestinationPath '${tmp}' -Force`], { stdio: 'pipe' })
      const bundleRoot = join(tmp, zip.replace(/\.zip$/, ''))
      const pluginRoot = join(bundleRoot, 'plugin')
      const manifest = JSON.parse(readFileSync(join(bundleRoot, 'MANIFEST.json'), 'utf8'))
      const bundleFiles = walk(pluginRoot)
      const bundleSet = new Set(bundleFiles)
      const differing = []
      for (const f of srcFiles) {
        if (!bundleSet.has(f)) continue
        if (sha(join(SOURCE, f)) !== sha(join(pluginRoot, f))) differing.push(f)
      }
      const missing = srcFiles.filter((f) => !bundleSet.has(f))
      console.log(`   ${zip}`)
      console.log(`     manifest: ${manifest.contents.totalFiles} files / ${(manifest.contents.totalBytes / 1024 / 1024).toFixed(2)} MB`)
      console.log(`     plugin文件: ${bundleFiles.length}（source ${srcFiles.length}）`)
      console.log(`     内容不一致: ${differing.length}${differing.length ? ` -> ${differing.slice(0, 10).join(', ')}` : ''}`)
      console.log(`     缺失: ${missing.length}${missing.length ? ` -> ${missing.slice(0, 10).join(', ')}` : ''}`)
      const bMarkers = markers(pluginRoot)
      const same = JSON.stringify(bMarkers) === JSON.stringify(srcMarkers)
      console.log(`     版本标记: ${same ? '与 SOURCE 完全一致 ✅' : '与 SOURCE 不一致 ❌'}`)
      if (!same) console.log(`       bundle: ${JSON.stringify(bMarkers)}`)
      // integrity
      const verify = execFileSync(process.execPath, [join(bundleRoot, 'verify.mjs')], { encoding: 'utf8' })
      console.log(`     完整性: ${verify.trim()}`)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
}
