/**
 * tools/opendata.mjs — AiCoin Open Data v3 行情/资讯工具（只读，HTTP API）。
 *
 * 与其它工具模块的分工：
 *   · `aicoin_app_*`  → 走 CDP 驱动**桌面客户端**（切图、读界面、改指标、下单按钮…）
 *   · `aicoin_data_*` → 走 `https://open.aicoin.com` 的**结构化只读接口**（本文件）
 * 两者互补：界面上看到的东西用 app_*，要拿干净的数字序列用 data_*。
 *
 * 设计取向：
 *   · 一个**通用透传** `aicoin_data_query`（端点 + 参数）覆盖全部 183 个只读接口，
 *     模型不需要我们预先包装每个接口；
 *   · 一个 **catalog** `aicoin_data_catalog` 让模型自己发现接口和参数（线上实时，
 *     失败退回仓库内置清单）；
 *   · 再加 5 个高频具名工具，省掉"先查 catalog 再拼参数"的两步。
 *   · 输出一律 `compact()` 裁剪（数组只留前 N 条并标 total），避免 500 根 K 线撑爆上下文。
 *
 * 免费档现实（2026-10-24 实测，内置免费 key）：
 *   可用 → market/ticker、market/tickers、market/klines、coins/tickers、coins/search、markets、
 *          hyperliquid/tickers、airdrops、_catalog
 *   403  → 资金费率/持仓量/多空比/清算、快讯/资讯/X 推文、指数/宏观/信号、全量币种、深度/大单、
 *          指标 K 线 —— 这些要用户自己的 key（AICOIN_ACCESS_KEY_ID / AICOIN_ACCESS_SECRET）。
 *   所以「工具存在」不等于「免费 key 能用」：403 时统一返回 needs_paid_key + 可用清单。
 *
 * 不提供任何交易能力（官方 183 个接口里也没有 GET 下单接口）。
 *
 * @module tools/opendata
 */

import { defineTool } from '../registry.mjs'
import {
  compact,
  describeEndpoint,
  describeGroup,
  getCatalog,
  methodOf,
  normalizePath,
  openapiGet,
  summarizeCatalog,
} from '../openapi.mjs'

const MAX_ITEMS_DEFAULT = 20

const DEFAULT_MARKET = 'binance'

/** 当前是否在用自己 key（只暴露布尔，不泄漏 secret）。 */
function credentialsForReport() {
  return { usingOwnKey: Boolean(process.env.AICOIN_ACCESS_KEY_ID && process.env.AICOIN_ACCESS_SECRET) }
}

function loggerOf(ctx) {
  return typeof ctx?.log === 'function' ? ctx.log : null
}

/** 统一失败信封（不抛异常，模型读到 ok:false 自己会改）。 */
function fail(code, message, extra = {}) {
  return { ok: false, error: { code, message }, ...extra }
}

/** 数字字符串转数字（接口里价格常是 "80558.6" 字符串）。 */
function num(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** K 线响应里取蜡烛数组：兼容 `candles` / `items` / 裸数组三种。 */
function candlesOf(data) {
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.candles)) return data.candles
  if (Array.isArray(data?.items)) return data.items
  if (Array.isArray(data?.list)) return data.list
  if (Array.isArray(data?.bars)) return data.bars
  return []
}

/** 从 `{items:[...]}` 或数组里取列表。 */
function listOf(data) {
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.items)) return data.items
  if (Array.isArray(data?.list)) return data.list
  return []
}

/**
 * 免费 key 的实测可用性（2026-10-24 实测，内置免费 key）。
 * 只用于给模型/用户一个准确的预期；真正的判据永远是接口返回的 HTTP 状态。
 */
const FREE_TIER_VERIFIED = {
  available: [
    'market/ticker',
    'market/tickers',
    'market/klines',
    'coins/tickers',
    'coins/search',
    'markets',
    'hyperliquid/tickers',
    'airdrops',
    '_catalog',
  ],
  needs_paid_key: [
    'derivatives/*（资金费率、持仓量、多空比、清算）',
    'content/*（快讯、资讯、X 推文）',
    'indexes/*、macro/*、signals/*',
    'coins（全量列表）、coins/detail、coins/profile',
    'market/overview、market/big-orders、market/trades、market/orderbook/*',
    'market/indicator-klines、market/indicator-pairs',
  ],
  note: '免费 key 只能拿「行情快照 + K 线 + 币种搜索 + 交易所列表」。要资金费率/清算/资讯等，需要自己的 key（https://www.aicoin.com/opendata），填 AICOIN_ACCESS_KEY_ID / AICOIN_ACCESS_SECRET。',
}

/** 给 403/TIER 的返回加上「需要自己的 key」标记，模型和面板都能一眼看懂。 */
function withTierHint(result) {
  if (!result || result.ok) return result
  const code = String(result.error?.code ?? '')
  const tier = code === 'TIER' || result.status === 403
  return {
    ...result,
    needs_paid_key: tier,
    free_tier: tier ? FREE_TIER_VERIFIED : undefined,
  }
}

// ---------------------------------------------------------------------------
// 1. catalog
// ---------------------------------------------------------------------------

const catalogTool = defineTool({
  name: 'aicoin_data_catalog',
  title: 'AiCoin 开放接口清单',
  description:
    '列出 AiCoin Open Data v3 的只读接口（线上实时 183 个，失败退回内置清单）。' +
    '不带参数 → 按分组给数量与代表接口；给 group → 该组全部接口（路径/说明/参数签名，必填参数带 *）；' +
    '给 path → 该接口的完整参数说明（含 enum、是否必填）。' +
    '拿到路径和参数后，用 aicoin_data_query 调它。' +
    ' / List AiCoin Open Data v3 endpoints (group summary, group detail, or one endpoint signature).',
  inputSchema: {
    type: 'object',
    properties: {
      group: {
        type: 'string',
        description: '分组名：coins / market / derivatives / content / signals / indexes / hyperliquid / treasuries / equities / airdrops / drop-radar / macro / markets / pairs / providers / institutions / sdk。',
      },
      path: {
        type: 'string',
        description: '接口路径，如 market/ticker 或 /api/v3/market/ticker。给了它就返回该接口的完整参数表。',
      },
      live: {
        type: 'boolean',
        description: 'true 时强制拉线上清单（默认 10 分钟缓存）。',
      },
    },
    additionalProperties: false,
  },
  handler: async (args = {}) => {
    const catalog = await getCatalog({ live: args.live === true })
    const head = { source: catalog.source, generated_at: catalog.generated_at, count: catalog.count }

    if (args.path) {
      const detail = describeEndpoint(catalog, args.path)
      if (!detail) {
        return fail('UNKNOWN_ENDPOINT', `清单里没有这个接口：${normalizePath(args.path)}`, {
          hint: '先用 aicoin_data_catalog 不带参数看分组，再用 group 看具体接口。',
          ...head,
        })
      }
      return { ok: true, ...head, endpoint: detail, next: '用 aicoin_data_query {endpoint, params} 调用它。' }
    }

    if (args.group) {
      const group = describeGroup(catalog, args.group, 60)
      if (group.count === 0) {
        return fail('UNKNOWN_GROUP', `没有这个分组：${args.group}`, { ...head, groups: summarizeCatalog(catalog).groups.map((item) => item.group) })
      }
      return { ok: true, ...head, ...group }
    }

    const summary = summarizeCatalog(catalog)
    return {
      ok: true,
      ...head,
      groups: summary.groups,
      next: '给 group 看该组接口；给 path 看单个接口参数；或直接 aicoin_data_query。',
    }
  },
})

// ---------------------------------------------------------------------------
// 1.5 能力探测（告诉模型/用户「哪些接口这个 key 真的能用」）
// ---------------------------------------------------------------------------

/** 探测用的参数默认值：只覆盖最常见的一批，覆盖不到的接口标记为 skipped。 */
const SAMPLE_PARAMS = {
  coin_key: 'bitcoin',
  coin_keys: 'bitcoin',
  quote_coin_key: 'usdt',
  market: DEFAULT_MARKET,
  contract_type: 'spot',
  interval: '1h',
  limit: 2,
  query: 'ETH',
  indicator_key: 'liquidation',
  window: '24h',
  index_key: 'aicoin',
  index_type: 'region',
}

/** 默认探测清单（覆盖各分组最常用的只读接口，控制在 8 个以内以避开免费档 15 req/min）。 */
const PROBE_LIST = [
  'market/ticker',
  'market/tickers',
  'market/klines',
  'coins/tickers',
  'coins/search',
  'derivatives/funding-rates',
  'content/newsflashes',
  'market/overview',
]

function probeParams(endpoint) {
  const params = {}
  const missing = []
  for (const param of endpoint.params ?? []) {
    if (param?.required !== true) continue
    const name = String(param.name)
    if (name in SAMPLE_PARAMS) {
      params[name] = /limit/i.test(name) ? 2 : SAMPLE_PARAMS[name]
      continue
    }
    missing.push(name)
  }
  return { params, missing }
}

const capabilitiesTool = defineTool({
  name: 'aicoin_data_capabilities',
  title: '开放接口可用性（免费 key 能调哪些）',
  description:
    '告诉你「当前这把 key 到底能调哪些接口」。不带 probe 时返回已知的免费档事实表（行情快照/K线可用，' +
    '衍生品/资讯/指标K线要付费 key）；probe=true 时真的逐个打一遍并回报 HTTP 状态（默认 8 个，' +
    '受免费档 15 req/min 限制，别反复调）。' +
    ' / Which AiCoin Open Data endpoints the current key can actually call.',
  inputSchema: {
    type: 'object',
    properties: {
      probe: { type: 'boolean', description: 'true 时真的探测（会消耗请求配额，默认 false）。' },
      group: { type: 'string', description: 'probe=true 时只探测该分组（如 derivatives）。' },
      limit: { type: 'integer', description: 'probe=true 时最多探测几个接口，默认 8，上限 12。' },
    },
    additionalProperties: false,
  },
  handler: async (args = {}) => {
    const creds = credentialsForReport()
    if (args.probe !== true) {
      return {
        ok: true,
        using_own_key: creds.usingOwnKey,
        ...FREE_TIER_VERIFIED,
      }
    }

    const catalog = await getCatalog()
    const cap = Math.min(Math.max(Number(args.limit) || PROBE_LIST.length, 1), 12)
    const wanted = args.group
      ? (catalog.endpoints ?? []).filter((endpoint) => String(endpoint.path).split('/').filter(Boolean)[2] === args.group)
      : PROBE_LIST.map((relative) => (catalog.endpoints ?? []).find((endpoint) => String(endpoint.path).endsWith(`/${relative}`))).filter(Boolean)

    const checked = []
    for (const endpoint of wanted.slice(0, cap)) {
      const { params, missing } = probeParams(endpoint)
      if (missing.length > 0) {
        checked.push({ path: endpoint.path, result: 'skipped', reason: `缺少必填参数样例：${missing.join(', ')}` })
        continue
      }
      const response = await openapiGet(endpoint.path, params)
      checked.push({
        path: endpoint.path,
        result: response.ok ? 'ok' : String(response.error?.code ?? 'error'),
        status: response.status,
        tookMs: response.tookMs,
      })
    }
    return {
      ok: true,
      using_own_key: creds.usingOwnKey,
      probed: checked.length,
      results: checked,
      free_tier: FREE_TIER_VERIFIED,
    }
  },
})

// ---------------------------------------------------------------------------
// 2. 通用透传
// ---------------------------------------------------------------------------

const queryTool = defineTool({
  name: 'aicoin_data_query',
  title: 'AiCoin 开放接口（通用）',
  description:
    '直接调用 AiCoin Open Data v3 的任意**只读**接口。endpoint 支持 `market/ticker`、`/market/ticker`、' +
    '`/api/v3/market/ticker` 三种写法；params 原样作为 query 参数（对象/数组会自动序列化）。' +
    '非 GET 接口一律拒绝。返回 `{ok, data, meta, tookMs}`，失败给 `error.code`（AUTH/TIER/TIMEOUT/NETWORK/HTTP_xxx）。' +
    '不知道接口名就先 aicoin_data_catalog。' +
    ' / Call any read-only AiCoin Open Data v3 endpoint with query params.',
  inputSchema: {
    type: 'object',
    properties: {
      endpoint: {
        type: 'string',
        description: '接口路径，如 market/klines、/api/v3/derivatives/funding-rates。',
      },
      params: {
        type: 'object',
        description: 'query 参数对象，如 {coin_key:"bitcoin", market:"binance", interval:"1h", limit:100}。',
        additionalProperties: true,
      },
      maxItems: {
        type: 'integer',
        description: `数组最多返回多少条（默认 ${MAX_ITEMS_DEFAULT}），超出部分只给 total。`,
      },
      timeoutMs: {
        type: 'integer',
        description: '超时毫秒，默认 20000。',
      },
    },
    required: ['endpoint'],
    additionalProperties: false,
  },
  handler: async (args = {}, ctx) => {
    const log = loggerOf(ctx)
    const endpoint = args.endpoint
    if (!endpoint || typeof endpoint !== 'string') {
      return fail('INVALID_ARGUMENTS', 'endpoint 必填，例如 market/ticker。')
    }
    const catalog = await getCatalog()
    const method = methodOf(catalog, endpoint)
    if (method === null) {
      return fail('UNKNOWN_ENDPOINT', `清单里没有这个接口：${normalizePath(endpoint)}`, {
        hint: '先用 aicoin_data_catalog 查分组与接口名。',
        catalog_source: catalog.source,
      })
    }
    if (method !== 'GET') {
      return fail('READ_ONLY', `本工具只允许 GET 接口，${normalizePath(endpoint)} 是 ${method}。`)
    }

    const result = await openapiGet(endpoint, args.params ?? {}, { timeoutMs: args.timeoutMs })
    log?.('debug', `openapi ${result.endpoint} → ${result.ok ? 'ok' : result.error?.code} (${result.tookMs}ms)`)
    if (!result.ok) return withTierHint(result)
    return {
      ok: true,
      endpoint: result.endpoint,
      tookMs: result.tookMs,
      using_own_key: result.usingOwnKey === true,
      meta: result.meta,
      data: compact(result.data, { maxItems: args.maxItems ?? MAX_ITEMS_DEFAULT }),
    }
  },
})

// ---------------------------------------------------------------------------
// 3. 报价
// ---------------------------------------------------------------------------

const quoteTool = defineTool({
  name: 'aicoin_quote',
  title: '币价 / 涨跌幅',
  description:
    '拿币种报价。view=overview（默认）：多币种总览（价格、24h/7d 涨跌幅、成交额、净流入），用 coins 传 ' +
    '`bitcoin,ethereum` 这类 coin_key 逗号串（不传=主要币种）。view=ticker：单交易所单交易对实时行情（开高低收+24h高低），' +
    '需要 coins 里给一个 coin_key 与 market。view=both 两个都给。' +
    ' / Crypto quotes: multi-coin overview and/or single-pair realtime ticker.',
  inputSchema: {
    type: 'object',
    properties: {
      coins: {
        type: 'string',
        description: 'coin_key 逗号串，如 bitcoin,ethereum,solana（也接受 BTC/ETH 这类符号，会自动搜一次）。',
      },
      market: {
        type: 'string',
        description: `交易所，默认 ${DEFAULT_MARKET}。`,
      },
      contract_type: {
        type: 'string',
        description: '合约类型（现货可省略），如 perp / swap / spot。',
      },
      view: {
        type: 'string',
        enum: ['overview', 'ticker', 'both'],
        description: 'overview=多币种总览；ticker=单交易对实时行情；both=都要。',
      },
    },
    additionalProperties: false,
  },
  handler: async (args = {}) => {
    const view = args.view ?? 'overview'
    const market = args.market ?? DEFAULT_MARKET
    const coinsArg = typeof args.coins === 'string' ? args.coins.trim() : ''

    // 允许用户直接给 BTC/ETH 这类符号：先搜一次换成 coin_key
    let coinKeys = coinsArg
    let resolvedFrom = null
    if (coinsArg && /^[A-Z0-9,\s]{2,}$/.test(coinsArg) && !coinsArg.includes('coin')) {
      const search = await openapiGet('/api/v3/coins/search', { query: coinsArg.split(',')[0].trim(), limit: 5 })
      const hits = listOf(search.ok ? search.data : null)
      const dbKeys = hits.flatMap((item) => (Array.isArray(item?.db_keys) ? item.db_keys : []))
      const cleaned = [...new Set(dbKeys.map((key) => String(key).split(':')[0]))].filter(Boolean)
      if (cleaned.length > 0) {
        coinKeys = coinsArg
          .split(',')
          .map((token) => {
            const symbol = token.trim().toUpperCase()
            const match = hits.find(
              (hit) =>
                String(hit?.symbol ?? hit?.coin_symbol ?? '').toUpperCase() === symbol ||
                String(hit?.coin_key ?? '').toLowerCase() === symbol.toLowerCase(),
            )
            return match?.coin_key ?? symbol.toLowerCase()
          })
          .join(',')
        resolvedFrom = coinsArg
      }
    }

    const out = { ok: true, market, coins: coinKeys || null }

    if (view === 'overview' || view === 'both') {
      const overview = await openapiGet('/api/v3/coins/tickers', coinKeys ? { coin_key: coinKeys } : {})
      if (!overview.ok) return overview
      out.overview = listOf(overview.data).map((item) => ({
        coin_key: item?.coin_key,
        price_usd: num(item?.price_usd),
        change_24h_pct: num(item?.degree_24h_usd),
        change_7d_pct: num(item?.degree_7day_usd),
        turnover_24h_usd: num(item?.trade_24h_usd),
        volume_24h: num(item?.vol_24h),
        net_inflow_24h_usd: num(item?.fundNetIn_24h_usd),
        market_cap_usd: num(item?.supply_usd),
      }))
      out.overview_count = out.overview.length
    }

    if (view === 'ticker' || view === 'both') {
      const first = String(coinKeys || 'bitcoin').split(',')[0].trim()
      const params = { coin_key: first, market }
      if (args.contract_type) params.contract_type = args.contract_type
      const ticker = await openapiGet('/api/v3/market/ticker', params)
      if (!ticker.ok) return withTierHint(ticker)
      const pair = ticker.data?.pair ?? null
      const row = ticker.data?.ticker ?? {}
      out.ticker = {
        pair,
        last_usd: num(row.last_usd),
        high_24h_usd: num(row.high24h_usd),
        low_24h_usd: num(row.low24h_usd),
      }
    }

    if (resolvedFrom) out.resolved_from = resolvedFrom
    out.tookMs_note = '价格来自 open.aicoin.com（与客户端界面可能差 1 个 tick）'
    return out
  },
})

// ---------------------------------------------------------------------------
// 4. K 线
// ---------------------------------------------------------------------------

const klineTool = defineTool({
  name: 'aicoin_kline',
  title: 'K 线序列',
  description:
    '取标准 K 线（OHLCV）。coin_key 用 coin_key 名（如 bitcoin，不是 BTC）；market 如 binance/okx；' +
    'interval 支持 1m/3m/5m/15m/30m/1h/2h/4h/6h/8h/12h/1d/3d/1w。' +
    '返回按时间排序的数组，并附 summary（最新收盘、区间高低、条数）。' +
    '注意：这是**交易所行情**，不是客户端图表上你自己画的指标。' +
    ' / OHLCV klines for a coin/market with a compact summary.',
  inputSchema: {
    type: 'object',
    properties: {
      coin_key: { type: 'string', description: '币种 key，如 bitcoin / ethereum。' },
      market: { type: 'string', description: `交易所，默认 ${DEFAULT_MARKET}。` },
      interval: { type: 'string', description: '周期，默认 1h。' },
      limit: { type: 'integer', description: '条数，默认 120，最多 500。' },
      quote_coin_key: { type: 'string', description: '计价币，默认 usdt。' },
      contract_type: { type: 'string', description: '现货可省略；永续写 perp/swap。' },
      start_time: { type: 'integer', description: '起始时间（秒级时间戳），可选。' },
      end_time: { type: 'integer', description: '结束时间（秒级时间戳），可选。' },
    },
    required: ['coin_key'],
    additionalProperties: false,
  },
  handler: async (args = {}) => {
    if (!args.coin_key) return fail('INVALID_ARGUMENTS', 'coin_key 必填（如 bitcoin）。')
    const limit = Math.min(Math.max(Number(args.limit) || 120, 1), 500)
    const params = {
      coin_key: args.coin_key,
      market: args.market ?? DEFAULT_MARKET,
      quote_coin_key: args.quote_coin_key ?? 'usdt',
      interval: args.interval ?? '1h',
      limit,
    }
    if (args.contract_type) params.contract_type = args.contract_type
    if (args.start_time) params.start_time = args.start_time
    if (args.end_time) params.end_time = args.end_time

    const result = await openapiGet('/api/v3/market/klines', params)
    if (!result.ok) return withTierHint(result)

    // 实测响应形状：{ candles:[{time(毫秒),open,high,low,close,volume}], pair:{...} }
    const rows = candlesOf(result.data)
    const closes = rows.map((row) => (Array.isArray(row) ? num(row[4]) : num(row?.close ?? row?.c)))
    const highs = rows.map((row) => (Array.isArray(row) ? num(row[2]) : num(row?.high ?? row?.h)))
    const lows = rows.map((row) => (Array.isArray(row) ? num(row[3]) : num(row?.low ?? row?.l)))
    const valid = closes.filter((value) => value !== null)
    const highValues = highs.filter((value) => value !== null)
    const lowValues = lows.filter((value) => value !== null)
    return {
      ok: true,
      endpoint: result.endpoint,
      params,
      pair: result.data?.pair ?? null,
      count: rows.length,
      summary: {
        first_close: valid[0] ?? null,
        last_close: valid[valid.length - 1] ?? null,
        high: highValues.length ? Math.max(...highValues) : null,
        low: lowValues.length ? Math.min(...lowValues) : null,
      },
      bars: compact(rows, { maxItems: limit, maxString: 80 }),
    }
  },
})

// ---------------------------------------------------------------------------
// 5. 指标 K 线（AiCoin 自带指标时序）
// ---------------------------------------------------------------------------

const indicatorKlineTool = defineTool({
  name: 'aicoin_indicator_kline',
  title: 'AiCoin 指标 K 线（指标时序数据）',
  description:
    '取 AiCoin 自有指标的时序数据（例如爆仓统计、主力持仓类指标），不是普通 OHLC（免费 key 通常 403）。' +
    'view=series（默认）需要 coin_key + market + indicator_key；view=pairs 只传 coin_key + indicator_key，' +
    '返回该指标支持的交易对列表（用来确认 market 该怎么写）。' +
    '写 AiScript 指标想核对「AiCoin 同名指标真实数值」时用这个。' +
    ' / AiCoin built-in indicator time series (and the trading pairs an indicator supports).',
  inputSchema: {
    type: 'object',
    properties: {
      view: { type: 'string', enum: ['series', 'pairs'], description: 'series=指标时序；pairs=该指标支持的交易对。' },
      coin_key: { type: 'string', description: '币种 key，如 bitcoin。' },
      market: { type: 'string', description: `交易所，默认 ${DEFAULT_MARKET}。` },
      indicator_key: { type: 'string', description: '指标 key（可用 view=pairs 先看可用交易对；不知道 key 时先 aicoin_data_catalog {group:"market"}）。' },
      interval: { type: 'string', description: '周期，默认 15m。' },
      limit: { type: 'integer', description: '条数，默认 60。' },
      contract_type: { type: 'string', description: '合约类型，可选。' },
    },
    required: ['coin_key', 'indicator_key'],
    additionalProperties: false,
  },
  handler: async (args = {}) => {
    if (!args.coin_key) return fail('INVALID_ARGUMENTS', 'coin_key 必填（如 bitcoin）。')
    if (!args.indicator_key) return fail('INVALID_ARGUMENTS', 'indicator_key 必填。')

    if ((args.view ?? 'series') === 'pairs') {
      const result = await openapiGet('/api/v3/market/indicator-pairs', {
        coin_key: args.coin_key,
        indicator_key: args.indicator_key,
      })
      if (!result.ok) return withTierHint(result)
      return { ok: true, endpoint: result.endpoint, data: compact(result.data, { maxItems: 40 }) }
    }

    const limit = Math.min(Math.max(Number(args.limit) || 60, 1), 500)
    const result = await openapiGet('/api/v3/market/indicator-klines', {
      coin_key: args.coin_key,
      market: args.market ?? DEFAULT_MARKET,
      indicator_key: args.indicator_key,
      interval: args.interval ?? '15m',
      limit,
    })
    if (!result.ok) return withTierHint(result)
    return { ok: true, endpoint: result.endpoint, count: candlesOf(result.data).length, data: compact(result.data, { maxItems: limit }) }
  },
})

// ---------------------------------------------------------------------------
// 6. 衍生品
// ---------------------------------------------------------------------------

const derivativesTool = defineTool({
  name: 'aicoin_derivatives',
  title: '衍生品：资金费率 / 持仓量 / 多空比 / 清算',
  description:
    '衍生品数据一站式。view=funding：资金费率历史（返回 8h OHLC 序列，close 是当期结算费率，小数）；' +
    'view=open-interest：全市场合约持仓量排名；view=long-short：多空比历史（不传 coin_key 时给全市场汇总）；' +
    'view=liquidations：清算地图（传 window=24h 等）或爆仓汇总（不传 window）。' +
    ' / Derivatives data: funding rates, open interest ranking, long/short ratio, liquidations.',
  inputSchema: {
    type: 'object',
    properties: {
      view: {
        type: 'string',
        enum: ['funding', 'open-interest', 'long-short', 'liquidations'],
        description: '要哪一种数据。',
      },
      coin_key: { type: 'string', description: '币种 key，如 bitcoin（funding/long-short/liquidations 用）。' },
      market: { type: 'string', description: `交易所，默认 ${DEFAULT_MARKET}。` },
      interval: { type: 'string', description: '周期，默认 8h（funding）；long-short 默认 1h。' },
      limit: { type: 'integer', description: '条数，默认 48。' },
      window: { type: 'string', description: 'liquidation map 的时间窗：1h / 4h / 24h / 7d。' },
      leverage: { type: 'string', description: '清算地图的杠杆倍数，可选（如 10、25、50、100）。' },
      contract_type: { type: 'string', description: '合约类型，可选（perp/swap）。' },
    },
    required: ['view'],
    additionalProperties: false,
  },
  handler: async (args = {}) => {
    const view = args.view ?? 'funding'
    const market = args.market ?? DEFAULT_MARKET
    const limit = Math.min(Math.max(Number(args.limit) || 48, 1), 500)

    if (view === 'funding') {
      if (!args.coin_key) return fail('INVALID_ARGUMENTS', 'view=funding 需要 coin_key（如 bitcoin）。')
      const params = { coin_key: args.coin_key, market, interval: args.interval ?? '8h', limit }
      if (args.contract_type) params.contract_type = args.contract_type
      const result = await openapiGet('/api/v3/derivatives/funding-rates', params)
      if (!result.ok) return withTierHint(result)
      const rows = listOf(result.data)
      const latest = rows[rows.length - 1]
      const latestClose = Array.isArray(latest) ? num(latest[4]) : num(latest?.close)
      return {
        ok: true,
        endpoint: result.endpoint,
        count: rows.length,
        latest_funding_rate: latestClose,
        latest_funding_rate_pct: latestClose === null ? null : latestClose * 100,
        note: 'close 是当期结算费率（小数），×100 = 百分比；正=多付空。',
        series: compact(rows, { maxItems: limit, maxString: 80 }),
      }
    }

    if (view === 'open-interest') {
      const result = await openapiGet('/api/v3/derivatives/open-interest/ranking', { limit })
      if (!result.ok) return withTierHint(result)
      return { ok: true, endpoint: result.endpoint, data: compact(result.data, { maxItems: limit }) }
    }

    if (view === 'long-short') {
      if (!args.coin_key) {
        const summary = await openapiGet('/api/v3/derivatives/long-short-ratio/summary', {})
        if (!summary.ok) return withTierHint(summary)
        return { ok: true, endpoint: summary.endpoint, note: '全市场汇总（不分币种）', data: compact(summary.data, { maxItems: 30 }) }
      }
      const params = { coin_key: args.coin_key, market, interval: args.interval ?? '1h', limit }
      if (args.contract_type) params.contract_type = args.contract_type
      const result = await openapiGet('/api/v3/derivatives/long-short-ratio', params)
      if (!result.ok) return withTierHint(result)
      return { ok: true, endpoint: result.endpoint, count: listOf(result.data).length, data: compact(result.data, { maxItems: limit }) }
    }

    // liquidations
    if (args.window) {
      if (!args.coin_key) return fail('INVALID_ARGUMENTS', '清算地图需要 coin_key。')
      const params = { coin_key: args.coin_key, market, window: args.window }
      if (args.leverage) params.leverage = args.leverage
      if (args.contract_type) params.contract_type = args.contract_type
      const result = await openapiGet('/api/v3/derivatives/liquidations/map', params)
      if (!result.ok) return withTierHint(result)
      return { ok: true, endpoint: result.endpoint, window: args.window, data: compact(result.data, { maxItems: 60, maxString: 200 }) }
    }

    const params = {}
    if (args.coin_key) params.coin_key = args.coin_key
    if (args.market) params.market = args.market
    const result = await openapiGet('/api/v3/derivatives/liquidations/summary', params)
    if (!result.ok) return withTierHint(result)
    return { ok: true, endpoint: result.endpoint, data: compact(result.data, { maxItems: 40 }) }
  },
})

// ---------------------------------------------------------------------------
// 7. 资讯
// ---------------------------------------------------------------------------

const newsTool = defineTool({
  name: 'aicoin_news',
  title: '快讯 / 资讯',
  description:
    'AiCoin 资讯（免费 key 通常 403，需要自备 key）。view=flash（默认）：7×24 快讯列表（标题+时间+重要性）；view=articles：资讯文章列表；' +
    'view=search：按关键词搜快讯（需要 query）。' +
    ' / AiCoin newsflashes, articles, or keyword search.',
  inputSchema: {
    type: 'object',
    properties: {
      view: { type: 'string', enum: ['flash', 'articles', 'search'], description: 'flash=快讯；articles=文章；search=搜快讯。' },
      limit: { type: 'integer', description: '条数，默认 15，最多 50。' },
      query: { type: 'string', description: 'view=search 时的关键词。' },
      locale: { type: 'string', enum: ['cn', 'en', 'tc'], description: '语言，默认 cn。' },
    },
    additionalProperties: false,
  },
  handler: async (args = {}) => {
    const view = args.view ?? 'flash'
    const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 50)

    if (view === 'search') {
      if (!args.query) return fail('INVALID_ARGUMENTS', 'view=search 需要 query。')
      const result = await openapiGet('/api/v3/content/newsflashes/search', { query: args.query, limit })
      if (!result.ok) return withTierHint(result)
      return { ok: true, endpoint: result.endpoint, data: compact(result.data, { maxItems: limit }) }
    }

    const endpoint = view === 'articles' ? '/api/v3/content/articles' : '/api/v3/content/newsflashes'
    const params = { limit }
    if (args.locale) params.locale = args.locale
    const result = await openapiGet(endpoint, params)
    if (!result.ok) return withTierHint(result)
    return { ok: true, endpoint: result.endpoint, count: candlesOf(result.data).length, data: compact(result.data, { maxItems: limit }) }
  },
})

export const tools = [
  catalogTool,
  capabilitiesTool,
  queryTool,
  quoteTool,
  klineTool,
  indicatorKlineTool,
  derivativesTool,
  newsTool,
]

export default tools
