/**
 * test/real-cdp-smoke.mjs — 真实 AiCoin 联调脚本（不进入 `node test/run.mjs`，
 * 因为它依赖本机正在运行的 AiCoin + CDP 端口 9222）。
 *
 * 用法：
 *   node test/real-cdp-smoke.mjs            # 默认 9222
 *   node test/real-cdp-smoke.mjs --port 9222
 *
 * 它做的事（也就是验收要求的三条）：
 *   1) discover：列出 /json/list 目标，确认 4 个 page 与 #/main 主窗口
 *   2) attach 默认目标 → evaluate('1+1')、document.title
 *   3) screenshot → base64 长度（主窗口才出帧）
 * 任何一步失败都会以非 0 退出。
 */

import { CdpClient } from '../src/cdp.mjs'

const portArgIndex = process.argv.indexOf('--port')
const port = portArgIndex === -1 ? 9222 : Number(process.argv[portArgIndex + 1])
const started = Date.now()
let failed = 0

function ok(label, value) {
  console.log(`✓ ${label}: ${value}`)
}

function fail(label, error) {
  failed += 1
  console.log(`✗ ${label}: ${error?.code ?? ''} ${error?.message ?? error}`)
}

const info = await CdpClient.discover({ port, timeoutMs: 4000 })
if (!info.ok) {
  console.log(`✗ discover 失败：端口 ${port} 不可用（${info.reason}）`)
  console.log('  请先启动带 --remote-debugging-port=9222 的 AiCoin。')
  process.exit(1)
}
const versionText = typeof info.version === 'string' ? info.version : (info.version?.Browser ?? info.browser ?? '未知')
ok('discover', `version=${versionText} targets=${info.targets.length} pages=${info.pages.length}`)
for (const page of info.pages) {
  console.log(`    page[${page.index}] isMain=${page.isMain} hash=${page.hash} title=${JSON.stringify(page.title)}`)
}

const client = await CdpClient.attach({ port, timeoutMs: 6000 })
try {
  ok('attach', `target=${client.target.hash} connected=${client.connected}`)
  const onePlusOne = await client.evaluate('1+1')
  if (onePlusOne === 2) ok('evaluate 1+1', onePlusOne)
  else fail('evaluate 1+1', `期望 2，实际 ${onePlusOne}`)

  const title = await client.evaluate('document.title')
  ok('document.title', JSON.stringify(title))

  const href = await client.evaluate('location.href')
  ok('location.href', String(href).slice(0, 100))

  const base64 = await client.screenshot()
  ok('screenshot base64 长度', `${base64.length} 字符（≈ ${Math.round((base64.length * 3) / 4 / 1024)} KB）`)
  ok('screenshot 前 16 字符', base64.slice(0, 16))

  // 选择器负向验证：显式选一个后台窗口（不截图，避免等超时）
  const notice = await CdpClient.attach({ port, target: { urlIncludes: '#/notice' } })
  try {
    ok('显式选择 #/notice', `target=${notice.target.hash} 独立连接=${notice !== client}`)
  } finally {
    await notice.close()
  }
} catch (error) {
  fail('真实联调', error)
} finally {
  await client.close()
}

// 异常透传验证：页面内抛错必须抛 CdpError（业务层的 {success:false} 是返回值，不在此列）
const probe = await CdpClient.attach({ port, timeoutMs: 6000 })
try {
  await probe.evaluate('(() => { throw new Error("smoke-page-boom") })()')
  fail('页面异常透传', '没有抛异常（BUG）')
} catch (error) {
  if (String(error.message).includes('smoke-page-boom')) ok('页面异常透传', `${error.code}: ${String(error.message).split('\n')[0]}`)
  else fail('页面异常透传', error)
} finally {
  await probe.close()
}

console.log(`\n耗时 ${Date.now() - started}ms，${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
