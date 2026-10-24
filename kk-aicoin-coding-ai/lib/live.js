/**
 * Read-only live checks against a running AiCoin client.
 *
 * Why this module is read-only, and why it does NOT call
 * `upgrade/customIndicator/script/save`:
 *
 *   The reverse-engineering notes in `research/compile-flow.md` establish, from
 *   the renderer bundle, that the client has **no local AiScript compiler** - the
 *   only place a script is truly compiled is the server, triggered by saving.
 *   That save body is `{ name, value, version: 'v4' }`; with no `id` it CREATES a
 *   new indicator in the user's account (the reducer pushes the new id into
 *   `myIndicators`). The client itself lists `upgrade/customIndicator/script/save`
 *   among the endpoints with a conservative no-retry policy, and the endpoint is
 *   subject to VIP / `securityCount` quotas.
 *
 *   So "use save as a free validation probe" would write junk into the user's
 *   account. This module therefore only ever READS: it probes the debug port and
 *   diffs the client's live function library against the bundled copy. The
 *   genuine compile check stays where it belongs - the client's own
 *   "保存并校验" button, pressed by the user.
 *
 * @module kk_aicoin_codingAI/live
 */

import { createConnection } from 'node:net'
import { randomBytes } from 'node:crypto'

const DEFAULT_PORT = 9222

/**
 * Minimal HTTP GET.
 *
 * Uses the runtime's own `fetch` (Node 18+/Electron ≥ 20) instead of a raw
 * socket: Chrome does not always honour `Connection: close`, so the old
 * socket-based reader waited for a `close` event that never came and every
 * probe timed out at 4 s even when the debug port was perfectly healthy.
 */
async function httpGet(port, path, timeoutMs = 4000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: controller.signal,
      cache: 'no-store',
    })
    const body = await response.text()
    return { status: response.status, headers: [...response.headers].map(([k, v]) => `${k}: ${v}`).join('\n'), body }
  } finally {
    clearTimeout(timer)
  }
}

/** WebSocket upgrade + framed send/receive, hand-rolled (no dependency). */
function wsConnect(wsUrl, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const url = new URL(wsUrl)
    const key = randomBytes(16).toString('base64')
    const socket = createConnection({ host: url.hostname, port: Number(url.port || 80) })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('WebSocket 握手超时'))
    }, timeoutMs)
    let handshake = ''
    const onData = (chunk) => {
      handshake += chunk.toString('utf8')
      if (!handshake.includes('\r\n\r\n')) return
      clearTimeout(timer)
      socket.removeListener('data', onData)
      if (!/101/.test(handshake.split('\r\n')[0] ?? '')) {
        socket.destroy()
        reject(new Error('WebSocket 升级失败'))
        return
      }
      // Any bytes after the handshake belong to the framed stream.
      const rest = Buffer.from(handshake.slice(handshake.indexOf('\r\n\r\n') + 4), 'utf8')
      socket.setNoDelay(true)
      resolve({ socket, pending: rest })
    }
    socket.on('connect', () => {
      socket.write(
        `GET ${url.pathname}${url.search} HTTP/1.1\r\n` +
          `Host: ${url.hostname}:${url.port}\r\n` +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      )
    })
    socket.on('data', onData)
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function wsSend(socket, text) {
  const payload = Buffer.from(text, 'utf8')
  const length = payload.length
  let header
  if (length < 126) header = Buffer.from([0x81, 0x80 | length])
  else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 0xfe
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 0xff
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  const mask = randomBytes(4)
  const masked = Buffer.alloc(length)
  for (let i = 0; i < length; i += 1) masked[i] = payload[i] ^ mask[i % 4]
  socket.write(Buffer.concat([header, mask, masked]))
}

/** Attach a frame reader; returns an emitter for decoded text messages. */
function attachReader(socket, onMessage, initial = Buffer.alloc(0)) {
  let buffer = Buffer.from(initial)
  const drain = () => {
    for (;;) {
      if (buffer.length < 2) return
      const opcode = buffer[0] & 0x0f
      let length = buffer[1] & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        length = Number(buffer.readBigUInt64BE(2))
        offset = 10
      }
      if (buffer.length < offset + length) return
      const payload = buffer.subarray(offset, offset + length)
      buffer = buffer.subarray(offset + length)
      if (opcode === 0x1) onMessage(payload.toString('utf8'))
      else if (opcode === 0x8) {
        socket.end()
        return
      }
    }
  }
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    drain()
  })
  drain()
}

/** Evaluate an expression in the page and return its value. */
async function cdpEvaluate(socket, expression, { awaitPromise = true, timeoutMs = 20000 } = {}) {
  let id = 0
  const pending = new Map()
  attachReader(socket, (text) => {
    let message
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  })
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const myId = (id += 1)
      const timer = setTimeout(() => {
        pending.delete(myId)
        reject(new Error(`${method} 超时`))
      }, timeoutMs)
      pending.set(myId, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
      wsSend(socket, JSON.stringify({ id: myId, method, params: params ?? {} }))
    })

  await call('Runtime.enable', {})
  const response = await call('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    includeCommandLineAPI: true,
  })
  const result = response?.result
  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? '页面内执行异常')
  }
  return result?.result?.value
}

/**
 * Probe for an open CDP port and list page targets.
 *
 * @returns {Promise<{ open: boolean, port: number, targets: Array<object>, reason?: string }>}
 */
export async function probeDebugPort(port = DEFAULT_PORT) {
  try {
    const response = await httpGet(port, '/json/list')
    if (response.status !== 200) {
      return { open: false, port, targets: [], reason: `端口有响应但状态码是 ${response.status}` }
    }
    const targets = JSON.parse(response.body)
    return {
      open: true,
      port,
      targets: (Array.isArray(targets) ? targets : []).map((t) => ({
        type: t.type,
        title: t.title,
        url: String(t.url ?? '').slice(0, 120),
        webSocketDebuggerUrl: t.webSocketDebuggerUrl,
      })),
    }
  } catch (error) {
    return { open: false, port, targets: [], reason: error?.message ?? String(error) }
  }
}

/**
 * Read the live function library out of a running AiCoin client.
 *
 * Uses the client's OWN axios instance (module id 31438), so its RSA+AES request
 * interceptor and login state apply. Read-only: `functionLib` is a GET-shaped
 * metadata call.
 *
 * @returns {Promise<{ ok: boolean, message: string, categories?: Array<object> }>}
 */
export async function fetchLiveLibrary(port = DEFAULT_PORT) {
  const probe = await probeDebugPort(port)
  if (!probe.open) {
    return { ok: false, message: `调试端口 ${port} 不可达：${probe.reason ?? '未监听'}` }
  }
  // 必须挑主窗口（#/main…）。通知窗（#/notice）里虽然也有同一个 axios 模块，
  // 但请求会被客户端拦下（BUSINESS_REQUEST_DENIED），且它的 store 不是行情页。
  const pages = probe.targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (pages.length === 0) return { ok: false, message: '没有找到可用的 page 目标（AiCoin 主窗口没开？）' }
  const page = pages.find((t) => /#\/main/.test(t.url)) ?? pages.find((t) => /#\/cha|#\/kline/.test(t.url)) ?? pages[0]

  const { socket } = await wsConnect(page.webSocketDebuggerUrl)
  try {
    const bootstrap = `(async function () {
      try {
        if (typeof window.__kk_wr !== 'function') {
          var key = null;
          for (var k in window) { if (/^webpackChunk/.test(k)) { key = k; break; } }
          if (!key) return { ok: false, step: 'chunk', message: '找不到 webpackChunk* 全局，可能版本不同' };
          var captured = null;
          window[key].push([['__kk_probe__'], {}, function (req) { captured = req; }]);
          if (typeof captured !== 'function') return { ok: false, step: 'require', message: 'webpack chunk push 没有回传 require' };
          window.__kk_wr = captured;
        }
        var mod = window.__kk_wr(31438);
        if (!mod || !mod.A) return { ok: false, step: 'axios', message: '模块 31438 里没有 A（axios 实例），客户端版本可能不同' };
        var res = await mod.A.post('upgrade/customIndicator/script/functionLib');
        var list = res && res.data && res.data.data && res.data.data.list;
        if (!list) return { ok: false, step: 'response', message: 'functionLib 响应结构不符合预期' };
        var flat = [];
        for (var i = 0; i < list.length; i++) {
          var cat = list[i];
          var items = cat.list || cat.items || [];
          for (var j = 0; j < items.length; j++) {
            flat.push({ t: cat.title, y: cat.type, k: items[j].key });
          }
        }
        window.__kk_fl = JSON.stringify(flat);
        return { ok: true, total: flat.length, categories: list.length, length: window.__kk_fl.length };
      } catch (e) {
        return { ok: false, step: 'exception', message: String(e && e.message ? e.message : e) };
      }
    })()`

    const meta = await cdpEvaluate(socket, bootstrap)
    if (!meta?.ok) {
      return { ok: false, message: `无法从客户端取到函数库：${meta?.message ?? '未知原因'}（步骤 ${meta?.step ?? '?'}）` }
    }

    const total = Number(meta.length)
    const chunkSize = 100000
    let text = ''
    for (let position = 0; position < total; position += chunkSize) {
      const part = await cdpEvaluate(socket, `window.__kk_fl.substr(${position}, ${chunkSize})`, { awaitPromise: false })
      text += part ?? ''
    }
    const flat = JSON.parse(text)
    return {
      ok: true,
      message: `客户端函数库已读取：${flat.length} 条，${meta.categories} 个分类`,
      entries: flat,
      categories: meta.categories,
    }
  } finally {
    try {
      socket.end()
    } catch {
      /* ignore */
    }
  }
}

/**
 * Read the **full** live function library, docs included.
 *
 * `fetchLiveLibrary` only keeps `{t,y,k}` keys (cheap diff). A refresh needs the
 * whole entry — the client ships each item as `{ doc, isPro, key, name, text }`,
 * where `doc` is the markdown the editor renders (说明 / 返回值 / 例子). That is
 * the same material the structured knowledge base was generated from.
 *
 * @returns {Promise<{ok: boolean, message: string, categories?: Array<object>, totalItems?: number}>}
 */
export async function fetchLiveLibraryFull(port = DEFAULT_PORT) {
  const probe = await probeDebugPort(port)
  if (!probe.open) {
    return { ok: false, message: `调试端口 ${port} 不可达：${probe.reason ?? '未监听'}` }
  }
  const pages = probe.targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (pages.length === 0) return { ok: false, message: '没有找到可用的 page 目标（AiCoin 主窗口没开？）' }
  const page = pages.find((t) => /#\/main/.test(t.url)) ?? pages[0]

  const { socket } = await wsConnect(page.webSocketDebuggerUrl)
  try {
    const bootstrap = `(async function () {
      try {
        if (typeof window.__kk_wr !== 'function') {
          var key = null;
          for (var k in window) { if (/^webpackChunk/.test(k)) { key = k; break; } }
          if (!key) return { ok: false, step: 'chunk', message: '找不到 webpackChunk* 全局，可能版本不同' };
          var captured = null;
          window[key].push([['__kk_probe_full__'], {}, function (req) { captured = req; }]);
          if (typeof captured !== 'function') return { ok: false, step: 'require', message: 'webpack chunk push 没有回传 require' };
          window.__kk_wr = captured;
        }
        var mod = window.__kk_wr(31438);
        if (!mod || !mod.A) return { ok: false, step: 'axios', message: '模块 31438 里没有 A（axios 实例），客户端版本可能不同' };
        var res = await mod.A.post('upgrade/customIndicator/script/functionLib');
        var list = res && res.data && res.data.data && res.data.data.list;
        if (!list) return { ok: false, step: 'response', message: 'functionLib 响应结构不符合预期' };
        var total = 0;
        for (var i = 0; i < list.length; i++) total += (list[i].list || list[i].items || []).length;
        window.__kk_fl_full = JSON.stringify({ categories: list.map(function (c) {
          var items = c.list || c.items || [];
          return { title: c.title, type: c.type, count: items.length, items: items };
        }), total_items: total, total_categories: list.length });
        return { ok: true, total: total, categories: list.length, length: window.__kk_fl_full.length };
      } catch (e) {
        return { ok: false, step: 'exception', message: String(e && e.message ? e.message : e) };
      }
    })()`

    const meta = await cdpEvaluate(socket, bootstrap)
    if (!meta?.ok) return { ok: false, message: `无法读取客户端函数库：${meta?.message ?? '未知原因'}` }

    const total = Number(meta.length)
    const chunkSize = 100000
    let text = ''
    for (let position = 0; position < total; position += chunkSize) {
      const part = await cdpEvaluate(socket, `window.__kk_fl_full.substr(${position}, ${chunkSize})`, { awaitPromise: false })
      text += part ?? ''
    }
    const payload = JSON.parse(text)
    return {
      ok: true,
      message: `客户端函数库已完整读取：${payload.total_items} 条 / ${payload.total_categories} 个分类`,
      categories: payload.categories,
      totalItems: payload.total_items,
    }
  } finally {
    try {
      socket.end()
    } catch {
      /* ignore */
    }
  }
}

/**
 * Diff the live library against the bundled knowledge base.
 *
 * @param {Array<{k: string, t: string, y: string}>} live
 * @param {object} kb
 */
export function diffLibrary(live, kb) {
  const normalise = (name) => String(name ?? '').trim()
  const liveNames = new Set(live.map((item) => normalise(item.k)))
  const bundledNames = new Set(kb.entries.map((entry) => normalise(entry.name)))
  const missingLocally = [...liveNames].filter((name) => !bundledNames.has(name)).sort()
  const extraLocally = [...bundledNames].filter((name) => !liveNames.has(name)).sort()
  return {
    liveCount: liveNames.size,
    bundledCount: bundledNames.size,
    missingLocally,
    extraLocally,
    inSync: missingLocally.length === 0 && extraLocally.length === 0,
  }
}

export { DEFAULT_PORT }
