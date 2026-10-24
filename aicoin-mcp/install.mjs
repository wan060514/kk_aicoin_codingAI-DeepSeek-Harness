#!/usr/bin/env node
/**
 * install.mjs — install the AiCoin MCP bridge into a DSH profile.
 *
 * What it does (nothing else):
 *   1. copies `<this repo>/dsh-plugin` into <profile>/plugins/dsh-plugin-aicoin-mcp
 *   2. adds  "dsh-plugin-aicoin-mcp": "link:./plugins/dsh-plugin-aicoin-mcp"
 *      to <profile>/package.json
 *   3. appends an `insert:` row (id `aicoin-mcp`) to <profile>/cordis.patch.yml,
 *      pointing `serverRoot` at the absolute path of THIS repository so the
 *      plugin runs the server straight out of the workspace
 *   4. prints (and with --run-pnpm runs) the pnpm command that links it
 *
 * Both edited files are backed up first. The row goes in DISABLED unless you
 * pass --enable, so a bad plugin cannot take the profile down before you have
 * looked at it once.
 *
 *   node install.mjs                              # profile "desktop", row disabled
 *   node install.mjs --enable --run-pnpm          # install + enable + link
 *   node install.mjs --profile desktop --port 9333
 *   node install.mjs --uninstall
 */
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, renameSync, existsSync, readdirSync, copyFileSync, statSync } from 'node:fs'
import { join, dirname, basename, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_NAME = 'dsh-plugin-aicoin-mcp'
const ROW_ID = 'aicoin-mcp'
const PLUGIN_SRC = join(HERE, 'dsh-plugin')

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const next = process.argv[i + 1]
  return next && !next.startsWith('--') ? next : true
}
const flag = (name) => process.argv.includes(`--${name}`)

const dshHome = String(arg('dsh-home', join(homedir(), '.dsh')))
const wantedProfile = String(arg('profile', 'desktop'))
const enable = flag('enable')
const uninstall = flag('uninstall')
const runPnpm = flag('run-pnpm')
const port = Number(arg('port', 9222))
const appPath = String(arg('app-path', 'D:/Program Files/AiCoin/AiCoin.exe')).replace(/\\/g, '/')
/** Absolute server root written into the row (this repository). */
const serverRoot = String(arg('server', HERE)).replace(/\\/g, '/')

if (!existsSync(join(PLUGIN_SRC, 'package.json'))) {
  console.error(`[x] 找不到插件源码：${PLUGIN_SRC}（本脚本必须放在 aicoin-mcp 仓库根目录）`)
  process.exit(1)
}
if (!existsSync(join(HERE, 'src', 'server.mjs'))) {
  console.error(`[x] 找不到 MCP 服务器：${join(HERE, 'src', 'server.mjs')}，插件装上也没东西可跑`)
  process.exit(1)
}

const profilesRoot = join(dshHome, 'profiles')
if (!existsSync(profilesRoot)) {
  console.error(`[x] 找不到 ${profilesRoot}：--dsh-home 指错了？`)
  process.exit(1)
}
const available = readdirSync(profilesRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
const profileName = available.includes(wantedProfile) ? wantedProfile : undefined
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

/** The loader row. Comments stay ASCII; paths are absolute so cwd never matters. */
const row = `- insert:
    - id: ${ROW_ID}
      name: '${PACKAGE_NAME}'
      disabled: ${enable ? 'false' : 'true'}
      config:
        enabled: true
        # Absolute path to the aicoin-mcp package root (the plugin spawns
        # node <serverRoot>/src/server.mjs over stdio).
        serverRoot: '${serverRoot}'
        port: ${port}
        appPath: '${appPath}'
        autoStart: true
        requestTimeoutMs: 120000
        maxTools: 64
        allowMutating: true
        # Serve /plugins/aicoin-mcp for the sidebar panel. Headless: false.
        panel: true
`

/** Read a UTF-8 text file ignoring a leading BOM (Notepad/PowerShell write one). */
function readText(path) {
  return readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
}

/** Read and parse JSON ignoring a leading BOM. */
function readJson(path) {
  const text = readText(path)
  return JSON.parse(text)
}

function patchProfileTree(insert) {
  let text = readText(patchPath)
  if (insert && new RegExp(`id:\\s*${ROW_ID}\\s*$`, 'm').test(text)) {
    console.log(`[=] ${patchPath} 里已有 ${ROW_ID} 的行，跳过（要改就手工编辑）`)
    return
  }
  const backupPath = backup(patchPath)
  if (insert) {
    const emptyArray = /^[ \t]*\[[ \t]*\][ \t]*$/m
    if (emptyArray.test(text)) text = text.replace(emptyArray, row.trimEnd())
    else text = `${text.replace(/\s*$/, '')}\n\n${row}`
  } else {
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
  const raw = readJson(packageJsonPath)
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

/** Keep the previous install(s) so a bad build can be rolled back by copying back. */
function pruneBackups() {
  try {
    const entries = readdirSync(pluginsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${PACKAGE_NAME}.bak-`))
      .map((entry) => join(pluginsDir, entry.name))
      .sort()
    while (entries.length > 2) rmSync(entries.shift(), { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

function copyPackage() {
  if (existsSync(destDir)) {
    const target = resolve(destDir)
    const inside = target.startsWith(resolve(pluginsDir) + sep) && basename(target) === PACKAGE_NAME
    const ours =
      existsSync(join(target, 'package.json')) && readJson(join(target, 'package.json')).name === PACKAGE_NAME
    if (!inside || !ours) {
      console.error(`[x] ${target} 已存在且不像本插件，拒绝覆盖。请手工处理。`)
      process.exit(1)
    }
    // Safety: back the previous install up instead of deleting it, so a broken
    // build can be rolled back with a file copy.
    try {
      const backupDir = `${target}.bak-${stamp}`
      renameSync(target, backupDir)
      pruneBackups()
      console.log(`[ok] 旧插件已备份 → ${backupDir}`)
    } catch (error) {
      console.warn(`[!] 备份旧插件失败（退化为直接覆盖）：${error?.message ?? error}`)
      rmSync(target, { recursive: true, force: true })
    }
    console.log(`[ok] 覆盖插件 → ${target}`)
  } else {
    console.log(`[ok] 复制插件 → ${destDir}`)
  }
  mkdirSync(pluginsDir, { recursive: true })
  cpSync(PLUGIN_SRC, destDir, { recursive: true, filter: COPY_FILTER })
}

function removePackage() {
  if (!existsSync(destDir)) {
    console.log(`[=] ${destDir} 不存在`)
    return
  }
  const target = resolve(destDir)
  const inside = target.startsWith(resolve(pluginsDir) + sep) && basename(target) === PACKAGE_NAME
  const ours =
    existsSync(join(target, 'package.json')) && readJson(join(target, 'package.json')).name === PACKAGE_NAME
  if (!inside || !ours) {
    console.error(`[x] 拒绝删除 ${target}：路径或内容不像本插件`)
    process.exit(1)
  }
  rmSync(target, { recursive: true, force: true })
  console.log(`[ok] 已删除 ${target}`)
}

const pnpmCandidate = join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
const pnpmPath = String(arg('pnpm', pnpmCandidate))
const pnpmCommand = `"${process.execPath}" "${pnpmPath}" -C "${profileDir}" install`

if (uninstall) {
  console.log(`== 卸载 ${PACKAGE_NAME} from profile "${profileName}" ==`)
  patchProfileTree(false)
  patchProfilePackageJson(false)
  removePackage()
  console.log(`\n下一步：\n  ${pnpmCommand}\n  （patch 层会热重载；没生效就重启 DSH）`)
  process.exit(0)
}

console.log(`== 安装 ${PACKAGE_NAME} → profile "${profileName}" ==`)
console.log(`   dsh home   : ${dshHome}`)
console.log(`   profile    : ${profileDir}`)
console.log(`   serverRoot : ${serverRoot}`)
console.log(`   cdp port   : ${port}`)
console.log(`   appPath    : ${appPath}`)
copyPackage()
patchProfilePackageJson(true)
patchProfileTree(true)

if (runPnpm) {
  if (!existsSync(pnpmPath)) {
    console.error(`[x] 找不到 pnpm：${pnpmPath}`)
    process.exit(1)
  }
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
  2) 让 AiCoin 带调试端口跑起来：直接对 agent 说「用 aicoin_launch 启动 AiCoin」
  3) 新会话里确认工具出现：aicoin_mcp_status / aicoin_launch / aicoin_status / aicoin_screenshot …
  4) 冒烟：aicoin_mcp_status → aicoin_status → aicoin_screenshot

回滚
  node install.mjs --uninstall --run-pnpm
`)
