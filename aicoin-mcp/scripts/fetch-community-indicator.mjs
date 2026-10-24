/**
 * Fetch a community indicator's source through the client's own session and
 * write it to disk byte-exactly.
 *
 * usage: node scripts/fetch-community-indicator.mjs --search "主力波段买卖点" --out "..\aicoin-re\主力波段买卖点-源码.txt"
 *
 * Read-only: calls `upgrade/scriptCommunity/list` (GET-shaped listing). It does
 * not subscribe, like, or write anything, and it deliberately drops the
 * platform's performance fields from the metadata sidecar.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve, isAbsolute } from 'node:path'
import { CdpClient } from '../src/cdp.mjs'
import { api } from '../src/inject.mjs'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const port = Number(arg('port', 9222))
const search = String(arg('search', '主力波段买卖点'))
const title = String(arg('title', search))
const outPath = resolve(process.cwd(), arg('out', `community-${search}.txt`))
const metaPath = outPath.replace(/\.txt$/i, '.meta.json')

const cdp = await CdpClient.attach({ port, timeoutMs: 8000 })
try {
  // The UI's own request shape (renderer 2196.js / 7689.js). `search` is the
  // keyword field; the other keys are required or the server answers 10011.
  const body = {
    autoTrade: 0,
    class: 'all',
    openSource: 0,
    public: 0,
    search,
    selected: 0,
    pageCursor: '',
    pageSize: 50,
  }
  const res = await api(cdp, { method: 'post', path: 'upgrade/scriptCommunity/list', data: body, includeData: true })
  const payload = res?.data?.data ?? res?.data ?? res
  const list = payload?.list ?? payload?.data?.list ?? []
  if (!Array.isArray(list) || !list.length) {
    console.error(`[x] no community indicator matched search="${search}"（success=${res?.success} status=${res?.status}）`)
    process.exit(1)
  }
  const hit = list.find((item) => String(item.title ?? '').trim() === title.trim()) ?? list[0]
  const source = hit.scriptValue
  if (typeof source !== 'string' || !source.trim()) {
    console.error(`[x] "${hit.title}" has no scriptValue in the list payload (source may be gated)`)
    process.exit(2)
  }
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, source, 'utf8')

  const meta = {
    id: hit.id,
    title: hit.title,
    author: hit.userName,
    authorId: hit.userId,
    isOfficial: Boolean(hit.isOfficial),
    subsType: hit.subsType,
    subscribed: hit.subsState === 1,
    openSource: hit.openSource,
    accessFlag: hit.accessFlag,
    hasTrade: Boolean(hit.hasTrade),
    supportsBacktest: Boolean(hit.isSupportBacktest),
    symbol: hit.symbol,
    symbolName: hit.symbolName,
    periodSeconds: hit.period,
    tagTexts: hit.tagTexts ?? [],
    describe: hit.describe ?? '',
    subCount: hit.subCount,
    createTime: hit.createTime,
    sourceChars: source.length,
    sourceLines: source.split('\n').length,
    fetchedAt: new Date().toISOString(),
    fetchedVia: `aicoin/2.16.27 scriptCommunity/list (port ${port})`,
    note: 'source is the scriptValue field returned by the listing endpoint; platform performance fields are intentionally not copied',
  }
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8')

  console.log(`[ok] ${hit.title}`)
  console.log(`     id=${hit.id} author=${hit.userName} subsType=${hit.subsType} openSource=${hit.openSource} subscribed=${meta.subscribed}`)
  console.log(`     chart=${hit.symbolName}(${hit.symbol}) period=${hit.period}s hasTrade=${meta.hasTrade}`)
  console.log(`     source: ${source.length} chars / ${meta.sourceLines} lines -> ${outPath}`)
  console.log(`     meta  : ${metaPath}`)
} finally {
  await cdp.close()
}
