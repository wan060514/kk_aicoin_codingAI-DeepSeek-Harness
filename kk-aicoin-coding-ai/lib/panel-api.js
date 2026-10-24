/**
 * Same-origin JSON API that lets the AiCoin panel (`dsh-plugin-aicoin-mcp`)
 * expose this plugin's AiScript helpers without either plugin importing the
 * other: the panel renders a card, this route answers it.
 *
 * Everything lives under one prefix owned by this plugin. The route is a thin
 * adapter — file reading, library lookup and validation stay in their modules.
 *
 *   GET  /plugins/kk-aicoin/state     library size, version, workspace
 *   POST /plugins/kk-aicoin/action    { action: 'validate' | 'library.search' | 'library.get' | 'spec.status' | 'advice' }
 *
 * A 404 here is meaningful to the caller: it means "this plugin is absent", and
 * the panel degrades to a hint instead of breaking.
 *
 * @module kk_aicoin_codingAI/panel-api
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { URL } from 'node:url'

import { validateScript } from './aiscript/validate.js'
import { SPEC_FIELDS, analyzeRequirement, slugify } from './spec.js'
import { NO_METRICS_NOTICE, buildAdvice } from './advice.js'

/** Prefix owned by this plugin; must match the client card's fetch path. */
export const API_PREFIX = '/plugins/kk-aicoin'

/** Plugin root (`plugin/`), used to locate data and package.json. */
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Largest accepted request body. */
const MAX_BODY_BYTES = 64 * 1024

/** How many diagnostics the panel receives; the tool output stays complete. */
const MAX_DIAGNOSTICS = 60

/** How many search hits / characters the panel receives. */
const MAX_LIBRARY_ITEMS = 40
const MAX_TEXT = 1200

/** How many structure-review findings the panel receives. */
const MAX_ADVICE = 12

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    /* socket already gone */
  }
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body larger than ${MAX_BODY_BYTES} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', (error) => reject(error))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) {
        resolvePromise({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('request body must be a JSON object'))
          return
        }
        resolvePromise(parsed)
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`))
      }
    })
  })
}

/** Trim a possibly long string so one entry cannot flood the panel. */
function clip(text, limit = MAX_TEXT) {
  const value = typeof text === 'string' ? text : ''
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

/**
 * Resolve a caller-supplied path.
 *
 * Absolute paths win. A relative path is ambiguous in this codebase (the tools
 * resolve against `process.cwd()`, the panel against the plugin workspace), so
 * prefer whichever candidate actually exists and fall back to the workspace one.
 */
function resolveScriptPath(input, workspace) {
  const raw = String(input ?? '').trim()
  if (!raw) return null
  if (isAbsolute(raw)) return raw
  const candidates = [resolve(workspace, raw), resolve(process.cwd(), raw)]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

/** Compact view of a library entry. */
function summarizeEntry(entry) {
  return {
    name: entry.name,
    callName: entry.callName ?? entry.name,
    type: entry.type,
    category: entry.category ?? null,
    signature: clip(entry.signature ?? '', 200),
    summary: clip(entry.summary ?? entry.description ?? '', 200),
  }
}

/** Case-insensitive substring match across the fields a user might type. */
function matches(entry, needle) {
  const haystack = [entry.name, entry.callName, entry.category, entry.signature, entry.summary, entry.description]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return haystack.includes(needle)
}

/**
 * Build the request handler for the named route.
 *
 * @param {{kb: object, workspace: string, strategyDir?: string, version: string, log?: object}} ctx
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function createPanelHandler({ kb, workspace, strategyDir, version, log }) {
  /** Folder (under the workspace) where strategy specs are written. */
  const specDir = strategyDir || 'aicoin-strategies'
  const readVersion = () => {
    try {
      const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'))
      return pkg.version ?? version ?? '0.0.0'
    } catch {
      return version ?? '0.0.0'
    }
  }

  const buildState = () => ({
    ok: true,
    name: 'kk_aicoin_codingAI',
    version: readVersion(),
    workspace,
    dataDir: kb?.dataDir ?? null,
    library: {
      entries: kb?.entries?.length ?? 0,
      functions: kb?.functions?.length ?? 0,
      variables: kb?.variables?.length ?? 0,
      rules: kb?.rules?.length ?? 0,
      meta: kb?.meta ?? {},
    },
    actions: ['validate', 'library.search', 'library.get', 'spec.status', 'advice'],
  })

  const doValidate = (body) => {
    const file = resolveScriptPath(body.path, workspace)
    if (!file) return { ok: false, error: 'validate 需要参数 path（脚本路径，相对工作目录或绝对路径）' }
    if (!existsSync(file)) return { ok: false, error: `找不到脚本文件：${file}`, resolvedPath: file }
    const source = readFileSync(file, 'utf8')
    const result = validateScript(source, kb)
    return {
      ok: result.ok,
      file,
      stats: result.stats,
      diagnostics: result.diagnostics.slice(0, MAX_DIAGNOSTICS).map((d) => ({
        severity: d.severity,
        ruleId: d.ruleId,
        message: d.message,
        line: d.line,
        column: d.column,
        hint: clip(d.hint ?? '', 300),
      })),
      truncated: Math.max(0, result.diagnostics.length - MAX_DIAGNOSTICS),
    }
  }

  const doLibrarySearch = (body) => {
    const query = String(body.query ?? '').trim()
    if (!query) return { ok: false, error: 'library.search 需要参数 query' }
    const limit = Math.min(Number(body.limit) > 0 ? Number(body.limit) : 10, MAX_LIBRARY_ITEMS)
    const needle = query.toLowerCase()
    const entries = Array.isArray(kb?.entries) ? kb.entries : []
    const hits = entries.filter((entry) => matches(entry, needle))
    const byCategory = body.category ? hits.filter((entry) => String(entry.category ?? '') === String(body.category)) : hits
    return {
      ok: true,
      query,
      total: byCategory.length,
      items: byCategory.slice(0, limit).map(summarizeEntry),
    }
  }

  const doLibraryGet = (body) => {
    const name = String(body.name ?? '').trim()
    if (!name) return { ok: false, error: 'library.get 需要参数 name' }
    const entry = kb?.byCall?.get(name) ?? kb?.byName?.get(name)
    if (!entry) return { ok: false, error: `函数库里没有 ${name}` }
    return {
      ok: true,
      entry: {
        ...summarizeEntry(entry),
        doc: clip(entry.doc ?? '', 2000),
        params: entry.params ?? null,
        returns: entry.returns ?? null,
        examples: Array.isArray(entry.examples) ? entry.examples.slice(0, 3).map((e) => clip(e, 800)) : [],
        notes: Array.isArray(entry.notes) ? entry.notes.slice(0, 5).map((n) => clip(n, 400)) : [],
      },
    }
  }

  /** Read a saved spec (explicit `path`, else `<workspace>/aicoin-strategies/<slug>/spec.json`). */
  const readSpec = (body) => {
    const explicit = resolveScriptPath(body.path, workspace)
    const file = explicit ?? join(workspace, specDir, slugify(String(body.name ?? '').trim()), 'spec.json')
    if (!existsSync(file)) return { file, saved: null }
    try {
      return { file, saved: JSON.parse(readFileSync(file, 'utf8')) }
    } catch {
      return { file, saved: null, error: `规格文件不是合法 JSON：${file}` }
    }
  }

  const doSpecStatus = (body) => {
    const name = String(body.name ?? '').trim()
    if (!name && !String(body.path ?? '').trim()) return { ok: false, error: 'spec.status 需要参数 name 或 path' }
    const { file, saved, error } = readSpec(body)
    if (error) return { ok: false, error }
    if (!saved) return { ok: false, error: `没有找到规格文件：${file}。先跑 aicoin_spec_draft 把需求固定下来。`, file }
    const analysis = analyzeRequirement(saved.need ?? '', saved.values ?? {})
    const values = SPEC_FIELDS.map((field) => ({
      id: field.id,
      label: field.label,
      required: field.required === true,
      value: saved.values?.[field.id] ? String(saved.values[field.id]) : null,
    }))
    return {
      ok: true,
      file,
      name: saved.name ?? name,
      completeness: analysis.completeness,
      values,
      openQuestions: analysis.openQuestions.slice(0, 12).map((question) => ({
        id: question.id,
        question: clip(question.question ?? '', 240),
        why: clip(question.why ?? '', 200),
      })),
      truncated: Math.max(0, analysis.openQuestions.length - 12),
    }
  }

  const doAdvice = (body) => {
    const file = resolveScriptPath(body.path, workspace)
    if (!file) return { ok: false, error: 'advice 需要参数 path（脚本路径，相对工作目录或绝对路径）' }
    if (!existsSync(file)) return { ok: false, error: `找不到脚本文件：${file}`, resolvedPath: file }
    const source = readFileSync(file, 'utf8')
    const validation = validateScript(source, kb)
    const { saved } = readSpec(body)
    const values = saved?.values ?? {}
    const analysis = saved ? analyzeRequirement(saved.need ?? '', values) : undefined
    const result = buildAdvice({ source, ast: validation.ast, spec: values, analysis, diagnostics: validation.diagnostics })
    return {
      ok: true,
      file,
      stats: validation.stats,
      facts: result.facts,
      total: result.advice.length,
      advice: result.advice.slice(0, MAX_ADVICE).map((item) => ({
        id: item.id,
        severity: item.severity,
        title: item.title,
        finding: clip(item.finding, 320),
        action: clip(item.action, 320),
      })),
      truncated: Math.max(0, result.advice.length - MAX_ADVICE),
      noMetricsNotice: NO_METRICS_NOTICE,
    }
  }

  const ACTIONS = new Map([
    ['validate', doValidate],
    ['library.search', doLibrarySearch],
    ['library.get', doLibraryGet],
    ['spec.status', doSpecStatus],
    ['advice', doAdvice],
  ])

  return async function handlePanelRequest(req, res) {
    let url
    try {
      url = new URL(req.url ?? API_PREFIX, 'http://127.0.0.1')
    } catch {
      sendJson(res, 400, { ok: false, error: 'malformed request URL' })
      return
    }
    const route = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) || '/' : url.pathname
    const method = (req.method ?? 'GET').toUpperCase()
    try {
      if (method === 'GET' && (route === '/state' || route === '/')) {
        sendJson(res, 200, buildState())
        return
      }
      if (method === 'POST' && route === '/action') {
        const body = await readBody(req)
        const action = typeof body.action === 'string' ? body.action : ''
        const run = ACTIONS.get(action)
        if (!run) {
          sendJson(res, 400, { ok: false, error: `unknown action "${action}"`, state: buildState() })
          return
        }
        sendJson(res, 200, { ...run(body), action })
        return
      }
      sendJson(res, 404, { ok: false, error: `no route for ${method} ${url.pathname}` })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log?.warn?.(`kk-aicoin panel API: ${message}`)
      sendJson(res, 500, { ok: false, error: message })
    }
  }
}
