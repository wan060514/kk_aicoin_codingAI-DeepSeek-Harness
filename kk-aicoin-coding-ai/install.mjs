#!/usr/bin/env node
/**
 * install.mjs - install kk_aicoin_codingAI into a DSH profile.
 *
 * What it does (nothing else):
 *   1. copies this package into <profile>/plugins/kk_aicoin_codingAI
 *   2. adds  "kk_aicoin_codingAI": "link:./plugins/kk_aicoin_codingAI"  to <profile>/package.json
 *   3. appends an `insert:` row for the plugin to <profile>/cordis.patch.yml
 *   4. prints (and, with --run-pnpm, runs) the pnpm command that links it
 *
 * Both edited files are backed up first. The row goes in DISABLED unless you
 * pass --enable, so a bad plugin cannot take the profile down before you have
 * looked at it once.
 *
 *   node install.mjs                                    # profile "desktop", row disabled
 *   node install.mjs --profile desktop --enable         # profile "desktop", row enabled
 *   node install.mjs --run-pnpm --enable --workspace D:/work/mystrategies
 *   node install.mjs --uninstall                        # reverse all four steps
 */
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync, readdirSync, copyFileSync } from 'node:fs'
import { join, dirname, basename, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_NAME = 'kk_aicoin_codingAI'
const ROW_ID = 'kk-aicoin-coding-ai'

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const next = process.argv[i + 1]
  return next && !next.startsWith('--') ? next : true
}
const flag = (name) => process.argv.includes(`--${name}`)

const dshHome = String(arg('dsh-home', join(homedir(), '.dsh')))
const wantedProfile = arg('profile', 'desktop')
const enable = flag('enable')
const uninstall = flag('uninstall')
const runPnpm = flag('run-pnpm')

/**
 * Output root written into the row. Relative paths resolve against the HOST
 * process cwd, so pass an absolute path here for a profile that should just work.
 */
const workspace = String(arg('workspace', '.')).replace(/\\/g, '/')

const profilesRoot = join(dshHome, 'profiles')
if (!existsSync(profilesRoot)) {
  console.error(`[x] 找不到 ${profilesRoot}：--dsh-home 指错了？`)
  process.exit(1)
}
const available = readdirSync(profilesRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
const profileName = available.includes(String(wantedProfile)) ? String(wantedProfile) : undefined
if (!profileName) {
  console.error(`[x] profile "${wantedProfile}" 不存在。可用：${available.join(', ') || '(无)'}`)
  process.exit(1)
}

const profileDir = join(profilesRoot, profileName)
const packageJsonPath = join(profileDir, 'package.json')
const patchPath = join(profileDir, 'cordis.patch.yml')
const pluginsDir = join(profileDir, 'plugins')
const destDir = join(pluginsDir, PACKAGE_NAME)
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = (path) => {
  const target = `${path}.bak-${stamp}`
  copyFileSync(path, target)
  return target
}

/** The loader row. Comments stay ASCII: this file is written as UTF-8 and read
 *  back by tools whose console codepage may be something else entirely. */
const row = `- insert:
    - id: ${ROW_ID}
      name: '${PACKAGE_NAME}'
      disabled: ${enable ? 'false' : 'true'}
      config:
        enabled: true
        # Relative paths resolve against the HOST process cwd; install.mjs
        # --workspace writes an absolute path here.
        workspace: '${workspace}'
        strategyDir: aicoin-strategies
        dataDir: ''
        registerSkill: true
        promptSection: true
`

function patchProfileTree(insert) {
  let text = readFileSync(patchPath, 'utf8')
  if (insert && text.includes(PACKAGE_NAME)) {
    console.log(`[=] ${patchPath} 里已有 ${PACKAGE_NAME} 的行，跳过（要改就手工编辑）`)
    return
  }
  const backupPath = backup(patchPath)
  if (insert) {
    const emptyArray = /^[ \t]*\[[ \t]*\][ \t]*$/m
    if (emptyArray.test(text)) text = text.replace(emptyArray, row.trimEnd())
    else text = `${text.replace(/\s*$/, '')}\n\n${row}`
  } else {
    // Block-based removal: a top-level "- " entry plus every following indented
    // line. Dropping the block whole is what keeps the YAML valid.
    const lines = text.split('\n')
    const kept = []
    let i = 0
    let removed = 0
    while (i < lines.length) {
      const line = lines[i]
      if (/^-\s/.test(line)) {
        const block = [line]
        let j = i + 1
        while (j < lines.length && /^\s+\S/.test(lines[j])) {
          block.push(lines[j])
          j += 1
        }
        const ours = block.some((l) => l.includes(PACKAGE_NAME) || new RegExp(`^\\s*-?\\s*id:\\s*${ROW_ID}\\s*$`).test(l))
        if (ours) {
          removed += 1
          i = j
          continue
        }
        kept.push(...block)
        i = j
        continue
      }
      kept.push(line)
      i += 1
    }
    text = kept.join('\n')
    if (removed === 0) {
      console.log(`[=] ${patchPath} 里没有找到本插件的行`)
      return
    }
    if (!/^[ \t]*\[[ \t]*\][ \t]*$/m.test(text) && !/^-\s/m.test(text)) {
      text = `${text.replace(/\s*$/, '')}\n[]\n`
    }
  }
  writeFileSync(patchPath, text, 'utf8')
  console.log(`[ok] ${insert ? '写入' : '移除'} ${patchPath} 的插件行（备份 ${basename(backupPath)}）`)
}

function patchProfilePackageJson(insert) {
  const raw = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  raw.dependencies = raw.dependencies ?? {}
  const had = Object.prototype.hasOwnProperty.call(raw.dependencies, PACKAGE_NAME)
  if (insert) raw.dependencies[PACKAGE_NAME] = `link:./plugins/${PACKAGE_NAME}`
  else delete raw.dependencies[PACKAGE_NAME]
  if (!insert && !had) {
    console.log(`[=] ${packageJsonPath} 里本来就没有 ${PACKAGE_NAME}`)
    return
  }
  const backupPath = backup(packageJsonPath)
  writeFileSync(packageJsonPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
  console.log(`[ok] ${insert ? '加入' : '移除'} ${packageJsonPath} 的 link 依赖（备份 ${basename(backupPath)}）`)
}

const COPY_FILTER = (src) => !/(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(src) && !src.endsWith('.bak')

function copyPackage() {
  if (!existsSync(destDir)) {
    mkdirSync(pluginsDir, { recursive: true })
    cpSync(HERE, destDir, { recursive: true, filter: COPY_FILTER })
    console.log(`[ok] 复制插件 → ${destDir}`)
    return
  }
  // Refuse to delete anything that is not recognisably our own package.
  const target = resolve(destDir)
  const inside = target.startsWith(resolve(pluginsDir) + sep) && basename(target) === PACKAGE_NAME
  const looksOurs =
    existsSync(join(target, 'package.json')) &&
    JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).name === PACKAGE_NAME
  if (!inside || !looksOurs) {
    console.error(`[x] ${target} 已存在且不像本插件，拒绝覆盖。请手工处理。`)
    process.exit(1)
  }
  rmSync(target, { recursive: true, force: true })
  cpSync(HERE, target, { recursive: true, filter: COPY_FILTER })
  console.log(`[ok] 覆盖插件 → ${target}`)
}

function removePackage() {
  if (!existsSync(destDir)) {
    console.log(`[=] ${destDir} 不存在`)
    return
  }
  const target = resolve(destDir)
  const inside = target.startsWith(resolve(pluginsDir) + sep) && basename(target) === PACKAGE_NAME
  const looksOurs =
    existsSync(join(target, 'package.json')) &&
    JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).name === PACKAGE_NAME
  if (!inside || !looksOurs) {
    console.error(`[x] 拒绝删除 ${target}：路径或内容不像本插件`)
    process.exit(1)
  }
  rmSync(target, { recursive: true, force: true })
  console.log(`[ok] 已删除 ${target}`)
}

const pnpmCandidate = join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
const pnpmFallback = join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
const pnpmPath = String(arg('pnpm', existsSync(pnpmCandidate) ? pnpmCandidate : pnpmFallback))
const pnpmCommand = `"${process.execPath}" "${pnpmPath}" -C "${profileDir}" install`

if (uninstall) {
  console.log(`== 卸载 ${PACKAGE_NAME} from profile "${profileName}" ==`)
  patchProfileTree(false)
  patchProfilePackageJson(false)
  removePackage()
  console.log(`\n下一步：\n  ${pnpmCommand}\n  （如已 running，patch 层热重载；必要时重启 DSH）`)
  process.exit(0)
}

console.log(`== 安装 ${PACKAGE_NAME} → profile "${profileName}" ==`)
console.log(`   dsh home : ${dshHome}`)
console.log(`   profile  : ${profileDir}`)
copyPackage()
patchProfilePackageJson(true)
patchProfileTree(true)

if (runPnpm) {
  console.log(`\n[..] 运行：${pnpmCommand}`)
  const result = spawnSync(process.execPath, [pnpmPath, '-C', profileDir, 'install'], { stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`[x] pnpm 退出码 ${result.status}：依赖没装上，插件不会被加载`)
    process.exit(result.status ?? 1)
  }
  console.log('[ok] 依赖已就绪')
} else {
  console.log(`\n[!] 还差一步（链接依赖）：\n  ${pnpmCommand}`)
}

console.log(`
下一步
  1) ${enable ? '行为已启用' : '行是 disabled: true —— 先在 Settings → Plugins 里确认它出现，再打开开关'}
  2) 确认工具出现：新会话里应能看到 aicoin_status / aicoin_validate / aicoin_spec_draft ...
  3) 冒烟测试：在会话里说「用 aicoin_status 看看插件状态」

回滚
  node install.mjs --uninstall
  或手工：删掉 ${patchPath} 里的 insert 行 + package.json 里的 link 依赖，再跑上面的 pnpm 命令
`)
