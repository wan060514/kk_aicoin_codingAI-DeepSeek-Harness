/**
 * openapi.test.mjs — AiCoin Open Data v3 客户端的纯本地测试（不联网）。
 *
 * 覆盖：路径归一、query 序列化、签名头形状（固定 nonce/ts 可复现）、catalog 投影、
 * compact 裁剪、以及 opendata 工具模块的定义合法性。
 */

import {
  authHeaders,
  buildQuery,
  compact,
  describeEndpoint,
  describeGroup,
  groupOf,
  loadBundledCatalog,
  methodOf,
  normalizePath,
  summarizeCatalog,
} from '../src/openapi.mjs'
import { ToolRegistry, defineTool } from '../src/registry.mjs'
import { tools as opendataTools } from '../src/tools/opendata.mjs'
import { createSuite, assert, assertEqual, assertDeepEqual, assertIncludes } from './helpers/harness.mjs'

// 本套测试不应依赖外网：把 base 指到本地不可达端口，getCatalog() 会快速失败并退回内置清单
process.env.AICOIN_BASE_URL = 'http://127.0.0.1:9'

const suite = createSuite('openapi')
const { test } = suite

/* ------------------------------ 路径归一 ------------------------------ */

test('normalizePath 接受相对/带前缀/完整 URL 三种写法', () => {
  assertEqual(normalizePath('market/ticker'), '/api/v3/market/ticker')
  assertEqual(normalizePath('/market/ticker'), '/api/v3/market/ticker')
  assertEqual(normalizePath('/api/v3/market/ticker'), '/api/v3/market/ticker')
  assertEqual(normalizePath('api/v3/market/ticker'), '/api/v3/market/ticker')
  assertEqual(normalizePath('https://open.aicoin.com/api/v3/market/ticker?x=1'), '/api/v3/market/ticker')
  assertEqual(normalizePath('  /market/klines?coin_key=bitcoin  '), '/api/v3/market/klines')
  assertEqual(normalizePath(''), '/api/v3')
})

test('groupOf 取 /api/v3/<group> 的第 3 段', () => {
  assertEqual(groupOf('/api/v3/market/ticker'), 'market')
  assertEqual(groupOf('/api/v3/derivatives/open-interest/ranking'), 'derivatives')
  assertEqual(groupOf('/api/v3'), 'misc')
})

/* ------------------------------ query ------------------------------ */

test('buildQuery 跳过空值、数组用逗号、对象转 JSON', () => {
  assertEqual(buildQuery({}), '')
  assertEqual(buildQuery({ coin_key: 'bitcoin', market: 'binance' }), 'coin_key=bitcoin&market=binance')
  assertEqual(buildQuery({ a: null, b: undefined, c: '', d: 0 }), 'd=0')
  assertEqual(buildQuery({ keys: ['a', 'b'] }), 'keys=a%2Cb')
  assertEqual(buildQuery({ obj: { x: 1 } }), 'obj=%7B%22x%22%3A1%7D')
  assertEqual(buildQuery({ empty: [] }), '')
})

/* ------------------------------ 签名 ------------------------------ */

test('authHeaders 用固定 nonce/ts 时签名可复现且是 base64', () => {
  const first = authHeaders({ keyId: 'kid', secret: 'secret', nonce: 'abcdef', timestamp: 1700000000 })
  const second = authHeaders({ keyId: 'kid', secret: 'secret', nonce: 'abcdef', timestamp: 1700000000 })
  assertEqual(first['X-Aic-Signature'], second['X-Aic-Signature'])
  assertEqual(first['X-Aic-AccessKey-Id'], 'kid')
  assertEqual(first['X-Aic-Signature-Nonce'], 'abcdef')
  assertEqual(first['X-Aic-Timestamp'], '1700000000')
  assert(/^[A-Za-z0-9+/]+=*$/.test(first['X-Aic-Signature']), `签名应是 base64：${first['X-Aic-Signature']}`)
  // 换 secret 必须换签名
  const other = authHeaders({ keyId: 'kid', secret: 'secret2', nonce: 'abcdef', timestamp: 1700000000 })
  assert(first['X-Aic-Signature'] !== other['X-Aic-Signature'], '不同 secret 必须得到不同签名')
})

test('authHeaders 默认不泄漏 secret 字段', () => {
  const headers = authHeaders({ keyId: 'kid', secret: 'topsecret' })
  const flat = JSON.stringify(headers)
  assert(!flat.includes('topsecret'), '请求头里不应出现 secret 原文')
})

/* ------------------------------ catalog ------------------------------ */

test('内置清单结构完整：绝大多数是 GET，少量 POST（Hyperliquid 批量/国库/均价）', () => {
  const catalog = loadBundledCatalog()
  assertEqual(catalog.source, 'bundled')
  assert(catalog.count > 150, `内置清单接口数应 >150，实际 ${catalog.count}`)
  const methods = new Set()
  for (const endpoint of catalog.endpoints) {
    assert(typeof endpoint.path === 'string' && endpoint.path.startsWith('/api/v3/'), `path 不合法：${endpoint.path}`)
    methods.add(String(endpoint.method ?? 'GET').toUpperCase())
  }
  assertDeepEqual([...methods].sort(), ['GET', 'POST'])
  const postCount = catalog.endpoints.filter((endpoint) => String(endpoint.method).toUpperCase() === 'POST').length
  assert(postCount > 0 && postCount < catalog.count / 4, `POST 接口数应在合理范围，实际 ${postCount}`)
})

test('summarizeCatalog 分组计数之和等于总数', () => {
  const catalog = loadBundledCatalog()
  const summary = summarizeCatalog(catalog)
  assertEqual(summary.total, catalog.count)
  const sum = summary.groups.reduce((acc, item) => acc + item.count, 0)
  assertEqual(sum, catalog.count)
  const market = summary.groups.find((item) => item.group === 'market')
  assert(market && market.count >= 10, 'market 分组应有至少 10 个接口')
  assert(market.examples.length > 0, '分组应带代表接口')
})

test('describeGroup 给紧凑参数签名（必填带 *）且支持截断', () => {
  const catalog = loadBundledCatalog()
  const group = describeGroup(catalog, 'market', 3)
  assertEqual(group.group, 'market')
  assertEqual(group.endpoints.length, 3)
  assertEqual(group.truncated, true)
  const ticker = describeGroup(catalog, 'market', 60).endpoints.find((item) => item.path.endsWith('/market/ticker'))
  assert(ticker, '应能找到 market/ticker')
  assertIncludes(ticker.params, 'coin_key*')
  assertIncludes(ticker.params, 'market*')
})

test('describeEndpoint + methodOf 能定位接口；未知接口返回 null', () => {
  const catalog = loadBundledCatalog()
  const detail = describeEndpoint(catalog, 'market/klines')
  assert(detail, '应能查到 market/klines')
  assertEqual(detail.path, '/api/v3/market/klines')
  assert(Array.isArray(detail.params) && detail.params.length > 0, '应带参数表')
  assertEqual(methodOf(catalog, '/api/v3/market/klines'), 'GET')
  assertEqual(describeEndpoint(catalog, 'nope/nothing'), null)
  assertEqual(methodOf(catalog, 'nope/nothing'), null)
})

/* ------------------------------ compact ------------------------------ */

test('compact 裁剪超长数组、截断长字符串、限制深度', () => {
  const long = { items: Array.from({ length: 30 }, (_, index) => ({ index, text: 'x'.repeat(500) })) }
  const out = compact(long, { maxItems: 2 })
  assertEqual(out.items.total, 30)
  assertEqual(out.items.truncated, true)
  assertEqual(out.items.items.length, 2)
  assert(out.items.items[0].text.length < 500, '长字符串应被截断')

  const deep = compact({ a: { b: { c: { d: { e: { f: 1 } } } } } }, { depth: 3 })
  assert(typeof deep.a.b.c === 'string' || typeof deep.a.b.c === 'object', '超过 depth 的层应被压成占位符')

  assertEqual(compact(null), null)
  assertEqual(compact(12), 12)
  assertEqual(compact('abc'), 'abc')
  assertDeepEqual(compact([1, 2]), [1, 2])
})

/* ------------------------------ 工具定义 ------------------------------ */

test('opendata 工具都能通过 registry 校验，名字合法且不重名', () => {
  const registry = new ToolRegistry()
  const names = []
  for (const spec of opendataTools) {
    const tool = defineTool(spec)
    registry.register(tool, { source: 'tools/opendata.mjs' })
    names.push(tool.name)
  }
  assertEqual(names.length, 8)
  assertEqual(new Set(names).size, names.length)
  for (const name of names) assert(name.startsWith('aicoin_data_') || name.startsWith('aicoin_'), `命名前缀：${name}`)
  assertIncludes(names.join(','), 'aicoin_data_query')
  assertIncludes(names.join(','), 'aicoin_data_catalog')
  assertIncludes(names.join(','), 'aicoin_quote')
  assertIncludes(names.join(','), 'aicoin_kline')
})

test('缺少必填参数时工具返回结构化失败而不是抛异常', async () => {
  const byName = new Map(opendataTools.map((spec) => [spec.name, defineTool(spec)]))

  const query = await byName.get('aicoin_data_query').handler({}, { log: () => {} })
  assertEqual(query.ok, false)
  assertEqual(query.error.code, 'INVALID_ARGUMENTS')

  const kline = await byName.get('aicoin_kline').handler({}, { log: () => {} })
  assertEqual(kline.ok, false)
  assertEqual(kline.error.code, 'INVALID_ARGUMENTS')

  const news = await byName.get('aicoin_news').handler({ view: 'search' }, { log: () => {} })
  assertEqual(news.error.code, 'INVALID_ARGUMENTS')
})

test('POST 接口被明确拒绝（本客户端只做只读 GET）', async () => {
  const byName = new Map(opendataTools.map((spec) => [spec.name, defineTool(spec)]))
  const result = await byName.get('aicoin_data_query').handler({ endpoint: 'treasuries/entities' }, { log: () => {} })
  assertEqual(result.ok, false)
  assertEqual(result.error.code, 'READ_ONLY')
  assertIncludes(String(result.error.message), 'POST')
})

test('未知接口在发请求前就被拦下（不消耗配额）', async () => {
  const byName = new Map(opendataTools.map((spec) => [spec.name, defineTool(spec)]))
  const result = await byName.get('aicoin_data_query').handler({ endpoint: 'definitely/not/real' }, { log: () => {} })
  assertEqual(result.ok, false)
  assertEqual(result.error.code, 'UNKNOWN_ENDPOINT')
})

test('能力表工具在非探测模式下不联网，直接给免费档事实表', async () => {
  const byName = new Map(opendataTools.map((spec) => [spec.name, defineTool(spec)]))
  const result = await byName.get('aicoin_data_capabilities').handler({}, { log: () => {} })
  assertEqual(result.ok, true)
  assert(Array.isArray(result.available) && result.available.includes('market/klines'))
  assert(Array.isArray(result.needs_paid_key) && result.needs_paid_key.length > 0)
  assertIncludes(String(result.note), 'AICOIN_ACCESS_KEY_ID')
})

export const tests = suite.tests
export default suite
