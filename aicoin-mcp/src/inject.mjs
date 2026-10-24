/**
 * src/inject.mjs — AiCoin 渲染层注入层（CDP 之上的一层「页面内运行时」）
 *
 * 这一层负责三件事：
 *
 *  1. **连哪个窗口**：AiCoin 同时挂着多个 `type=page` 的 CDP 目标
 *     （`#/main/exchange` 的 K 线主窗口、`#/chat`、`#/notice`、`#/asset-sync`…），
 *     每个窗口是**独立渲染进程 + 独立 redux store + 独立 axios 实例**。
 *     选错目标就会读到/改到另一个窗口的状态。所以本模块把「目标选择」做成显式参数
 *     `target: 'main' | 'chart' | 'chat' | 'notice' | '#/xxx' | index`，
 *     并且任何返回值都会回显实际 attach 的 `target.title / target.url / target.hash`。
 *
 *  2. **在页面里拿 require / axios / redux store / action creator**：
 *     AiCoin 渲染层是 webpack 打包的 React + redux 应用，模块 id 与 chunk 全局名
 *     **跨窗口、跨版本都不稳定**，所以这里全部走「形状发现 + 缓存 + 失效重扫」，
 *     绝不写死模块 id（2.16.27 上实测：chunk 全局名 `webpackChunkaicoin`，
 *     axios 在 webpack 模块 31438 的 `.A`，store 在 65453 的 `.default`，
 *     但这些 id 只作为「本次会话的观测结果」记录，不作为常量使用）。
 *
 *  3. **把只读的领域操作封成函数**：`bootstrap / findAxios / api / loginState /
 *     routes / chartState / setChart / domSummary / click / consoleCapture`。
 *
 * 设计上的一切都为了「不写用户账号」：`api()` 有硬编码的写接口守卫，
 * `upgrade/customIndicator/script/save` 这类路径必须显式 `allowWrite: true` 才放行。
 *
 * 连接层直接用框架的 `CdpClient`（`src/cdp.mjs`），错误码原样透出：
 * `PORT_CLOSED` / `NO_PAGE_TARGET` / `TARGET_NOT_FOUND` / `SCREENSHOT_TIMEOUT` / `PAGE_EXCEPTION`。
 *
 * @module aicoin-mcp/inject
 */

import { CdpClient, CdpError, DEFAULT_PORT } from './cdp.mjs'

export { CdpClient, CdpError, DEFAULT_PORT }

/** 页面内核版本；改动 PAGE_KERNEL 时必须递增（页面侧按版本号判断是否需要重装）。 */
export const KERNEL_VERSION = '1.5.0'

/** K 线主窗口的 URL 特征。 */
export const MAIN_WINDOW_URL_HINT = '#/main'

/* ================================================================== *
 * 1. 目标（窗口）选择
 * ================================================================== */

/**
 * `target` 别名 → CDP 目标 URL/hash 子串。
 *
 * AiCoin 的所有窗口都是同一个 `index.html#/路由`，所以「窗口」= hash 路由。
 * `chart` / `kline` / `exchange` 都指向主窗口（图表在 `#/main/exchange`）。
 */
export const TARGET_ALIASES = Object.freeze({
  main: '#/main',
  chart: '#/main',
  kline: '#/main',
  exchange: '#/main',
  notice: '#/notice',
  chat: '#/chat',
  login: '#/login',
  'asset-sync': '#/asset-sync',
})

/**
 * 把工具的 `target` 参数归一化成 `CdpClient.attach` 能吃的形式。
 *
 * - `undefined|null|''|'main'|'chart'|…` → 别名对应的 URL 子串
 * - `number` / `'0'` / `'1'` → `{ index: n }`（**列表顺序会变，仅调试用**）
 * - `'#/xxx'` 或其他字符串 → 原样交给 cdp.mjs（它按 url/hash/title/id 依次匹配）
 * - 对象 → 原样透传（支持 `{id|urlIncludes|titleIncludes|index}`）
 *
 * @param {string|number|object|null|undefined} target
 */
export function resolveTarget(target) {
  if (target === undefined || target === null || target === '') return TARGET_ALIASES.main
  if (typeof target === 'number') return { index: Math.max(0, Math.trunc(target)) }
  if (typeof target === 'string') {
    const raw = target.trim()
    if (raw === '') return TARGET_ALIASES.main
    const alias = TARGET_ALIASES[raw.toLowerCase()]
    if (alias) return alias
    if (/^\d+$/.test(raw)) return { index: Number(raw) }
    return raw
  }
  if (typeof target === 'object') return target
  return TARGET_ALIASES.main
}

/** 目标的可读描述（写进返回值里，排查多窗口问题时最有用）。 */
export function describeTarget(target) {
  if (!target) return null
  const url = target.url ?? null
  const hash = target.hash ?? (typeof url === 'string' && url.includes('#') ? `#${url.split('#')[1]}` : '')
  return {
    id: target.id ?? null,
    title: target.title ?? null,
    url,
    hash,
    type: target.type ?? null,
    isMain: typeof target.isMain === 'boolean' ? target.isMain : undefined,
  }
}

/** 列出当前所有 page 窗口（给工具层做「多窗口自检」用）。 */
export async function listWindows({ port = DEFAULT_PORT, timeoutMs = 2500 } = {}) {
  const discovery = await CdpClient.discover({ port, timeoutMs })
  return {
    ok: discovery.ok,
    port: discovery.port,
    reason: discovery.reason ?? null,
    version: discovery.version ?? null,
    userAgent: discovery.userAgent ?? null,
    windows: (discovery.pages ?? []).map((page) => ({
      index: page.index,
      id: page.id,
      title: page.title,
      url: page.url,
      hash: page.hash,
      isMain: page.isMain,
      type: page.type,
    })),
  }
}

/* ================================================================== *
 * 2. 连接
 * ================================================================== */

/**
 * 连接到某个 AiCoin 窗口（默认 K 线主窗口）。
 *
 * @param {{port?: number, target?: string|number|object|null, timeoutMs?: number}} [options]
 * @returns {Promise<CdpClient>} `client.target` 是实际附加的目标
 */
export async function attach({ port = DEFAULT_PORT, target = null, timeoutMs = 8000 } = {}) {
  return CdpClient.attach({ port: Number(port) || DEFAULT_PORT, target: resolveTarget(target), timeoutMs })
}

/**
 * 给工具层用：拿到一个「连到指定窗口」的客户端。
 * 如果 ctx 已经连着同一个窗口就复用，否则新开一条连接并返回 `release()`。
 *
 * @param {object} ctx 框架 createContext 的产物（也接受普通 `{port, client}`）
 * @param {string|number|object|null} [target]
 * @returns {Promise<{client: object, target: object|null, reused: boolean, release: () => Promise<void>}>}
 */
export async function openTarget(ctx, target = null) {
  const port = Number(ctx?.port ?? ctx?.config?.port ?? DEFAULT_PORT) || DEFAULT_PORT
  const existing = ctx?.client ?? null
  const wanted = resolveTarget(target)
  const wantedText = typeof wanted === 'string' ? wanted : null

  if (existing && typeof existing.evaluate === 'function' && existing.connected !== false) {
    const cur = existing.target ?? null
    const curUrl = String(cur?.url ?? '')
    const isMainNow = curUrl.includes(MAIN_WINDOW_URL_HINT)
    const wantMain = wantedText === TARGET_ALIASES.main
    const sameAsWanted = wantedText ? curUrl.includes(wantedText) || String(cur?.title ?? '').includes(wantedText) : wantMain && isMainNow
    if (wantMain ? isMainNow : sameAsWanted) {
      return { client: existing, target: cur, reused: true, release: async () => {} }
    }
  }

  const client = await attach({ port, target })
  return {
    client,
    target: client.target ?? null,
    reused: false,
    release: async () => {
      try {
        await client.close()
      } catch {
        /* ignore */
      }
    },
  }
}

/* ================================================================== *
 * 3. 页面内核
 * ================================================================== */

/**
 * 页面内核源码，安装到 `window.__aicoin_app`（幂等：版本一致就不重装）。
 *
 * 里面做的事：
 *  - `$req()`：`webpackChunk*.push([['probe'],{}, r => captured = r])` 捕获
 *    `__webpack_require__`（2.16.27 真实全局名 `webpackChunkaicoin`，但这里用正则找）；
 *  - `$axios()`：扫 `__webpack_require__.m` 的**源码文本**（不执行）筛候选，再
 *    `require()` 候选做形状校验。webpack 内部有模块缓存，重复 require 已加载的模块
 *    不会重新执行 ⇒ 安全。注意 axios 实例是**函数**（bound fn）不是 object；
 *  - `$store()` / `$action()`：同理发现 redux store 与 action creator，带缓存 + 失效重扫；
 *  - `chart()` / `setChart()`：读/改 K 线窗口的 symbol+period（redux dispatch）；
 *  - `api()`：用 client 自己的 axios 发请求（自动带 token + 自动加解密）；
 *  - `indicators()` / `indicator()`：只读指标列表/详情。
 */
const PAGE_KERNEL = String.raw`
(function () {
  var VERSION = '__KERNEL_VERSION__';
  var G = window.__aicoin_app;
  if (G && G.kernelVersion === VERSION) {
    // 已安装：刷新使用时间并直接回报安装信息
    G.touch();
    return G.installInfo();
  }
  G = window.__aicoin_app = { kernelVersion: VERSION, installedAt: Date.now() };
  G.touch = function () { G.lastUsedAt = Date.now(); };

  function fail(code, message) {
    var e = new Error(message);
    e.code = code;
    throw e;
  }

  // ---------- webpack require ----------
  G.$req = function () {
    if (G._req) return G._req;
    var cand = [];
    for (var k in window) {
      if (/^webpackChunk[A-Za-z0-9_]*$/.test(k)) cand.push(k);
    }
    // 已知主 bundle 名优先，但仍逐个试（不写死）
    cand.sort(function (a, b) {
      var pa = a === 'webpackChunkaicoin' ? 0 : 1;
      var pb = b === 'webpackChunkaicoin' ? 0 : 1;
      return pa - pb;
    });
    for (var i = 0; i < cand.length; i += 1) {
      try {
        var cap = null;
        var probeName = ['__aicoin_probe__', String(Date.now()), String(i)].join('_');
        window[cand[i]].push([[probeName], {}, function (r) { cap = r; }]);
        if (typeof cap === 'function') {
          G._req = cap;
          G._chunkGlobal = cand[i];
          return cap;
        }
      } catch (e) {
        /* 换下一个候选 */
      }
    }
    fail('NO_WEBPACK_CHUNK', '找不到 webpackChunk* 全局（尝试过：' + (cand.join(',') || '无') + '）');
  };

  G.$modules = function () { return G.$req().m || {}; };
  G.$moduleCount = function () { return Object.keys(G.$modules()).length; };

  // ---------- axios ----------
  function axiosLike(v) {
    if (v === null || v === undefined) return false;
    var t = typeof v;
    if (t !== 'object' && t !== 'function') return false;
    try {
      if (typeof v.get !== 'function' || typeof v.post !== 'function') return false;
      if (!v.interceptors || !v.interceptors.request || !v.interceptors.response) return false;
      if (!v.defaults || typeof v.defaults !== 'object') return false;
    } catch (e) {
      return false;
    }
    return true;
  }

  function handlerCount(inst, kind) {
    try {
      var h = inst.interceptors[kind].handlers;
      return h ? h.filter(Boolean).length : 0;
    } catch (e) {
      return 0;
    }
  }

  G.$axios = function (force) {
    if (G._axios && !force) return G._axios;
    var req = G.$req();
    var mods = req.m || {};
    var ids = Object.keys(mods);
    var scored = [];
    for (var i = 0; i < ids.length; i += 1) {
      var src;
      try { src = String(mods[ids[i]]); } catch (e) { continue; }
      if (src.indexOf('interceptors') === -1 && !/axios/i.test(src)) continue;
      var score = 0;
      if (/axios/i.test(src)) score += 3;
      if (src.indexOf('interceptors') !== -1) score += 3;
      if (src.indexOf('baseURL') !== -1) score += 2;
      if (src.indexOf('.create(') !== -1) score += 1;
      scored.push({ id: ids[i], score: score, len: src.length });
    }
    scored.sort(function (a, b) { return b.score - a.score || b.len - a.len; });
    var best = null;
    for (var j = 0; j < scored.length && j < 60; j += 1) {
      var exp;
      try { exp = req(scored[j].id); } catch (e) { continue; }
      var seen = [];
      var visit = function (path, v) {
        if (!axiosLike(v) || seen.indexOf(v) !== -1) return;
        seen.push(v);
        var reqH = handlerCount(v, 'request');
        var respH = handlerCount(v, 'response');
        var baseURL = '';
        try { baseURL = v.defaults.baseURL || ''; } catch (e) { baseURL = ''; }
        var rank = (baseURL ? 100 : 0) + reqH * 10 + respH * 10 + (typeof v === 'function' ? 1 : 0);
        if (!best || rank > best.rank) {
          best = { rank: rank, id: scored[j].id, path: path, instance: v, baseURL: baseURL, reqHandlers: reqH, respHandlers: respH };
        }
      };
      visit('', exp);
      if (exp && (typeof exp === 'object' || typeof exp === 'function')) {
        var ks;
        try { ks = Object.keys(exp); } catch (e) { ks = []; }
        for (var m = 0; m < ks.length && m < 80; m += 1) {
          var v;
          try { v = exp[ks[m]]; } catch (e) { continue; }
          visit('.' + ks[m], v);
        }
      }
    }
    if (!best) fail('NO_AXIOS', '没有在 webpack 模块里找到 axios 实例（扫描了 ' + ids.length + ' 个模块）');
    G._axios = best;
    return best;
  };

  G.axiosInfo = function () {
    var a = G.$axios();
    return JSON.stringify({
      moduleId: a.id, exportPath: a.path, baseURL: a.baseURL,
      requestInterceptors: a.reqHandlers, responseInterceptors: a.respHandlers,
      hasSkipCryptFlag: true
    });
  };

  // ---------- redux store ----------
  function storeLike(v) {
    try {
      if (!v || typeof v.getState !== 'function' || typeof v.dispatch !== 'function') return false;
      var s = v.getState();
      return !!s && typeof s === 'object' && !!s.chart && !!s.user;
    } catch (e) {
      return false;
    }
  }

  G.$store = function (force) {
    if (G._store && !force) return G._store;
    var req = G.$req();
    var mods = req.m || {};
    var ids = Object.keys(mods);
    var cands = [];
    for (var i = 0; i < ids.length; i += 1) {
      var src;
      try { src = String(mods[ids[i]]); } catch (e) { continue; }
      if (src.indexOf('getState') === -1 || src.indexOf('dispatch') === -1) continue;
      cands.push(ids[i]);
    }
    for (var j = 0; j < cands.length; j += 1) {
      var exp;
      try { exp = req(cands[j]); } catch (e) { continue; }
      if (storeLike(exp)) { G._store = { id: cands[j], path: '', store: exp }; return G._store; }
      if (exp && (typeof exp === 'object' || typeof exp === 'function')) {
        var ks;
        try { ks = Object.keys(exp); } catch (e) { ks = []; }
        for (var m = 0; m < ks.length && m < 60; m += 1) {
          var v;
          try { v = exp[ks[m]]; } catch (e) { continue; }
          if (storeLike(v)) { G._store = { id: cands[j], path: '.' + ks[m], store: v }; return G._store; }
        }
      }
    }
    fail('NO_STORE', '没有在 webpack 模块里找到 redux store（候选 ' + cands.length + ' 个）');
  };

  G.state = function () { return G.$store().store.getState(); };

  // ---------- redux action creator ----------
  G.$action = function (type, force) {
    G._actions = G._actions || {};
    G._actionSrc = G._actionSrc || {};
    if (G._actions[type] && !force) return G._actions[type];
    var req = G.$req();
    var mods = req.m || {};
    var ids = Object.keys(mods);
    var slash = type.indexOf('/');
    var prefix = slash === -1 ? '' : type.slice(0, slash);
    var name = slash === -1 ? type : type.slice(slash + 1);

    function scan(order, deep) {
      for (var i = 0; i < order.length; i += 1) {
        var exp;
        try { exp = req(order[i]); } catch (e) { continue; }
        if (!exp || (typeof exp !== 'object' && typeof exp !== 'function')) continue;
        var ks;
        try { ks = Object.keys(exp); } catch (e) { continue; }
        for (var k = 0; k < ks.length; k += 1) {
          var v;
          try { v = exp[ks[k]]; } catch (e) { continue; }
          if (typeof v === 'function' && v.type === type) {
            G._actions[type] = v;
            G._actionSrc[type] = order[i] + '.' + ks[k];
            return v;
          }
        }
        if (deep) {
          for (var d = 0; d < ks.length; d += 1) {
            var nested;
            try { nested = exp[ks[d]]; } catch (e) { continue; }
            if (!nested || typeof nested !== 'object') continue;
            var nks;
            try { nks = Object.keys(nested); } catch (e) { continue; }
            for (var n = 0; n < nks.length; n += 1) {
              var nv;
              try { nv = nested[nks[n]]; } catch (e) { continue; }
              if (typeof nv === 'function' && nv.type === type) {
                G._actions[type] = nv;
                G._actionSrc[type] = order[i] + '.' + ks[d] + '.' + nks[n];
                return nv;
              }
            }
          }
        }
      }
      return null;
    }

    var narrow = [];
    for (var a = 0; a < ids.length; a += 1) {
      var src;
      try { src = String(mods[ids[a]]); } catch (e) { continue; }
      if (src.indexOf(name) === -1) continue;
      if (prefix && src.indexOf(prefix) === -1) continue;
      narrow.push(ids[a]);
    }
    var found = scan(narrow, false);
    if (!found) found = scan(narrow, true);
    if (!found) found = scan(ids, false);
    if (!found) fail('NO_ACTION', '找不到 redux action creator：' + type + '（已扫描 ' + ids.length + ' 个模块）');
    return found;
  };

  G.actionInfo = function (type) {
    G.$action(type);
    return JSON.stringify({ type: type, modulePath: G._actionSrc[type] || null });
  };

  // ---------- 图表 ----------
  G.$chartInstanceKey = function (st) {
    return (st.chart && st.chart.currentChartInstanceKey) || 'chart0';
  };

  G.chart = function () {
    var st = G.state();
    var ch = st.chart || {};
    var key = G.$chartInstanceKey(st);
    var o = (ch.chartsOptions || {})[key] || {};
    return JSON.stringify({
      instanceKey: key,
      symbol: o.symbol || '',
      period: o.period || 0,
      type: o.type || '',
      currentPeriod: ch.currentPeriod || 0,
      coinMeta: ch.currentCoinMeta || null,
      activeTab: ch.currentChartTabId || '',
      tabs: (ch.chartTabs || []).map(function (t) { return t.id; }),
      mainIndicators: (o.mainIndicators || []).length,
      subIndicators: (o.subIndicators || []).length,
      title: document.title,
      hash: location.hash
    });
  };

  // 失效检测：state 里没有 chart（窗口重载 / 热更新）就清缓存重扫一次
  G.$assertFresh = function () {
    try {
      var st = G.state();
      if (!st || !st.chart) throw new Error('no chart');
    } catch (e) {
      G._store = null;
      G._actions = null;
      G.state();
    }
  };

  G.setChart = function (args) {
    args = args || {};
    G.$assertFresh();
    var before = JSON.parse(G.chart());
    var store = G.$store().store;
    var key = before.instanceKey;
    var applied = { chartInstanceKey: key };
    if (args.symbol) {
      applied.symbol = String(args.symbol);
      applied.type = String(args.type || (String(args.symbol).indexOf('swap') !== -1 ? 'tp' : 'sp'));
    }
    if (args.period) applied.period = Number(args.period);

    var steps = [];
    var dispatch = function (type, payload) {
      var creator = G.$action(type);
      store.dispatch(creator(payload));
      steps.push({ action: type, payload: payload, via: G._actionSrc[type] || null });
    };

    dispatch('chart/setCurrentChartOptions', applied);
    if (args.period) dispatch('chart/setCurrentPeriod', Number(args.period));
    if (args.symbol) dispatch('chart/setCurrentCoinMeta', { key: applied.symbol, type: applied.type });

    return JSON.stringify({ before: before, requested: { symbol: args.symbol || null, type: applied.type || null, period: args.period || null }, applied: applied, steps: steps });
  };

  // ---------- 登录态 ----------
  G.loginState = function () {
    var st = G.state();
    var u = st.user || {};
    var d = u.details || {};
    var token = typeof d.token === 'string' ? d.token : '';
    var storage = {};
    try {
      for (var i = 0; i < localStorage.length; i += 1) {
        var key = localStorage.key(i);
        if (/token|account|auth/i.test(key)) {
          var val = String(localStorage.getItem(key) || '');
          storage[key] = val.length > 40 ? val.slice(0, 40) + '…' : val;
        }
      }
    } catch (e) {
      /* file:// 下 localStorage 可能受限 */
    }
    return JSON.stringify({
      loggedIn: !!(u.auth && token),
      auth: !!u.auth,
      tokenPresent: !!token,
      tokenLength: token.length,
      uid: d.uid != null ? String(d.uid) : null,
      nickName: d.nickName || null,
      email: d.email || null,
      sessionGeneration: u.sessionGeneration != null ? u.sessionGeneration : null,
      expired: !!u.expired,
      language: (st.app && st.app.language) || null,
      vipStatusKeys: u.vipStatus ? Object.keys(u.vipStatus) : [],
      vipAbility: u.vipAbility || null,
      storageHits: storage
    });
  };

  // ---------- 通用 api ----------
  function summarize(v, depth) {
    depth = depth || 0;
    if (v === null || v === undefined) return { kind: String(v) };
    var t = typeof v;
    if (t === 'string') return { kind: 'string', length: v.length, preview: v.length > 120 ? v.slice(0, 120) + '…' : v };
    if (t === 'number' || t === 'boolean') return { kind: t, value: v };
    if (t === 'function') return { kind: 'function' };
    if (Array.isArray(v)) {
      var itemKeys = [];
      if (v.length && v[0] && typeof v[0] === 'object') itemKeys = Object.keys(v[0]).slice(0, 40);
      return { kind: 'array', length: v.length, itemKeys: itemKeys };
    }
    var keys = Object.keys(v);
    var out = { kind: 'object', keyCount: keys.length, keys: keys.slice(0, 40) };
    if (depth === 0 && keys.length <= 12) {
      var preview = {};
      for (var i = 0; i < keys.length; i += 1) {
        var val = v[keys[i]];
        if (val && typeof val === 'object') preview[keys[i]] = summarize(val, depth + 1);
        else preview[keys[i]] = typeof val === 'string' && val.length > 80 ? val.slice(0, 80) + '…' : val;
      }
      out.preview = preview;
    }
    return out;
  }

  G.api = async function (args) {
    args = args || {};
    if (!args.path) fail('BAD_ARGUMENT', 'api 需要 path');
    var ax = G.$axios().instance;
    var method = String(args.method || 'post').toLowerCase();
    var cfg = {};
    if (args.skipCrypt) cfg.skipCrypt = true;
    if (args.skipAutoToken) cfg.skipAutoToken = true;
    if (args.timeout) cfg.timeout = Number(args.timeout);
    var started = Date.now();
    var base = { path: args.path, method: method, baseURL: G._axios ? G._axios.baseURL : '' };
    try {
      var resp;
      if (method === 'get') {
        if (args.params) cfg.params = args.params;
        resp = await ax.get(args.path, cfg);
      } else if (method === 'post') {
        resp = await ax.post(args.path, args.data, cfg);
      } else {
        resp = await ax.request(Object.assign({ url: args.path, method: method, data: args.data, params: args.params }, cfg));
      }
      var d = resp && resp.data;
      var body = d && typeof d === 'object' ? d : null;
      var data = body ? body.data : d;
      var out = {
        ok: true,
        httpOk: true,
        httpStatus: resp && resp.status,
        ms: Date.now() - started,
        success: body ? body.success === true : null,
        status: body ? body.status : null,
        message: body ? (typeof body.message === 'string' ? body.message : body.message) : null
      };
      out.dataSummary = summarize(data);
      if (args.includeData) {
        var json = '';
        try { json = JSON.stringify(data); } catch (e) { json = ''; }
        var cap = Number(args.maxChars || 0) || 120000;
        out.data = data === undefined ? null : data;
        if (json.length > cap) {
          out.dataTruncated = true;
          out.dataJsonLength = json.length;
        }
      }
      return JSON.stringify(Object.assign(base, out));
    } catch (e) {
      var respErr = e && e.response;
      var bodyErr = respErr && respErr.data && typeof respErr.data === 'object' ? respErr.data : null;
      return JSON.stringify(Object.assign(base, {
        ok: false,
        httpOk: false,
        httpStatus: respErr ? respErr.status : null,
        ms: Date.now() - started,
        error: String((e && e.message) || e),
        code: (e && e.code) || null,
        success: bodyErr ? bodyErr.success === true : null,
        status: bodyErr ? bodyErr.status : null,
        message: bodyErr && bodyErr.message ? String(bodyErr.message).slice(0, 200) : null
      }));
    }
  };

  // ---------- 指标（只读） ----------
  G.indicators = async function (args) {
    args = args || {};
    var ax = G.$axios().instance;
    var resp;
    try {
      resp = await ax.post('upgrade/customIndicator/script/list');
    } catch (e) {
      return JSON.stringify({ ok: false, error: String((e && e.message) || e), httpStatus: e && e.response ? e.response.status : null });
    }
    var d = resp && resp.data;
    if (!d || d.success !== true) {
      return JSON.stringify({ ok: false, success: d ? d.success : null, status: d ? d.status : null, message: d ? d.message : null });
    }
    var list = (d.data && d.data.customList) || [];
    var rows = list.map(function (x) {
      var row = {
        id: x.id, name: x.name, position: x.position, buildType: x.buildType,
        subID: x.subID || null, isSub: !!x.isSub, userId: x.userId != null ? String(x.userId) : null,
        createTime: x.createTime || 0, updateTime: x.updateTime || 0,
        hasAlert: !!x.hasAlert, hasTrade: !!x.hasTrade, openSource: !!x.is_opensource,
        symbol: x.symbol || '', period: x.period || 0, describe: (x.describe || '').slice(0, 120)
      };
      if (args.includeSource) row.source = x.scriptValue || '';
      return row;
    });
    var total = rows.length;
    if (args.id !== undefined && args.id !== null && args.id !== '') {
      rows = rows.filter(function (r) { return String(r.id) === String(args.id); });
    }
    if (args.name) {
      var needle = String(args.name).toLowerCase();
      rows = rows.filter(function (r) { return String(r.name || '').toLowerCase().indexOf(needle) !== -1; });
    }
    if (args.position) rows = rows.filter(function (r) { return r.position === args.position; });
    var matched = rows.length;
    var offset = Math.max(0, Number(args.offset || 0));
    var limit = Math.max(1, Math.min(500, Number(args.limit || 50)));
    var page = rows.slice(offset, offset + limit);
    return JSON.stringify({
      ok: true, total: total, matched: matched, offset: offset, limit: limit, returned: page.length,
      includeSource: !!args.includeSource, rows: page,
      recentlyVisitCount: ((d.data && d.data.recentlyVisit) || []).length
    });
  };

  G.indicator = async function (args) {
    args = args || {};
    var id = Number(args.id);
    if (!id) fail('BAD_ARGUMENT', 'indicator 需要数字 id');
    var ax = G.$axios().instance;
    var resp;
    try {
      resp = await ax.post('upgrade/customIndicator/script/detail', { id: id });
    } catch (e) {
      return JSON.stringify({ ok: false, id: id, error: String((e && e.message) || e), httpStatus: e && e.response ? e.response.status : null });
    }
    var d = resp && resp.data;
    if (!d || d.success !== true) {
      return JSON.stringify({ ok: false, id: id, success: d ? d.success : null, status: d ? d.status : null, message: d ? d.message : null });
    }
    var x = d.data || {};
    var value = x.value == null ? '' : String(x.value);
    return JSON.stringify({
      ok: true, id: x.id, name: x.name, position: x.position, buildType: x.buildType,
      value: value, valueLength: value.length,
      visualCode: x.visualCode || null,
      state: x.state || null, hasAlert: !!x.hasAlert, hasTrade: !!x.hasTrade, hasSecurity: !!x.hasSecurity,
      subID: x.subID || null, isSub: !!x.isSub, isSupportBacktest: !!x.isSupportBacktest,
      updateTime: x.updateTime || 0
    });
  };

  G.saveIndicator = async function (args) {
    args = args || {};
    if (args.dryRun) {
      var body = { name: args.name, value: args.value, version: args.version || 'v4' };
      if (args.id) body.id = Number(args.id);
      if (args.buildType) body.buildType = args.buildType;
      if (args.position) body.position = args.position;
      return JSON.stringify({ ok: true, dryRun: true, wouldPost: 'upgrade/customIndicator/script/save', body: body, bodyBytes: JSON.stringify(body).length });
    }
    var ax = G.$axios().instance;
    var payload = { name: args.name, value: args.value, version: args.version || 'v4' };
    if (args.id) payload.id = Number(args.id);
    if (args.buildType) payload.buildType = args.buildType;
    if (args.position) payload.position = args.position;
    if (args.visualCode && args.buildType === 'visual') payload.visualCode = args.visualCode;
    var resp = await ax.post('upgrade/customIndicator/script/save', payload);
    var d = resp && resp.data;
    return JSON.stringify({
      ok: !!(d && d.success === true),
      httpStatus: resp && resp.status,
      success: d ? d.success : null,
      status: d ? d.status : null,
      message: d ? d.message : null,
      data: d ? d.data : null,
      attempted: { path: 'upgrade/customIndicator/script/save', bodyKeys: Object.keys(payload) }
    });
  };

  G.delIndicator = async function (args) {
    args = args || {};
    var id = Number(args.id);
    if (!id) fail('BAD_ARGUMENT', 'delIndicator 需要数字 id');
    if (args.dryRun) {
      return JSON.stringify({ ok: true, dryRun: true, wouldPost: 'upgrade/customIndicator/script/del', body: { id: id } });
    }
    var ax = G.$axios().instance;
    var resp;
    try {
      resp = await ax.post('upgrade/customIndicator/script/del', { id: id });
    } catch (e) {
      return JSON.stringify({ ok: false, id: id, error: String((e && e.message) || e), httpStatus: e && e.response ? e.response.status : null });
    }
    var d = resp && resp.data;
    return JSON.stringify({
      ok: !!(d && d.success === true),
      id: id,
      httpStatus: resp && resp.status,
      success: d ? d.success : null,
      status: d ? d.status : null,
      message: d ? d.message : null
    });
  };

  // ---------- DOM ----------
  function pathOf(el) {
    if (!el || el.nodeType !== 1) return null;
    var parts = [];
    var cur = el;
    var depth = 0;
    while (cur && cur.nodeType === 1 && depth < 8) {
      var s = cur.tagName.toLowerCase();
      if (cur.id) { s += '#' + cur.id; parts.unshift(s); break; }
      var cls = typeof cur.className === 'string' ? cur.className.trim().split(/\s+/).filter(Boolean) : [];
      if (cls.length) s += '.' + cls.slice(0, 2).join('.');
      var attrs = [];
      for (var i = 0; i < (cur.attributes ? cur.attributes.length : 0); i += 1) {
        var a = cur.attributes[i];
        if (/^(data-testid|data-pair|data-period-key|data-current|data-indic-key|data-guide-area|placeholder|aria-label|role)$/.test(a.name)) {
          attrs.push('[' + a.name + '="' + String(a.value).slice(0, 40) + '"]');
        }
      }
      parts.unshift(s + attrs.join(''));
      cur = cur.parentElement;
      depth += 1;
    }
    return parts.join(' > ');
  }

  G.dom = function (args) {
    args = args || {};
    var limit = Math.max(1, Math.min(200, Number(args.limit || 40)));
    var out = {
      title: document.title, hash: location.hash,
      counts: {
        canvas: document.querySelectorAll('canvas').length,
        buttons: document.querySelectorAll('button').length,
        testids: document.querySelectorAll('[data-testid]').length
      },
      periodButtons: [], symbolTabs: [], indicatorItems: [], dialogs: [], visibleInputs: []
    };
    var wrap = document.querySelector('#ChartToolsBar__period_panel_wrap');
    if (wrap) {
      var items = wrap.querySelectorAll('[data-period-key]');
      for (var i = 0; i < items.length && i < limit; i += 1) {
        out.periodButtons.push({
          period: items[i].getAttribute('data-period-key'),
          text: (items[i].innerText || '').trim().slice(0, 12),
          selector: '#ChartToolsBar__period_panel_wrap [data-period-key="' + items[i].getAttribute('data-period-key') + '"]'
        });
      }
    }
    var tabs = document.querySelectorAll('[data-testid="chart-trading-pair-tab"]');
    for (var t = 0; t < tabs.length && t < limit; t += 1) {
      out.symbolTabs.push({
        pair: tabs[t].getAttribute('data-pair'),
        current: tabs[t].getAttribute('data-current') === 'true',
        selector: '[data-testid="chart-trading-pair-tab"][data-pair="' + tabs[t].getAttribute('data-pair') + '"]'
      });
    }
    var inds = document.querySelectorAll('[data-indic-key]');
    for (var n = 0; n < inds.length && n < limit; n += 1) {
      var r = inds[n].getBoundingClientRect();
      out.indicatorItems.push({
        key: inds[n].getAttribute('data-indic-key'),
        text: (inds[n].innerText || '').replace(/\s+/g, ' ').trim().slice(0, 24),
        visible: r.width > 0 && r.height > 0,
        selector: '[data-indic-key="' + inds[n].getAttribute('data-indic-key') + '"]'
      });
    }
    var inputs = document.querySelectorAll('input,textarea');
    for (var k = 0; k < inputs.length; k += 1) {
      var ri = inputs[k].getBoundingClientRect();
      if (ri.width > 0 && ri.height > 0 && out.visibleInputs.length < 20) {
        out.visibleInputs.push({ path: pathOf(inputs[k]), placeholder: inputs[k].getAttribute('placeholder'), type: inputs[k].type || null });
      }
    }
    var dlg = document.querySelectorAll('[role="dialog"],[role="alertdialog"],[class*="dialog"],[class*="modal"]');
    for (var g = 0; g < dlg.length; g += 1) {
      var rd = dlg[g].getBoundingClientRect();
      if (rd.width > 80 && rd.height > 40 && out.dialogs.length < 10) {
        out.dialogs.push({ path: pathOf(dlg[g]), text: (dlg[g].innerText || '').replace(/\s+/g, ' ').slice(0, 120), rect: { x: Math.round(rd.x), y: Math.round(rd.y), w: Math.round(rd.width), h: Math.round(rd.height) } });
      }
    }
    out.keySelectors = {
      chartTabBar: '#chart_tab',
      periodPanel: '#ChartToolsBar__period_panel_wrap',
      chartToolsBar: '#chart_toolsbar',
      chartGrid: '#ChartSheet__chart_grid_wrap',
      customIndicatorsButton: '[data-testid="kline-customIndicators"]'
    };
    return JSON.stringify(out);
  };

  G.click = function (args) {
    args = args || {};
    var el = null;
    var how = null;
    if (args.selector) {
      el = document.querySelector(args.selector);
      how = 'selector';
    }
    if (!el && args.text) {
      var wanted = String(args.text).trim();
      var all = document.querySelectorAll('button,a,[role="button"],li,div,span');
      for (var i = 0; i < all.length; i += 1) {
        if ((all[i].innerText || '').trim() === wanted) { el = all[i]; how = 'text'; break; }
      }
    }
    if (!el) return JSON.stringify({ ok: false, error: '找不到目标元素', selector: args.selector || null, text: args.text || null });
    var r = el.getBoundingClientRect();
    var cx = r.x + r.width / 2;
    var cy = r.y + r.height / 2;
    var types = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (var j = 0; j < types.length; j += 1) {
      try { el.dispatchEvent(new MouseEvent(types[j], { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy })); } catch (e) { /* ignore */ }
    }
    try { el.click(); } catch (e) { /* ignore */ }
    return JSON.stringify({
      ok: true, how: how, text: (el.innerText || '').trim().slice(0, 40),
      path: pathOf(el), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    });
  };

  // ---------- console 捕获（关键：CDP 拿不到页面 console，必须自己 hook） ----------
  // 实测 2.16.27 / Electron 43 / Chrome 150：Runtime.consoleAPICalled **从不触发**，
  // Log.entryAdded 只带 Chromium 内部诊断（cookie/网络/干预），页面自己的
  // console.log/warn/error 一条都收不到（用两个独立 WS 客户端复核过）。
  // 所以这里在页面里替换 console.* 做环形缓冲，工具层读增量。
  G.installConsoleHook = function () {
    if (G._consoleHooked) return true;
    G._consoleHooked = true;
    G.consoleBuffer = [];
    var levels = ['log', 'info', 'warn', 'error', 'debug'];
    var toText = function (v) {
      if (typeof v === 'string') return v;
      try {
        var s = JSON.stringify(v);
        return s === undefined ? String(v) : s;
      } catch (e) {
        return String(v);
      }
    };
    for (var i = 0; i < levels.length; i += 1) {
      (function (level) {
        var orig = console[level];
        if (typeof orig !== 'function') return;
        console[level] = function () {
          try {
            var parts = [];
            for (var k = 0; k < arguments.length; k += 1) parts.push(toText(arguments[k]));
            G.consoleBuffer.push({ ts: Date.now(), type: level, text: parts.join(' ').slice(0, 500) });
            if (G.consoleBuffer.length > 500) G.consoleBuffer.splice(0, G.consoleBuffer.length - 500);
          } catch (e) {
            /* 观测不能影响业务 */
          }
          try {
            return orig.apply(console, arguments);
          } catch (e) {
            /* ignore */
          }
        };
      })(levels[i]);
    }
    return true;
  };

  G.consoleMark = function () {
    G.installConsoleHook();
    return JSON.stringify({ size: (G.consoleBuffer || []).length });
  };

  G.consoleRead = function (args) {
    args = args || {};
    G.installConsoleHook();
    var from = Math.max(0, Number(args.from || 0));
    var buf = G.consoleBuffer || [];
    return JSON.stringify({ hooked: true, size: buf.length, from: from, lines: buf.slice(from) });
  };

  G.installInfo = function () {
    return JSON.stringify({
      ok: true, kernelVersion: VERSION, chunkGlobal: G._chunkGlobal || null,
      moduleCount: G._req ? G.$moduleCount() : null,
      axiosModuleId: G._axios ? G._axios.id : null,
      storeModuleId: G._store ? G._store.id + (G._store.path || '') : null,
      hash: location.hash, title: document.title
    });
  };

  G.touch();
  return G.installInfo();
})()
`.replace('__KERNEL_VERSION__', KERNEL_VERSION)

/**
 * 确保页面内核已安装（幂等），返回安装信息。
 *
 * @param {object} client
 * @returns {Promise<{ok:boolean, kernelVersion:string, chunkGlobal:string|null, moduleCount:number|null,
 *   axiosModuleId:string|null, storeModuleId:string|null, hash:string, title:string}>}
 */
export async function ensureKernel(client) {
  const raw = await client.evaluate(PAGE_KERNEL, { timeoutMs: 30000 })
  let info
  try {
    info = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    info = { ok: false, raw }
  }
  if (!info || info.ok !== true) {
    const err = new CdpError(`页面内核安装失败：${JSON.stringify(info)?.slice(0, 400)}`, { code: 'KERNEL_INSTALL_FAILED' })
    throw err
  }
  return info
}

/** 在页面里执行一段表达式（先确保内核已装）。 */
export async function evalInPage(client, expression, options = {}) {
  await ensureKernel(client)
  return client.evaluate(expression, { timeoutMs: 30000, ...options })
}

/** 调用内核方法并把 JSON 结果解析回对象。 */
async function callKernel(client, method, args) {
  await ensureKernel(client)
  const expr = args === undefined ? `window.__aicoin_app.${method}()` : `window.__aicoin_app.${method}(${JSON.stringify(args)})`
  const raw = await client.evaluate(expr, { timeoutMs: 60000 })
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/* ================================================================== *
 * 4. 便捷包装：既能收 client，也能收 {port,target} 自己连
 * ================================================================== */

function isClientLike(x) {
  return !!x && typeof x.evaluate === 'function' && typeof x.send === 'function'
}

/**
 * 统一入口：第一个参数可以是已连接的 CdpClient，也可以是 `{port,target}`（自己连、用完关）。
 * 返回值统一补上 `target`（实际附加的窗口）与 `via`。
 */
async function withClient(first, second, fn) {
  if (isClientLike(first)) {
    const result = await fn(first, second)
    return withTargetMeta(result, first.target ?? null, 'client')
  }
  const options = first && typeof first === 'object' ? first : {}
  const client = await attach({ port: options.port ?? DEFAULT_PORT, target: options.target ?? null, timeoutMs: options.timeoutMs ?? 8000 })
  try {
    const result = await fn(client, second)
    return withTargetMeta(result, client.target ?? null, 'attached')
  } finally {
    try {
      await client.close()
    } catch {
      /* ignore */
    }
  }
}

function withTargetMeta(result, target, via) {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return { ...result, target: describeTarget(target), via }
  }
  return result
}

/* ================================================================== *
 * 5. 对外 API
 * ================================================================== */

/**
 * 幂等地拿到 `__webpack_require__`，返回 chunk 全局名与已注册模块数。
 *
 * @param {object|{port?:number,target?:any}} client
 */
export async function bootstrap(client) {
  return withClient(client, undefined, async (c) => {
    const info = await ensureKernel(c)
    // 全新安装时 require 还没被触发过 ⇒ 主动触发一次，把 chunk 全局名/模块数带回来
    if (info.moduleCount == null) {
      try {
        const raw = await c.evaluate('(function(){ var G = window.__aicoin_app; G.$req(); return G.installInfo(); })()', { timeoutMs: 30000 })
        Object.assign(info, typeof raw === 'string' ? JSON.parse(raw) : raw)
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err), kernelVersion: info.kernelVersion, hash: info.hash, title: info.title }
      }
    }
    return {
      ok: true,
      chunkGlobal: info.chunkGlobal ?? null,
      moduleCount: info.moduleCount ?? null,
      kernelVersion: info.kernelVersion,
      hash: info.hash,
      title: info.title,
      axiosModuleId: info.axiosModuleId ?? null,
      storeModuleId: info.storeModuleId ?? null,
      note: 'chunkGlobal 是 webpack chunk 数组的全局名（2.16.27 实测为 webpackChunkaicoin）；module id 会随窗口/版本变化，不要写死',
    }
  })
}

/**
 * 定位 client 自己正在用的 axios 实例（带 3 个请求拦截器 + 3 个响应拦截器，
 * 自动 token、自动 AES 加解密）。
 *
 * 返回的模块 id 只是**本次观测值**，不要当常量用。
 */
export async function findAxios(client) {
  return withClient(client, undefined, async (c) => {
    await ensureKernel(c)
    const info = await callKernel(c, 'axiosInfo')
    return { ok: true, ...info, method: 'scan module source (no exec) -> require -> shape check' }
  })
}

/** 会写用户账号的接口模式（命中即拒绝，除非显式 allowWrite）。 */
export const WRITE_PATH_PATTERNS = Object.freeze([
  /customIndicator\/script\/save/i,
  /customIndicator\/script\/(del|delete)/i,
  /customIndicator\/trade\/del/i,
  /indicator\/gen/i,
  /indicator\/execBacktestTask/i,
  /indicator\/execScreenerTask/i,
  /indicator\/deleteIndicatorTradingConfig/i,
  /indicator\/updateSignalStrategyConfig/i,
  /indicator\/updateSignalStrategyStatus/i,
  /indicator\/addIndicatorStatus/i,
  /screener\/execTask/i,
])

/** 判断一个 API path 是否属于「会写用户账号」的接口。 */
export function isWritePath(path) {
  const p = String(path ?? '')
  return WRITE_PATH_PATTERNS.some((re) => re.test(p))
}

/**
 * 业务码解码。AiCoin 的业务错误是 **HTTP 200 + `{success:false,status:<码>}`**，
 * 所以调用方必须看 `success` 而不是 HTTP 状态。
 */
export function decodeBusinessStatus(status, message) {
  const s = Number(status)
  const m = String(message ?? '')
  if (s === 403 || s === 401 || /login required|登录信息已过期|未登录/i.test(m)) {
    return '未登录或登录已过期（业务码 403/401，message="login required"）——请先在 AiCoin 客户端里登录'
  }
  if (s === 304) return '参数无效（业务码 304）——常见于用 skipCrypt 发出未加密的明文请求'
  if (s === 10510) return '指标已被删除（业务码 10510）'
  if (s === 40003) return '服务端要求切换线路后重试（业务码 40003，客户端会自动换 baseURL 重试）'
  return null
}

/**
 * 在客户端上下文里发一个请求（走 client 自己的 axios ⇒ 自动带 token、自动加解密）。
 *
 * @param {object|{port?:number,target?:any}} client
 * @param {{
 *   method?: 'post'|'get', path: string, data?: any, params?: any,
 *   includeData?: boolean, maxChars?: number, timeout?: number,
 *   skipCrypt?: boolean, skipAutoToken?: boolean, allowWrite?: boolean,
 * }} opts
 */
export async function api(client, opts) {
  const options = isClientLike(client) ? opts : client
  if (!options || !options.path) {
    throw new CdpError('api 需要 path 参数，例如 "upgrade/customIndicator/script/list"', { code: 'BAD_ARGUMENT' })
  }
  if (isWritePath(options.path) && options.allowWrite !== true) {
    throw new CdpError(
      `拒绝调用写接口：${options.path}。这类接口会在用户账号里新建/修改/删除数据；` +
        `如确需调用必须显式传 allowWrite: true（工具层要求 confirm: true）。`,
      { code: 'WRITE_BLOCKED' },
    )
  }
  return withClient(client, options, async (c, o) => {
    await ensureKernel(c)
    const payload = {
      method: o.method ?? 'post',
      path: o.path,
      data: o.data,
      params: o.params,
      includeData: o.includeData === true,
      maxChars: o.maxChars,
      timeout: o.timeout,
      skipCrypt: o.skipCrypt === true,
      skipAutoToken: o.skipAutoToken === true,
    }
    const res = await callKernel(c, 'api', payload)
    if (res && typeof res === 'object') {
      const hint = res.success === false ? decodeBusinessStatus(res.status, res.message) : null
      res.hint = hint
    }
    return res
  })
}

/** 当前窗口的登录态（token 是否存在、uid、昵称、VIP 能力等）。 */
export async function loginState(client) {
  return withClient(client, undefined, async (c) => {
    await ensureKernel(c)
    const st = await callKernel(c, 'loginState')
    return { ok: true, ...st }
  })
}

/**
 * AiCoin 2.16.27 的 hash 路由表（从渲染层路由模块源码静态提取）。
 * 只作为拼路由的参考：真正跳转只需要在页面里 `location.hash = '#/xxx'`。
 */
export const ROUTE_TABLE = Object.freeze({
  main: [
    '/login', '/main', '/main/homepage', '/main/exchange', '/main/data', '/main/data/crypto-reserves',
    '/main/data/hyperliquid', '/main/quant', '/main/asset', '/main/auth', '/main/news', '/main/info',
    '/main/external', '/main/dex', '/main/bots', '/main/trading-bot', '/main/copy-trade',
    '/main/trading-bot/quant', '/main/strategy-square', '/main/trading-bot/follow', '/main/beginner',
    '/main/oauth', '/main/external/wallet',
  ],
  windows: [
    '/version', '/notice', '/chat-notice', '/msg-notice', '/float', '/chat', '/community', '/screenshot',
    '/recordBtn', '/record', '/preference', '/flash', '/proxy', '/security', '/cache', '/contact', '/network',
    '/depth', '/flash-share', '/calendar', '/info-detail', '/info-author', '/following', '/twitter-author',
    '/flash-detail', '/large-order', '/agg-trade', '/estimated-liq', '/function-library', '/script-window',
    '/screener-window', '/hl-smart-money-window', '/order-window', '/ai-analysis', '/vip-open',
    '/product-chat', '/ai-script-copilot', '/add-account', '/asset-sync', '/contract-radar-detail',
    '/chat/private', '/chat/private/min',
  ],
  chart: [
    '/chart/common', '/chart/newCommon', '/chart/history', '/chart/spread', '/chart/template',
    '/chart/multiline', '/chart/proBacktest', '/chart-share/create', '/chart-share/details',
    '/chart-share/panel', '/script-share/create', '/script-share/details', '/script-share/panel',
  ],
})

/** 当前窗口的 hash 路由 + 路由表（供 agent 拼路由）。 */
export async function routes(client) {
  return withClient(client, undefined, async (c) => {
    await ensureKernel(c)
    const info = JSON.parse(await c.evaluate('JSON.stringify({ hash: location.hash, href: location.href })'))
    return {
      ok: true,
      current: info.hash,
      href: info.href,
      navigable: true,
      howToNavigate: '在页面里执行 location.hash = "#/xxx" 即可（自研 hash 路由，2.16.27 实测生效）',
      table: ROUTE_TABLE,
      source: 'AiCoin 2.16.27 渲染层路由表（模块源码静态提取）；版本升级后可能漂移',
    }
  })
}

/** period(秒) → 人类可读标签。 */
export function periodToLabel(period) {
  const n = Number(period)
  if (!Number.isFinite(n) || n <= 0) return null
  const table = [
    [60, '1分'], [180, '3分'], [300, '5分'], [600, '10分'], [900, '15分'], [1800, '30分'],
    [3600, '1时'], [7200, '2时'], [14400, '4时'], [21600, '6时'], [43200, '12时'],
    [86400, '1日'], [259200, '3日'], [604800, '1周'], [2592000, '1月'], [7776000, '季K'],
  ]
  const hit = table.find(([sec]) => sec === n)
  return hit ? hit[1] : `${n}s`
}

/**
 * timeframe 入参归一化：支持秒数、`'15m'`/`'1h'`/`'1d'`/`'1w'`、中文标签（`'15分'`/`'1时'`/`'1日'`）。
 *
 * @param {string|number} input
 * @returns {number|null} 秒
 */
export function normalizeTimeframe(input) {
  if (input === undefined || input === null || input === '') return null
  if (typeof input === 'number' && Number.isFinite(input) && input > 0) return Math.trunc(input)
  const raw = String(input).trim()
  if (/^\d+$/.test(raw)) return Number(raw)
  const lower = raw.toLowerCase()
  const m = /^(\d+)\s*(s|m|h|d|w|mo)$/.exec(lower)
  if (m) {
    const mult = { s: 1, m: 60, h: 3600, d: 86400, w: 604800, mo: 2592000 }[m[2]]
    if (mult) return Number(m[1]) * mult
  }
  const zh = {
    分时: 60, '1分': 60, '3分': 180, '5分': 300, '10分': 600, '15分': 900, '30分': 1800,
    '1时': 3600, '2时': 7200, '4时': 14400, '6时': 21600, '12时': 43200,
    '1日': 86400, '3日': 259200, '1周': 604800, '1月': 2592000, 季K: 7776000,
  }
  if (zh[raw]) return zh[raw]
  return null
}

/**
 * symbol 入参归一化。AiCoin 图表的 symbol 形如 `btcswapusdt:binance`（永续）/
 * `btcusdt:binance`（现货），格式 = `{base}{swap?}{quote}:{exchange}`。
 *
 * 支持的人类写法：
 *  - `btcswapusdt:binance`（已是标准形式，原样归一化）
 *  - `BTCUSDT` / `BTC/USDT` → 现货 `btcusdt:binance`
 *  - `BTCUSDT永续` / `BTC/USDT永续` / `BTCUSDT-PERP` → `btcswapusdt:binance`
 *  - `BTCUSDC` → `btcusdc:binance`；`BTC/USDC永续` → `btcswapusdc:binance`
 *
 * @param {string} input
 * @param {{type?: 'tp'|'sp', exchange?: string}} [defaults]
 * @returns {{key:string, type:string, base:string, quote:string, exchange:string, kind:'swap'|'spot'}}
 */
export function normalizeSymbol(input, defaults = {}) {
  const exchange = String(defaults.exchange || 'binance').toLowerCase()
  const raw = String(input ?? '').trim()
  if (!raw) throw new CdpError('symbol 不能为空', { code: 'BAD_ARGUMENT' })

  if (raw.includes(':')) {
    const [keyPart, exPart] = raw.split(':')
    const keyBody = keyPart.trim().toLowerCase()
    const ex = (exPart || exchange).trim().toLowerCase()
    const isSwap = keyBody.includes('swap')
    const quoteMatch = /(swapusdt|swapusdc|usdt|usdc)$/.exec(keyBody)
    const quote = quoteMatch ? (quoteMatch[1].includes('usdc') ? 'USDC' : 'USDT') : 'USDT'
    const base = keyBody.replace(/(swap)?(usdt|usdc)$/, '')
    return {
      key: `${keyBody}:${ex}`,
      type: defaults.type ?? (isSwap ? 'tp' : 'sp'),
      base,
      quote,
      exchange: ex,
      kind: isSwap ? 'swap' : 'spot',
    }
  }

  const perp = /永续|合约|perp|swap/i.test(raw) || defaults.type === 'tp'
  const compact = raw.replace(/永续|合约|perp|swap/gi, '').replace(/[\s\-_/]/g, '').toUpperCase()
  const m = /^([A-Z0-9]+?)(USDT|USDC)$/.exec(compact)
  if (!m) {
    throw new CdpError(
      `无法把 symbol「${raw}」归一化成 AiCoin 的 key。请直接给标准形式，例如 ` +
        `'btcswapusdt:binance'（BTC 永续）或 'btcusdt:binance'（BTC 现货）。`,
      { code: 'BAD_SYMBOL' },
    )
  }
  const base = m[1].toLowerCase()
  const quote = m[2]
  const contract = perp ? `swap${quote.toLowerCase()}` : quote.toLowerCase()
  return { key: `${base}${contract}:${exchange}`, type: perp ? 'tp' : 'sp', base, quote, exchange, kind: perp ? 'swap' : 'spot' }
}

/** 当前 K 线窗口的 symbol/period/type/标题等状态。 */
export async function chartState(client) {
  return withClient(client, undefined, async (c) => {
    await ensureKernel(c)
    const st = await callKernel(c, 'chart')
    return { ok: true, ...st, timeframeLabel: periodToLabel(st.period) }
  })
}

/**
 * 程序化切换 K 线窗口的 symbol / timeframe（redux dispatch）。
 *
 * 机制（2.16.27 实测生效）：dispatch `chart/setCurrentChartOptions`
 * + `chart/setCurrentPeriod` + `chart/setCurrentCoinMeta`，图表会真的重绘
 * （窗口标题跟着新标的的实时价变化，例：切到 BTC 永续后标题变成
 * "81468.1 BTC/USDT永续 币安USDT永续"）。
 *
 * @param {object|{port?:number,target?:any}} client
 * @param {{symbol?: string, timeframe?: string|number, period?: number, type?: 'tp'|'sp',
 *   exchange?: string, verify?: boolean, waitMs?: number}} args
 */
export async function setChart(client, args = {}) {
  const wants = args.symbol !== undefined || args.timeframe !== undefined || args.period !== undefined || args.type !== undefined
  if (!wants) {
    throw new CdpError('setChart 需要至少一个参数：symbol / timeframe（或 period）', { code: 'BAD_ARGUMENT' })
  }
  return withClient(client, args, async (c, a) => {
    await ensureKernel(c)
    const state = await callKernel(c, 'chart')
    const symbolInfo = a.symbol
      ? normalizeSymbol(a.symbol, {
          type: a.type,
          exchange: a.exchange || (state.symbol ? String(state.symbol).split(':')[1] : undefined),
        })
      : null
    const period =
      a.timeframe !== undefined ? normalizeTimeframe(a.timeframe) : a.period !== undefined ? normalizeTimeframe(a.period) : null
    if (a.timeframe !== undefined && !period) {
      throw new CdpError(
        `无法识别的 timeframe：${JSON.stringify(a.timeframe)}（支持秒数、'15m'/'1h'/'1d'、'15分'/'1时'/'1日'）`,
        { code: 'BAD_TIMEFRAME' },
      )
    }

    const dispatchArgs = {}
    if (symbolInfo) {
      dispatchArgs.symbol = symbolInfo.key
      dispatchArgs.type = symbolInfo.type
    }
    if (period) dispatchArgs.period = period

    let result
    try {
      result = await callKernel(c, 'setChart', dispatchArgs)
    } catch (err) {
      // 缓存失效（窗口重载 / store 变了）：清缓存重扫一次
      await c.evaluate('window.__aicoin_app._store = null; window.__aicoin_app._actions = null; true')
      result = await callKernel(c, 'setChart', dispatchArgs)
    }

    let verified = false
    let after = result.after ?? result.before
    if (a.verify !== false) {
      const waitMs = Math.max(300, Math.min(8000, Number(a.waitMs ?? 1600)))
      await new Promise((r) => setTimeout(r, waitMs))
      after = await callKernel(c, 'chart')
      const symbolOk = !symbolInfo || String(after.symbol || '').toLowerCase() === symbolInfo.key
      const periodOk = !period || Number(after.period) === Number(period)
      verified = symbolOk && periodOk
    }

    return {
      ok: true,
      verified,
      before: result.before,
      after,
      symbol: symbolInfo,
      timeframe: period ? { period, label: periodToLabel(period) } : null,
      steps: result.steps ?? [],
      note: verified
        ? '已确认图表状态切换（store 值 + 窗口标题）；如需视觉确认可再调 aicoin_app_snapshot'
        : 'dispatch 已执行但校验未通过（可能命中了另一个窗口，或该标的在当前数据源不存在）',
    }
  })
}

/**
 * 页面 DOM 摘要：标题/hash、图表工具条、周期按钮、交易对 tab、指标项、可见输入框、弹窗。
 * 用来给 agent「自己在哪个页面、能点什么」。
 */
export async function domSummary(client, args = {}) {
  return withClient(client, args, async (c, a) => {
    await ensureKernel(c)
    const dom = await callKernel(c, 'dom', a)
    return { ok: true, ...dom }
  })
}

/**
 * 点页面元素（先 selector，其次按可见文本精确匹配）。
 * 派发 pointerdown/mousedown/pointerup/mouseup/click 全序列 + `el.click()`，
 * AiCoin 的 React 组件两种都能吃掉（实测周期按钮点击生效）。
 */
export async function click(client, args = {}) {
  const options = isClientLike(client) ? args : client
  if (!options || (!options.selector && !options.text)) {
    throw new CdpError('click 需要 selector 或 text 参数', { code: 'BAD_ARGUMENT' })
  }
  return withClient(client, options, async (c, o) => {
    await ensureKernel(c)
    const res = await callKernel(c, 'click', { selector: o.selector, text: o.text })
    if (res && res.ok && o.settleMs !== 0) {
      await new Promise((r) => setTimeout(r, Math.max(0, Math.min(5000, Number(o.settleMs ?? 400)))))
    }
    return { ...res, clicked: res?.ok === true }
  })
}

/**
 * 抓一段页面 console（含未捕获异常）。默认 1200ms。
 *
 * 实现要点（踩过的坑）：**CDP 的 `Runtime.consoleAPICalled` 在 AiCoin 2.16.27 /
 * Electron 43 / Chrome 150 上从不触发**，`Log.entryAdded` 也只带 Chromium 内部
 * 诊断（cookie / 网络 / intervention），页面 `console.log/warn/error` 一条都收不到。
 * 所以这里改走「页面内 hook console.* + 环形缓冲 + 读增量」，同时仍然订阅 CDP 的
 * `exception` 事件（`Runtime.exceptionThrown` 是**能用**的）。
 *
 * @param {object|{port?:number,target?:any}} client
 * @param {{ms?: number, types?: string[], trigger?: string}} [args]
 *   `trigger` 是订阅期间顺手在页面里执行的表达式（例如点一次 UI 再收日志）
 */
export async function consoleCapture(client, args = {}) {
  return withClient(client, args, async (c, a) => {
    const ms = Math.max(100, Math.min(15000, Number(a.ms ?? 1200)))
    const wanted = Array.isArray(a.types) && a.types.length ? new Set(a.types) : null
    const exceptions = []
    const offException = c.on('exception', (e) => {
      if (exceptions.length >= 50) return
      exceptions.push({ text: String(e.text ?? '').slice(0, 500), url: e.url ?? null, line: e.line ?? null })
    })
    let triggerResult = null
    try {
      await ensureKernel(c)
      const mark = JSON.parse(await c.evaluate('window.__aicoin_app.consoleMark()', { timeoutMs: 15000 }))
      if (typeof a.trigger === 'string' && a.trigger.trim()) {
        try {
          triggerResult = await c.evaluate(a.trigger, { timeoutMs: 15000 })
        } catch (err) {
          triggerResult = { error: String(err?.message ?? err) }
        }
      }
      await new Promise((r) => setTimeout(r, ms))
      const read = JSON.parse(await c.evaluate(`window.__aicoin_app.consoleRead(${JSON.stringify({ from: mark.size })})`, { timeoutMs: 15000 }))
      let lines = Array.isArray(read?.lines) ? read.lines : []
      if (wanted) lines = lines.filter((l) => wanted.has(l.type))
      return {
        ok: true,
        windowMs: ms,
        count: lines.length,
        lines: lines.slice(0, 200),
        exceptions,
        triggerResult,
        how: 'in-page console.* hook + ring buffer（CDP 的 Runtime.consoleAPICalled 在本客户端不触发）',
        totalBuffered: read?.size ?? null,
      }
    } finally {
      try {
        offException?.()
      } catch {
        /* ignore */
      }
    }
  })
}

/**
 * 页面截图（裸 base64）。注意：非主窗口会抛 `SCREENSHOT_TIMEOUT`（Chromium 只给
 * 正在合成帧的窗口出图），所以截图工具默认 target=main。
 */
export async function screenshotBase64(client, options = {}) {
  return withClient(client, options, async (c, o) => {
    const b64 = await c.screenshot({ format: o.format ?? 'png', timeoutMs: o.timeoutMs ?? 20000 })
    return { ok: true, format: o.format ?? 'png', base64Length: b64.length, base64: b64 }
  })
}

/** 指标列表（只读）。默认不含源码，避免 191 条 AiScript 撑爆上下文。 */
export async function indicatorsList(client, args = {}) {
  return withClient(client, args, async (c, a) => {
    await ensureKernel(c)
    const res = await callKernel(c, 'indicators', {
      includeSource: a.includeSource === true,
      id: a.id,
      name: a.name,
      position: a.position,
      offset: a.offset,
      limit: a.limit,
    })
    if (res && typeof res === 'object' && res.ok === false) {
      res.hint = decodeBusinessStatus(res.status, res.message)
    }
    return res
  })
}

/** 单个指标详情（含完整 AiScript 源码 `value`）。只读。 */
export async function indicatorGet(client, args = {}) {
  const options = isClientLike(client) ? args : client
  if (!options || options.id === undefined || options.id === null || options.id === '') {
    throw new CdpError('indicatorGet 需要 id', { code: 'BAD_ARGUMENT' })
  }
  return withClient(client, options, async (c, a) => {
    await ensureKernel(c)
    const res = await callKernel(c, 'indicator', { id: a.id })
    if (res && typeof res === 'object' && res.ok === false) res.hint = decodeBusinessStatus(res.status, res.message)
    return res
  })
}

/**
 * 保存指标（**会写用户账号**）。只负责调用，不负责确认；
 * 工具层必须先拿到用户的 `confirm: true` 才允许走到这里。
 *
 *  - 没有 `id` → 新建（服务端会分配新 id）
 *  - 有 `id` → 覆盖更新该指标
 *
 * @param {object|{port?:number,target?:any}} client
 * @param {{id?: number, name: string, value: string, version?: string, buildType?: string,
 *   position?: 'main'|'sub', visualCode?: string, dryRun?: boolean}} args
 */
export async function indicatorSave(client, args = {}) {
  const options = isClientLike(client) ? args : client
  if (!options || (!options.dryRun && (!options.name || typeof options.value !== 'string'))) {
    throw new CdpError('indicatorSave 需要 name 与 value（或 dryRun: true 只验证参数拼装）', { code: 'BAD_ARGUMENT' })
  }
  return withClient(client, options, async (c, a) => {
    await ensureKernel(c)
    const res = await callKernel(c, 'saveIndicator', {
      dryRun: a.dryRun === true,
      id: a.id,
      name: a.name,
      value: a.value,
      version: a.version,
      buildType: a.buildType,
      position: a.position,
      visualCode: a.visualCode,
    })
    if (res && typeof res === 'object' && res.ok === false) res.hint = decodeBusinessStatus(res.status, res.message)
    return res
  })
}

/**
 * 删除指标（**会写用户账号**）。只负责调用，不负责确认。
 *
 * 用途：①清理 `verify 模式` 留下的临时探针指标；②清掉编译失败后残留的草稿。
 *
 * @param {object|{port?:number,target?:any}} client
 * @param {{id: number, dryRun?: boolean}} args
 */
export async function indicatorDelete(client, args = {}) {
  const options = isClientLike(client) ? args : client
  const id = Number(options?.id)
  if (!Number.isFinite(id) || id <= 0) {
    throw new CdpError('indicatorDelete 需要数字 id', { code: 'BAD_ARGUMENT' })
  }
  return withClient(client, options, async (c, a) => {
    await ensureKernel(c)
    const res = await callKernel(c, 'delIndicator', { id, dryRun: a.dryRun === true })
    if (res && typeof res === 'object' && res.ok === false) res.hint = decodeBusinessStatus(res.status, res.message)
    return res
  })
}

export default {
  KERNEL_VERSION,
  DEFAULT_PORT,
  MAIN_WINDOW_URL_HINT,
  TARGET_ALIASES,
  ROUTE_TABLE,
  WRITE_PATH_PATTERNS,
  CdpClient,
  CdpError,
  attach,
  openTarget,
  listWindows,
  resolveTarget,
  describeTarget,
  ensureKernel,
  evalInPage,
  bootstrap,
  findAxios,
  api,
  loginState,
  routes,
  chartState,
  setChart,
  domSummary,
  click,
  consoleCapture,
  screenshotBase64,
  indicatorsList,
  indicatorGet,
  indicatorSave,
  indicatorDelete,
  normalizeSymbol,
  normalizeTimeframe,
  periodToLabel,
  isWritePath,
  decodeBusinessStatus,
}
