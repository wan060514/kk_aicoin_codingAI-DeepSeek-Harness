/**
 * tools/api.mjs — 在 AiCoin 客户端上下文里发内部 API 请求 / 抓 console。
 *
 * 为什么不在 Node 侧自己拼 HTTP：
 *   AiCoin 的 `upgrade/*` 接口不是普通 REST：
 *     · 请求体要 AES 加密成 `{p,k,v,iv}`，响应体要按 config.key/iv 解密；
 *     · 登录 token **不放在 header**，而是塞进加密体里（`data.token` / `params.token`），
 *       另外还要 `lan` / `pc_client` / `pc_client_version`。
 *   这些都由渲染层那个 axios 实例的 3 个请求拦截器 + 3 个响应拦截器完成。
 *   所以我们**借用客户端自己的 axios**（`src/inject.mjs` 的 `api()`），
 *   Node 侧既不需要复制加密逻辑，也不会出现「token 放错位置」这类问题。
 *
 * 业务错误是 **HTTP 200 + `{success:false,status:<码>}`**，一定要看 success：
 *   403 / "login required" → 未登录或登录过期
 *   304                   → 参数无效（常见于 skipCrypt 明文请求）
 *   10510                 → 指标已被删除
 *   40003                 → 服务端要求切线路重试（客户端会自动换 baseURL）
 *
 * 写保护：`script/save`、`script/del`、`indicator/gen` 等**会写用户账号**的路径，
 * 默认直接拒绝（`WRITE_BLOCKED`）。本文件只有一个地方能放行：`aicoin_app_api`
 * 的 `allowWrite: true`，而且描述里明确写了风险。
 *
 * @module tools/api
 */

import { defineTool } from '../registry.mjs'
import { api, consoleCapture, isWritePath, openTarget, describeTarget, listWindows, decodeBusinessStatus } from '../inject.mjs'

/** target 参数（多窗口）共用 schema。 */
const TARGET_SCHEMA = {
  type: ['string', 'integer'],
  description:
    '可选目标窗口：main/chart（默认，#/main 的 K 线主窗）、chat、notice、login、asset-sync、' +
    '任一 URL 子串（如 "#/main"）、page 下标或 target id。' +
    ' / Target window: main|chart|chat|notice|login|asset-sync, url substring, page index or target id.',
}

function loggerOf(ctx) {
  return typeof ctx?.log === 'function' ? ctx.log : null
}

export const tools = [
  defineTool({
    name: 'aicoin_app_api',
    title: 'Call an AiCoin internal API (in-client axios)',
    description:
      '在 AiCoin 渲染层里用它自己的 axios 发一个内部接口请求：自动带登录 token、自动 AES 加解密，' +
      '返回 httpOk/success/status/message/dataSummary（业务错误是 HTTP 200 + success:false，必须看 success）。' +
      '默认只允许只读接口；save/del/gen 这类写账号的路径必须显式 allowWrite:true 才会放行（慎用）。' +
      ' / POST/GET an internal AiCoin endpoint through the client\'s own axios (auto token + crypto). Read-only by default; write paths need allowWrite:true.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            '接口路径（相对 baseURL https://apipc.aicoin.com/api/），例如 ' +
            '"upgrade/customIndicator/script/list"、"upgrade/customIndicator/script/functionLib"。' +
            ' / Endpoint path relative to the client baseURL.',
        },
        method: { type: 'string', enum: ['post', 'get'], description: 'HTTP 方法，默认 post。 / Default post.' },
        data: { type: 'object', description: 'POST body（明文对象，加密由客户端拦截器完成）。 / POST body (plain object).' },
        params: { type: 'object', description: 'GET query 参数。 / Query params for GET.' },
        includeData: {
          type: 'boolean',
          description: '是否把 data 原文一起返回（默认 false，只给结构摘要；大响应会撑爆上下文）。 / Include raw data (default false).',
        },
        maxChars: { type: 'integer', description: 'includeData=true 时 data 的 JSON 字符上限，默认 120000。 / Raw data size cap.' },
        timeout: { type: 'integer', description: '请求超时毫秒（透传给 axios）。 / Request timeout ms.' },
        skipCrypt: {
          type: 'boolean',
          description: '诊断用：跳过 AES 加密（同时也不会注入 token，服务端会回 304 invalid parameters）。 / Diagnostic: skip crypto.',
        },
        skipAutoToken: {
          type: 'boolean',
          description: '诊断用：不带 token 发（用于确认某接口是否要求登录；不会触发登出）。 / Diagnostic: send without token.',
        },
        allowWrite: {
          type: 'boolean',
          description:
            '危险：允许调用会写用户账号的接口（save/del/gen 等）。调用前必须让用户明确同意。 / Dangerous: allow account-writing endpoints.',
        },
        target: TARGET_SCHEMA,
        port: { type: 'integer', description: 'CDP 端口，默认取服务器配置（9222）。 / CDP port.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const log = loggerOf(ctx)
      const { client, target, release } = await openTarget(ctx, args.target)
      try {
        const opts = {
          method: args.method ?? 'post',
          path: args.path,
          data: args.data,
          params: args.params,
          includeData: args.includeData === true,
          maxChars: args.maxChars,
          timeout: args.timeout,
          skipCrypt: args.skipCrypt === true,
          skipAutoToken: args.skipAutoToken === true,
          allowWrite: args.allowWrite === true,
        }
        const res = await api(client, opts)
        const out = {
          ...res,
          window: describeTarget(target),
          writePath: isWritePath(args.path),
          note:
            res.success === false
              ? decodeBusinessStatus(res.status, res.message) ?? '业务失败（success:false），请看 status/message'
              : undefined,
        }
        log?.info?.(`aicoin_app_api ${opts.method.toUpperCase()} ${args.path} → success=${res.success} status=${res.status}`)
        return out
      } finally {
        await release()
      }
    },
  }),

  defineTool({
    name: 'aicoin_app_windows',
    title: 'List AiCoin windows (CDP page targets)',
    description:
      '列出 AiCoin 当前所有可 attach 的窗口（CDP page 目标）：下标、title、url、hash、是否主窗。' +
      '多窗口是这套工具最容易踩的坑：每个窗口有独立的 redux store 与 axios 实例，选错窗口会读到/改到别的窗口状态。' +
      ' / List every attachable AiCoin window (page target) with index/title/url/hash/isMain.',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'integer', description: 'CDP 端口，默认 9222。 / CDP port.' },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const port = Number(args.port ?? ctx?.port ?? 9222)
      const info = await listWindows({ port })
      return {
        ...info,
        hint: info.ok
          ? '把 windows[].index / hash / id 作为其它工具的 target 参数即可精确选中窗口'
          : `调试端口不可用：${info.reason}。先运行 aicoin_app_launch。`,
      }
    },
  }),

  defineTool({
    name: 'aicoin_app_console',
    title: 'Capture page console output',
    description:
      '抓取 AiCoin 页面在指定时间窗内的 console 输出与未捕获异常。' +
      '注意实测事实：CDP 的 Runtime.consoleAPICalled 在这个客户端**从不触发**，' +
      '所以本工具在页面里 hook console.* 做环形缓冲再读增量；未捕获异常走 Runtime.exceptionThrown（可用）。' +
      ' / Capture page console + uncaught exceptions (uses an in-page console hook because Runtime.consoleAPICalled never fires here).',
    inputSchema: {
      type: 'object',
      properties: {
        ms: { type: 'integer', minimum: 100, maximum: 15000, description: '采集时长毫秒，默认 1200。 / Capture window in ms.' },
        types: {
          type: 'array',
          items: { type: 'string', enum: ['log', 'info', 'warn', 'error', 'debug'] },
          description: '只保留这些级别（默认全部）。 / Only keep these levels.',
        },
        trigger: {
          type: 'string',
          description: '采集期间顺手在页面里执行的 JS 表达式（例如点一次按钮再收日志）。 / JS expression to trigger during capture.',
        },
        target: TARGET_SCHEMA,
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const { client, release } = await openTarget(ctx, args.target)
      try {
        return await consoleCapture(client, { ms: args.ms, types: args.types, trigger: args.trigger })
      } finally {
        await release()
      }
    },
  }),
]

export default { tools }
