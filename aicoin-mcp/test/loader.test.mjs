/**
 * loader.test.mjs — src/tools/index.mjs 动态加载器的测试（纯本地，不碰 CDP）。
 *
 * fixtures/tools/ 里埋了三种情况：
 *   - echo_tool.mjs / cdp_tool.mjs：正常工具模块
 *   - broken.mjs：import 阶段抛错 → 只 warn，不影响其它工具
 *   - _helpers.mjs：下划线开头 → 必须被跳过（它 import 就会炸）
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { ToolRegistry } from '../src/registry.mjs'
import { loadTools, discoverToolFiles, extractToolSpecs, DEFAULT_TOOLS_DIR } from '../src/tools/index.mjs'
import { createSuite, assert, assertEqual, assertIncludes, assertRejects } from './helpers/harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures', 'tools')

const suite = createSuite('loader')
const { test } = suite

/** 收集日志，方便断言 warn。 */
function captureLogger() {
  const lines = []
  const log = (lvl, message) => lines.push(`${String(lvl)}: ${message}`)
  log.lines = lines
  return log
}

test('discoverToolFiles 跳过 index.mjs / 下划线前缀 / 非 .mjs，并按名字排序', async () => {
  const files = await discoverToolFiles(FIXTURES)
  const names = files.map((file) => file.split(/[\\/]/).pop())
  assert(names.includes('echo_tool.mjs'), '应包含 echo_tool.mjs')
  assert(names.includes('cdp_tool.mjs'), '应包含 cdp_tool.mjs')
  assert(names.includes('broken.mjs'), '应包含 broken.mjs（加载时才失败）')
  assertEqual(names.includes('_helpers.mjs'), false, '下划线开头的辅助模块必须跳过')
  const sorted = [...names].sort()
  assertEqual(names.join(','), sorted.join(','), '文件列表应排序')
})

test('loadTools 加载正常模块、跳过 broken 与 _helpers，并注册内置 framework_info', async () => {
  const log = captureLogger()
  const registry = new ToolRegistry({ log })
  const summary = await loadTools({ registry, log, dir: FIXTURES })

  assertEqual(summary.dir, resolve(FIXTURES))
  assertEqual(summary.failed.length, 1, `应只有 broken.mjs 失败，实际：${JSON.stringify(summary.failed)}`)
  assertIncludes(summary.failed[0].file, 'broken.mjs')
  assertIncludes(summary.failed[0].reason, '模块加载失败')
  assert(log.lines.some((line) => line.startsWith('warn:') && line.includes('broken.mjs')), 'broken 模块应 warn')

  const names = registry.names()
  for (const expected of ['echo_tool', 'object_tool', 'content_tool', 'fail_tool', 'mock_eval', 'mock_where', 'mock_shot']) {
    assert(names.includes(expected), `应注册 ${expected}，实际：${names.join(', ')}`)
  }
  assertEqual(names.includes('framework_info'), true, '应注册内置 framework_info')
  assertEqual(summary.builtin.length, 1)
  // 内置工具在最后注册（避免和队友同名工具冲突）
  assertEqual(summary.tools.includes('framework_info'), true)
  // _helpers.mjs 没被 import：它 import 就会炸，若失败数 > 1 说明被加载了
  assertEqual(summary.failed.length, 1)
})

test('loadTools 对不存在的目录：只 warn 返回 failed，不抛异常', async () => {
  const log = captureLogger()
  const registry = new ToolRegistry({ log })
  const summary = await loadTools({ registry, log, dir: join(HERE, 'no-such-dir-xyz') })
  assertEqual(summary.failed.length, 1)
  assertIncludes(summary.failed[0].reason, '无法读取工具目录')
  assertEqual(registry.names().length, 1, '目录不可用时仍应有内置 framework_info')
})

test('loadTools 拒绝非 ToolRegistry 参数', async () => {
  await assertRejects(() => loadTools({ registry: {}, dir: FIXTURES }), { includes: 'ToolRegistry' })
})

test('loadTools builtins:false 时不注册 framework_info', async () => {
  const log = captureLogger()
  const registry = new ToolRegistry({ log })
  const summary = await loadTools({ registry, log, dir: FIXTURES, builtins: false })
  assertEqual(registry.has('framework_info'), false)
  assertEqual(summary.builtin.length, 0)
})

test('extractToolSpecs 支持 tools / default.tools / default 数组三种写法', () => {
  assertEqual(extractToolSpecs({ tools: [{ name: 'a' }] }).length, 1)
  assertEqual(extractToolSpecs({ default: { tools: [{ name: 'b' }] } }).length, 1)
  assertEqual(extractToolSpecs({ default: [{ name: 'c' }] }).length, 1)
  assertEqual(extractToolSpecs({}).length, 0)
  assertEqual(extractToolSpecs(null).length, 0)
})

test('loadTools fresh:true 能绕过模块缓存重新加载（开发热重载）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aicoin-tools-'))
  try {
    const file = join(dir, 'dyn_tool.mjs')
    await writeFile(file, `export const tools = [{ name: 'dyn_v1', description: 'v1', inputSchema: {}, handler: async () => 'v1' }]\n`, 'utf8')
    const registry1 = new ToolRegistry()
    const first = await loadTools({ registry: registry1, dir, builtins: false })
    assertEqual(first.tools.length, 1)
    assertEqual(registry1.names()[0], 'dyn_v1')

    await writeFile(file, `export const tools = [{ name: 'dyn_v2', description: 'v2', inputSchema: {}, handler: async () => 'v2' }]\n`, 'utf8')
    const registry2 = new ToolRegistry()
    const second = await loadTools({ registry: registry2, dir, builtins: false, fresh: true })
    assertEqual(second.tools.length, 1)
    assertEqual(registry2.names()[0], 'dyn_v2', 'fresh 应重新 import 拿到新内容')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('DEFAULT_TOOLS_DIR 指向 src/tools 目录', () => {
  assertIncludes(DEFAULT_TOOLS_DIR, join('src', 'tools'))
})

export const tests = suite.tests
export default suite
