/**
 * tools/system.mjs — 通用系统工具：状态 / 目标列表 / 页面内 eval / 截图。
 *
 * 工具名统一用 `aicoin_app_` 前缀（本机 DSH 里还装了 kk_aicoin_codingAI 插件，
 * 它已注册 `aicoin_status`、`aicoin_eval` 等同名工具，我们必须加前缀区分）。
 *
 *   aicoin_app_status      端口/版本/进程/全部 page 目标/URL hash/登录启发式判定（只读）
 *   aicoin_app_targets     /json/list 全部目标（含每个 page 的 index，供 target 参数用）
 *   aicoin_app_eval        在页面执行 JS 表达式（带超时、异常回传、JSON 化）
 *   aicoin_app_screenshot  Page.captureScreenshot 存 PNG/JPEG/WebP 到 shots/，只回长度不回整段 base64
 *
 * ## target 选择器
 * `/json/list` 上同时存在多个 page 目标（实测有 #/main/exchange、#/chat、#/asset-sync、
 * #/notice），所以 eval / screenshot / status 都支持可选 `target` 参数：
 *   - 数字（或数字字符串）：page 目标数组下标，顺序与 `aicoin_app_targets` 的 pages[].index 一致；
 *   - 字符串：按 url 子串匹配，其次 title 子串，再次 target id；
 *   - 省略：优先选 url 含 `#/main` 的窗口（K 线主窗），没有则取第一个 page。
 *
 * ## 依赖
 * CDP 连接一律走框架的 ctx（createContext 提供懒连接）：
 *   ctx.discover({port}) / ctx.attach({port?, target?}) / ctx.client / ctx.close()
 * 进程信息来自 ../launcher.mjs。ctx 不可用时（例如单元测试里只传了裸对象）会退化为
 * launcher 的 HTTP 探测，保证工具本身不炸。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_PORT,
  findAppPath,
  getLiveLaunchRecord,
  isRunning,
  listTargets,
} from '../launcher.mjs';

/** 本文件所在目录（src/tools）。 */
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根目录（aicoin-mcp）。 */
const REPO_ROOT = path.resolve(SELF_DIR, '..', '..');
/** 默认截图目录：aicoin-mcp/shots。 */
export const DEFAULT_SHOTS_DIR = path.join(REPO_ROOT, 'shots');

/** target 选择失败（带候选清单，方便模型自己修正）。 */
class TargetSelectionError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'TargetSelectionError';
    this.code = 'TARGET_SELECTION';
    this.candidates = info.candidates ?? [];
  }
}

/* ------------------------------------------------------------------ *
 * 参数与端口
 * ------------------------------------------------------------------ */

function logOf(ctx) {
  return typeof ctx?.log === 'function' ? ctx.log : null;
}

function resolvePort(args, ctx) {
  for (const raw of [args?.port, ctx?.port, DEFAULT_PORT]) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  }
  return DEFAULT_PORT;
}

const PORT_SCHEMA = {
  type: 'integer',
  minimum: 1,
  maximum: 65535,
  description: 'CDP 调试端口，默认取服务器配置（9222）。 / CDP debug port; defaults to the configured port (9222).',
};

const TARGET_SCHEMA = {
  type: ['string', 'integer'],
  description:
    '可选目标：page 下标（与 aicoin_app_targets 的 pages[].index 一致）、url 子串、title 子串或 target id；' +
    '省略时优先 url 含 #/main 的窗口。 / Optional target: page index, url/title substring, or target id; defaults to the #/main window.',
};

/* ------------------------------------------------------------------ *
 * CDP 探测与目标选择
 * ------------------------------------------------------------------ */

function hashOf(url) {
  const text = String(url ?? '');
  const idx = text.indexOf('#');
  return idx === -1 ? '' : text.slice(idx);
}

/** 把两种来源（框架 ctx.discover / launcher.listTargets）的目标结构统一。 */
function normalizeTarget(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = String(raw.url ?? '');
  return {
    id: String(raw.id ?? ''),
    type: String(raw.type ?? 'unknown'),
    title: String(raw.title ?? ''),
    url,
    hash: hashOf(url),
    wsUrl: String(raw.webSocketDebuggerUrl ?? raw.wsUrl ?? ''),
    description: String(raw.description ?? ''),
  };
}

/**
 * 探测 CDP：优先框架的 ctx.discover()，没有就退化成 launcher 的 HTTP 探测。
 * 永不抛异常。
 */
async function discoverCdp(ctx, port) {
  if (ctx && typeof ctx.discover === 'function') {
    try {
      const info = await ctx.discover({ port });
      const targets = Array.isArray(info?.targets) ? info.targets.map(normalizeTarget).filter(Boolean) : [];
      return {
        ok: info?.ok === true,
        port,
        source: 'ctx.discover',
        version: info?.version ?? null,
        targets,
        reason: info?.reason ?? null,
      };
    } catch (err) {
      return { ok: false, port, source: 'ctx.discover', version: null, targets: [], reason: err?.message ?? String(err) };
    }
  }
  const res = await listTargets(port, { timeoutMs: 2500 });
  const targets = (res.targets ?? []).map(normalizeTarget).filter(Boolean);
  return {
    ok: res.ok === true,
    port,
    source: 'launcher.listTargets',
    version: null,
    targets,
    reason: res.error ?? null,
  };
}

/** page 目标（保持 /json/list 顺序，index 就是这里的位置）。 */
function pageTargets(targets) {
  return targets.filter((t) => t.type === 'page');
}

function candidatesOf(pool) {
  return pool.map((t, index) => ({ index, id: t.id, type: t.type, title: t.title, url: t.url }));
}

/**
 * 解析 target 参数，返回 {picked, matchedBy, index, pool}。
 * 省略 target 时优先 `#/main`（K 线主窗），否则第一个 page。
 */
function pickTarget(targets, { target, defaultUrlIncludes = '#/main' } = {}) {
  const pages = pageTargets(targets);
  const pool = pages.length > 0 ? pages : targets.filter((t) => t.wsUrl || t.id);
  if (pool.length === 0) {
    throw new TargetSelectionError('端口上没有可附加的目标 / no attachable target on this port', { candidates: [] });
  }

  if (target !== undefined && target !== null && target !== '') {
    const raw = String(target).trim();
    if (/^\d+$/.test(raw)) {
      const index = Number(raw);
      const picked = pool[index];
      if (!picked) {
        throw new TargetSelectionError(
          `target 下标 ${index} 超出范围：共 ${pool.length} 个 page 目标 / index ${index} out of range (${pool.length} page targets)`,
          { candidates: candidatesOf(pool) },
        );
      }
      return { picked, matchedBy: 'index', index, pool };
    }
    const picked =
      pool.find((t) => t.id === raw) ??
      pool.find((t) => t.url.includes(raw)) ??
      pool.find((t) => t.title.includes(raw)) ??
      pool.find((t) => t.id.includes(raw)) ??
      null;
    if (!picked) {
      throw new TargetSelectionError(
        `找不到匹配「${raw}」的目标 / no target matches "${raw}"`,
        { candidates: candidatesOf(pool) },
      );
    }
    return { picked, matchedBy: 'selector', index: pool.indexOf(picked), pool };
  }

  const main = pool.find((t) => t.url.includes(defaultUrlIncludes));
  if (main) return { picked: main, matchedBy: 'default-main', index: pool.indexOf(main), pool };
  return { picked: pool[0], matchedBy: 'default-first', index: 0, pool };
}

/**
 * 附加到指定目标。
 *
 * ctx 在同一个 MCP server 进程里是复用的（createContext 返回单个对象），而
 * context.attach() 在已有活连接时会**直接复用**当前连接（忽略 target）。所以这里
 * 先在「已连的目标 != 想要的目标」时把连接关掉，让 attach 重新选目标。
 */
async function attachTo(ctx, picked, { port } = {}) {
  if (!ctx || typeof ctx.attach !== 'function') {
    const err = new Error(
      '当前上下文不支持 CDP 附加（ctx.attach 不可用），无法操作页面 / ctx.attach is unavailable; cannot reach the page',
    );
    err.code = 'CONTEXT_UNAVAILABLE';
    throw err;
  }
  const current = ctx.client ?? null;
  if (current && current.connected) {
    const currentId = current.target?.id ? String(current.target.id) : '';
    const currentPort = Number(current.port);
    // 端口也要比：同一个 MCP server 的 ctx 只配置了一个端口（例如 9222），
    // 而工具允许显式传 port。只比 target id 会在多端口场景下静默连错端口。
    const portMatches =
      !Number.isInteger(port) || !Number.isInteger(currentPort) || currentPort === port;
    if (currentId && currentId === picked.id && portMatches) {
      return { client: current, reused: true };
    }
    if (typeof ctx.close === 'function') {
      try {
        await ctx.close();
      } catch (err) {
        logOf(ctx)?.('debug', `切换目标前关闭旧连接失败：${err?.message ?? err}`);
      }
    }
  }
  // 同时给 target 对象、port 和 urlIncludes：target/port 是精确选择器，
  // urlIncludes 是框架层新增的便捷选择器，指向同一个目标，谁生效都正确。
  const options = { target: picked };
  if (Number.isInteger(port)) options.port = port;
  if (picked.url) options.urlIncludes = picked.url;
  const client = await ctx.attach(options);
  return { client, reused: false };
}

function targetBrief(picked) {
  if (!picked) return null;
  return { id: picked.id, type: picked.type, title: picked.title, url: picked.url, hash: picked.hash };
}

/* ------------------------------------------------------------------ *
 * 值序列化（eval 结果要能进 JSON）
 * ------------------------------------------------------------------ */

function serializeValue(value) {
  if (value === undefined) {
    return { value: null, valueIsUndefined: true, valueType: 'undefined' };
  }
  const t = typeof value;
  if (value === null) return { value: null, valueType: 'null' };
  if (t === 'number' && !Number.isFinite(value)) {
    return { value: String(value), valueType: 'number', note: 'non-finite number (NaN/Infinity) 已转字符串' };
  }
  if (t === 'bigint') return { value: String(value), valueType: 'bigint', note: 'BigInt 已转字符串' };
  if (t === 'function' || t === 'symbol') return { value: String(value), valueType: t, note: '不可 JSON 化的值已转字符串' };
  return { value, valueType: t };
}

/* ------------------------------------------------------------------ *
 * 截图文件路径与图像尺寸
 * ------------------------------------------------------------------ */

function extOf(format) {
  if (format === 'jpeg') return '.jpg';
  if (format === 'webp') return '.webp';
  return '.png';
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
}

/** 决定截图落盘路径；相对路径按 shots 目录解析，没写扩展名按格式补。 */
function resolveShotPath({ dir, requested, format }) {
  const baseDir = path.resolve(dir || DEFAULT_SHOTS_DIR);
  const ext = extOf(format);
  if (typeof requested === 'string' && requested.trim()) {
    const raw = requested.trim();
    const abs = path.isAbsolute(raw) ? raw : path.resolve(baseDir, raw);
    return path.extname(abs) === '' ? `${abs}${ext}` : abs;
  }
  return path.join(baseDir, `aicoin-${stamp()}${ext}`);
}

/**
 * 从图片字节里读像素尺寸（不依赖任何图像库）：
 * PNG 读 IHDR，JPEG 扫 SOFn，WebP 读 VP8X/VP8/VP8L 头。读不出就返回 null。
 */
export function imageSize(buffer) {
  try {
    if (!buffer || buffer.length < 24) return null;

    // PNG: 89 50 4E 47 ... IHDR 宽高在偏移 16/20（大端 uint32）
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
      return { format: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }

    // JPEG: FFD8 开头，扫描 marker 找 SOF0..SOF3/SOF5..SOF7/SOF9..SOF11/SOF13..SOF15
    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buffer.length) {
        if (buffer[i] !== 0xff) {
          i += 1;
          continue;
        }
        const marker = buffer[i + 1];
        if (marker === 0xff) {
          i += 1;
          continue;
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2;
          continue;
        }
        const len = buffer.readUInt16BE(i + 2);
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) {
          return { format: 'jpeg', height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
        }
        if (len < 2) break;
        i += 2 + len;
      }
      return null;
    }

    // WebP: RIFF....WEBP + chunk
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = buffer.toString('ascii', 12, 16);
      if (chunk === 'VP8X' && buffer.length >= 30) {
        const w = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
        const h = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
        return { format: 'webp', width: w, height: h };
      }
      if (chunk === 'VP8 ' && buffer.length >= 30) {
        const w = buffer.readUInt16LE(26) & 0x3fff;
        const h = buffer.readUInt16LE(28) & 0x3fff;
        return { format: 'webp', width: w, height: h };
      }
      if (chunk === 'VP8L' && buffer.length >= 25) {
        const bits = buffer[21] | (buffer[22] << 8) | (buffer[23] << 16) | (buffer[24] << 24);
        const w = 1 + (bits & 0x3fff);
        const h = 1 + ((bits >> 14) & 0x3fff);
        return { format: 'webp', width: w, height: h };
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

function sha256Short(buffer) {
  try {
    return createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 页面快照表达式（status 用，纯读取）
 * ------------------------------------------------------------------ */

const PAGE_SNAPSHOT_EXPRESSION = `(() => {
  const out = {
    href: String(location.href),
    hash: String(location.hash || ''),
    pathname: String(location.pathname || ''),
    title: String(document.title || ''),
    readyState: String(document.readyState || ''),
    visibility: String(document.visibilityState || ''),
  };
  try { out.cookieLength = document.cookie.length } catch (e) { out.cookieLength = null }
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i += 1) keys.push(String(localStorage.key(i)));
    out.localStorageKeyCount = keys.length;
    out.tokenLikeKeys = keys.filter((k) => /token|auth|user|account|session|login/i.test(k)).slice(0, 20);
  } catch (e) { out.localStorageError = String((e && e.message) || e) }
  try { out.sessionStorageKeyCount = sessionStorage.length } catch (e) { out.sessionStorageKeyCount = null }
  return out;
})()`;

function loginVerdict(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const routeText = `${snapshot.hash || ''} ${snapshot.pathname || ''} ${snapshot.title || ''}`;
  const routeLooksLogin = /login|sign-?in|登录/i.test(routeText);
  const tokenLikeKeys = Array.isArray(snapshot.tokenLikeKeys) ? snapshot.tokenLikeKeys : [];
  const loggedIn = routeLooksLogin ? false : tokenLikeKeys.length > 0 ? true : null;
  return {
    loggedIn,
    heuristic: true,
    note:
      '启发式判定：路由/title 像登录页 → false；否则存在 token/auth/user 类 localStorage 键 → true；都不满足 → null（未知）。' +
      ' / Heuristic only: login-looking route => false, token-like storage keys => true, otherwise null.',
    routeLooksLogin,
    tokenLikeKeys,
    localStorageKeyCount: snapshot.localStorageKeyCount ?? null,
    cookieLength: snapshot.cookieLength ?? null,
    observedTitle: snapshot.title ?? null,
    observedHash: snapshot.hash ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * 工具定义
 * ------------------------------------------------------------------ */

export const tools = [
  {
    name: 'aicoin_app_status',
    title: 'AiCoin 客户端状态',
    description:
      '汇总只读状态：CDP 端口是否可连、Chromium/Electron 版本、AiCoin 进程与调试端口、安装路径、' +
      '**全部 page 目标**（title + url + id + url hash）、默认窗口的页面快照，以及「是否已登录」的启发式判定。' +
      '不修改任何东西；端口不可连时会给出可执行的下一步提示。' +
      ' / Read-only status: CDP availability, version, processes, install path, all page targets, page snapshot and a login heuristic.',
    inputSchema: {
      type: 'object',
      properties: {
        port: PORT_SCHEMA,
        target: TARGET_SCHEMA,
        timeoutMs: {
          type: 'integer',
          minimum: 500,
          maximum: 30000,
          description: '页面快照的超时时间（毫秒），默认 6000。 / Page snapshot timeout, default 6000 ms.',
        },
      },
      additionalProperties: false,
    },
    readOnly: true,
    mutating: false,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args = {}, ctx) => {
      const port = resolvePort(args, ctx);
      const log = logOf(ctx);
      const app = findAppPath({ appPath: ctx?.appPath ?? undefined });

      const [disc, running] = await Promise.all([discoverCdp(ctx, port), isRunning({ port })]);
      const entries = disc.targets.map((t, index) => ({ index, ...t }));
      const pages = entries.filter((t) => t.type === 'page');
      const otherTargets = entries.filter((t) => t.type !== 'page');

      let selection = null;
      let selectionError = null;
      try {
        const { picked, matchedBy, index, pool } = pickTarget(disc.targets, { target: args.target });
        selection = { matchedBy, index, poolSize: pool.length, target: targetBrief(picked) };
      } catch (err) {
        selectionError = { code: err?.code ?? null, message: err?.message ?? String(err), candidates: err?.candidates ?? [] };
      }

      let pageSnapshot = null;
      let pageError = null;
      if (disc.ok && selection?.target) {
        try {
          const { picked } = pickTarget(disc.targets, { target: args.target });
          const { client } = await attachTo(ctx, picked, { port });
          pageSnapshot = await client.evaluate(PAGE_SNAPSHOT_EXPRESSION, {
            awaitPromise: false,
            returnByValue: true,
            timeoutMs: Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : 6000,
          });
        } catch (err) {
          pageError = { code: err?.code ?? null, message: err?.message ?? String(err) };
          log?.('warn', `状态页面快照失败：${err?.message ?? err}`);
        }
      }

      const version = disc.version ?? null;
      const liveRecord = getLiveLaunchRecord(port);
      const result = {
        ok: disc.ok,
        port,
        message: disc.ok
          ? `端口 ${port} 可连接，共 ${pages.length} 个 page 目标 / port ${port} attachable, ${pages.length} page target(s).`
          : running.verdict === 'running-without-debug-port'
            ? `端口 ${port} 不可连接：AiCoin 正在运行（pid ${(running.mainPids || []).join(', ')}）但没有开启调试端口。` +
              `Electron 的 CDP 只能在进程启动时用 --remote-debugging-port 打开，事后无法附加，` +
              `所以要么调 aicoin_app_connect({allowRestart:true})，要么 aicoin_app_restart({force:true})，用调试端口把它重开一次（会关闭当前窗口）。` +
              ` / AiCoin runs without a debug port; CDP cannot be attached afterwards — restart it with a debug port.`
            : running.verdict === 'running-on-other-port'
              ? `端口 ${port} 不可连接，但 AiCoin 已在端口 ${(running.debugPorts || []).join(', ')} 上开了调试端口，改用那个端口即可。` +
                ` / AiCoin already exposes CDP on port ${(running.debugPorts || []).join(', ')}; use that port.`
              : `端口 ${port} 不可连接（${running.verdict}）：AiCoin 没有在运行，调 aicoin_app_launch 或 aicoin_app_connect 带调试端口启动它。` +
                ` / Port ${port} is not attachable (${running.verdict}); AiCoin is not running — start it with aicoin_app_launch.`,
        nextAction:
          running.verdict === 'running-without-debug-port'
            ? { tool: 'aicoin_app_connect', args: { port, allowRestart: true }, summary: `以调试端口 ${port} 重启 AiCoin（会关闭当前窗口）` }
            : running.verdict === 'running-on-other-port'
              ? { tool: 'aicoin_app_status', args: { port: (running.debugPorts || [port])[0] }, summary: '改用已开启调试端口的实例' }
              : { tool: 'aicoin_app_launch', args: { port }, summary: `以调试端口 ${port} 启动 AiCoin` },
        cdp: {
          available: disc.ok,
          source: disc.source,
          browser: version?.Browser ?? running.version ?? null,
          protocolVersion: version?.['Protocol-Version'] ?? null,
          userAgent: version?.['User-Agent'] ?? running.userAgent ?? null,
          v8Version: version?.['V8-Version'] ?? null,
          wsUrl: version?.webSocketDebuggerUrl ?? running.wsUrl ?? null,
          reason: disc.reason,
        },
        process: {
          running: running.running,
          verdict: running.verdict,
          mainPids: running.mainPids,
          debugPorts: running.debugPorts,
          otherDebugPorts: running.otherDebugPorts,
          aiCoinProcessCount: running.processScan.count ?? null,
          processScanAvailable: running.processScan.available,
          processScanError: running.processScan.error ?? null,
          processScanShell: running.processScan.shell ?? null,
        },
        appPath: { path: app.path, exists: app.exists, source: app.source },
        targetCount: entries.length,
        pageCount: pages.length,
        pages: pages.map((t) => ({ index: t.index, id: t.id, title: t.title, url: t.url, hash: t.hash })),
        otherTargets: otherTargets.map((t) => ({ index: t.index, id: t.id, type: t.type, title: t.title, url: t.url })),
        defaultSelection: selection,
        defaultSelectionError: selectionError,
        page: pageSnapshot,
        pageError,
        login: loginVerdict(pageSnapshot),
        launchRecord: liveRecord.record,
        launchRecordStale: liveRecord.stale === true ? { reason: liveRecord.reason } : null,
      };
      log?.('debug', `aicoin_app_status port=${port} ok=${result.ok} pages=${pages.length}`);
      return result;
    },
  },

  {
    name: 'aicoin_app_targets',
    title: '列出 CDP 目标',
    description:
      '列出该端口上 /json/list 返回的全部 CDP 目标：page 目标带 index（可直接作为 aicoin_app_eval / ' +
      'aicoin_app_screenshot 的 target 参数）、title、url、url hash、target id、webSocketDebuggerUrl，' +
      '非 page 目标（service worker / iframe 等）单独列出。只读。' +
      ' / List every CDP target from /json/list; page targets carry the index used by the target parameter. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        port: PORT_SCHEMA,
      },
      additionalProperties: false,
    },
    readOnly: true,
    mutating: false,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args = {}, ctx) => {
      const port = resolvePort(args, ctx);
      const disc = await discoverCdp(ctx, port);
      const entries = disc.targets.map((t, index) => ({ index, ...t }));
      const pages = entries.filter((t) => t.type === 'page');
      const others = entries.filter((t) => t.type !== 'page');
      const version = disc.version ?? null;
      return {
        ok: disc.ok,
        port,
        source: disc.source,
        browser: version?.Browser ?? null,
        userAgent: version?.['User-Agent'] ?? null,
        count: entries.length,
        pageCount: pages.length,
        pages: pages.map((t) => ({
          index: t.index,
          id: t.id,
          title: t.title,
          url: t.url,
          hash: t.hash,
          wsUrl: t.wsUrl,
        })),
        otherTargets: others.map((t) => ({ index: t.index, id: t.id, type: t.type, title: t.title, url: t.url })),
        reason: disc.reason,
        message: disc.ok
          ? `共 ${pages.length} 个 page 目标 / ${pages.length} page target(s).`
          : `端口 ${port} 不可连接：${disc.reason ?? '未知原因'} / port ${port} is not attachable.`,
      };
    },
  },

  {
    name: 'aicoin_app_eval',
    title: '在 AiCoin 页面执行 JS',
    description:
      '在 AiCoin 渲染进程页面里执行 JS 表达式并返回结果（JSON 化）。支持 awaitPromise（默认 true，可直接返回 Promise 结果）、' +
      '超时控制、页面内异常回传（返回 ok:false + error，不会把 MCP 调用打挂）。' +
      '可用 target 选择窗口（下标 / url 子串 / title 子串），默认 url 含 #/main 的 K 线主窗。' +
      '注意：表达式在真实页面里执行，可能产生副作用；Runtime.evaluate 不支持顶层 await，需要 await 时请写成 ' +
      '`(async () => { ... })()` 这种立即执行异步函数。' +
      ' / Evaluate a JS expression in the AiCoin renderer page; JSON-safe result, timeout, exception reporting, optional target window. ' +
      'No top-level await: wrap in `(async () => { ... })()`.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: '要执行的 JS 表达式，例如 "1+1"、"document.title" 或 "Promise.resolve(location.hash)"。 / JS expression to evaluate.',
        },
        awaitPromise: {
          type: 'boolean',
          description: '表达式返回 Promise 时是否等待结果，默认 true。 / Await promise results, default true.',
        },
        returnByValue: {
          type: 'boolean',
          description: '是否把结果按值返回（默认 true）；false 时返回 CDP RemoteObject 描述。 / Return by value, default true.',
        },
        timeoutMs: {
          type: 'integer',
          minimum: 100,
          maximum: 120000,
          description: '执行超时（毫秒），默认 20000。 / Evaluation timeout, default 20000 ms.',
        },
        target: TARGET_SCHEMA,
      },
      required: ['expression'],
      additionalProperties: false,
    },
    readOnly: false,
    mutating: true,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    handler: async (args = {}, ctx) => {
      const port = resolvePort(args, ctx);
      const expression = typeof args.expression === 'string' ? args.expression : '';
      const started = Date.now();
      const base = {
        ok: false,
        port,
        expression: expression.length > 2000 ? `${expression.slice(0, 2000)}…` : expression,
        awaitPromise: args.awaitPromise !== false,
        returnByValue: args.returnByValue !== false,
      };

      if (!expression.trim()) {
        return {
          ...base,
          error: { code: 'INVALID_ARGUMENT', message: 'expression 必须是非空字符串 / expression must be a non-empty string' },
          durationMs: Date.now() - started,
        };
      }

      const disc = await discoverCdp(ctx, port);
      if (!disc.ok) {
        return {
          ...base,
          target: null,
          error: {
            code: 'CDP_UNAVAILABLE',
            message:
              `端口 ${port} 不可连接：${disc.reason ?? '未知原因'}。先运行 aicoin_app_launch（外部启动的实例需 aicoin_app_restart + force）。` +
              ` / Port ${port} is not attachable; run aicoin_app_launch first.`,
          },
          durationMs: Date.now() - started,
        };
      }

      let picked;
      try {
        ({ picked } = pickTarget(disc.targets, { target: args.target }));
      } catch (err) {
        return {
          ...base,
          target: null,
          error: { code: err?.code ?? 'TARGET_SELECTION', message: err?.message ?? String(err), candidates: err?.candidates ?? [] },
          durationMs: Date.now() - started,
        };
      }

      const timeoutMs = Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : 20000;
      try {
        const { client, reused } = await attachTo(ctx, picked, { port });
        const value = await client.evaluate(expression, {
          awaitPromise: args.awaitPromise !== false,
          returnByValue: args.returnByValue !== false,
          timeoutMs,
        });
        const serialized = serializeValue(value);
        return {
          ...base,
          ok: true,
          target: targetBrief(picked),
          reusedConnection: reused,
          ...serialized,
          durationMs: Date.now() - started,
        };
      } catch (err) {
        return {
          ...base,
          target: targetBrief(picked),
          error: {
            code: err?.code ?? null,
            message: err?.message ?? String(err),
            exceptionDetails: err?.exceptionDetails ?? null,
          },
          durationMs: Date.now() - started,
        };
      }
    },
  },

  {
    name: 'aicoin_app_screenshot',
    title: '截图 AiCoin 页面',
    description:
      '对 AiCoin 页面执行 Page.captureScreenshot，把图片写到 aicoin-mcp/shots/（可用 path 指定相对/绝对路径），' +
      '返回文件路径、字节数、像素尺寸、base64 长度与 sha256 前缀；**不返回整段 base64**。' +
      '支持 png/jpeg/webp、quality、fullPage（captureBeyondViewport），用 target 选择窗口，默认 #/main。' +
      ' / Capture a screenshot of an AiCoin page into shots/; returns path/size/dimensions/base64 length (never the raw base64).',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '输出路径：相对路径按 shots 目录解析，绝对路径原样使用；不写扩展名会按 format 补。 / Output path (relative to shots/ or absolute).',
        },
        format: {
          type: 'string',
          enum: ['png', 'jpeg', 'webp'],
          description: '图片格式，默认 png。 / Image format, default png.',
        },
        quality: {
          type: 'integer',
          minimum: 0,
          maximum: 100,
          description: '有损格式（jpeg/webp）的压缩质量 0-100，默认不传（由浏览器决定）。 / Lossy quality 0-100.',
        },
        fullPage: {
          type: 'boolean',
          description: '是否整页截图（captureBeyondViewport），默认 false（只截可视区域）。 / Capture beyond viewport, default false.',
        },
        target: TARGET_SCHEMA,
        port: PORT_SCHEMA,
      },
      additionalProperties: false,
    },
    readOnly: false,
    mutating: false,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args = {}, ctx) => {
      const port = resolvePort(args, ctx);
      const started = Date.now();
      const format = ['png', 'jpeg', 'webp'].includes(String(args.format ?? '').toLowerCase())
        ? String(args.format).toLowerCase()
        : 'png';
      const base = { ok: false, port, format };

      const disc = await discoverCdp(ctx, port);
      if (!disc.ok) {
        return {
          ...base,
          error: {
            code: 'CDP_UNAVAILABLE',
            message:
              `端口 ${port} 不可连接：${disc.reason ?? '未知原因'}。先运行 aicoin_app_launch。` +
              ` / Port ${port} is not attachable; run aicoin_app_launch first.`,
          },
          durationMs: Date.now() - started,
        };
      }

      let picked;
      try {
        ({ picked } = pickTarget(disc.targets, { target: args.target }));
      } catch (err) {
        return {
          ...base,
          error: { code: err?.code ?? 'TARGET_SELECTION', message: err?.message ?? String(err), candidates: err?.candidates ?? [] },
          durationMs: Date.now() - started,
        };
      }

      const shotsDir = typeof ctx?.config?.shotsDir === 'string' && ctx.config.shotsDir
        ? ctx.config.shotsDir
        : process.env.AICOIN_SHOTS_DIR || DEFAULT_SHOTS_DIR;
      const outPath = resolveShotPath({ dir: shotsDir, requested: args.path, format });

      try {
        const { client, reused } = await attachTo(ctx, picked, { port });
        const options = { format, timeoutMs: 30000 };
        if (Number.isInteger(Number(args.quality)) && format !== 'png') {
          options.quality = Math.max(0, Math.min(100, Number(args.quality)));
        }
        if (args.fullPage === true) options.captureBeyondViewport = true;
        const base64 = await client.screenshot(options);
        const buffer = Buffer.from(String(base64), 'base64');
        mkdirSync(path.dirname(outPath), { recursive: true });
        writeFileSync(outPath, buffer);
        const size = imageSize(buffer);
        const rel = path.relative(REPO_ROOT, outPath).split(path.sep).join('/');
        logOf(ctx)?.('info', `截图已保存 ${outPath} (${buffer.length} bytes)`);
        return {
          ...base,
          ok: true,
          target: targetBrief(picked),
          reusedConnection: reused,
          path: outPath,
          relativePath: rel,
          exists: existsSync(outPath),
          bytes: buffer.length,
          width: size?.width ?? null,
          height: size?.height ?? null,
          detectedFormat: size?.format ?? null,
          base64Length: String(base64).length,
          base64BytesApprox: Math.round((String(base64).length * 3) / 4),
          sha256_16: sha256Short(buffer),
          fullPage: args.fullPage === true,
          durationMs: Date.now() - started,
          message: `已保存 ${rel}（${size ? `${size.width}x${size.height}` : '尺寸未知'}，${buffer.length} bytes）；base64 长度 ${String(base64).length}，未回传内容。` +
            ` / Saved ${rel}.`,
        };
      } catch (err) {
        const code = err?.code ?? null;
        // 实测：非主窗口截图可能 30s 无响应（CDP 侧报 SCREENSHOT_TIMEOUT），
        // 直接把定位提示回给模型，别让它瞎猜。
        const hint =
          code === 'SCREENSHOT_TIMEOUT'
            ? '该窗口对 Page.captureScreenshot 无响应，请用 target:"#/main"（K 线主窗）重试 / use target:"#/main" for the main window'
            : undefined;
        return {
          ...base,
          target: targetBrief(picked),
          path: outPath,
          error: { code, message: err?.message ?? String(err), ...(hint ? { hint } : {}) },
          durationMs: Date.now() - started,
        };
      }
    },
  },
];

export default { tools };
