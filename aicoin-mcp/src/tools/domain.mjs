/**
 * tools/domain.mjs — AiCoin 领域工具：图表导航、页面快照、自定义指标（只读 + 受保护的保存）。
 *
 * 关键实测结论（写进工具行为里）：
 *  · **多窗口**：每个窗口独立 redux store / 独立 axios。默认 target=main（URL 含 #/main 的
 *    K 线主窗），返回里一律回显实际 attach 的窗口 title+url+hash。
 *  · **切 symbol/timeframe**：走 redux dispatch（`chart/setCurrentChartOptions` +
 *    `chart/setCurrentPeriod` + `chart/setCurrentCoinMeta`），实测图表真重绘
 *    （窗口标题跟着新标的实时价变），并有 store 二次校验 `verified`。
 *    兜底才用 UI 点击（周期按钮选择器 `#ChartToolsBar__period_panel_wrap [data-period-key="900"]`）。
 *  · **路由**：自研 hash 路由，`location.hash = '#/xxx'` 实测生效。
 *  · **指标列表**接口 `upgrade/customIndicator/script/list` 一次就返回全部 191 条且**自带源码**
 *    （scriptValue）。默认 `includeSource:false` 只给摘要，否则会撑爆模型上下文；
 *    要源码请用 `aicoin_app_indicators_get` 取单条。
 *  · **保存**接口 `upgrade/customIndicator/script/save` 会**真的写用户账号**
 *    （无 id 新建、有 id 覆盖），所以必须 `confirm:true` 才执行；默认 dryRun 只校验参数拼装。
 *
 * @module tools/domain
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { defineTool } from '../registry.mjs'
import { buildCompileReport, summarizeCompileReport } from '../compile-report.mjs'
import {
  openTarget,
  describeTarget,
  setChart,
  chartState,
  loginState,
  routes,
  domSummary,
  indicatorsList,
  indicatorGet,
  indicatorSave,
  indicatorDelete,
  evalInPage,
  decodeBusinessStatus,
} from '../inject.mjs'

const TARGET_SCHEMA = {
  type: ['string', 'integer'],
  description:
    '可选目标窗口：main/chart（默认，#/main 的 K 线主窗）、chat、notice、login、asset-sync、' +
    '任一 URL 子串、page 下标或 target id。切换图表请用 main/chart。' +
    ' / Target window: main|chart|chat|notice|login|asset-sync, url substring, page index or id.',
}

/** 把 `~/x` 展开成家目录（工具参数里手写路径时很常见）。 */
function resolveHome(input) {
  const text = String(input ?? '')
  if (!text.startsWith('~')) return text
  return join(homedir(), text.slice(1))
}

function loggerOf(ctx) {
  return typeof ctx?.log === 'function' ? ctx.log : null
}

export const tools = [
  defineTool({
    name: 'aicoin_app_navigate',
    title: 'Navigate AiCoin chart / routes',
    description:
      '切换 AiCoin 的状态：' +
      '(1) symbol/timeframe —— 程序化 dispatch redux，切换 K 线窗口的交易对与周期（如 BTCUSDT永续 → btcswapusdt:binance，15m → 900 秒），并做 store 二次校验；' +
      '(2) route —— 改 location.hash 跳到任意页面（#/main/exchange、#/chat、#/preference…，路由表可用 aicoin_app_snapshot 查看）。' +
      'symbol 支持人类写法：BTCUSDT / BTC/USDT（现货）、BTCUSDT永续 / BTC/USDT永续（永续）、' +
      '或标准 key btcswapusdt:binance。timeframe 支持 15m/1h/1d、15分/1时/1日、或秒数 900。' +
      ' / Switch the chart symbol/timeframe via redux dispatch (verified) or navigate by hash route.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: '交易对：BTCUSDT / BTC/USDT / BTCUSDT永续 / BTC/USDT永续 / btcswapusdt:binance。 / Trading pair (human or canonical key).',
        },
        timeframe: {
          type: ['string', 'integer'],
          description: '周期：15m、1h、4h、1d、1w，或中文 15分/1时/1日，或秒数 900。 / Timeframe: 15m/1h/1d, 中文 or seconds.',
        },
        type: {
          type: 'string',
          enum: ['tp', 'sp'],
          description: 'tp=永续合约，sp=现货；省略时按 symbol 里有没有「永续/swap」自动判断。 / tp=perp, sp=spot (auto by default).',
        },
        exchange: {
          type: 'string',
          description: '交易所后缀，默认沿用当前图表的交易所（通常是 binance）。 / Exchange suffix, defaults to the current chart exchange.',
        },
        route: {
          type: 'string',
          description: '要跳转的 hash 路由，如 "#/main/exchange"、"#/chat"、"#/preference"。与 symbol/timeframe 互斥优先。 / Hash route to navigate to.',
        },
        target: TARGET_SCHEMA,
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const log = loggerOf(ctx)
      const hasChart = args.symbol !== undefined || args.timeframe !== undefined || args.type !== undefined
      if (!hasChart && !args.route) {
        return {
          ok: false,
          error: '需要至少一个参数：symbol / timeframe / route',
          examples: [
            '{"symbol":"BTCUSDT永续","timeframe":"15m"}',
            '{"timeframe":"1h"}',
            '{"route":"#/main/exchange"}',
          ],
        }
      }
      const { client, target, release } = await openTarget(ctx, args.target ?? (args.route && !hasChart ? null : 'main'))
      try {
        if (args.route && !hasChart) {
          const want = String(args.route).startsWith('#') ? String(args.route) : `#${args.route}`
          const before = await evalInPage(client, 'location.hash')
          await evalInPage(client, `(function(){ location.hash = ${JSON.stringify(want)}; return location.hash; })()`)
          await new Promise((r) => setTimeout(r, 900))
          const after = await evalInPage(client, 'location.hash')
          return {
            ok: true,
            mode: 'hash-route',
            requested: want,
            before,
            after,
            verified: after === want,
            window: describeTarget(target),
          }
        }

        const res = await setChart(client, {
          symbol: args.symbol,
          timeframe: args.timeframe,
          type: args.type,
          exchange: args.exchange,
        })
        const st = await chartState(client)
        log?.info?.(`aicoin_app_navigate → ${st.symbol} @ ${st.period}（verified=${res.verified}）`)
        return {
          ok: true,
          mode: 'chart',
          verified: res.verified,
          requested: { symbol: args.symbol ?? null, timeframe: args.timeframe ?? null, type: args.type ?? null },
          applied: { key: res.symbol?.key ?? null, type: res.symbol?.type ?? res.timeframe?.period ?? null, period: res.timeframe?.period ?? null },
          timeframeLabel: res.timeframe?.label ?? null,
          before: res.before,
          after: res.after,
          current: { symbol: st.symbol, period: st.period, label: st.timeframeLabel, type: st.type, title: st.title },
          window: describeTarget(target),
          note: res.note,
        }
      } finally {
        await release()
      }
    },
  }),

  defineTool({
    name: 'aicoin_app_snapshot',
    title: 'Structured AiCoin page snapshot',
    description:
      '返回 AiCoin 当前窗口的结构化快照（不返回图片字节）：窗口 title/url/hash、登录态摘要、K 线图表状态' +
      '（symbol/period/type/标签/tab 数/主副图指标数）、DOM 摘要（周期按钮、交易对 tab、指标项、可见输入框、弹窗）' +
      '和关键选择器（供 aicoin_app_click 之类复用）。需要图片请用 aicoin_app_screenshot。' +
      ' / Structured snapshot of the current AiCoin window: window info, login summary, chart state, DOM summary and key selectors.',
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET_SCHEMA,
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'DOM 列表每项的条数上限，默认 40。 / DOM list limit.' },
        skipLogins: { type: 'boolean', description: '省略登录态（少输出）。 / Skip login summary.' },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const { client, target, release } = await openTarget(ctx, args.target)
      try {
        const [chart, dom] = await Promise.all([chartState(client), domSummary(client, { limit: args.limit ?? 40 })])
        let login = null
        if (args.skipLogins !== true) {
          const l = await loginState(client)
          login = {
            loggedIn: l.loggedIn,
            uid: l.uid,
            nickName: l.nickName,
            tokenPresent: l.tokenPresent,
            expired: l.expired,
            vip: { isVip: l.vipAbility?.customIndicator?.isVip ?? null, indicatorLimit: l.vipAbility?.customIndicator?.vipLimit ?? null },
          }
        }
        return {
          ok: true,
          window: describeTarget(target),
          login,
          chart: {
            symbol: chart.symbol,
            period: chart.period,
            timeframeLabel: chart.timeframeLabel,
            type: chart.type,
            title: chart.title,
            hash: chart.hash,
            instanceKey: chart.instanceKey,
            tabs: Array.isArray(chart.tabs) ? chart.tabs.length : 0,
            mainIndicators: chart.mainIndicators,
            subIndicators: chart.subIndicators,
          },
          dom: {
            counts: dom.counts,
            periodButtons: dom.periodButtons,
            symbolTabs: dom.symbolTabs,
            indicatorItems: dom.indicatorItems,
            visibleInputs: dom.visibleInputs,
            dialogs: dom.dialogs,
            keySelectors: dom.keySelectors,
          },
        }
      } finally {
        await release()
      }
    },
  }),

  defineTool({
    name: 'aicoin_app_indicators_list',
    title: 'List my custom indicators',
    description:
      '列出当前账号的自定义指标（走只读接口 upgrade/customIndicator/script/list）。' +
      '默认**不返回 AiScript 源码**（一次 191 条全带源码会撑爆上下文），只给 id/name/position/buildType/时间等摘要；' +
      '要源码请用 aicoin_app_indicators_get 取单条，或显式 includeSource:true。' +
      ' / List the account custom indicators (read-only). Source code is omitted unless includeSource:true.',
    inputSchema: {
      type: 'object',
      properties: {
        includeSource: { type: 'boolean', description: '是否在列表里带上 AiScript 源码（慎用，响应会很大）。 / Include AiScript source in each row.' },
        id: { type: 'integer', description: '只取某个 id。 / Filter by id.' },
        name: { type: 'string', description: '按名字模糊过滤。 / Filter by name substring.' },
        position: { type: 'string', enum: ['main', 'sub'], description: '只取主图/副图指标。 / Filter by main/sub chart.' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: '返回条数上限，默认 50。 / Rows per page, default 50.' },
        offset: { type: 'integer', description: '分页偏移，默认 0。 / Offset.' },
        target: TARGET_SCHEMA,
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const { client, release } = await openTarget(ctx, args.target)
      try {
        const res = await indicatorsList(client, {
          includeSource: args.includeSource === true,
          id: args.id,
          name: args.name,
          position: args.position,
          limit: args.limit,
          offset: args.offset,
        })
        return {
          ...res,
          hint:
            res.ok === false
              ? decodeBusinessStatus(res.status, res.message) ?? '接口返回 success:false'
              : '每行是摘要；取源码请调用 aicoin_app_indicators_get({id})',
        }
      } finally {
        await release()
      }
    },
  }),

  defineTool({
    name: 'aicoin_app_indicators_get',
    title: 'Get one custom indicator (with AiScript source)',
    description:
      '按 id 取单个自定义指标的详情，**包含完整 AiScript 源码**（value 字段）+ buildType/position/alert/trade 等元信息。' +
      '只读接口 upgrade/customIndicator/script/detail。适用场景：把源码喂给 AiScript 静态校验器（kk_aicoin_codingAI 的 aicoin_validate）。' +
      ' / Fetch one custom indicator including its full AiScript source (read-only).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: '指标 id（可从 aicoin_app_indicators_list 得到）。 / Indicator id.' },
        target: TARGET_SCHEMA,
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const { client, release } = await openTarget(ctx, args.target)
      try {
        const res = await indicatorGet(client, { id: args.id })
        return {
          ...res,
          hint: res.ok === false ? decodeBusinessStatus(res.status, res.message) ?? '接口返回 success:false' : null,
        }
      } finally {
        await release()
      }
    },
  }),

  defineTool({
    name: 'aicoin_app_indicator_save',
    title: 'Save a custom indicator (WRITES the account)',
    description:
      '⚠️ 会写用户账号：调用 upgrade/customIndicator/script/save —— 没有 id 是**新建**指标，有 id 是**覆盖**该指标。' +
      '必须显式 confirm:true 才真的发请求；否则只做 dryRun（返回将要 POST 的 body，不发请求）。' +
      'body 结构（2.16.27 源码静态确认）：{name, value, version:"v4", ...(id?{id}:{}), ...(buildType?{buildType}:{}), ...(position?{position}:{})}。' +
      '注意：客户端没有本地 AiScript 编译器，真正的编译发生在服务端保存时；本工具不做校验，请在保存前用 aicoin_validate 静态校验。' +
      ' / SAVE the account: creates (no id) or overwrites (with id). Requires confirm:true; otherwise dry-run only.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '指标名称。 / Indicator name.' },
        value: { type: 'string', description: 'AiScript 源码全文。 / AiScript source code.' },
        id: { type: 'integer', description: '已有指标 id：给了就是覆盖更新，不给就是新建。 / Existing id to overwrite; omit to create.' },
        version: { type: 'string', description: '脚本版本，默认 v4（客户端当前用 v4）。 / Script version, default v4.' },
        buildType: { type: 'string', enum: ['source', 'visual'], description: 'source=源码指标，visual=可视化指标。 / Build type.' },
        position: { type: 'string', enum: ['main', 'sub'], description: '主图还是副图。 / main or sub chart.' },
        visualCode: { type: 'string', description: '仅 buildType=visual 时使用。 / Only for visual buildType.' },
        confirm: { type: 'boolean', description: '必须为 true 才真的保存（写账号）。 / Must be true to actually save.' },
        target: TARGET_SCHEMA,
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const confirmed = args.confirm === true
      if (confirmed && typeof args.value !== 'string') {
        return { ok: false, executed: false, error: 'confirm:true 时必须提供 value（AiScript 源码全文）' }
      }
      const { client, target, release } = await openTarget(ctx, args.target)
      try {
        const res = await indicatorSave(client, {
          dryRun: !confirmed,
          id: args.id,
          name: args.name,
          value: args.value,
          version: args.version,
          buildType: args.buildType,
          position: args.position,
          visualCode: args.visualCode,
        })
        return {
          ...res,
          executed: confirmed && res.dryRun !== true,
          warning: confirmed
            ? '已按要求调用 script/save：这是写用户账号的操作（无 id 新建 / 有 id 覆盖）'
            : '未执行：缺少 confirm:true，只做了 dryRun 参数校验',
          window: describeTarget(target),
          hint: res.ok === false ? decodeBusinessStatus(res.status, res.message) : null,
        }
      } finally {
        await release()
      }
    },
  }),
  defineTool({
    name: 'aicoin_app_indicator_publish',
    title: 'Write a script into AiCoin and read back the real compile verdict',
    description:
      '把 AiScript 源码**写进 AiCoin** 并当场取回服务端编译结论 —— 一步到位，不用在编辑器里粘贴。' +
      'mode=publish（默认）：同名指标已存在就覆盖更新（先按名字精确匹配拿 id），不存在就新建，成功后指标留在账号里；' +
      'mode=verify：用「<名字> · 编译探针」临时建一个，读到编译结论后**立刻删掉**，账号不留垃圾（只想验证不想留指标时用它）。' +
      '编译失败时如果这次是新建的（不是覆盖既有指标），默认会把失败的草稿删掉，避免账号里留一堆坏指标（keepOnFail:true 可保留）。' +
      '返回里 compile 字段是结构化结论：pass / err / errLine / errColumn / **sourceLine（出错那行原文）/ caret（列对齐的 ^）**/ warnings / securityCount。' +
      '⚠️ 写账号，必须 confirm:true；否则只做 dryRun（回显将要 POST 的 body）。' +
      ' / Write an AiScript into AiCoin and return the server-side compile verdict (publish, or verify-then-delete).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '指标名称（publish 时同名会被覆盖更新）。 / Indicator name.' },
        value: { type: 'string', description: 'AiScript 源码全文；与 path 二选一。 / Source text.' },
        path: { type: 'string', description: '本地脚本路径（UTF-8）；与 value 二选一。 / Local script path.' },
        id: { type: 'integer', description: '直接指定要覆盖的指标 id（跳过按名字匹配）。 / Explicit id to overwrite.' },
        mode: { type: 'string', enum: ['publish', 'verify'], description: 'publish=写进账号并保留（默认）；verify=编译验证后删除探针。 / publish or verify.' },
        position: { type: 'string', enum: ['main', 'sub'], description: '主图 / 副图（新建时用）。 / main or sub.' },
        buildType: { type: 'string', enum: ['source', 'visual'], description: '源码指标（默认）或可视化指标。 / build type.' },
        version: { type: 'string', description: '脚本版本，默认 v4。 / Script version, default v4.' },
        keepOnFail: { type: 'boolean', description: '编译失败时也保留新建的指标（默认删掉）。 / Keep a failed draft.' },
        confirm: { type: 'boolean', description: '必须为 true 才真的写入；否则 dryRun。 / Must be true to write.' },
        target: TARGET_SCHEMA,
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const source = typeof args.value === 'string' ? args.value : args.path ? readFileSync(resolveHome(args.path), 'utf8') : null
      if (typeof source !== 'string' || source.trim() === '') {
        return { ok: false, executed: false, error: '需要 value（源码）或 path（脚本路径）' }
      }
      const confirmed = args.confirm === true
      const mode = args.mode === 'verify' ? 'verify' : 'publish'
      const name = String(args.name ?? '').trim() || '未命名指标'
      const position = args.position === 'sub' ? 'sub' : args.position === 'main' ? 'main' : undefined

      const { client, target, release } = await openTarget(ctx, args.target)
      try {
        // publish 且没指定 id：先按名字精确匹配，命中就覆盖更新，别造重复指标。
        let id = Number.isFinite(Number(args.id)) && Number(args.id) > 0 ? Number(args.id) : null
        let adoptedExisting = false
        if (!confirmed) {
          const dry = await indicatorSave(client, {
            dryRun: true,
            id: mode === 'verify' ? undefined : id ?? undefined,
            name: mode === 'verify' ? `${name} · 编译探针` : name,
            value: source,
            version: args.version,
            buildType: args.buildType,
            position,
          })
          return {
            ok: true,
            executed: false,
            dryRun: true,
            mode,
            name: dry?.body?.name ?? name,
            wouldPost: dry?.wouldPost ?? null,
            body: dry?.body ?? null,
            warning: '未执行：缺少 confirm:true（这是写账号的操作）',
            note: '源码建议先用 aicoin_validate 静态校验，再带 confirm:true 走真机编译验证',
            window: describeTarget(target),
          }
        }
        if (mode === 'publish' && !id) {
          const list = await indicatorsList(client, { name, limit: 20 })
          const rows = Array.isArray(list?.rows) ? list.rows : []
          const exact = rows.find((row) => String(row.name ?? '') === name && (!position || row.position === position))
          if (exact) {
            id = Number(exact.id)
            adoptedExisting = true
          }
        }

        const saveName = mode === 'verify' ? `${name} · 编译探针` : name
        const saveArgs = {
          dryRun: false,
          id: mode === 'verify' ? undefined : id ?? undefined,
          name: saveName,
          value: source,
          version: args.version,
          buildType: args.buildType,
          position,
        }
        // 刚启动的 AiCoin（尤其是被 aicoin_app_connect 冷启动的那次）渲染进程还没装好
        // axios 拦截器，第一次保存会抛 `AxiosError: Network Error`。这不是脚本的错，
        // 等一拍重试一次即可，避免把「应用还没热」误报成编译失败。
        let res
        try {
          res = await indicatorSave(client, saveArgs)
        } catch (error) {
          const message = String(error?.message ?? error)
          if (!/Network Error|ECONNRESET|socket hang up|net::ERR_/i.test(message)) throw error
          await new Promise((resolve) => setTimeout(resolve, 1500))
          res = await indicatorSave(client, saveArgs)
        }
        const report = buildCompileReport(source, res)
        const savedId = Number.isFinite(Number(res?.data?.id)) ? Number(res.data.id) : id
        const created = Boolean(savedId) && !adoptedExisting && !(Number(args.id) > 0)

        // 清理：verify 模式一律删探针；publish 失败且是新建的，默认删掉坏草稿。
        let cleanup = null
        const shouldCleanup =
          Boolean(savedId) &&
          (mode === 'verify' || (report.pass !== true && created && args.keepOnFail !== true))
        if (shouldCleanup) {
          const del = await indicatorDelete(client, { id: savedId })
          cleanup = { attempted: true, id: savedId, ok: del?.ok === true, message: del?.message ?? null, reason: mode === 'verify' ? 'verify 模式的临时探针' : '编译失败的草稿' }
        }

        const ok = report.pass === true
        return {
          ok,
          executed: true,
          mode,
          name: saveName,
          id: ok && mode === 'verify' ? null : savedId,
          created,
          adoptedExisting,
          compile: report,
          summary: summarizeCompileReport(report),
          cleanup,
          next: ok
            ? mode === 'verify'
              ? '编译通过；探针已删除，可以直接按这份源码交付'
              : '编译通过，指标已写进 AiCoin 账号（同名会被覆盖）'
            : '按 compile.errLine / compile.sourceLine 改源码，改完再调一次本工具',
          window: describeTarget(target),
        }
      } finally {
        await release()
      }
    },
  }),

  defineTool({
    name: 'aicoin_app_indicator_del',
    title: 'Delete a custom indicator (WRITES the account)',
    description:
      '删除一个自定义指标（`upgrade/customIndicator/script/del`）。' +
      '用途：清理编译探针、坏草稿、或用户明确要删的指标。**不可恢复**。' +
      '默认 dryRun；必须 confirm:true 才真的删。 / Delete a custom indicator. confirm:true required; dry-run by default.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: '要删除的指标 id。 / Indicator id.' },
        confirm: { type: 'boolean', description: '必须为 true 才真的删。 / Must be true to delete.' },
        target: TARGET_SCHEMA,
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const id = Number(args.id)
      if (!Number.isFinite(id) || id <= 0) return { ok: false, executed: false, error: 'id 必须是正整数' }
      const confirmed = args.confirm === true
      const { client, target, release } = await openTarget(ctx, args.target)
      try {
        const res = await indicatorDelete(client, { id, dryRun: !confirmed })
        return {
          ...res,
          executed: confirmed && res?.dryRun !== true,
          warning: confirmed ? '已调用 script/del：指标已从账号删除，不可恢复' : '未执行：缺少 confirm:true',
          window: describeTarget(target),
          hint: res?.ok === false ? decodeBusinessStatus(res.status, res.message) : null,
        }
      } finally {
        await release()
      }
    },
  }),

]

export default { tools }
