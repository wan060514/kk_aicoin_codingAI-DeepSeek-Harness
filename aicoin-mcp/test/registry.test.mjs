/**
 * registry.test.mjs — 工具定义校验 / 注册表 / 结果规范化的测试（纯本地，不碰 CDP）。
 */

import { ToolRegistry, ToolError, defineTool, normalizeToolResult, TOOL_NAME_PATTERN } from '../src/registry.mjs'
import { createSuite, assert, assertEqual, assertDeepEqual, assertIncludes, assertRejects } from './helpers/harness.mjs'

const suite = createSuite('registry')
const { test } = suite

const okSpec = () => ({
  name: 'demo_tool',
  description: '演示工具',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  handler: async (args) => `got: ${args.text ?? ''}`,
})

/* ---------------------------- defineTool 校验 ---------------------------- */

test('defineTool 接受合法定义并规范化 inputSchema（补 type/properties）', () => {
  const tool = defineTool({ ...okSpec(), inputSchema: {}, title: '演示', annotations: { readOnlyHint: true } })
  assertEqual(tool.name, 'demo_tool')
  assertEqual(tool.description, '演示工具')
  assertEqual(tool.inputSchema.type, 'object')
  assertDeepEqual(tool.inputSchema.properties, {})
  assertEqual(tool.title, '演示')
  assertDeepEqual(tool.annotations, { readOnlyHint: true })
})

test('defineTool 拒绝非法工具名（大写/连字符/太短/太长/非字符串）', async () => {
  for (const name of ['Bad', 'has-dash', 'a', 'x'.repeat(65), 123, '', '空格 名']) {
    await assertRejects(() => Promise.resolve(defineTool({ ...okSpec(), name })), { code: 'INVALID_TOOL', includes: '工具名不合法' })
  }
  // 合法边界：2 位、64 位、下划线、数字
  assertEqual(defineTool({ ...okSpec(), name: 'ab' }).name, 'ab')
  assertEqual(defineTool({ ...okSpec(), name: 'a'.repeat(64) }).name, 'a'.repeat(64))
  assertEqual(defineTool({ ...okSpec(), name: 'a_b_9' }).name, 'a_b_9')
  assert(TOOL_NAME_PATTERN.test('ok_name_9'), '正则应接受 ok_name_9')
})

test('defineTool 拒绝缺失 description / 非法 inputSchema / 缺失 handler', async () => {
  await assertRejects(() => Promise.resolve(defineTool({ ...okSpec(), description: '' })), { includes: 'description' })
  await assertRejects(() => Promise.resolve(defineTool({ ...okSpec(), description: undefined })), { includes: 'description' })
  await assertRejects(() => Promise.resolve(defineTool({ ...okSpec(), inputSchema: [] })), { includes: 'inputSchema' })
  await assertRejects(() => Promise.resolve(defineTool({ ...okSpec(), inputSchema: null })), { includes: 'inputSchema' })
  await assertRejects(() => Promise.resolve(defineTool({ ...okSpec(), inputSchema: { type: 'string' } })), {
    includes: "inputSchema.type 必须是 'object'",
  })
  await assertRejects(() => Promise.resolve(defineTool({ ...okSpec(), inputSchema: { properties: [] } })), {
    includes: 'properties',
  })
  await assertRejects(() => Promise.resolve(defineTool({ ...okSpec(), handler: 'not-a-function' })), { includes: 'handler' })
  await assertRejects(() => Promise.resolve(defineTool(null)), { includes: '工具定义必须是对象' })
})

/* ---------------------------- 注册表 ---------------------------- */

test('register 注册工具，重名抛 DUPLICATE_TOOL 并保留原工具', () => {
  const registry = new ToolRegistry()
  registry.register(okSpec(), { source: 'a.mjs' })
  assertEqual(registry.size, 1)
  assertEqual(registry.has('demo_tool'), true)
  assertEqual(registry.get('demo_tool').source, 'a.mjs')
  assertEqual(registry.has('nope'), false)
  assertEqual(registry.get('nope'), undefined)
  let error = null
  try {
    registry.register(okSpec(), { source: 'b.mjs' })
  } catch (err) {
    error = err
  }
  assert(error instanceof ToolError, '重名应抛 ToolError')
  assertEqual(error.code, 'DUPLICATE_TOOL')
  assertIncludes(error.message, 'a.mjs')
  assertIncludes(error.message, 'b.mjs')
  assertEqual(registry.size, 1)
})

test('registerAll 逐个校验：坏工具只进 failed，不影响好工具', () => {
  const warnings = []
  const registry = new ToolRegistry({ log: (lvl, msg) => warnings.push(`${lvl}:${msg}`) })
  const result = registry.registerAll(
    [okSpec(), { name: 'BadName', description: 'x', inputSchema: {}, handler: () => {} }, { name: 'second_ok', description: 'd', inputSchema: {}, handler: () => 'ok' }],
    { source: 'mix.mjs' },
  )
  assertEqual(result.registered.length, 2)
  assertEqual(result.failed.length, 1)
  assertEqual(result.failed[0].name, 'BadName')
  assertEqual(registry.names().length, 2)
  assert(warnings.some((w) => w.startsWith('warn:') && w.includes('BadName')), '应 warn 坏工具')
})

test('list / names / toToolList 输出稳定且只含 MCP 需要的字段', () => {
  const registry = new ToolRegistry()
  registry.register({ ...okSpec(), name: 'zeta_tool' })
  registry.register({ ...okSpec(), name: 'alpha_tool' })
  assertDeepEqual(registry.names(), ['alpha_tool', 'zeta_tool'])
  const list = registry.toToolList()
  assertEqual(list.tools.length, 2)
  assertEqual(list.tools[0].name, 'alpha_tool')
  for (const item of list.tools) {
    assertEqual(typeof item.description, 'string')
    assertEqual(item.inputSchema.type, 'object')
    assertEqual(Object.hasOwn(item, 'handler'), false, 'tools/list 不能泄露 handler')
  }
})

/* ---------------------------- 结果规范化 ---------------------------- */

test('normalizeToolResult：字符串/对象/content 数组/空值', () => {
  assertDeepEqual(normalizeToolResult('hi'), { content: [{ type: 'text', text: 'hi' }] })
  const object = normalizeToolResult({ a: 1 })
  assertEqual(object.content[0].type, 'text')
  assertDeepEqual(JSON.parse(object.content[0].text), { a: 1 })
  assertDeepEqual(normalizeToolResult(undefined), { content: [{ type: 'text', text: 'ok' }] })
  assertDeepEqual(normalizeToolResult(null), { content: [{ type: 'text', text: 'ok' }] })
  const passthrough = normalizeToolResult({ content: [{ type: 'text', text: 'x' }], isError: true, structuredContent: { a: 1 } })
  assertEqual(passthrough.isError, true)
  assertDeepEqual(passthrough.structuredContent, { a: 1 })
  const array = normalizeToolResult([{ type: 'text', text: 'a' }])
  assertEqual(array.content.length, 1)
})

test('call：字符串结果、对象结果、handler 抛错 → isError:true 且带工具名', async () => {
  const registry = new ToolRegistry()
  registry.register(okSpec())
  const stringResult = await registry.call('demo_tool', { text: 'abc' }, {})
  assertDeepEqual(stringResult, { content: [{ type: 'text', text: 'got: abc' }] })

  registry.register({
    name: 'obj_tool',
    description: 'obj',
    inputSchema: {},
    handler: async () => ({ ok: true, n: 1 }),
  })
  const objectResult = await registry.call('obj_tool', {}, {})
  assertDeepEqual(JSON.parse(objectResult.content[0].text), { ok: true, n: 1 })

  registry.register({
    name: 'boom_tool',
    description: 'boom',
    inputSchema: {},
    handler: async () => {
      const error = new Error('内部炸了')
      error.code = 'BOOM'
      throw error
    },
  })
  const failedResult = await registry.call('boom_tool', {}, {})
  assertEqual(failedResult.isError, true)
  assertIncludes(failedResult.content[0].text, 'boom_tool')
  assertIncludes(failedResult.content[0].text, '内部炸了')
  assertIncludes(failedResult.content[0].text, 'BOOM')
})

test('call：未知工具抛 UNKNOWN_TOOL，非对象参数抛 INVALID_ARGUMENTS，参数缺省为 {}', async () => {
  const registry = new ToolRegistry()
  let seenArgs = null
  registry.register({ ...okSpec(), handler: async (args) => ((seenArgs = args), 'ok') })
  await registry.call('demo_tool', undefined, {})
  assertDeepEqual(seenArgs, {})
  await assertRejects(() => registry.call('no_such_tool', {}, {}), { code: 'UNKNOWN_TOOL', includes: '未知工具' })
  await assertRejects(() => registry.call('demo_tool', [1, 2], {}), { code: 'INVALID_ARGUMENTS' })
  await assertRejects(() => registry.call('demo_tool', 'str', {}), { code: 'INVALID_ARGUMENTS' })
})

test('handler 收到 (args, ctx)，ctx 原样传递', async () => {
  const registry = new ToolRegistry()
  const fakeCtx = { port: 9222, marker: 'ctx-marker' }
  registry.register({ ...okSpec(), handler: async (args, ctx) => ({ args, marker: ctx?.marker }) })
  const result = await registry.call('demo_tool', { text: 'x' }, fakeCtx)
  assertDeepEqual(JSON.parse(result.content[0].text), { args: { text: 'x' }, marker: 'ctx-marker' })
})

export const tests = suite.tests
export default suite
