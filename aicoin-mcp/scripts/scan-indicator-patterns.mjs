/**
 * Read-only style/claims scan over the account's indicator sources.
 *
 * Answers, with evidence:
 *   1. is single-line `if (cond) statement` (no braces) actually used anywhere?
 *   2. is bracket-less multi-return `a, b, c = f()` used anywhere?
 *   3. how do td() users map the sign?
 *   4. rough "claim vs code" check: does the source mention the indicators its
 *      description advertises (macd/rsi/boll/volume/td/ema/...)?
 *
 * usage: node scripts/scan-indicator-patterns.mjs [--port 9222]
 */
import { CdpClient } from '../src/cdp.mjs'
import { api } from '../src/inject.mjs'

const port = Number((() => {
  const i = process.argv.indexOf('--port')
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : 9222
})())

const BARE_ASSIGN = /^\s*(?!\[)([A-Za-z_]\w*\s*,\s*[A-Za-z_]\w*\s*,\s*[A-Za-z_]\w*)\s*=\s*(boll|macd|kdj|stoch|dmi|aroon|supertrend)\s*\(/m
const BRACKET_ASSIGN = /^\s*\[\s*[A-Za-z_]\w*\s*,.*\]\s*=\s*(boll|macd|kdj|stoch|dmi|aroon|supertrend)\s*\(/m
const TD_USE = /\b(td\w*)\s*==\s*(-?)9\b/g

/**
 * Find `if (cond) statement` written without a block.
 *
 * Uses "last ) on the line" instead of a regex over the condition, because
 * conditions contain nested calls like nz(x, 0) that defeat simple patterns.
 * A line whose text after the last `)` starts with `{` (or is empty, meaning the
 * condition continues on the next line) is NOT a single-line if.
 */
function findSingleLineIf(src) {
  const hits = []
  for (const raw of src.split('\n')) {
    const line = raw.trim()
    // ignore trailing comments so `if (x) // note` is not a statement
    const code = line.split('//')[0].trim()
    if (!/^if\s*\(/.test(code)) continue
    if (code.endsWith('{')) continue // block opening braces on the same line
    const close = code.lastIndexOf(')')
    if (close === -1) continue
    const rest = code.slice(close + 1).trim()
    if (!rest || rest.startsWith('{')) continue
    // Only count it when what follows is a real statement, not the tail of a
    // multi-line condition such as `if (a) > b * 2`.
    if (!/(:=|=|\(|\.\w+\s*\()/.test(rest)) continue
    hits.push(line)
  }
  return hits
}

const cdp = await CdpClient.attach({ port, timeoutMs: 8000 })
try {
  const res = await api(cdp, {
    method: 'post',
    path: 'upgrade/customIndicator/script/list',
    includeData: true,
    maxChars: 8_000_000,
  })
  const payload = res?.data?.data ?? res?.data ?? res
  const list = payload?.customList ?? payload?.list ?? payload?.data?.customList ?? []
  if (!Array.isArray(list) || !list.length) {
    console.error(`[x] no indicators returned (success=${res?.success} status=${res?.status})`)
    process.exit(1)
  }
  const withSource = list.filter((item) => typeof item.scriptValue === 'string' && item.scriptValue.trim())

  const bare = []
  const bracketed = []
  const singleIf = []
  const tdRows = []
  let tcHit = 0

  for (const item of withSource) {
    const src = item.scriptValue
    const row = { id: item.id, name: item.name }
    if (BARE_ASSIGN.test(src)) {
      const line = src.split('\n').find((l) => BARE_ASSIGN.test(`${l}\n`) && !/^\s*\[/.test(l)) ?? ''
      bare.push({ ...row, line: line.trim() })
    }
    if (BRACKET_ASSIGN.test(src)) bracketed.push(row)

    const badIf = findSingleLineIf(src)
    if (badIf.length) singleIf.push({ ...row, line: badIf[0], count: badIf.length })

    let m
    TD_USE.lastIndex = 0
    while ((m = TD_USE.exec(src))) {
      const ls = src.lastIndexOf('\n', m.index) + 1
      const le = src.indexOf('\n', m.index)
      const line = src.slice(ls, le === -1 ? undefined : le).trim()
      tdRows.push({ ...row, sign: m[2] === '-' ? '-9' : '9', line })
    }
  }

  console.log(`扫描：${withSource.length} 个带源码的指标（共 ${list.length} 条）\n`)

  console.log('===== Q1：单行 if（不带大括号）=====')
  console.log(`命中 ${singleIf.length} 个指标`)
  for (const row of singleIf.slice(0, 6)) console.log(`  - ${row.name}: ${row.line}`)
  console.log(singleIf.length ? '=> 存在先例，客户端可能接受这种写法\n' : '=> 0 先例：更可能是语法错误\n')

  console.log('===== Q2：无方括号多返回值 =====')
  console.log(`命中 ${bare.length} 个；带方括号 ${bracketed.length} 个`)
  for (const row of bare.slice(0, 6)) console.log(`  - ${row.name}: ${row.line}`)
  console.log('')

  console.log('===== Q3：td() 符号方向 =====')
  if (!tdRows.length) console.log('样本里没有 td() 调用')
  else {
    const tally = {}
    for (const row of tdRows) {
      const bottom = /底|买|多|long|buy|bottom/i.test(row.line)
      const top = /顶|卖|空|short|sell|top/i.test(row.line)
      const cls = bottom && !top ? 'bottom' : top && !bottom ? 'top' : 'ambiguous'
      const key = `${row.sign} -> ${cls}`
      tally[key] = (tally[key] ?? 0) + 1
    }
    console.log(`用到 td 的指标 ${new Set(tdRows.map((r) => r.id)).size} 个`)
    for (const [k, v] of Object.entries(tally).sort()) console.log(`  ${k}: ${v}`)
  }
} finally {
  await cdp.close()
}
