#!/usr/bin/env node
/**
 * dump-functionlib.mjs — 把 AiCoin 客户端的「函数库」(upgrade/customIndicator/script/functionLib)
 * 原文落盘到文件，供离线比对/建规则库用。数据不进模型上下文。
 *
 *   node scripts/dump-functionlib.mjs            # 默认写到 data/functionLib.json
 *   node scripts/dump-functionlib.mjs --out x.json --port 9222
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { openTarget, api } from '../src/inject.mjs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const out = resolve(arg('out', 'data/functionLib.json'))
const port = Number(arg('port', 9222))

const ctx = { port }
const { client, release } = await openTarget(ctx, 'main')
try {
  const res = await api(client, {
    method: 'post',
    path: 'upgrade/customIndicator/script/functionLib',
    data: {},
    includeData: true,
    maxChars: 50_000_000,
    timeout: 60000,
  })
  if (!res.success) {
    console.error(`[x] 业务失败 status=${res.status} message=${res.message}`)
    process.exit(1)
  }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(res.data, null, 1)}\n`, 'utf8')
  const cats = res.data?.list ?? []
  console.log(`[ok] ${out}  ${Buffer.byteLength(JSON.stringify(res.data))} bytes, ${cats.length} 个分类`)
  for (const c of cats) console.log(`  - ${c.title ?? '?'} (${c.type ?? '?'}): ${(c.list ?? []).length} 项`)
} finally {
  await release()
}
