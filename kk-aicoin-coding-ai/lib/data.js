/**
 * Plugin data layer: loads and indexes the bundled AiCoin knowledge base.
 *
 * Everything is read once and cached. The indexes are derived here - not baked
 * into the JSON - so that a refreshed function library from a future AiCoin
 * build immediately produces correct lookups.
 *
 * @module kk_aicoin_codingAI/data
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const cache = new Map()

function readJson(path) {
  if (cache.has(path)) return cache.get(path)
  if (!existsSync(path)) throw new Error(`缺少数据文件：${path}（插件安装不完整）`)
  const value = JSON.parse(readFileSync(path, 'utf8'))
  cache.set(path, value)
  return value
}

/** Derive the real callable name from a signature: `line.new([...])` -> `line.new`. */
export function callNameOf(entry) {
  const fromSignature = /^([A-Za-z_\u4E00-\u9FAF][\w.\u4E00-\u9FAF]*)\s*\(/.exec(entry.signature ?? '')
  if (fromSignature) return fromSignature[1]
  return entry.name
}

/** True when the entry documents the parameter as required. */
function isRequired(param) {
  const value = param?.default
  return value === '(必要参数)'
}

/** True when the entry documents the parameter as optional-with-a-default. */
function isOptional(param) {
  const value = param?.default
  if (value === null || value === undefined) return false
  if (value === '(必要参数)') return false
  return true
}

/**
 * Split a documented signature into its top-level argument chunks.
 *
 * `label.new([series, price], title, text)` -> two chunks, the first packed:
 * the four/​two coordinate names inside `[...]` are ONE argument on the wire.
 * `color=rgba(255,255,255,1)` stays a single chunk because the commas sit
 * inside parentheses.
 *
 * @returns {Array<{ names: string[], packed: boolean, hasDefault: boolean }>|null}
 */
export function parseSignatureGroups(signature) {
  const match = /^[\w.\u4E00-\u9FAF]*\s*\((.*)\)\s*$/.exec(String(signature ?? '').trim())
  if (!match) return null
  const inner = match[1].trim()
  if (!inner) return []
  const chunks = []
  let depth = 0
  let buf = ''
  for (const ch of inner) {
    if (ch === '(' || ch === '[') depth += 1
    else if (ch === ')' || ch === ']') depth -= 1
    if (ch === ',' && depth === 0) {
      chunks.push(buf)
      buf = ''
      continue
    }
    buf += ch
  }
  chunks.push(buf)
  return chunks
    .map((chunk) => {
      const text = chunk.trim()
      if (!text) return null
      const packed = text.startsWith('[')
      const body = packed ? text.replace(/^\[/, '').replace(/\]$/, '') : text
      const names = []
      let d = 0
      let piece = ''
      for (const ch of body) {
        if (ch === '(' || ch === '[') d += 1
        else if (ch === ')' || ch === ']') d -= 1
        if (ch === ',' && d === 0) {
          names.push(piece)
          piece = ''
          continue
        }
        piece += ch
      }
      names.push(piece)
      const clean = names
        .map((n) => n.trim().replace(/=.*$/, '').trim())
        .filter((n) => /^[A-Za-z_\u4E00-\u9FAF][\w\u4E00-\u9FAF]*$/.test(n))
      return { names: clean, packed, hasDefault: /(^|[^=!<>])=[^=]/.test(body) }
    })
    .filter(Boolean)
}

/**
 * Map the documented signature onto the structured parameter table so that
 * arity is checked PER ARGUMENT, not per parameter.
 *
 * `line.new([series1, price1, series2, price2], title, ...)` documents 10
 * parameters but accepts 7 arguments, and `plot(title=title)` carries a default
 * in the signature while the table marks `title` required. Both cases are
 * resolved here, once, so the analyzer stays simple.
 */
function buildArgGroups(signature, params) {
  const chunks = parseSignatureGroups(signature)
  const fallback = params.map((p) => ({ names: [p.name], packed: false, hasDefault: false, params: [p] }))
  if (!chunks || chunks.length === 0 || params.length === 0) return { groups: fallback, fromSignature: false }

  // The extraction only carries a 默认值 column for some tables. When EVERY
  // parameter is `null` the table simply had no such column, so "no `=` in the
  // signature" cannot be read as "required" - `hour(timezone)` is called as
  // `hour()` throughout the platform's own examples.
  const tableHasColumn = params.some((p) => p.default !== null && p.default !== undefined)

  const byName = new Map(params.map((p) => [p.name, p]))
  const used = new Set()
  const groups = []
  for (const chunk of chunks) {
    const matches = chunk.names.map((n) => byName.get(n))
    if (matches.some((m) => !m)) return { groups: fallback, fromSignature: false }
    for (const name of chunk.names) used.add(name)
    groups.push({ names: chunk.names, packed: chunk.packed, hasDefault: chunk.hasDefault, params: matches })
  }
  // Parameters the signature never mentioned keep table-only requiredness.
  for (const param of params) {
    if (used.has(param.name)) continue
    groups.push({ names: [param.name], packed: false, hasDefault: false, params: [param], tableOnly: true })
  }

  const resolved = groups.map((group) => {
    const required = group.tableOnly
      ? group.params.some(isRequired)
      : group.params.some(isRequired) ||
        (tableHasColumn && !group.hasDefault && !group.params.some(isOptional))
    return {
      names: group.names,
      packed: group.packed,
      required,
      label: group.packed ? `[${group.names.join(', ')}]` : group.names.join(', '),
      params: group.params,
    }
  })
  return { groups: resolved, fromSignature: true }
}

/** Normalize one library entry into the shape the validator consumes. */
export function normalizeEntry(entry) {
  const params = (entry.params ?? []).map((param) => ({
    name: String(param.name ?? '').trim(),
    type: String(param.type ?? '').trim(),
    required: isRequired(param),
    optional: isOptional(param),
    default: param.default ?? null,
    desc: param.desc ?? '',
  }))
  const { groups: argGroups, fromSignature } = buildArgGroups(entry.signature, params)
  // Arity is only asserted when the documented signature parsed into a group
  // structure that agrees with the parameter table. The extraction has ~50
  // entries whose parameter table came from code samples (operators such as
  // `+=`, `"`, `range`); for those we stay silent rather than guess.
  const arityKnown = entry.type === 'function' && fromSignature && argGroups.length > 0
  const arityUnknown = !arityKnown
  return {
    name: entry.name,
    callName: callNameOf(entry),
    category: entry.category,
    type: entry.type,
    signature: entry.signature ?? entry.name,
    version: entry.version ?? null,
    summary: entry.summary ?? '',
    returns: entry.returns ?? '',
    params,
    argGroups,
    arityFromSignature: fromSignature,
    arityKnown,
    requiredCount: params.filter((p) => p.required).length,
    arityUnknown,
    examples: entry.examples ?? [],
    notes: entry.notes ?? [],
    snippet: entry.snippet ?? '',
    doc: entry.doc ?? entry.doc_markdown ?? '',
    flags: {
      rootScopeOnly: entry.flags?.rootScopeOnly === true,
      singleDeclaration: entry.flags?.singleDeclaration === true,
      requiresUniqueId: entry.flags?.requiresUniqueId === true,
      conditionFirstParam: entry.flags?.conditionFirstParam === true,
      arityUnknown,
    },
  }
}

/**
 * Load the whole knowledge base.
 *
 * @param {string} dataDir - absolute path of the plugin's `data/` directory.
 */
export function loadKnowledge(dataDir) {
  if (cache.has(`kb:${dataDir}`)) return cache.get(`kb:${dataDir}`)

  const functionsRaw = readJson(join(dataDir, 'aiscript_functions.json'))
  const language = readJson(join(dataDir, 'aiscript_language.json'))
  let rules = { rules: [] }
  try {
    rules = readJson(join(dataDir, 'aiscript_rules.json'))
  } catch {
    /* the catalogue is optional at runtime: ids still resolve, text degrades */
  }

  const all = [...(functionsRaw.functions ?? []), ...(functionsRaw.variables ?? []), ...(functionsRaw.operators ?? [])]
  const entries = all.map(normalizeEntry)

  // 客户端比知识库新时（`aicoin_library_refresh` 会写这个文件），把「本地还不认识
  // 但客户端确实有」的条目补成 stub：函数名可解析、参数个数未知、文档原样保留。
  // 目的只有一个 —— 别把真实存在的函数误报成 UNKNOWN_FUNCTION。
  const known = new Set(entries.map((entry) => entry.name))
  let liveExtra = []
  try {
    const extra = readJson(join(dataDir, 'live-extra.json'))
    liveExtra = Array.isArray(extra?.entries) ? extra.entries : []
  } catch {
    /* 没有这个文件是常态 */
  }
  for (const item of liveExtra) {
    const name = String(item?.name ?? '').trim()
    if (!name || known.has(name)) continue
    known.add(name)
    entries.push({
      name,
      callName: name,
      category: String(item.category ?? '客户端新增'),
      type: 'function',
      signature: '',
      version: null,
      summary: String(item.summary ?? ''),
      returns: '',
      params: [],
      minArgs: 0,
      maxArgs: null,
      examples: [],
      notes: [],
      snippet: '',
      doc: String(item.doc ?? ''),
      flags: {
        rootScopeOnly: false,
        singleDeclaration: false,
        requiresUniqueId: false,
        conditionFirstParam: false,
        arityUnknown: true,
      },
      source: 'live-extra',
    })
  }

  /** callable name -> entry (dotted names such as `line.new` included). */
  const byCall = new Map()
  /** Every name the library documents, callable or not. */
  const byName = new Map()
  // Priority order matters: a function entry must win a name collision against
  // an operator entry whose signature was scraped from a code sample (the `?:`
  // entry's signature literally reads `plot(trend, ...)`).
  const priority = [
    ...entries.filter((e) => e.type === 'function'),
    ...entries.filter((e) => e.type === 'operators'),
    ...entries.filter((e) => e.type === 'variable'),
  ]
  const CALLABLE_SIGNATURE = /^[A-Za-z_\u4E00-\u9FAF][\w.\u4E00-\u9FAF]*\s*\(/
  for (const entry of priority) {
    if (!byName.has(entry.name)) byName.set(entry.name, entry)
    const callable = CALLABLE_SIGNATURE.test(String(entry.signature ?? ''))
    if (callable) {
      // `iff` lives in the 条件表达式 category (type "operators") but is called
      // like a function, so operators are indexed here too.
      if (!byCall.has(entry.callName)) byCall.set(entry.callName, entry)
    }
    if (!byCall.has(entry.name) && (entry.type === 'function' || entry.type === 'operators')) {
      byCall.set(entry.name, entry)
    }
  }

  const variables = entries.filter((e) => e.type === 'variable')
  const operatorEntries = entries.filter((e) => e.type === 'operators')

  const builtinVars = new Set([...(language.builtinVars ?? []), ...variables.map((v) => v.name)])
  const namespaces = new Set(language.namespaces ?? [])
  for (const entry of entries) {
    for (const part of entry.name.split('.').slice(0, -1)) namespaces.add(part)
  }

  const rulesById = new Map((rules.rules ?? []).map((rule) => [rule.id, rule]))

  const kb = {
    dataDir,
    meta: functionsRaw.meta ?? {},
    categories: functionsRaw.categories ?? [],
    entries,
    liveExtraCount: liveExtra.filter((item) => item?.name).length,
    byCall,
    byName,
    functions: entries.filter((e) => e.type === 'function'),
    variables,
    operatorEntries,
    builtinVars,
    namespaces,
    language,
    rules: rules.rules ?? [],
    rulesById,
  }
  cache.set(`kb:${dataDir}`, kb)
  return kb
}

/** Look up the catalogue text for a rule id, with a safe fallback. */
export function ruleInfo(kb, id) {
  return kb.rulesById.get(id) ?? { id, severity: 'warning', title: id, message: id, hint: '' }
}

/** Clear the module cache (used by tests). */
export function resetCache() {
  cache.clear()
}
