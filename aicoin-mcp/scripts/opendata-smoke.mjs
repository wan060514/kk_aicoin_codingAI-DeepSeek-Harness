/**
 * scripts/opendata-smoke.mjs — 线上冒烟：验证 AiCoin Open Data v3 客户端能真的取到数据。
 *
 * 用法（本机没有 node 时用 Electron 当 node）：
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     scripts/opendata-smoke.mjs
 *
 * 只打只读接口，不写任何东西。任何一项失败都会以非 0 退出码结束。
 */

import { openapiGet, getCatalog, summarizeCatalog, describeGroup, compact } from '../src/openapi.mjs'
import { tools } from '../src/tools/opendata.mjs'

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const toolByName = new Map(tools.map((tool) => [tool.name, tool]))

async function callTool(name, args) {
  const tool = toolByName.get(name)
  if (!tool) throw new Error(`没有这个工具：${name}`)
  const raw = await tool.handler(args, { log: () => {} })
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
  return { raw, text }
}

// 1. 直连 && 鉴权
try {
  const ping = await openapiGet('/api/v3/market/ticker', { coin_key: 'bitcoin', market: 'binance' })
  record('openapiGet /market/ticker', ping.ok, ping.ok ? `last=${ping.data?.ticker?.last_usd}` : `${ping.error?.code}: ${ping.error?.message}`)
} catch (error) {
  record('openapiGet /market/ticker', false, String(error?.message ?? error))
}

// 2. catalog（线上优先）
try {
  const catalog = await getCatalog({ live: true })
  const summary = summarizeCatalog(catalog)
  record('catalog', catalog.count > 100, `source=${catalog.source} count=${catalog.count} groups=${summary.groups.length}`)
  const market = describeGroup(catalog, 'market', 100)
  record('catalog group=market', market.count >= 10, `${market.count} 个接口`)
} catch (error) {
  record('catalog', false, String(error?.message ?? error))
}

// 3. 工具：报价
try {
  const { raw } = await callTool('aicoin_quote', { coins: 'bitcoin,ethereum', view: 'both' })
  const ok = raw.ok === true && Array.isArray(raw.overview) && raw.overview.length > 0 && raw.ticker?.last_usd > 0
  record('aicoin_quote', ok, ok ? `btc=${raw.overview[0].price_usd} ticker=${raw.ticker.last_usd}` : JSON.stringify(raw).slice(0, 200))
} catch (error) {
  record('aicoin_quote', false, String(error?.message ?? error))
}

// 4. 工具：K 线
try {
  const { raw } = await callTool('aicoin_kline', { coin_key: 'bitcoin', market: 'binance', interval: '1h', limit: 5 })
  const ok = raw.ok === true && raw.count > 0 && typeof raw.summary?.last_close === 'number'
  record('aicoin_kline', ok, ok ? `bars=${raw.count} last_close=${raw.summary.last_close}` : JSON.stringify(raw).slice(0, 300))
} catch (error) {
  record('aicoin_kline', false, String(error?.message ?? error))
}

// 5. 工具：资金费率（免费 key 通常 403 —— 403 + needs_paid_key 也算「行为正确」）
try {
  const { raw } = await callTool('aicoin_derivatives', { view: 'funding', coin_key: 'bitcoin', limit: 3 })
  const pass = raw.ok === true || (raw.ok === false && raw.needs_paid_key === true)
  record(
    'aicoin_derivatives funding',
    pass,
    raw.ok === true ? `latest=${raw.latest_funding_rate_pct}% count=${raw.count}` : `403/needs_paid_key（免费档预期行为）`,
  )
} catch (error) {
  record('aicoin_derivatives funding', false, String(error?.message ?? error))
}

// 6. 工具：快讯（同上，免费档通常 403）
try {
  const { raw } = await callTool('aicoin_news', { view: 'flash', limit: 3 })
  const pass = (raw.ok === true && raw.count >= 0) || (raw.ok === false && raw.needs_paid_key === true)
  record('aicoin_news flash', pass, raw.ok === true ? `${raw.count} 条` : '403/needs_paid_key（免费档预期行为）')
} catch (error) {
  record('aicoin_news flash', false, String(error?.message ?? error))
}

// 7. 通用透传 + 未知接口的报错路径
try {
  const { raw } = await callTool('aicoin_data_query', { endpoint: 'market/klines', params: { coin_key: 'bitcoin', market: 'binance', limit: 2 }, maxItems: 3 })
  record('aicoin_data_query market/klines', raw.ok === true, raw.ok ? `data keys=${Object.keys(raw.data ?? {}).join(',')}` : `${raw.error?.code}`)
  const bad = await callTool('aicoin_data_query', { endpoint: 'nope/not-real' })
  record('aicoin_data_query 未知接口报错', bad.raw.ok === false && bad.raw.error?.code === 'UNKNOWN_ENDPOINT', bad.raw.error?.code)
} catch (error) {
  record('aicoin_data_query', false, String(error?.message ?? error))
}

// 7.5 能力表（不探测，纯本地事实表）
try {
  const { raw } = await callTool('aicoin_data_capabilities', {})
  const ok = raw.ok === true && Array.isArray(raw.available) && raw.available.includes('market/klines')
  record('aicoin_data_capabilities', ok, `available=${raw.available?.length} needs_paid_key=${raw.needs_paid_key?.length}`)
} catch (error) {
  record('aicoin_data_capabilities', false, String(error?.message ?? error))
}

// 8. compact 裁剪
try {
  const sample = { items: Array.from({ length: 50 }, (_, index) => ({ index, text: 'x'.repeat(600) })) }
  const squeezed = compact(sample, { maxItems: 3 })
  // compact 对「超长数组」返回 { total, items, truncated }，所以这里看 items.items
  const bucket = squeezed.items
  const ok = bucket.total === 50 && bucket.truncated === true && bucket.items.length === 3 && bucket.items[0].text.length < 600
  record('compact 裁剪', ok, `total=${bucket.total} kept=${bucket.items.length}`)
} catch (error) {
  record('compact 裁剪', false, String(error?.message ?? error))
}

const failed = results.filter((item) => !item.ok)
console.log(`\nRESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${results.length - failed.length}/${results.length})`)
if (failed.length > 0) {
  console.log(`失败项：${failed.map((item) => item.name).join(', ')}`)
  process.exitCode = 1
}
