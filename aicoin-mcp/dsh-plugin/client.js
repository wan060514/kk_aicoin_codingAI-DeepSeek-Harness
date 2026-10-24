/**
 * dsh-plugin-aicoin-mcp — browser half.
 *
 * One sidebar rail icon plus one central panel page that is the human control
 * surface for the AiCoin MCP bridge. The Host half (lib/index.js) owns the child
 * process and the same-origin JSON API under `/plugins/aicoin-mcp`; this file
 * only reads and drives that API.
 *
 * Contract rules honoured here:
 *  - `react` is the only import; nothing else is required or fetched.
 *  - colours are Harness theme tokens (`var(--dsw-alias-*)`), never hex.
 *  - every string goes through the locale dictionaries (zh + en).
 *  - nothing throws inside the component: a missing Host half (404) renders an
 *    explanatory banner instead.
 *
 * Slot registrations
 *   sidebar.panellist  id 'aicoin-mcp'  order 21  -> AicoinIcon
 *   main               key 'aicoin-mcp'           -> AicoinPanel
 *
 * @module dsh-plugin-aicoin-mcp/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-aicoin-mcp',
  factory(require) {
    'use strict'

    /** Only allowed import. */
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /** Panel key shared by the sidebar seat and the main seat. */
    const PANEL_ID = 'aicoin-mcp'
    /** Locale namespace owned by this file. */
    const NAMESPACE = 'aicoin-mcp'
    /** Same-origin Host API root. */
    const API_BASE = '/plugins/aicoin-mcp'
    /** State poll cadence while the document is visible. */
    const POLL_INTERVAL_MS = 3000
    /** How many tool names the panel lists. */
    const TOOL_RENDER_LIMIT = 32
    /** Same-origin root of the AiScript helper plugin (kk_aicoin_codingAI). */
    const KK_BASE = '/plugins/kk-aicoin'

    const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'

    /** Theme tokens only — both Harness themes work unchanged. */
    const COLOR = {
      base: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      border1: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      brand: 'var(--dsw-alias-brand-primary)',
      label: 'var(--dsw-alias-label-primary)',
      labelSecondary: 'var(--dsw-alias-label-secondary)',
      error: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
    }

    /** `phase` -> pill colour. */
    const PHASE_TONE = {
      stopped: COLOR.idle,
      starting: COLOR.warn,
      ready: COLOR.success,
      error: COLOR.error,
    }

    //#region translations

    /** Simplified Chinese dictionary — key-set source of truth. */
    const ZH = {
      'panel.label': 'AiCoin MCP',
      'panel.title': 'AiCoin MCP 控制台',
      'panel.subtitle': '在这里启停 aicoin-mcp 桥接、查看连接状态，并把 AiCoin 客户端状态一眼看清。',
      'panel.refresh': '刷新',
      'panel.loading': '正在读取状态…',
      'phase.stopped': '已停止',
      'phase.starting': '启动中',
      'phase.ready': '已就绪',
      'phase.error': '异常',
      'section.mcp': 'MCP 桥接',
      'section.mcpHint': '插件的宿主进程与 aicoin-mcp 服务器之间的 stdio 连接',
      'section.aicoin': 'AiCoin 客户端',
      'section.aicoinHint': '通过调试端口（CDP）看到的客户端状态',
      'section.run': '工具台',
      'section.runHint': '直接调用上面任一工具；参数按 JSON 传。带 ✱ 的是写操作，受 allowMutating 限制。',
      'row.tool': '工具',
      'row.args': '参数（JSON）',
      'row.lastRun': '最近一次结果',
      'btn.run': '运行',
      'hint.blocked': '配置里 allowMutating=false，这个写操作被拒绝。',
      'hint.hostStale': '宿主半还是旧版本，重启 DeepSeek Harness 后新卡片才会生效。',
      'section.script': 'AiScript 工具链',
      'section.scriptHint': '静态校验与函数库查询（由 kk_aicoin_codingAI 插件提供）。',
      'section.publish': '写进 AiCoin 并验证',
      'section.publishHint': '把脚本写成自定义指标，保存时由服务端真编译，结论直接回填到行号；不再需要手工粘贴到编辑器。',
      'row.indicatorName': '指标名（同名会覆盖）',
      'row.scriptPath2': '脚本路径',
      'row.publishMode': '模式（publish=保留 / verify=验证后删除探针）',
      'row.chartArea': '主图 / 副图（main / sub）',
      'btn.publish': '写进 AiCoin',
      'btn.verifyOnly': '只验证（不留指标）',
      'state.compiledOk': '编译通过',
      'state.compiledFail': '编译失败',
      'section.market': '行情数据（Open Data）',
      'section.marketHint': 'AiCoin 开放接口 v3 的只读行情；免费 key 只有行情快照与 K 线，其余接口会 403。',
      'row.coins': '币种（coin_key，逗号分隔）',
      'row.interval': '周期',
      'btn.quote': '报价',
      'btn.kline': 'K 线',
      'btn.funding': '资金费率',
      'btn.liquidation': '清算汇总',
      'btn.news': '快讯',
      'hint.paidKey': '免费 key 无此接口权限（403）：设置 AICOIN_ACCESS_KEY_ID / AICOIN_ACCESS_SECRET 换成自己的 key 即可解锁。',
      'row.scriptPath': '脚本路径',
      'row.keyword': '函数库关键词',
      'row.hits': '命中',
      'row.specName': '策略名（读 spec.json）',
      'row.findings': '结构审查发现',
      'row.completeness': '完成度',
      'state.ready': '可以写代码',
      'state.notReady': '仍需确认',
      'btn.advice': '结构审查',
      'btn.specStatus': '规格复查',
      'row.verdict': '结果',
      'row.lines': '行数',
      'state.pass': '通过',
      'state.fail': '未通过',
      'btn.validate': '静态校验',
      'btn.searchLib': '查函数库',
      'error.scriptMissing': '没找到 kk_aicoin_codingAI 插件（/plugins/kk-aicoin 返回 404），AiScript 卡片已降级。',
      'banner.needsRestart': 'AiCoin 正在运行，但没有开启调试端口。Electron 的 CDP 只能在进程启动时用 --remote-debugging-port 打开，事后无法附加 —— 点下面的「以调试模式重启」重开一次（会关闭当前窗口）。',
      'btn.restartDebug': '以调试模式重启',
      'btn.connect': '连上（必要时重启）',
      'confirm.restartDebug': '将以调试端口重启 AiCoin，当前窗口会被关闭。继续？',
      'section.tools': '已注册工具',
      'section.toolsHint': '这些工具已经出现在模型的可调用列表里',
      'row.phase': '阶段',
      'row.pid': '子进程 PID',
      'row.server': '服务器',
      'row.port': 'CDP 端口',
      'row.registered': '已注册工具',
      'row.advertised': '服务器提供',
      'row.connectedAt': '连接时间',
      'row.reachable': '调试端口',
      'row.browser': '浏览器',
      'row.windows': '窗口数',
      'row.mainWindow': '主窗口',
      'row.login': '登录态',
      'row.verdict': '进程判定',
      'row.lastError': '最近错误',
      'row.updatedAt': '更新时间',
      'btn.start': '启动连接',
      'btn.stop': '断开连接',
      'btn.restart': '重连',
      'btn.probe': '探测 AiCoin',
      'btn.launch': '启动 AiCoin',
      'btn.stopAicoin': '停止 AiCoin',
      'state.running': '运行中',
      'state.stopped': '未运行',
      'state.yes': '是',
      'state.no': '否',
      'state.unknown': '未知',
      'state.reachable': '可连接',
      'state.unreachable': '不可连接',
      'state.loggedIn': '已登录',
      'state.loggedOut': '未登录',
      'state.busy': '执行中…',
      'confirm.stopAicoin': '确定要停止 AiCoin 客户端吗？这会关闭你正在使用的窗口（登录态与数据保留）。',
      'error.apiMissing': '面板 API 不可用：宿主侧没有挂上 /plugins/aicoin-mcp（可能是插件未启用、旧版本，或当前 profile 没有 webServer）。工具仍然可以直接调用。',
      'error.request': '请求失败',
      'hint.autoPoll': '每 3 秒自动刷新（页面不可见时暂停）',
      'hint.mutating': '启动/停止 AiCoin 属于改动类操作，可用插件配置 allowMutating=false 关闭。',
      'empty.tools': '（还没有注册工具）',
      'empty.aicoin': '（还没探测过 AiCoin，点「探测 AiCoin」）',
      'err.hostDown': '宿主没有响应',
    }

    /** English dictionary (same key set). */
    const EN = {
      'panel.label': 'AiCoin MCP',
      'panel.title': 'AiCoin MCP console',
      'panel.subtitle': 'Start and stop the aicoin-mcp bridge, watch its connection, and see the AiCoin client state at a glance.',
      'panel.refresh': 'Refresh',
      'panel.loading': 'Loading state…',
      'phase.stopped': 'stopped',
      'phase.starting': 'starting',
      'phase.ready': 'ready',
      'phase.error': 'error',
      'section.mcp': 'MCP bridge',
      'section.mcpHint': 'stdio link between this plugin and the aicoin-mcp server',
      'section.aicoin': 'AiCoin client',
      'section.aicoinHint': 'client state seen through the debug port (CDP)',
      'section.run': 'Tool runner',
      'section.runHint': 'Call any tool above directly; pass its arguments as JSON. Entries marked ✱ are writes and obey allowMutating.',
      'row.tool': 'Tool',
      'row.args': 'Arguments (JSON)',
      'row.lastRun': 'Last result',
      'btn.run': 'Run',
      'hint.blocked': 'allowMutating=false in config, so this write is refused.',
      'hint.hostStale': 'the Host half is still the old build; restart DeepSeek Harness to activate the new cards.',
      'section.script': 'AiScript toolchain',
      'section.scriptHint': 'Static validation and function-library search (served by the kk_aicoin_codingAI plugin).',
      'section.publish': 'Write into AiCoin & verify',
      'section.publishHint': 'Saves the script as a custom indicator; the server compiles it and the verdict is mapped back to the offending line — no copy-paste into the editor.',
      'row.indicatorName': 'indicator name (same name overwrites)',
      'row.scriptPath2': 'script path',
      'row.publishMode': 'mode (publish = keep / verify = delete probe)',
      'row.chartArea': 'main / sub chart',
      'btn.publish': 'Write into AiCoin',
      'btn.verifyOnly': 'Verify only (no indicator kept)',
      'state.compiledOk': 'compiled OK',
      'state.compiledFail': 'compile failed',
      'section.market': 'Market data (Open Data)',
      'section.marketHint': 'Read-only AiCoin Open Data v3 market data; the free key only covers snapshots and klines, other endpoints return 403.',
      'row.coins': 'coins (coin_key, comma separated)',
      'row.interval': 'interval',
      'btn.quote': 'Quote',
      'btn.kline': 'Klines',
      'btn.funding': 'Funding',
      'btn.liquidation': 'Liquidations',
      'btn.news': 'News',
      'hint.paidKey': 'The free key has no access to this endpoint (403): set AICOIN_ACCESS_KEY_ID / AICOIN_ACCESS_SECRET to use your own key.',
      'row.scriptPath': 'Script path',
      'row.keyword': 'Library keyword',
      'row.hits': 'Hits',
      'row.specName': 'Strategy name (reads spec.json)',
      'row.findings': 'Findings',
      'row.completeness': 'Completeness',
      'state.ready': 'ready to code',
      'state.notReady': 'still open',
      'btn.advice': 'Structure review',
      'btn.specStatus': 'Spec status',
      'row.verdict': 'Result',
      'row.lines': 'Lines',
      'state.pass': 'pass',
      'state.fail': 'fail',
      'btn.validate': 'Validate',
      'btn.searchLib': 'Search library',
      'error.scriptMissing': 'kk_aicoin_codingAI is not installed (/plugins/kk-aicoin returned 404); the AiScript card is degraded.',
      'banner.needsRestart': 'AiCoin is running without a debug port. Electron only opens CDP at process start (--remote-debugging-port); it cannot be attached afterwards — use “Restart with debug port” below (closes the current window).',
      'btn.restartDebug': 'Restart with debug port',
      'btn.connect': 'Connect (restart if needed)',
      'confirm.restartDebug': 'AiCoin will be restarted with a debug port; the current window closes. Continue?',
      'section.tools': 'Registered tools',
      'section.toolsHint': 'these tools are already in the model tool list',
      'row.phase': 'Phase',
      'row.pid': 'Child PID',
      'row.server': 'Server',
      'row.port': 'CDP port',
      'row.registered': 'Registered',
      'row.advertised': 'Advertised',
      'row.connectedAt': 'Connected at',
      'row.reachable': 'Debug port',
      'row.browser': 'Browser',
      'row.windows': 'Windows',
      'row.mainWindow': 'Main window',
      'row.login': 'Login',
      'row.verdict': 'Process verdict',
      'row.lastError': 'Last error',
      'row.updatedAt': 'Updated',
      'btn.start': 'Connect',
      'btn.stop': 'Disconnect',
      'btn.restart': 'Reconnect',
      'btn.probe': 'Probe AiCoin',
      'btn.launch': 'Launch AiCoin',
      'btn.stopAicoin': 'Stop AiCoin',
      'state.running': 'running',
      'state.stopped': 'stopped',
      'state.yes': 'yes',
      'state.no': 'no',
      'state.unknown': 'unknown',
      'state.reachable': 'reachable',
      'state.unreachable': 'unreachable',
      'state.loggedIn': 'logged in',
      'state.loggedOut': 'logged out',
      'state.busy': 'working…',
      'confirm.stopAicoin': 'Stop the AiCoin client? This closes the window you are using (login and data are kept).',
      'error.apiMissing': 'Panel API is unavailable: the Host half did not mount /plugins/aicoin-mcp (plugin disabled, older version, or this profile has no webServer). Tools still work.',
      'error.request': 'request failed',
      'hint.autoPoll': 'Auto-refreshes every 3s (paused while the page is hidden)',
      'hint.mutating': 'Launch/stop AiCoin are mutating actions; disable them with allowMutating=false.',
      'empty.tools': '(no tool registered yet)',
      'empty.aicoin': '(AiCoin not probed yet — click "Probe AiCoin")',
      'err.hostDown': 'host did not answer',
    }

    /** Set by `apply`; last-resort fallback under the slot-supplied locale seat. */
    let boundTranslate = null

    /** Current-language fallback dictionary. */
    function fallbackDict() {
      const lang = typeof navigator !== 'undefined' ? String(navigator.language || '') : ''
      return /^zh/i.test(lang) ? ZH : EN
    }

    /** Interpolate `{name}` placeholders. */
    function format(text, vars) {
      if (!vars || typeof text !== 'string') return text
      return text.replace(/\{(\w+)\}/g, (match, name) => (vars[name] === undefined ? match : String(vars[name])))
    }

    /**
     * Build a translate function: slot locale seat → namespace binding → local
     * dictionary. A missing entry must never render as a bare key.
     */
    function makeT(seat) {
      return function translate(key, vars) {
        let text
        if (typeof seat === 'function') {
          try {
            text = seat(key, vars)
          } catch {
            text = undefined
          }
        }
        if ((!text || text === key) && typeof boundTranslate === 'function') {
          try {
            text = boundTranslate(key, vars)
          } catch {
            text = undefined
          }
        }
        if (!text || text === key) text = fallbackDict()[key] ?? ZH[key] ?? key
        return format(text, vars)
      }
    }

    //#endregion

    //#region shared styles

    const S = {
      root: {
        height: '100%',
        overflowY: 'auto',
        boxSizing: 'border-box',
        background: COLOR.base,
        color: COLOR.label,
        fontFamily: 'inherit',
      },
      inner: { maxWidth: 960, margin: '0 auto', padding: '20px 22px 40px' },
      header: { display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 18 },
      title: { margin: 0, fontSize: 20, fontWeight: 650, letterSpacing: 0.2 },
      subtitle: { margin: '6px 0 0', fontSize: 13, lineHeight: 1.55, color: COLOR.labelSecondary, maxWidth: 640 },
      card: { border: `1px solid ${COLOR.border1}`, borderRadius: 12, background: COLOR.layer1, padding: '14px 16px', marginBottom: 14 },
      cardHead: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 },
      cardTitle: { fontSize: 14, fontWeight: 600 },
      cardHint: { fontSize: 12, color: COLOR.labelSecondary, marginBottom: 10 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '8px 18px', marginTop: 6 },
      row: { display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12.5, minWidth: 0 },
      rowLabel: { color: COLOR.labelSecondary, flex: '0 0 auto' },
      rowValue: { color: COLOR.label, fontFamily: MONO, fontSize: 12, wordBreak: 'break-all', minWidth: 0 },
      pill: { display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 999, padding: '3px 10px', fontSize: 12, border: `1px solid ${COLOR.border2}`, background: COLOR.layer2 },
      dot: { width: 8, height: 8, borderRadius: 999, display: 'inline-block' },
      actions: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 },
      btn: {
        appearance: 'none',
        border: `1px solid ${COLOR.border2}`,
        background: COLOR.layer2,
        color: COLOR.label,
        borderRadius: 8,
        padding: '6px 12px',
        fontSize: 12.5,
        cursor: 'pointer',
        lineHeight: 1.4,
      },
      btnPrimary: { borderColor: COLOR.brand, color: COLOR.brand },
      btnDanger: { borderColor: COLOR.error, color: COLOR.error },
      btnDisabled: { opacity: 0.55, cursor: 'not-allowed' },
      banner: { border: `1px solid ${COLOR.warn}`, background: COLOR.layer1, borderRadius: 10, padding: '10px 12px', fontSize: 12.5, lineHeight: 1.6, marginBottom: 14, color: COLOR.label },
      bannerError: { borderColor: COLOR.error },
      mono: { fontFamily: MONO, fontSize: 11.5, color: COLOR.labelSecondary, wordBreak: 'break-all' },
      toolWrap: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 },
      toolChip: { fontFamily: MONO, fontSize: 11.5, padding: '3px 8px', borderRadius: 6, background: COLOR.layer2, border: `1px solid ${COLOR.border1}`, color: COLOR.labelSecondary },
      footer: { marginTop: 18, display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 11.5, color: COLOR.labelSecondary },
      linkBtn: { appearance: 'none', border: 'none', background: 'transparent', color: COLOR.brand, fontSize: 12, cursor: 'pointer', padding: 0 },
      fieldLabel: { display: 'block', fontSize: 11.5, color: COLOR.labelSecondary, marginTop: 8 },
      hitBtn: {
        display: 'block',
        width: '100%',
        textAlign: 'left',
        appearance: 'none',
        border: `1px solid ${COLOR.border1}`,
        background: COLOR.layer2,
        color: COLOR.label,
        borderRadius: 6,
        padding: '5px 8px',
        marginTop: 4,
        fontSize: 12,
        cursor: 'pointer',
      },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        border: `1px solid ${COLOR.border2}`,
        borderRadius: 8,
        background: COLOR.layer2,
        color: COLOR.label,
        fontSize: 12.5,
        padding: '6px 10px',
        fontFamily: 'inherit',
      },
      textarea: { resize: 'vertical', lineHeight: 1.5, fontSize: 11.5 },
      pre: {
        margin: '6px 0 0',
        padding: '10px 12px',
        borderRadius: 8,
        background: COLOR.layer2,
        border: `1px solid ${COLOR.border1}`,
        fontFamily: MONO,
        fontSize: 11.5,
        lineHeight: 1.5,
        maxHeight: 260,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: COLOR.labelSecondary,
      },
    }

    //#endregion

    //#region small building blocks

    /** Sidebar rail glyph: three candles under a trend line. */
    function AicoinIcon(props) {
      const size = Math.max(14, Number(props && props.size) || 20)
      const active = Boolean(props && props.active)
      const tone = active ? COLOR.brand : 'currentColor'
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: tone,
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M3 16.5 8 11l4 3.2L21 4.5' }),
        h('path', { d: 'M7 20V9.5' }),
        h('rect', { x: 5.2, y: 12.2, width: 3.6, height: 5.6, rx: 0.8 }),
        h('path', { d: 'M14 20v-7' }),
        h('rect', { x: 12.2, y: 14.4, width: 3.6, height: 4.2, rx: 0.8 }),
        h('circle', { cx: 19, cy: 20, r: 1, fill: tone, stroke: 'none' }),
      )
    }

    /** Phase pill. */
    function PhasePill(props) {
      const t = props.t
      const tone = PHASE_TONE[props.phase] ?? COLOR.idle
      return h(
        'span',
        { style: S.pill },
        h('span', { style: { ...S.dot, background: tone } }),
        h('span', { style: { color: COLOR.labelSecondary } }, t(`phase.${props.phase}`)),
      )
    }

    /** One label/value row. */
    function Row(props) {
      return h(
        'div',
        { style: S.row },
        h('span', { style: S.rowLabel }, `${props.label}:`),
        h('span', { style: S.rowValue }, props.value === undefined || props.value === null || props.value === '' ? '—' : String(props.value)),
      )
    }

    /** Button with tone + busy support. */
    function Btn(props) {
      const style = { ...S.btn, ...(props.tone === 'primary' ? S.btnPrimary : {}), ...(props.tone === 'danger' ? S.btnDanger : {}), ...(props.disabled ? S.btnDisabled : {}) }
      return h(
        'button',
        {
          type: 'button',
          style,
          disabled: Boolean(props.disabled),
          onClick: props.onClick,
          title: props.title,
        },
        props.children,
      )
    }

    //#endregion

    //#region panel

    /** Fetch JSON from the Host API. Throws on transport/HTTP errors. */
    async function fetchJson(path, init) {
      const response = await fetch(`${API_BASE}${path}`, {
        cache: 'no-store',
        headers: { accept: 'application/json', ...(init && init.body ? { 'content-type': 'application/json' } : {}) },
        ...init,
      })
      if (response.status === 404) {
        const error = new Error('panel API missing')
        error.code = 'API_MISSING'
        throw error
      }
      const text = await response.text()
      let payload = null
      try {
        payload = text ? JSON.parse(text) : null
      } catch {
        payload = null
      }
      if (!response.ok) {
        const error = new Error((payload && payload.error) || `HTTP ${response.status}`)
        error.payload = payload
        throw error
      }
      return payload
    }

    /** JSON view of an arbitrary tool result, capped so one payload cannot flood the panel. */
    function pretty(value) {
      if (value === undefined) return ''
      try {
        const text = JSON.stringify(value, null, 2)
        return text.length > 4000 ? `${text.slice(0, 4000)}\n… (${text.length} chars)` : text
      } catch {
        return String(value)
      }
    }

    /** POST JSON to another same-origin plugin route; 404 means "that plugin is absent". */
    async function postJson(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
      if (response.status === 404) {
        const error = new Error('route missing')
        error.code = 'API_MISSING'
        throw error
      }
      const text = await response.text()
      let payload = null
      try {
        payload = text ? JSON.parse(text) : null
      } catch {
        payload = null
      }
      if (!response.ok) {
        const error = new Error((payload && payload.error) || `HTTP ${response.status}`)
        error.payload = payload
        throw error
      }
      return payload
    }

    /**
     * Direct tool runner: pick a registered tool, edit its argument JSON, run it.
     * Write-capable tools stay disabled unless the Host config allows mutating.
     */
    function ToolRunnerCard(props) {
      const { t, tools, busy, act, allowMutating, lastToolResult } = props
      const [name, setName] = useState('')
      const [args, setArgs] = useState('{}')
      const [parseError, setParseError] = useState(null)
      const list = Array.isArray(tools) ? tools : []
      const current = name || (list[0] ? list[0].name : '')
      const selected = list.find((item) => item.name === current)
      const blocked = Boolean(selected && selected.mutating && allowMutating === false)
      const run = () => {
        if (!current) return
        let parsed = {}
        try {
          parsed = args.trim() ? JSON.parse(args) : {}
        } catch (caught) {
          setParseError(caught instanceof Error ? caught.message : String(caught))
          return
        }
        setParseError(null)
        act('tool.run', null, { tool: current, args: parsed })
      }
      return h(
        'section',
        { style: S.card },
        h(
          'div',
          { style: S.cardHead },
          h('span', { style: S.cardTitle }, t('section.run')),
          h('span', { style: S.pill }, String(list.length)),
        ),
        h('div', { style: S.cardHint }, t('section.runHint')),
        list.length
          ? h(
              'div',
              null,
              h('label', { style: S.fieldLabel }, t('row.tool')),
              h(
                'select',
                { style: S.input, value: current, onChange: (event) => setName(event.target.value) },
                list.map((item) => h('option', { key: item.name, value: item.name }, item.mutating ? `${item.name} ✱` : item.name)),
              ),
              h('label', { style: S.fieldLabel }, t('row.args')),
              h('textarea', {
                style: { ...S.input, ...S.textarea, fontFamily: MONO },
                value: args,
                rows: 4,
                spellCheck: false,
                onChange: (event) => setArgs(event.target.value),
              }),
              parseError ? h('div', { style: { ...S.mono, color: COLOR.error, marginTop: 6 } }, parseError) : null,
              blocked ? h('div', { style: { ...S.mono, marginTop: 6 } }, t('hint.blocked')) : null,
              h(
                'div',
                { style: S.actions },
                h(Btn, { tone: 'primary', onClick: run, disabled: Boolean(busy) || blocked }, busy ? t('state.busy') : t('btn.run')),
              ),
            )
          : h('div', { style: S.mono }, t('empty.tools')),
        lastToolResult
          ? h(
              'div',
              null,
              h(
                'div',
                { style: S.fieldLabel },
                `${t('row.lastRun')} · ${lastToolResult.tool} · ${lastToolResult.ok === false ? 'error' : 'ok'}` +
                  (typeof lastToolResult.tookMs === 'number' ? ` · ${lastToolResult.tookMs}ms` : ''),
              ),
              h('pre', { style: S.pre }, pretty(lastToolResult.result)),
            )
          : null,
      )
    }

    /**
     * AiScript card: static validation and function-library search, served by the
     * kk_aicoin_codingAI plugin's own route. A 404 degrades to a hint instead of
     * breaking the panel (that plugin is optional).
     */
    function ScriptCard(props) {
      const { t } = props
      const [path, setPath] = useState('')
      const [query, setQuery] = useState('')
      const [specName, setSpecName] = useState('')
      const [result, setResult] = useState(null)
      const [missing, setMissing] = useState(false)
      const [failure, setFailure] = useState(null)
      const [running, setRunning] = useState('')
      const call = async (action, extra) => {
        setRunning(action)
        setFailure(null)
        try {
          const payload = await postJson(`${KK_BASE}/action`, { action, ...extra })
          setMissing(false)
          setResult({ action, ...payload })
        } catch (caught) {
          if (caught && caught.code === 'API_MISSING') {
            setMissing(true)
            return
          }
          setFailure(caught instanceof Error ? caught.message : String(caught))
        } finally {
          setRunning('')
        }
      }
      return h(
        'section',
        { style: S.card },
        h(
          'div',
          { style: S.cardHead },
          h('span', { style: S.cardTitle }, t('section.script')),
          h('span', { style: S.mono }, KK_BASE),
        ),
        h('div', { style: S.cardHint }, t('section.scriptHint')),
        missing ? h('div', { style: S.banner }, t('error.scriptMissing')) : null,
        h('label', { style: S.fieldLabel }, t('row.scriptPath')),
        h('input', {
          style: S.input,
          value: path,
          spellCheck: false,
          placeholder: 'aicoin/strategies/<name>/strategy.txt',
          onChange: (event) => setPath(event.target.value),
        }),
        h(
          'div',
          { style: S.actions },
          h(
            Btn,
            {
              tone: 'primary',
              onClick: () => call('validate', { path }),
              disabled: Boolean(running) || !path.trim(),
            },
            running === 'validate' ? t('state.busy') : t('btn.validate'),
          ),
          h(
            Btn,
            {
              onClick: () => call('advice', { path }),
              disabled: Boolean(running) || !path.trim(),
            },
            running === 'advice' ? t('state.busy') : t('btn.advice'),
          ),
        ),
        h('label', { style: S.fieldLabel }, t('row.keyword')),
        h('input', {
          style: S.input,
          value: query,
          spellCheck: false,
          placeholder: 'ma / 均线 / 突破',
          onChange: (event) => setQuery(event.target.value),
        }),
        h(
          'div',
          { style: S.actions },
          h(
            Btn,
            {
              onClick: () => call('library.search', { query, limit: 10 }),
              disabled: Boolean(running) || !query.trim(),
            },
            running === 'library.search' ? t('state.busy') : t('btn.searchLib'),
          ),
        ),
        h('label', { style: S.fieldLabel }, t('row.specName')),
        h('input', {
          style: S.input,
          value: specName,
          spellCheck: false,
          placeholder: 'pivot-daily-no-security',
          onChange: (event) => setSpecName(event.target.value),
        }),
        h(
          'div',
          { style: S.actions },
          h(
            Btn,
            {
              onClick: () => call('spec.status', { name: specName }),
              disabled: Boolean(running) || !specName.trim(),
            },
            running === 'spec.status' ? t('state.busy') : t('btn.specStatus'),
          ),
        ),
        failure ? h('div', { style: { ...S.mono, color: COLOR.error, marginTop: 8 } }, failure) : null,
        result && result.action === 'library.search' && Array.isArray(result.items)
          ? h(
              'div',
              { style: { marginTop: 8 } },
              h('div', { style: S.fieldLabel }, `${t('row.hits')} ${result.total ?? result.items.length}`),
              ...result.items.map((item) =>
                h(
                  'button',
                  {
                    key: item.name,
                    type: 'button',
                    style: S.hitBtn,
                    onClick: () => call('library.get', { name: item.callName || item.name }),
                  },
                  h('span', { style: { fontFamily: MONO } }, item.callName || item.name),
                  h('span', { style: { ...S.mono, marginLeft: 8 } }, item.signature || ''),
                ),
              ),
            )
          : null,
        result && result.action === 'library.get' && result.entry
          ? h(
              'div',
              { style: { marginTop: 8 } },
              h('div', { style: { ...S.mono, marginBottom: 4 } }, result.entry.signature || result.entry.name),
              h('pre', { style: S.pre }, pretty(result.entry)),
            )
          : null,
        result && result.action === 'validate'
          ? h(
              'div',
              { style: { marginTop: 8 } },
              h(
                'div',
                { style: { ...S.mono, color: result.ok ? COLOR.success : COLOR.error } },
                `${t('row.verdict')}: ${result.ok ? t('state.pass') : t('state.fail')} · ` +
                  `${t('row.lines')} ${result.stats && result.stats.lines} · error ${result.stats && result.stats.errors} · warning ${result.stats && result.stats.warnings}`,
              ),
              result.diagnostics && result.diagnostics.length
                ? h(
                    'div',
                    null,
                    ...result.diagnostics.map((d, index) =>
                      h(
                        'div',
                        { key: `${d.ruleId}-${index}`, style: { ...S.mono, marginTop: 4, color: d.severity === 'error' ? COLOR.error : COLOR.labelSecondary } },
                        `${d.severity} · ${d.line}:${d.column} · ${d.ruleId} · ${d.message}`,
                      ),
                    ),
                  )
                : null,
            )
          : null,
        result && result.action === 'advice'
          ? h(
              'div',
              { style: { marginTop: 8 } },
              h(
                'div',
                { style: S.mono },
                `${t('row.findings')} ${result.total ?? 0} · ` +
                  `${t('row.lines')} ${result.stats && result.stats.lines} · error ${result.stats && result.stats.errors}`,
              ),
              ...(result.advice || []).map((item) =>
                h(
                  'div',
                  { key: item.id, style: { marginTop: 6 } },
                  h(
                    'div',
                    { style: { ...S.mono, color: item.severity === 'high' ? COLOR.error : COLOR.labelSecondary } },
                    `[${item.severity}] ${item.title}`,
                  ),
                  h('div', { style: { fontSize: 12, color: COLOR.label } }, item.finding),
                  h('div', { style: { fontSize: 12, color: COLOR.labelSecondary } }, item.action),
                ),
              ),
              result.noMetricsNotice
                ? h('div', { style: { ...S.mono, marginTop: 6, color: COLOR.labelSecondary } }, result.noMetricsNotice)
                : null,
            )
          : null,
        result && result.action === 'spec.status'
          ? h(
              'div',
              { style: { marginTop: 8 } },
              h(
                'div',
                { style: { ...S.mono, color: result.ok ? COLOR.success : COLOR.error } },
                result.ok
                  ? `${t('row.completeness')} ${result.completeness && result.completeness.percent}% · ` +
                    `${result.completeness && result.completeness.readyToCode ? t('state.ready') : t('state.notReady')}`
                  : result.error,
              ),
              ...(result.openQuestions || []).map((question) =>
                h(
                  'div',
                  { key: question.id, style: { ...S.mono, marginTop: 4, color: COLOR.labelSecondary } },
                  `${question.id}: ${question.question}`,
                ),
              ),
            )
          : null,
      )
    }

    /**
     * Market card: live quotes / klines from AiCoin Open Data v3.
     *
     * These go through the Host's generic `tool.run` action, so this card needs no
     * dedicated route: it simply calls `aicoin_quote` / `aicoin_kline` / … and shows
     * whatever the tool returned. Paid-tier endpoints answer 403 and the card says so
     * instead of looking broken.
     */
    function MarketCard(props) {
      const { t } = props
      const [coins, setCoins] = useState('bitcoin,ethereum')
      const [interval, setIntervalValue] = useState('1h')
      const [last, setLast] = useState(null)
      const [busy, setBusy] = useState('')
      const [failure, setFailure] = useState(null)
      const run = async (label, tool, args) => {
        setBusy(label)
        setFailure(null)
        try {
          const payload = await postJson(`${API_BASE}/action`, { action: 'tool.run', tool, args })
          setLast((payload && payload.lastToolResult) || null)
        } catch (caught) {
          setFailure(caught instanceof Error ? caught.message : String(caught))
        } finally {
          setBusy('')
        }
      }
      const first = String(coins || 'bitcoin').split(',')[0].trim() || 'bitcoin'
      const payload = last && last.result ? last.result : null
      const paid = Boolean(payload && payload.needs_paid_key)

      let body = null
      if (payload && last.tool === 'aicoin_quote' && payload.ok) {
        const rows = (payload.overview || []).slice(0, 8)
        body = h(
          'div',
          null,
          ...rows.map((row) =>
            h(
              'div',
              { key: row.coin_key, style: { ...S.mono, marginTop: 4 } },
              `${row.coin_key} · ${row.price_usd} USD · 24h ${row.change_24h_pct}% · 7d ${row.change_7d_pct}%`,
            ),
          ),
          payload.ticker
            ? h('div', { style: { ...S.mono, marginTop: 4, color: COLOR.labelSecondary } }, `ticker · last ${payload.ticker.last_usd} · high ${payload.ticker.high_24h_usd} · low ${payload.ticker.low_24h_usd}`)
            : null,
        )
      } else if (payload && last.tool === 'aicoin_kline' && payload.ok) {
        body = h(
          'div',
          { style: { ...S.mono, marginTop: 4 } },
          `bars ${payload.count} · last_close ${payload.summary && payload.summary.last_close} · ` +
            `high ${payload.summary && payload.summary.high} · low ${payload.summary && payload.summary.low}`,
        )
      } else if (payload && payload.needs_paid_key) {
        body = h('div', { style: { ...S.mono, marginTop: 4, color: COLOR.warn } }, t('hint.paidKey'))
      } else if (payload) {
        body = h('pre', { style: S.pre }, pretty(payload))
      }

      return h(
        'section',
        { style: S.card },
        h(
          'div',
          { style: S.cardHead },
          h('span', { style: S.cardTitle }, t('section.market')),
          h('span', { style: S.mono }, 'open.aicoin.com · v3'),
        ),
        h('div', { style: S.cardHint }, t('section.marketHint')),
        h('label', { style: S.fieldLabel }, t('row.coins')),
        h('input', {
          style: S.input,
          value: coins,
          spellCheck: false,
          placeholder: 'bitcoin,ethereum',
          onChange: (event) => setCoins(event.target.value),
        }),
        h('label', { style: S.fieldLabel }, t('row.interval')),
        h('input', {
          style: S.input,
          value: interval,
          spellCheck: false,
          placeholder: '1h',
          onChange: (event) => setIntervalValue(event.target.value),
        }),
        h(
          'div',
          { style: S.actions },
          h(Btn, { tone: 'primary', onClick: () => run('quote', 'aicoin_quote', { coins, view: 'both' }), disabled: Boolean(busy) }, busy === 'quote' ? t('state.busy') : t('btn.quote')),
          h(Btn, { onClick: () => run('kline', 'aicoin_kline', { coin_key: first, interval, limit: 24 }), disabled: Boolean(busy) }, busy === 'kline' ? t('state.busy') : t('btn.kline')),
          h(Btn, { onClick: () => run('funding', 'aicoin_derivatives', { view: 'funding', coin_key: first, limit: 8 }), disabled: Boolean(busy) }, busy === 'funding' ? t('state.busy') : t('btn.funding')),
          h(Btn, { onClick: () => run('liq', 'aicoin_derivatives', { view: 'liquidations', coin_key: first }), disabled: Boolean(busy) }, busy === 'liq' ? t('state.busy') : t('btn.liquidation')),
          h(Btn, { onClick: () => run('news', 'aicoin_news', { view: 'flash', limit: 8 }), disabled: Boolean(busy) }, busy === 'news' ? t('state.busy') : t('btn.news')),
        ),
        failure ? h('div', { style: { ...S.mono, color: COLOR.error, marginTop: 8 } }, failure) : null,
        paid ? h('div', { style: S.banner }, t('hint.paidKey')) : null,
        payload && !payload.ok && !paid
          ? h('div', { style: { ...S.mono, color: COLOR.error, marginTop: 8 } }, `${payload.error && payload.error.code} · ${payload.error && payload.error.message}`)
          : null,
        body,
        last ? h('div', { style: { ...S.mono, marginTop: 8, color: COLOR.labelSecondary } }, `${last.tool}${typeof last.tookMs === 'number' ? ` · ${last.tookMs}ms` : ''}`) : null,
      )
    }

    /**
     * Publish card: write the script into AiCoin and read back the real compile verdict.
     *
     * This is the "no copy-paste" path: `aicoin_app_indicator_publish` saves through the
     * client's own API (server-side compile) and returns errLine/errColumn/sourceLine, which
     * we render right next to the offending line.
     */
    function PublishCard(props) {
      const { t } = props
      const [name, setName] = useState('枢轴点-当日')
      const [path, setPath] = useState('aicoin/strategies/pivot-daily-no-security/strategy-today-labels.txt')
      const [mode, setMode] = useState('verify')
      const [position, setPosition] = useState('main')
      const [last, setLast] = useState(null)
      const [busy, setBusy] = useState(false)
      const [failure, setFailure] = useState(null)
      const run = async (overrideMode) => {
        const effectiveMode = overrideMode || mode
        setBusy(true)
        setFailure(null)
        try {
          const payload = await postJson(`${API_BASE}/action`, {
            action: 'tool.run',
            tool: 'aicoin_app_indicator_publish',
            args: { name, path, mode: effectiveMode, position, confirm: true },
          })
          setLast((payload && payload.lastToolResult) || null)
        } catch (caught) {
          setFailure(caught instanceof Error ? caught.message : String(caught))
        } finally {
          setBusy(false)
        }
      }
      const payload = last && last.result ? last.result : null
      const compile = (payload && payload.compile) || null

      return h(
        'section',
        { style: S.card },
        h(
          'div',
          { style: S.cardHead },
          h('span', { style: S.cardTitle }, t('section.publish')),
          h('span', { style: S.mono }, compile && compile.verified ? (compile.pass ? t('state.compiledOk') : t('state.compiledFail')) : ''),
        ),
        h('div', { style: S.cardHint }, t('section.publishHint')),
        h('label', { style: S.fieldLabel }, t('row.indicatorName')),
        h('input', { style: S.input, value: name, spellCheck: false, onChange: (event) => setName(event.target.value) }),
        h('label', { style: S.fieldLabel }, t('row.scriptPath2')),
        h('input', { style: S.input, value: path, spellCheck: false, onChange: (event) => setPath(event.target.value) }),
        h('label', { style: S.fieldLabel }, t('row.publishMode')),
        h(
          'select',
          { style: S.input, value: mode, onChange: (event) => setMode(event.target.value) },
          h('option', { value: 'verify' }, 'verify'),
          h('option', { value: 'publish' }, 'publish'),
        ),
        h('label', { style: S.fieldLabel }, t('row.chartArea')),
        h(
          'select',
          { style: S.input, value: position, onChange: (event) => setPosition(event.target.value) },
          h('option', { value: 'main' }, 'main'),
          h('option', { value: 'sub' }, 'sub'),
        ),
        h(
          'div',
          { style: S.actions },
          h(Btn, { tone: 'primary', onClick: () => run('publish'), disabled: busy }, busy ? t('state.busy') : t('btn.publish')),
          h(Btn, { onClick: () => run('verify'), disabled: busy }, t('btn.verifyOnly')),
        ),
        failure ? h('div', { style: { ...S.mono, color: COLOR.error, marginTop: 8 } }, failure) : null,
        compile && compile.pass === false
          ? h(
              'div',
              { style: { marginTop: 8 } },
              h('div', { style: { ...S.mono, color: COLOR.error } }, `${compile.errLine ? `L${compile.errLine}` : '?'}${compile.errColumn ? `:${compile.errColumn}` : ''} ${compile.err || ''}`),
              compile.sourceLine ? h('pre', { style: S.pre }, `${compile.sourceLine}\n${compile.caret || ''}`) : null,
            )
          : null,
        compile && compile.pass === true
          ? h('div', { style: { ...S.mono, color: COLOR.success, marginTop: 8 } }, payload.summary || t('state.compiledOk'))
          : null,
        compile && compile.hint ? h('div', { style: S.banner }, compile.hint) : null,
        payload && payload.cleanup
          ? h('div', { style: { ...S.mono, marginTop: 8, color: COLOR.labelSecondary } }, `cleanup: id ${payload.cleanup.id} · ${payload.cleanup.reason} · ${payload.cleanup.ok ? 'ok' : 'failed'}`)
          : null,
      )
    }

    /** The control panel. */
    function AicoinPanel(props) {
      const t = makeT(props && props.locale)
      // `initialData` lets tests/previews render the panel with canned Host state.
      const [data, setData] = useState((props && props.initialData) || null)
      const [error, setError] = useState(null)
      const [apiMissing, setApiMissing] = useState(false)
      const [busy, setBusy] = useState('')
      const [showTools, setShowTools] = useState(false)
      const mounted = useRef(true)
      const inFlight = useRef(false)

      useEffect(
        () => () => {
          mounted.current = false
        },
        [],
      )

      const refresh = useCallback(async () => {
        if (inFlight.current) return
        inFlight.current = true
        try {
          const next = await fetchJson('/state')
          if (!mounted.current) return
          setData(next)
          setApiMissing(false)
          setError(null)
        } catch (caught) {
          if (!mounted.current) return
          if (caught && caught.code === 'API_MISSING') setApiMissing(true)
          setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
          inFlight.current = false
        }
      }, [])

      useEffect(() => {
        refresh()
        const timer = setInterval(() => {
          const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden'
          if (visible) refresh()
        }, POLL_INTERVAL_MS)
        return () => clearInterval(timer)
      }, [refresh])

      const act = useCallback(
        async (action, confirmText, extra) => {
          if (confirmText && typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(confirmText)) return
          setBusy(action)
          const body = { action, ...(extra && typeof extra === 'object' ? extra : {}) }
          try {
            const next = await fetchJson('/action', { method: 'POST', body: JSON.stringify(body) })
            if (!mounted.current) return
            setData(next)
            setApiMissing(false)
            setError(next && next.ok === false ? next.error || t('error.request') : null)
          } catch (caught) {
            if (!mounted.current) return
            if (caught && caught.code === 'API_MISSING') setApiMissing(true)
            const payload = caught && caught.payload
            if (payload && typeof payload === 'object') setData(payload.state || payload)
            const message = caught instanceof Error ? caught.message : String(caught)
            setError(/unknown action/i.test(message) ? `${message} · ${t('hint.hostStale')}` : message)
          } finally {
            if (mounted.current) setBusy('')
          }
        },
        [t],
      )

      const mcp = (data && data.mcp) || {}
      const cfg = (data && data.config) || {}
      const aicoin = data && data.aicoin
      const tools = Array.isArray(data && data.tools) ? data.tools : []
      const phase = (data && data.phase) || 'stopped'
      const phaseTone = PHASE_TONE[phase] ?? COLOR.idle
      const busyLabel = busy ? t('state.busy') : ''

      const yesNo = (value) => (value === true ? t('state.yes') : value === false ? t('state.no') : t('state.unknown'))

      return h(
        'div',
        { style: S.root, 'data-plugin': PANEL_ID },
        h(
          'div',
          { style: S.inner },
          h(
            'div',
            { style: S.header },
            h(
              'div',
              { style: { flex: '1 1 auto', minWidth: 0 } },
              h('h2', { style: S.title }, t('panel.title')),
              h('p', { style: S.subtitle }, t('panel.subtitle')),
            ),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' } },
              h(PhasePill, { phase, t }),
              h(Btn, { onClick: refresh, disabled: Boolean(busy) }, busy ? t('state.busy') : t('panel.refresh')),
            ),
          ),

          apiMissing
            ? h('div', { style: S.banner }, t('error.apiMissing'), h('div', { style: { ...S.mono, marginTop: 6 } }, `${API_BASE}/state`))
            : null,
          error && !apiMissing ? h('div', { style: { ...S.banner, ...S.bannerError } }, `${t('error.request')}: ${error}`) : null,

          // ---- MCP bridge card -------------------------------------------
          h(
            'section',
            { style: S.card },
            h(
              'div',
              { style: S.cardHead },
              h('span', { style: { ...S.dot, background: phaseTone } }),
              h('span', { style: S.cardTitle }, t('section.mcp')),
              h(PhasePill, { phase, t }),
            ),
            h('div', { style: S.cardHint }, t('section.mcpHint')),
            h(
              'div',
              { style: S.grid },
              h(Row, { label: t('row.pid'), value: mcp.pid }),
              h(Row, { label: t('row.server'), value: mcp.serverInfo ? `${mcp.serverInfo.name || 'aicoin-mcp'} ${mcp.serverInfo.version || ''}`.trim() : null }),
              h(Row, { label: t('row.registered'), value: mcp.toolsRegistered }),
              h(Row, { label: t('row.advertised'), value: mcp.toolsAdvertised }),
              h(Row, { label: t('row.port'), value: cfg.port }),
              h(Row, { label: t('row.connectedAt'), value: mcp.connectedAt ? new Date(mcp.connectedAt).toLocaleString() : null }),
            ),
            h(
              'div',
              { style: S.actions },
              h(Btn, { tone: 'primary', onClick: () => act('mcp.start'), disabled: Boolean(busy) || mcp.running }, t('btn.start')),
              h(Btn, { onClick: () => act('mcp.stop'), disabled: Boolean(busy) || !mcp.running }, t('btn.stop')),
              h(Btn, { onClick: () => act('mcp.restart'), disabled: Boolean(busy) }, t('btn.restart')),
            ),
          ),

          // ---- AiCoin client card ---------------------------------------
          h(
            'section',
            { style: S.card },
            h(
              'div',
              { style: S.cardHead },
              h('span', { style: { ...S.dot, background: aicoin && aicoin.reachable ? COLOR.success : COLOR.idle } }),
              h('span', { style: S.cardTitle }, t('section.aicoin')),
              h(
                'span',
                { style: S.pill },
                aicoin ? (aicoin.reachable ? t('state.reachable') : t('state.unreachable')) : t('state.unknown'),
              ),
            ),
            h('div', { style: S.cardHint }, t('section.aicoinHint')),
            aicoin
              ? h(
                  'div',
                  { style: S.grid },
                  h(Row, { label: t('row.reachable'), value: yesNo(aicoin.reachable) }),
                  h(Row, { label: t('row.browser'), value: aicoin.browser }),
                  h(Row, { label: t('row.windows'), value: aicoin.pageCount }),
                  h(Row, { label: t('row.mainWindow'), value: aicoin.mainPage ? aicoin.mainPage.hash || aicoin.mainPage.title : null }),
                  h(Row, { label: t('row.login'), value: aicoin.login === true ? t('state.loggedIn') : aicoin.login === false ? t('state.loggedOut') : t('state.unknown') }),
                  h(Row, { label: t('row.verdict'), value: aicoin.verdict }),
                )
              : h('div', { style: S.mono }, t('empty.aicoin')),
            aicoin && aicoin.error ? h('div', { style: { ...S.mono, marginTop: 6 } }, aicoin.error) : null,
            aicoin && aicoin.verdict === 'running-without-debug-port'
              ? h('div', { style: { ...S.banner, marginTop: 10 } }, t('banner.needsRestart'))
              : null,
            h(
              'div',
              { style: S.actions },
              h(Btn, { onClick: () => act('aicoin.probe'), disabled: Boolean(busy) }, t('btn.probe')),
              h(
                Btn,
                { tone: 'primary', onClick: () => act('aicoin.connect', t('confirm.restartDebug')), disabled: Boolean(busy) || cfg.allowMutating === false },
                t('btn.connect'),
              ),
              h(
                Btn,
                { onClick: () => act('aicoin.restartDebug', t('confirm.restartDebug')), disabled: Boolean(busy) || cfg.allowMutating === false },
                t('btn.restartDebug'),
              ),
              h(Btn, { onClick: () => act('aicoin.launch'), disabled: Boolean(busy) || cfg.allowMutating === false }, t('btn.launch')),
              h(Btn, { tone: 'danger', onClick: () => act('aicoin.stop', t('confirm.stopAicoin')), disabled: Boolean(busy) || cfg.allowMutating === false }, t('btn.stopAicoin')),
            ),
          ),

          // ---- tool runner card -----------------------------------------
          h(ToolRunnerCard, {
            t,
            tools,
            busy,
            act,
            allowMutating: cfg.allowMutating,
            lastToolResult: data && data.lastToolResult,
          }),

          // ---- AiScript card -------------------------------------------
          h(ScriptCard, { t }),
          h(PublishCard, { t }),
          h(MarketCard, { t }),

          // ---- tools card ----------------------------------------------
          h(
            'section',
            { style: S.card },
            h(
              'div',
              { style: S.cardHead },
              h('span', { style: S.cardTitle }, t('section.tools')),
              h('span', { style: S.pill }, String(mcp.toolsRegistered || 0)),
              h('button', { type: 'button', style: S.linkBtn, onClick: () => setShowTools((value) => !value) }, `${showTools ? '▾' : '▸'} ${t('section.tools')}`),
            ),
            h('div', { style: S.cardHint }, t('section.toolsHint')),
            showTools
              ? tools.length
                ? h(
                    'div',
                    { style: S.toolWrap },
                    tools.slice(0, TOOL_RENDER_LIMIT).map((tool) =>
                      h('span', { key: tool.name, style: S.toolChip, title: tool.description || '' }, tool.name),
                    ),
                    tools.length > TOOL_RENDER_LIMIT
                      ? h('span', { style: S.toolChip }, `+${tools.length - TOOL_RENDER_LIMIT}`)
                      : null,
                  )
                : h('div', { style: S.mono }, t('empty.tools'))
              : null,
          ),

          // ---- footer ---------------------------------------------------
          h(
            'div',
            { style: S.footer },
            h('span', null, t('hint.autoPoll')),
            h('span', null, t('hint.mutating')),
            h('span', { style: S.mono }, API_BASE),
            data && data.generatedAt ? h('span', { style: S.mono }, `${t('row.updatedAt')}: ${new Date(data.generatedAt).toLocaleTimeString()}`) : null,
            data && data.lastError ? h('span', { style: { ...S.mono, color: COLOR.error } }, `${t('row.lastError')}: ${data.lastError}`) : null,
            busyLabel ? h('span', { style: S.mono }, busyLabel) : null,
          ),
        ),
      )
    }

    //#endregion

    //#region plugin wiring

    return {
      inject: ['slots', 'locale'],
      /**
       * Register the dictionaries, the sidebar rail seat and the main panel.
       * Everything is defensive: one missing service must not throw during load.
       * @param {object} ctx browser services
       */
      apply(ctx) {
        try {
          if (ctx.locale && typeof ctx.locale.register === 'function') {
            ctx.effect(() => ctx.locale.register(NAMESPACE, { zh: ZH, en: EN }), 'aicoin-mcp: dictionaries')
            if (typeof ctx.locale.bind === 'function') boundTranslate = ctx.locale.bind(NAMESPACE)
          }
        } catch (error) {
          // Fall back to the built-in dictionaries.
          console.warn('[aicoin-mcp] locale registration failed', error)
        }

        try {
          if (ctx.slots && typeof ctx.slots.inject === 'function' && typeof ctx.slots.register === 'function') {
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.panellist',
                  id: PANEL_ID,
                  order: 21,
                  locale: NAMESPACE,
                  label: () => (typeof boundTranslate === 'function' ? boundTranslate('panel.label') : ZH['panel.label']),
                },
                AicoinIcon,
              ),
            )
            ctx.slots.inject('main', () =>
              ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NAMESPACE }, AicoinPanel),
            )
          } else {
            console.warn('[aicoin-mcp] slots service unavailable; the panel is not mounted')
          }
        } catch (error) {
          // A failed slot registration must not break the browser bundle.
          console.warn('[aicoin-mcp] slot registration failed', error)
        }
      },
    }

    //#endregion
  },
})
