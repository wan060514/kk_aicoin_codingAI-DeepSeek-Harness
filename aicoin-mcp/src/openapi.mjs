/**
 * openapi.mjs — AiCoin Open Data v3 只读客户端（零依赖）。
 *
 * 为什么有这个东西：本仓库原有的 17 个工具全部走 CDP 驱动**桌面客户端 UI**，
 * 能控制图表、能读界面，但**拿不到结构化行情数据**。AiCoin 官方提供的
 * Open Data v3（`https://open.aicoin.com`，183 个只读接口）正好补上这块。
 *
 * 鉴权方式（从官方实现里核对过的真实行为，不是猜的）：
 *   · 请求头携带 4 个值：
 *       X-Aic-AccessKey-Id / X-Aic-Signature-Nonce / X-Aic-Timestamp / X-Aic-Signature
 *   · 待签串：`AccessKeyId=<key>&SignatureNonce=<nonce>&Timestamp=<ts>`
 *   · 签名：HMAC-SHA1(待签串, secret) → hex → 对该 hex **字符串**做 base64
 *   · nonce = 8 字节随机 hex；ts = 秒级时间戳
 *   · 响应统一信封 `{ ok, data, error, meta }`，**先看 ok**
 *
 * 凭据：官方在客户端仓库里内置了一枚免费 key（IP 限速），不填 env 就用它；
 * 自己的 key 通过 `AICOIN_ACCESS_KEY_ID` / `AICOIN_ACCESS_SECRET` 覆盖（更高速率）。
 * 域名可用 `AICOIN_BASE_URL` 覆盖（默认 https://open.aicoin.com）。
 *
 * 安全边界：本模块**只实现 GET**。官方 183 个接口里没有任何下单/转账接口是 GET，
 * 我们也不提供交易所 API key 的任何入口 —— 这个模块动不了资金。
 *
 * @module openapi
 */

import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** 官方内置的免费 key（IP 限速；可在 env 里换成自己的）。 */
const BUNDLED_KEY_ID = 'ronJ8uI0Yj2soAfGVs5H1YALUIINbE22'
const BUNDLED_SECRET = 'CWHZcH2us1CLSE7grroR1TpS0Z1JxTwU'

/** 默认域名。 */
export const DEFAULT_BASE = 'https://open.aicoin.com'
/** 默认超时。 */
export const DEFAULT_TIMEOUT_MS = 20000
/** catalog 缓存时长。 */
export const CATALOG_TTL_MS = 10 * 60 * 1000

/** 读 env（每次调用都读，方便测试注入）。 */
function credentials() {
  const keyId = process.env.AICOIN_ACCESS_KEY_ID || BUNDLED_KEY_ID
  const secret = process.env.AICOIN_ACCESS_SECRET || BUNDLED_SECRET
  return { keyId, secret, usingOwnKey: Boolean(process.env.AICOIN_ACCESS_KEY_ID && process.env.AICOIN_ACCESS_SECRET) }
}

/** 当前 base（env 可覆盖）。 */
export function baseUrl() {
  return (process.env.AICOIN_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '')
}

/**
 * 生成签名头。导出以便测试。
 *
 * @param {{keyId?: string, secret?: string, nonce?: string, timestamp?: string|number}} [opts]
 * @returns {Record<string, string>}
 */
export function authHeaders(opts = {}) {
  const creds = credentials()
  const keyId = opts.keyId ?? creds.keyId
  const secret = opts.secret ?? creds.secret
  const nonce = opts.nonce ?? randomBytes(8).toString('hex')
  const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000))
  const signStr = `AccessKeyId=${keyId}&SignatureNonce=${nonce}&Timestamp=${ts}`
  const hex = createHmac('sha1', secret).update(signStr).digest('hex')
  const signature = Buffer.from(hex).toString('base64')
  return {
    'X-Aic-AccessKey-Id': keyId,
    'X-Aic-Signature-Nonce': nonce,
    'X-Aic-Timestamp': ts,
    'X-Aic-Signature': signature,
    Accept: 'application/json',
    'User-Agent': 'aicoin-mcp/0.4.0 (+dsh-plugin)',
  }
}

/**
 * 把用户给的 endpoint 归一成 `/api/v3/...`。
 * 接受 `market/ticker` / `/market/ticker` / `/api/v3/market/ticker` / 完整 URL。
 *
 * @param {string} endpoint
 * @returns {string}
 */
export function normalizePath(endpoint) {
  let path = String(endpoint ?? '').trim()
  path = path.replace(/^https?:\/\/[^/]+/i, '')
  path = path.split('?')[0].split('#')[0]
  if (/^\/?api\/v3(\/|$)/i.test(path)) {
    path = path.replace(/^\/?api\/v3/i, '')
    path = '/' + path.replace(/^\/+/, '')
    return path === '/' ? '/api/v3' : `/api/v3${path === '/' ? '' : path}`
  }
  path = path.replace(/^\/+/, '')
  return path ? `/api/v3/${path}` : '/api/v3'
}

/**
 * query 序列化：跳过 undefined/null/空串；对象转 JSON；数组用逗号连接。
 *
 * @param {Record<string, unknown>} params
 * @returns {string}
 */
export function buildQuery(params = {}) {
  const search = new URLSearchParams()
  for (const [key, raw] of Object.entries(params ?? {})) {
    if (raw === undefined || raw === null) continue
    if (typeof raw === 'string') {
      if (raw.length === 0) continue
      search.append(key, raw)
      continue
    }
    if (Array.isArray(raw)) {
      if (raw.length === 0) continue
      search.append(key, raw.join(','))
      continue
    }
    if (typeof raw === 'object') {
      search.append(key, JSON.stringify(raw))
      continue
    }
    search.append(key, String(raw))
  }
  return search.toString()
}

/**
 * 调一个只读接口。**不抛异常**，一律返回带 ok 的信封，方便工具层原样透传。
 *
 * @param {string} endpoint
 * @param {Record<string, unknown>} [params]
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   endpoint: string,
 *   status: number|null,
 *   data?: any,
 *   error?: {code: string, message: string, hint?: string},
 *   meta?: any,
 *   tookMs: number,
 *   usingOwnKey?: boolean,
 * }>}
 */
export async function openapiGet(endpoint, params = {}, options = {}) {
  const startedAt = Date.now()
  const path = normalizePath(endpoint)
  const query = buildQuery(params)
  const url = `${baseUrl()}${path}${query ? `?${query}` : ''}`
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS
  const creds = credentials()

  let response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: authHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const name = error?.name ?? ''
    const code = name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK'
    return {
      ok: false,
      endpoint: path,
      status: null,
      error: {
        code,
        message: code === 'TIMEOUT' ? `请求超时（${timeoutMs}ms）：${path}` : `网络错误：${error?.message ?? error}`,
        hint: '确认能访问 https://open.aicoin.com（本机代理/DNS 可能拦截）。',
      },
      tookMs: Date.now() - startedAt,
      usingOwnKey: creds.usingOwnKey,
    }
  }

  const text = await response.text()
  let body = null
  try {
    body = text.length > 0 ? JSON.parse(text) : null
  } catch {
    return {
      ok: false,
      endpoint: path,
      status: response.status,
      error: { code: 'BAD_JSON', message: `响应不是 JSON（前 200 字）：${text.slice(0, 200)}` },
      tookMs: Date.now() - startedAt,
      usingOwnKey: creds.usingOwnKey,
    }
  }

  const tookMs = Date.now() - startedAt

  if (!response.ok) {
    const code = response.status === 401 ? 'AUTH' : response.status === 403 ? 'TIER' : `HTTP_${response.status}`
    const serverMessage = typeof body?.error === 'string' ? body.error : body?.error?.message ?? body?.message ?? text.slice(0, 300)
    return {
      ok: false,
      endpoint: path,
      status: response.status,
      error: {
        code,
        message: `${path} → HTTP ${response.status}：${serverMessage}`,
        hint:
          code === 'AUTH'
            ? '免费 key 失效或环境变量里的 key 不对：检查 AICOIN_ACCESS_KEY_ID / AICOIN_ACCESS_SECRET。'
            : code === 'TIER'
              ? '该接口需要更高套餐（https://www.aicoin.com/opendata），或本 key 无权访问。'
              : undefined,
      },
      tookMs,
      usingOwnKey: creds.usingOwnKey,
    }
  }

  // 业务信封：{ ok, data, error, meta }
  if (body && typeof body === 'object' && 'ok' in body) {
    if (body.ok !== true) {
      const err = body.error ?? {}
      return {
        ok: false,
        endpoint: path,
        status: response.status,
        error: {
          code: String(err.code ?? 'BIZ_ERROR'),
          message: String(err.message ?? '接口返回 ok:false'),
        },
        meta: body.meta ?? null,
        tookMs,
        usingOwnKey: creds.usingOwnKey,
      }
    }
    return {
      ok: true,
      endpoint: path,
      status: response.status,
      data: body.data ?? null,
      meta: body.meta ?? null,
      tookMs,
      usingOwnKey: creds.usingOwnKey,
    }
  }

  // 少数接口直接返回裸数据，也一并兼容
  return { ok: true, endpoint: path, status: response.status, data: body, meta: null, tookMs, usingOwnKey: creds.usingOwnKey }
}

// ---------------------------------------------------------------------------
// catalog（接口清单）
// ---------------------------------------------------------------------------

let catalogCache = null
/** @type {number} */
let catalogCacheAt = 0

/** 内置清单文件路径。 */
export const BUNDLED_CATALOG_PATH = join(__dirname, 'data', 'endpoints.json')

/**
 * 读仓库内置的接口清单（离线兜底）。
 *
 * @returns {{generated_at?: string, count: number, endpoints: Array<any>}}
 */
export function loadBundledCatalog() {
  try {
    const raw = readFileSync(resolve(BUNDLED_CATALOG_PATH), 'utf8')
    const parsed = JSON.parse(raw)
    const endpoints = Array.isArray(parsed.endpoints) ? parsed.endpoints : []
    return { generated_at: parsed.generated_at ?? null, count: endpoints.length, endpoints, source: 'bundled' }
  } catch {
    return { generated_at: null, count: 0, endpoints: [], source: 'missing' }
  }
}

/**
 * 取接口清单：优先线上 `/api/v3/_catalog`，失败退回内置清单，带 10 分钟缓存。
 *
 * @param {{live?: boolean, maxAgeMs?: number}} [options]
 * @returns {Promise<{generated_at: string|null, count: number, endpoints: Array<any>, source: string}>}
 */
export async function getCatalog(options = {}) {
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? Number(options.maxAgeMs) : CATALOG_TTL_MS
  const fresh = options.live === true || catalogCache === null || Date.now() - catalogCacheAt > maxAgeMs
  if (!fresh) return catalogCache

  const bundled = loadBundledCatalog()
  const live = await openapiGet('/api/v3/_catalog', {}, { timeoutMs: 12000 })
  if (live.ok) {
    const payload = live.data
    const endpoints = Array.isArray(payload) ? payload : Array.isArray(payload?.endpoints) ? payload.endpoints : null
    if (endpoints && endpoints.length > 0) {
      catalogCache = {
        generated_at: payload?.generated_at ?? null,
        count: endpoints.length,
        endpoints,
        source: 'live',
      }
      catalogCacheAt = Date.now()
      return catalogCache
    }
  }
  if (catalogCache && catalogCache.endpoints.length > 0) return catalogCache
  catalogCache = bundled
  catalogCacheAt = Date.now()
  return catalogCache
}

/** 分组名 = path 的第 4 段（/api/v3/<group>/...）。 */
export function groupOf(path) {
  const parts = String(path ?? '').split('/').filter(Boolean)
  return parts[2] ?? 'misc'
}

/**
 * 按分组汇总（给模型"先看有哪些接口"用，只给数量+代表接口，省上下文）。
 *
 * @param {{endpoints: Array<any>}} catalog
 * @returns {{total: number, source?: string, groups: Array<{group: string, count: number, examples: string[]}>}}
 */
export function summarizeCatalog(catalog) {
  /** @type {Map<string, {group: string, count: number, examples: string[]}>} */
  const map = new Map()
  for (const endpoint of catalog?.endpoints ?? []) {
    const group = groupOf(endpoint.path)
    if (!map.has(group)) map.set(group, { group, count: 0, examples: [] })
    const item = map.get(group)
    item.count += 1
    if (item.examples.length < 3) item.examples.push(endpoint.path.replace('/api/v3/', ''))
  }
  const groups = [...map.values()].sort((a, b) => b.count - a.count)
  return { total: catalog?.endpoints?.length ?? 0, source: catalog?.source, groups }
}

/** 参数压成一行短签名：`coin_key*(必填), market, limit`。 */
function paramSig(params) {
  if (!Array.isArray(params) || params.length === 0) return ''
  return params
    .map((param) => {
      const required = param?.required === true ? '*' : ''
      const enumPart = Array.isArray(param?.enum) && param.enum.length > 0 ? `(${param.enum.slice(0, 6).join('|')})` : ''
      return `${param?.name ?? '?'}${required}${enumPart}`
    })
    .join(', ')
}

/**
 * 某分组的接口列表（紧凑：path + 一句说明 + 参数签名）。
 *
 * @param {{endpoints: Array<any>}} catalog
 * @param {string} group
 * @param {number} [limit]
 * @returns {{group: string, count: number, endpoints: Array<{path: string, method: string, summary: string, params: string}>}}
 */
export function describeGroup(catalog, group, limit = 40) {
  const wanted = String(group ?? '').trim().replace(/^\/+/, '')
  const all = (catalog?.endpoints ?? []).filter((endpoint) => groupOf(endpoint.path) === wanted)
  const items = all.slice(0, limit).map((endpoint) => ({
    path: endpoint.path,
    method: endpoint.method ?? 'GET',
    summary: endpoint.summary ?? '',
    params: paramSig(endpoint.params),
  }))
  return { group: wanted, count: all.length, endpoints: items, truncated: all.length > items.length }
}

/**
 * 单个接口的完整参数说明。
 *
 * @param {{endpoints: Array<any>}} catalog
 * @param {string} path
 * @returns {null | {path: string, method: string, summary: string, auth?: any, params: Array<any>}}
 */
export function describeEndpoint(catalog, path) {
  const wanted = normalizePath(path)
  const found = (catalog?.endpoints ?? []).find((endpoint) => normalizePath(endpoint.path) === wanted)
  if (!found) return null
  return {
    path: found.path,
    method: found.method ?? 'GET',
    summary: found.summary ?? '',
    auth: found.auth ?? null,
    params: Array.isArray(found.params) ? found.params : [],
  }
}

/** 该 path 在清单里是否是 GET（未知返回 null）。 */
export function methodOf(catalog, path) {
  const found = describeEndpoint(catalog, path)
  if (!found) return null
  return String(found.method ?? 'GET').toUpperCase()
}

// ---------------------------------------------------------------------------
// 输出压缩：模型不需要 500 根 K 线，也不需要 20 层嵌套
// ---------------------------------------------------------------------------

/**
 * 递归裁剪输出：数组保留前 maxItems 个并标注 total，深层对象截断字符串。
 *
 * @param {any} value
 * @param {{maxItems?: number, maxString?: number, depth?: number, maxKeys?: number}} [options]
 * @returns {any}
 */
export function compact(value, options = {}) {
  const maxItems = options.maxItems ?? 20
  const maxString = options.maxString ?? 400
  const depth = options.depth ?? 6
  const maxKeys = options.maxKeys ?? 60

  function walk(node, level) {
    if (node === null || node === undefined) return node
    if (typeof node === 'string') return node.length > maxString ? `${node.slice(0, maxString)}…(${node.length}字)` : node
    if (typeof node === 'number' || typeof node === 'boolean') return node
    if (level >= depth) return Array.isArray(node) ? `[Array(${node.length})]` : '[Object]'
    if (Array.isArray(node)) {
      const head = node.slice(0, maxItems).map((item) => walk(item, level + 1))
      if (node.length > maxItems) return { total: node.length, items: head, truncated: true }
      return head
    }
    if (typeof node === 'object') {
      const out = {}
      const keys = Object.keys(node)
      for (const key of keys.slice(0, maxKeys)) out[key] = walk(node[key], level + 1)
      if (keys.length > maxKeys) out.__more_keys = keys.length - maxKeys
      return out
    }
    return String(node)
  }

  return walk(value, 0)
}

export default { openapiGet, getCatalog, describeGroup, describeEndpoint, summarizeCatalog, compact, authHeaders, normalizePath }
