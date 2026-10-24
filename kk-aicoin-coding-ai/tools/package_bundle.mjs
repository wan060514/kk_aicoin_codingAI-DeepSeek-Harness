#!/usr/bin/env node
/**
 * package_bundle.mjs - build the shareable, auditable single-file bundle.
 *
 * Produces  dist/kk_aicoin_codingAI-<version>.zip  containing:
 *   plugin/            the complete DSH plugin
 *   aicoin-reference/  every AiCoin source file the plugin depends on, so a
 *                      third party can re-derive data/ without the original
 *                      extraction machine
 *   INSTALL.md         install instructions for someone else
 *   MANIFEST.json      file inventory + SHA-256 + counts
 *   CHECKSUMS.sha256   one line per file
 *   verify.mjs         standalone integrity check (`node verify.mjs`)
 *
 * Only the files that matter are copied: the AiCoin renderer holds ~100 MB of
 * images and video that have nothing to do with the indicator editor.
 *
 *   node tools/package_bundle.mjs [--source "<函数库资料包目录>"] [--out <dir>]
 */
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, relative, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, '..')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const next = process.argv[i + 1]
  return next && !next.startsWith('--') ? next : true
}

const AI_SCRIPT_SOURCE = String(arg('source', 'C:/Users/11/Desktop/AiScript编辑器架构与函数库')).replace(/\\/g, '/')
const OUT_DIR = String(arg('out', join(PLUGIN_ROOT, 'dist')))
const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'))
const VERSION = pkg.version
const BUNDLE_NAME = `${pkg.name}-${VERSION}`
/**
 * Stage OUTSIDE the plugin root: Node's cpSync rejects copying a directory into
 * its own subtree up front (ERR_FS_CP_EINVAL), before any filter runs. Only the
 * finished .zip is written back into OUT_DIR.
 */
const STAGE_PARENT = join(tmpdir(), `kk-aicoin-bundle-${process.pid}`)
const STAGE = join(STAGE_PARENT, BUNDLE_NAME)
const OUT_PREFIX = `${OUT_DIR.replace(/\\/g, '/').replace(/\/+$/, '')}/`

/**
 * Files copied out of the AiCoin extraction folder. The original relative layout
 * is preserved on purpose, so `node tools/build_data.mjs --source
 * aicoin-reference/结构化数据` works straight out of the bundle.
 */
const REFERENCE = [
  ['结构化数据/函数库结构化数据.json', '结构化数据/函数库结构化数据.json'],
  ['结构化数据/AiScript语言定义.json', '结构化数据/AiScript语言定义.json'],
  ['结构化数据/函数库训练语料.jsonl', '结构化数据/函数库训练语料.jsonl'],
  ['AiScript函数库速查索引.md', 'AiScript函数库速查索引.md'],
  ['AiScript函数库详解手册.md', 'AiScript函数库详解手册.md'],
  ['AiScript编辑器架构分析.md', 'AiScript编辑器架构分析.md'],
  ['README.md', 'README.md'],
  ['aicoin_dist/extracted/dist/renderer/2776.js', 'aicoin_dist/extracted/dist/renderer/2776.js'],
  ['aicoin_dist/extracted/dist/renderer/551.js', 'aicoin_dist/extracted/dist/renderer/551.js'],
  ['原始数据与工具/函数库原始数据.json', '原始数据与工具/函数库原始数据.json'],
  ['原始数据与工具/构建脚本/00-解包asar.js', '原始数据与工具/构建脚本/00-解包asar.js'],
  ['原始数据与工具/构建脚本/01-从客户端导出函数库.js', '原始数据与工具/构建脚本/01-从客户端导出函数库.js'],
  ['原始数据与工具/构建脚本/02-CDP页面求值工具.js', '原始数据与工具/构建脚本/02-CDP页面求值工具.js'],
  ['原始数据与工具/构建脚本/03-生成结构化数据.js', '原始数据与工具/构建脚本/03-生成结构化数据.js'],
  ['原始数据与工具/构建脚本/04-生成详解手册.js', '原始数据与工具/构建脚本/04-生成详解手册.js'],
  ['原始数据与工具/构建脚本/05-生成速查索引与训练语料.js', '原始数据与工具/构建脚本/05-生成速查索引与训练语料.js'],
  ['原始数据与工具/构建脚本/zh_names.js', '原始数据与工具/构建脚本/zh_names.js'],
  ['原始数据与工具/构建脚本/启动AiCoin调试模式.bat', '原始数据与工具/构建脚本/启动AiCoin调试模式.bat'],
]

const SKIP_PLUGIN = /(^|[\\/])(node_modules|\.git|dist)([\\/]|$)|\.bak-|\.tgz$|\.zip$/

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, base, out)
    else if (entry.isFile()) out.push(relative(base, full).replace(/\\/g, '/'))
  }
  return out
}

// ------------------------------------------------------------------ staging
if (existsSync(STAGE)) rmSync(STAGE, { recursive: true, force: true })
mkdirSync(STAGE, { recursive: true })

console.log(`== 打包 ${BUNDLE_NAME} ==`)
console.log(`   目标: ${join(OUT_DIR, `${BUNDLE_NAME}.zip`)}`)

cpSync(PLUGIN_ROOT, join(STAGE, 'plugin'), {
  recursive: true,
  filter: (src) => {
    const normalised = src.replace(/\\/g, '/')
    if (normalised === OUT_DIR.replace(/\\/g, '/') || normalised.startsWith(OUT_PREFIX)) return false
    return !SKIP_PLUGIN.test(src)
  },
})
console.log('[ok] plugin/ 已复制')

const missing = []
let referenceFiles = 0
for (const [from, to] of REFERENCE) {
  const source = join(AI_SCRIPT_SOURCE, from)
  if (!existsSync(source)) {
    missing.push(from)
    continue
  }
  const target = join(STAGE, 'aicoin-reference', to)
  mkdirSync(dirname(target), { recursive: true })
  cpSync(source, target)
  referenceFiles += 1
}
console.log(`[ok] aicoin-reference/ 已复制 ${referenceFiles} 个文件${missing.length ? `（缺 ${missing.length} 个）` : ''}`)
for (const item of missing) console.log(`     [warn] 源文件不存在：${item}`)

// ------------------------------------------------------------- manifest
const files = walk(STAGE)
  .map((rel) => ({ path: rel, bytes: statSync(join(STAGE, rel)).size, sha256: sha256(join(STAGE, rel)) }))
  .sort((a, b) => a.path.localeCompare(b.path))

const kbPath = join(STAGE, 'plugin', 'data', 'aiscript_functions.json')
const kb = JSON.parse(readFileSync(kbPath, 'utf8'))
const rules = JSON.parse(readFileSync(join(STAGE, 'plugin', 'data', 'aiscript_rules.json'), 'utf8'))
const libSource = JSON.parse(readFileSync(join(AI_SCRIPT_SOURCE, '结构化数据/函数库结构化数据.json'), 'utf8'))

const manifest = {
  name: pkg.name,
  version: pkg.version,
  builtAt: new Date().toISOString(),
  description: pkg.description,
  node: process.version,
  contents: {
    pluginFiles: files.filter((f) => f.path.startsWith('plugin/')).length,
    aicoinReferenceFiles: files.filter((f) => f.path.startsWith('aicoin-reference/')).length,
    totalFiles: files.length,
    totalBytes: files.reduce((sum, f) => sum + f.bytes, 0),
  },
  knowledgeBase: {
    libraryEntries: kb.meta.total_items ?? kb.functions.length + kb.variables.length + kb.operators.length,
    functions: kb.functions.length,
    variables: kb.variables.length,
    operators: kb.operators.length,
    categories: kb.categories.length,
    rules: rules.rules.length,
    sourceTotalItems: libSource.total_items,
    matchesSource: (kb.meta.total_items ?? 0) === libSource.total_items,
  },
  tools: [
    'aicoin_status',
    'aicoin_library_search',
    'aicoin_library_get',
    'aicoin_language_reference',
    'aicoin_spec_draft',
    'aicoin_spec_status',
    'aicoin_validate',
    'aicoin_scaffold',
    'aicoin_optimize_advice',
    'aicoin_deliver',
    'aicoin_live_check',
  ],
  skill: 'aicoin-strategy-engineer',
  capabilities: {
    backtest: false,
    performanceMetrics: false,
    note:
      'The unpacked AiCoin editor has no backtest engine. This plugin never emits returns, win rates, ' +
      'Sharpe ratios or drawdowns; it performs offline static validation and structural review only.',
  },
  files,
}

writeFileSync(join(STAGE, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
writeFileSync(
  join(STAGE, 'CHECKSUMS.sha256'),
  `${files.map((f) => `${f.sha256}  ${f.path}`).join('\n')}\n`,
  'utf8',
)
console.log(`[ok] MANIFEST.json（${files.length} 个文件，${(manifest.contents.totalBytes / 1024 / 1024).toFixed(2)} MB）`)
console.log(`[ok] CHECKSUMS.sha256`)

writeFileSync(
  join(STAGE, 'verify.mjs'),
  `#!/usr/bin/env node
// Standalone integrity check: run from the bundle root with \`node verify.mjs\`.
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'MANIFEST.json'), 'utf8'))
let bad = 0
for (const file of manifest.files) {
  const path = join(root, file.path)
  if (!existsSync(path)) { console.log('MISSING ' + file.path); bad += 1; continue }
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex')
  if (hash !== file.sha256) { console.log('CHANGED ' + file.path); bad += 1 }
}
console.log(bad === 0 ? \`OK - \${manifest.files.length} files verified (\${manifest.name} v\${manifest.version})\` : \`\${bad} FILE(S) FAILED\`)
process.exit(bad === 0 ? 0 : 1)
`,
  'utf8',
)

writeFileSync(join(STAGE, 'INSTALL.md'), buildInstallDoc({ pkg, manifest, missing }), 'utf8')

// ------------------------------------------------------------------- zip
const zipPath = join(OUT_DIR, `${BUNDLE_NAME}.zip`)
if (existsSync(zipPath)) rmSync(zipPath, { force: true })
mkdirSync(OUT_DIR, { recursive: true })

let zipped = false
const tar = spawnSync('tar.exe', ['-a', '-c', '-f', zipPath, '-C', STAGE_PARENT, BUNDLE_NAME], { stdio: 'pipe', encoding: 'utf8' })
if (tar.status === 0 && existsSync(zipPath)) {
  zipped = true
} else {
  const ps = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `Compress-Archive -Path '${STAGE}' -DestinationPath '${zipPath}' -Force`],
    { stdio: 'pipe', encoding: 'utf8' },
  )
  zipped = ps.status === 0 && existsSync(zipPath)
}

if (!zipped) {
  console.error('[x] 打包失败：tar 与 Compress-Archive 都没成功。临时目录仍然保留在 ' + STAGE)
  process.exit(1)
}
rmSync(STAGE_PARENT, { recursive: true, force: true })

const zipBytes = statSync(zipPath).size
console.log('')
console.log(`[done] ${zipPath}`)
console.log(`       ${(zipBytes / 1024 / 1024).toFixed(2)} MB · ${files.length} 个文件`)
console.log(`       解压后目录：${basename(STAGE)}/`)
if (missing.length) console.log(`       [warn] ${missing.length} 个参考文件缺失（已写入 INSTALL.md）`)
console.log('')
console.log('给别人：解压 → cd plugin → node install.mjs --profile <profile> --enable --run-pnpm')

function buildInstallDoc({ pkg: p, manifest: m, missing: miss }) {
  return `# ${p.name} v${p.version} — 安装说明

> 由 \`tools/package_bundle.mjs\` 于 ${m.builtAt} 生成。
> 共 ${m.contents.totalFiles} 个文件（插件 ${m.contents.pluginFiles} + AiCoin 参考 ${m.contents.aicoinReferenceFiles}），
> 校验信息在 \`MANIFEST.json\` 与 \`CHECKSUMS.sha256\`。

## 这是什么

一个 DeepSeek Harness 插件：以量化工程师视角，把用户模糊的交易想法变成 **AiCoin AiScript** 可运行脚本。

三个关键点：

1. **先问清楚仓位运行模式**（一开一平 / 反手 / 分批止盈 / 马丁加仓 / 移动止盈 / 自定义），再写代码；
2. 生成的脚本用 \`var\` 状态变量记录仓位（是否持仓、入场价、入场 K 线、止盈档位、加仓层数、峰值），
   每笔下单都是**边沿触发或状态保护**，因此不会重复开仓、平仓后状态会复位；
3. 用离线静态校验自动 debug 到零错误，交付脚本是纯文本 \`strategy.txt\`。

**它不提供回测。** 拆包的 AiCoin 编辑器里没有回测功能，所以本插件不输出收益率、胜率、夏普、最大回撤、
盈亏比等任何绩效数字——一个都不输出。详细边界见 \`plugin/README.md\`。

## 前置条件

- DeepSeek Harness 桌面版（本包基于 0.2.0-rc.2 开发）
- Node.js 20+（桌面版自带运行时；命令行安装时需要 \`node\`）
- 一个已存在的 DSH profile（默认 \`desktop\`）

## 安装

\`\`\`bash
# 1. 解压后进入插件目录
cd plugin

# 2. 先看一遍完整性（可选，但推荐）
node ../verify.mjs

# 3. 装进 profile。默认先装成 disabled，确认出现后再打开开关
node install.mjs --profile desktop --enable --run-pnpm --workspace "D:/my-strategies"

# 4. 重启 DSH
\`\`\`

装好后新会话里应能看到 11 个 \`aicoin_*\` 工具。第一句话建议说：

> 用 aicoin_status 看看插件状态

## 自测

\`\`\`bash
cd plugin
node test/validate.test.mjs   # 校验器：335 段官方示例 + 真实脚本 + 18 个 fixture + 健壮性
node test/smoke.mjs           # 插件：注册、11 个工具的实际调用、卸载
\`\`\`

两个套件必须全绿。

## 卸载

\`\`\`bash
cd plugin
node install.mjs --profile desktop --uninstall
\`\`\`

## 目录

\`\`\`
plugin/                        完整插件
  lib/                         实现（校验器 / 工具 / 需求客观化 / 模板 / 建议）
  data/                        内置知识库：334 条函数 + 34 条规则
  skill/SKILL.md               量化工程师方法论（含仓位状态机三条不变量）
  test/                        两个测试套件（92 + 88 项检查）
  tools/build_data.mjs         从 aicoin-reference 重建 data/
  tools/package_bundle.mjs     生成本压缩包
  research/                    逆向证据：编辑器词法定义、编译流程、结论
aicoin-reference/              AiCoin 原始资料（插件 data/ 的来源，保持原目录结构）
  结构化数据/                  函数库结构化数据（334 条）、语言定义、训练语料
  AiScript函数库详解手册.md     逐参数详解
  AiScript函数库速查索引.md     一页纸速查
  AiScript编辑器架构分析.md     编辑器逆向分析
  aicoin_dist/extracted/...    拆包后的 AiScript 语言定义(2776.js) 与编辑器组件(551.js)
  原始数据与工具/               原始函数库 JSON + 全套提取脚本
INSTALL.md                     本文件
MANIFEST.json                  文件清单 + SHA-256 + 统计
CHECKSUMS.sha256               校验和
verify.mjs                     独立完整性校验
\`\`\`

## 用参考资料重建知识库

客户端升级后（插件目录下执行）：

\`\`\`bash
cd plugin
node tools/build_data.mjs --source "../aicoin-reference/结构化数据"
node test/validate.test.mjs && node test/smoke.mjs
\`\`\`

两个套件必须全绿后再发布。

## 已知限制

1. 客户端有 263 个条目的参数表缺少「默认值」列、50 个条目没有参数表，这些条目的必填性无法判定，
   校验器对它们只做参数上限校验，避免误报。
2. 函数库文档存在自相矛盾之处（例如 \`line.new\` 把 \`refSeries\` 标为必要参数，其自身示例却省略了它），
   这类问题被降级为警告并附说明。
3. \`aicoin_live_check\` 的 \`library-diff\` 依赖客户端 webpack 模块 id \`31438\`，客户端大版本更新后可能失效；
   失效时会给明确报错，不影响离线功能。
4. 静态校验不能替代服务端编译器。最终判定请在客户端点「保存并校验」。

${miss.length ? `## 打包时缺失的参考文件\n\n${miss.map((x) => `- ${x}`).join('\n')}\n` : ''}
## 许可

MIT。内置函数库文档版权归 AiCoin 所有，此处仅用于指标脚本编程辅助。
`
}
