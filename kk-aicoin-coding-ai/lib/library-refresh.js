/**
 * Keep the bundled function library honest against the live client.
 *
 * The knowledge base is generated from the client's own `functionLib` payload
 * (`tools/build_data.mjs`), so it is correct for exactly one client version. When
 * AiCoin ships a new build, a script that is valid in the client can be reported
 * as `UNKNOWN_FUNCTION` by the offline validator — a false alarm that costs a
 * round trip and erodes trust in the checker.
 *
 * `refreshLibrary` closes that gap in two steps:
 *
 *   1. read the live library (docs included) over CDP, diff names;
 *   2. on `apply`, persist a raw snapshot plus `data/live-extra.json` — the entries
 *      the client has and we do not. `lib/data.js` merges those as stubs, so
 *      they stop being "unknown" immediately and their real doc text is still
 *      shown by `aicoin_library_get`.
 *
 * It never rewrites `aiscript_functions.json`: regenerating parameter tables from
 * markdown needs the offline extractor, and silently degrading signatures into
 * guesses would be worse than the honest stub.
 *
 * @module kk_aicoin_codingAI/library-refresh
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { fetchLiveLibraryFull } from './live.js'

const normalise = (name) => String(name ?? '').trim()

/** Flatten the client payload into `[{name, category, doc}]`. */
export function flattenLive(categories) {
  const out = []
  for (const category of Array.isArray(categories) ? categories : []) {
    for (const item of Array.isArray(category?.items) ? category.items : []) {
      const name = normalise(item?.key ?? item?.name)
      if (!name) continue
      out.push({
        name,
        category: String(category?.title ?? ''),
        doc: String(item?.doc ?? ''),
        summary: String(item?.text ?? ''),
        isPro: item?.isPro === true,
      })
    }
  }
  return out
}

/**
 * @param {object} options
 * @param {number} options.port          CDP port (defaults to 9222).
 * @param {object} options.kb            loaded knowledge base (`loadKnowledge`).
 * @param {string} options.dataDir       directory that holds the data JSON files.
 * @param {boolean} [options.apply]      persist the raw snapshot + live-extra stubs.
 * @returns {Promise<object>} summary — never throws for a normal diff.
 */
export async function refreshLibrary({ port, kb, dataDir, apply = false } = {}) {
  const live = await fetchLiveLibraryFull(port)
  if (!live.ok) return { ok: false, message: live.message }

  const liveEntries = flattenLive(live.categories)
  const bundledNames = new Set(kb.entries.map((entry) => normalise(entry.name)))
  const liveNames = new Set(liveEntries.map((entry) => entry.name))
  const missingLocally = [...liveNames].filter((name) => !bundledNames.has(name)).sort()
  const extraLocally = [...bundledNames].filter((name) => !liveNames.has(name)).sort()
  const inSync = missingLocally.length === 0 && extraLocally.length === 0

  const result = {
    ok: true,
    liveCount: liveNames.size,
    bundledCount: bundledNames.size,
    liveTotal: live.totalItems ?? liveEntries.length,
    inSync,
    missingLocally,
    extraLocally,
    applied: false,
    rawPath: null,
    extraPath: null,
    message: inSync
      ? `知识库与客户端一致：${liveNames.size} 条`
      : `知识库落后 ${missingLocally.length} 条、多出 ${extraLocally.length} 条`,
  }

  if (!inSync && apply) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    mkdirSync(dataDir, { recursive: true })
    const rawPath = join(dataDir, `client-functionLib-${stamp}.json`)
    writeFileSync(
      rawPath,
      `${JSON.stringify({ fetchedAt: new Date().toISOString(), port, total_items: live.totalItems, categories: live.categories }, null, 2)}\n`,
      'utf8',
    )
    const extraPath = join(dataDir, 'live-extra.json')
    const entries = liveEntries.filter((entry) => missingLocally.includes(entry.name))
    writeFileSync(
      extraPath,
      `${JSON.stringify({ generatedAt: new Date().toISOString(), source: 'aicoin_library_refresh', liveTotal: live.totalItems, entries }, null, 2)}\n`,
      'utf8',
    )
    result.applied = true
    result.rawPath = rawPath
    result.extraPath = extraPath
    result.message += '；已留存原始快照并写入 live-extra.json（重载插件后生效）'
  } else if (!inSync) {
    result.message += '；加 apply:true 可把缺失条目补成 stub（不会覆盖现有签名）'
  }

  return result
}
