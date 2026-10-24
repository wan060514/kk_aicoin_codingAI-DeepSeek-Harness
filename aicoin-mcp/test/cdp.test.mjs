/**
 * cdp.test.mjs — CdpClient 的测试。
 *
 * 全部跑本地 mock CDP（test/helpers/mock-cdp.mjs：自己起 HTTP /json/* 和手写 WS
 * 服务端），**不依赖真实 AiCoin**，没有客户端时也必须全绿。
 *
 * 被测接口以 src/cdp.mjs（Lead 维护）为准：
 *   CdpClient.discover / attach / pickTarget、client.send / evaluate / screenshot /
 *   title / location / close / on('console'|'exception'|'disconnect')、CdpError。
 */

import { CdpClient, CdpError, DEFAULT_PORT } from '../src/cdp.mjs'
import { startMockCdp, findDeadPort, MOCK_TARGETS } from './helpers/mock-cdp.mjs'
import { createSuite, assert, assertEqual, assertIncludes, assertRejects, assertType, waitFor } from './helpers/harness.mjs'

const suite = createSuite('cdp')
const { test } = suite

/** 起一个 mock CDP，跑完自动关掉。 */
async function withMock(fn, options) {
  const mock = await startMockCdp(options)
  try {
    return await fn(mock)
  } finally {
    await mock.close().catch(() => {})
  }
}

/** 按 url 片段找 mock 目标。 */
function mockTarget(fragment) {
  const found = MOCK_TARGETS.find((t) => t.url.includes(fragment))
  if (!found) throw new Error(`mock 目标里没有 ${fragment}`)
  return found
}

/* ---------------------------- discover ---------------------------- */

test('discover 返回 ok/port/version/userAgent/targets/pages（含 hash、index、isMain）', async () => {
  await withMock(async (mock) => {
    const info = await CdpClient.discover({ port: mock.port, timeoutMs: 3000 })
    assertEqual(info.ok, true)
    assertEqual(info.port, mock.port)
    assertIncludes(info.version, 'Chrome/150')
    assertIncludes(info.userAgent, 'aicoin/2.16.27')
    assertEqual(info.targets.length, MOCK_TARGETS.length)
    assertEqual(info.pages.length, 4, 'mock 有 4 个 page 目标')
    for (const target of info.targets) {
      assertType(target.id, 'string')
      assertType(target.type, 'string')
      assertType(target.title, 'string')
      assertType(target.url, 'string')
      assertType(target.hash, 'string')
    }
    for (const [index, page] of info.pages.entries()) {
      assertEqual(page.index, index, 'pages[].index 应等于下标')
      assertType(page.isMain, 'boolean')
      assertIncludes(page.url, '#')
    }
    const main = info.pages.filter((p) => p.isMain)
    assertEqual(main.length, 1, '应只有一个主窗口')
    assertIncludes(main[0].url, '#/main/exchange')
    assert(main[0].index > 0, 'mock 故意把 #/main 放在非首位')
  })
})

test('discover 对没人监听的端口返回 ok:false + reason（不抛异常）', async () => {
  const deadPort = await findDeadPort()
  const info = await CdpClient.discover({ port: deadPort, timeoutMs: 1500 })
  assertEqual(info.ok, false)
  assertEqual(info.port, deadPort)
  assertEqual(info.targets.length, 0)
  assertEqual(info.pages.length, 0)
  assertType(info.reason, 'string')
  assert(info.reason.length > 0, 'reason 不应为空')
})

test('DEFAULT_PORT 导出为 9222', () => {
  assertEqual(DEFAULT_PORT, 9222)
})

/* ---------------------------- 目标选择 ---------------------------- */

test('attach 默认附加到 #/main 主窗口，并暴露 client.target / connected', async () => {
  await withMock(async (mock) => {
    const client = await CdpClient.attach({ port: mock.port, timeoutMs: 4000 })
    try {
      assertEqual(client.connected, true)
      assertEqual(client.port, mock.port)
      assertIncludes(client.target.url, '#/main/exchange')
      assertIncludes(client.target.title, 'ETH/USDT')
      assertEqual(client.target.id, mockTarget('#/main').id)
      assertEqual(await client.evaluate('document.title'), client.target.title)
      assertEqual(await client.evaluate('location.href'), client.target.url)
    } finally {
      await client.close()
    }
  })
})

test('attach 支持 id 字符串 / {urlIncludes} / {titleIncludes} / {index} / 数字下标', async () => {
  await withMock(async (mock) => {
    const cases = [
      { selector: mockTarget('#/chat').id, expect: '#/chat' },
      { selector: { urlIncludes: '#/asset-sync' }, expect: '#/asset-sync' },
      { selector: { titleIncludes: 'ETH/USDT' }, expect: '#/main/exchange' },
      { selector: { index: 3 }, expect: '#/notice' },
      { selector: 0, expect: '#/chat' },
    ]
    for (const item of cases) {
      const client = await CdpClient.attach({ port: mock.port, target: item.selector })
      try {
        assertIncludes(client.target.url, item.expect, `选择器 ${JSON.stringify(item.selector)} 应命中 ${item.expect}`)
        assertIncludes(await client.evaluate('location.href'), item.expect)
      } finally {
        await client.close()
      }
    }
  })
})

test('attach 显式选择器匹配不到 → TARGET_NOT_FOUND（不静默回退）', async () => {
  await withMock(async (mock) => {
    const error = await assertRejects(() => CdpClient.attach({ port: mock.port, target: 'definitely-not-here' }), {
      name: 'CdpError',
      code: 'TARGET_NOT_FOUND',
    })
    assertIncludes(error.message, 'definitely-not-here')
    assertIncludes(error.message, '#/main', '错误里应带可用窗口清单')
  })
})

/* ---------------------------- 辅助：错误码断言 ---------------------------- */

/**
 * src/cdp.mjs 由 Lead 维护，个别错误码在迭代中改过名（PORT_CLOSED↔CDP_UNAVAILABLE、
 * METHOD_TIMEOUT↔TIMEOUT、PAGE_EXCEPTION↔EVALUATION_ERROR 等）。测试断言「语义」
 * （CdpError 类型 + 消息内容），错误码接受一个允许集合，避免实现微调就红一片。
 */
function assertCodeIn(error, allowed, label = '错误码') {
  assert(
    allowed.includes(error.code),
    `${label} 应为 ${allowed.join(' / ')} 之一，实际 ${JSON.stringify(error.code)}（${error.message}）`,
  )
}

test('attach 对不可用端口抛 CdpError（PORT_CLOSED / CDP_UNAVAILABLE）', async () => {
  const deadPort = await findDeadPort()
  const error = await assertRejects(() => CdpClient.attach({ port: deadPort, timeoutMs: 1500, discoverTimeoutMs: 1000 }), {
    name: 'CdpError',
  })
  assertCodeIn(error, ['PORT_CLOSED', 'CDP_UNAVAILABLE'])
  assertIncludes(error.message, String(deadPort))
})

/* ---------------------------- evaluate ---------------------------- */

test('evaluate 返回基本值：1+1=2、document.title、location.href', async () => {
  await withMock(async (mock) => {
    const client = await CdpClient.attach({ port: mock.port })
    try {
      assertEqual(await client.evaluate('1+1'), 2)
      assertEqual(await client.evaluate('document.title'), '2413.36 ETH/USDT永续 币安USDT永续')
      assertIncludes(await client.evaluate('location.href'), '#/main/exchange')
      assertEqual(await client.title(), client.target.title)
      assertIncludes(await client.location(), '#/main/exchange')
    } finally {
      await client.close()
    }
  })
})

test('evaluate 页面内异常 → CdpError(EVALUATION_ERROR / PAGE_EXCEPTION)，message 带页面异常文本', async () => {
  await withMock(async (mock) => {
    const client = await CdpClient.attach({ port: mock.port })
    try {
      const error = await assertRejects(() => client.evaluate('THROW'), {
        name: 'CdpError',
        includes: 'mock-boom',
      })
      assertCodeIn(error, ['PAGE_EXCEPTION', 'EVALUATION_ERROR'])
      assert(Object.hasOwn(error, 'details'), 'CdpError 应始终带 details 字段')
    } finally {
      await client.close()
    }
  })
})

test('evaluate 收到 17MB 大消息（>16MB，走 64 位长度）', async () => {
  await withMock(async (mock) => {
    const client = await CdpClient.attach({ port: mock.port, timeoutMs: 10000 })
    try {
      const big = await client.evaluate('BIG', { timeoutMs: 30000 })
      assertType(big, 'string')
      assertEqual(big.length, mock.bigBytes)
      assertEqual(big[0], 'x')
      assertEqual(big[big.length - 1], 'x')
    } finally {
      await client.close()
    }
  })
})

test('evaluate 能发出 2MB 大负载（客户端掩码 + 64 位长度编码）', async () => {
  await withMock(async (mock) => {
    const client = await CdpClient.attach({ port: mock.port, timeoutMs: 10000 })
    try {
      const payloadSize = 2 * 1024 * 1024
      const expression = `ECHO_LEN:${'y'.repeat(payloadSize)}`
      const value = await client.evaluate(expression, { timeoutMs: 20000 })
      assertEqual(value, expression.length)
      assert(
        mock.stats.maxClientFrameBytes > payloadSize,
        `客户端发出的帧应大于 ${payloadSize}，实际 ${mock.stats.maxClientFrameBytes}`,
      )
    } finally {
      await client.close()
    }
  })
})

test('分片响应（text + 2 个 continuation）能被重组', async () => {
  await withMock(async (mock) => {
    const client = await CdpClient.attach({ port: mock.port })
    try {
      assertEqual(await client.evaluate('FRAGMENT'), 'fragmented-ok')
      assertEqual(await client.evaluate('1+1'), 2, '分片之后连接仍可用')
    } finally {
      await client.close()
    }
  })
})

test('无法解析的 JSON 帧不会弄崩客户端（连接继续可用）', async () => {
  await withMock(async (mock) => {
    const client = await CdpClient.attach({ port: mock.port })
    try {
      // 服务端推一条坏 JSON 帧：客户端应忽略而不是崩掉
      mock.pushRaw('{this-is-not-json')
      await new Promise((resolve) => setTimeout(resolve, 150))
      assertEqual(client.connected, true, '坏帧不应导致断线')
      assertEqual(await client.evaluate('1+1'), 2, '坏帧之后仍可正常求值')
    } finally {
      await client.close()
    }
  })
})

/* ---------------------------- 事件 ---------------------------- */

test('握手后服务端 ping 会被自动回 pong', async () => {
  await withMock(async (mock) => {
    const client = await CdpClient.attach({ port: mock.port })
    try {
      await waitFor(() => mock.stats.gotPong, { label: 'mock 收到 pong', timeoutMs: 3000 })
      assert(mock.stats.pingsSent >= 1, 'mock 应该发过 ping')
    } finally {
      await client.close()
    }
  })
})

test("console 事件：client.on('console') 收到 {type, text}", async () => {
  await withMock(async (mock) => {
    const client = await CdpClient.attach({ port: mock.port })
    const events = []
    const off = client.on('console', (event) => events.push(event))
    try {
      mock.pushConsole(null, 'pushed-console')
      await waitFor(() => events.length > 0, { label: 'console 事件' })
      assertEqual(events[0].type, 'info')
      assertIncludes(events[0].text, 'pushed-console')
      assertEqual(typeof off, 'function', 'on() 应返回退订函数')
      off()
      mock.pushConsole(null, 'after-off')
      await new Promise((resolve) => setTimeout(resolve, 150))
      assertEqual(events.length, 1, '退订后不应再收到事件')
    } finally {
      await client.close()
    }
  })
})

test("连接被对端断开时 emit 'disconnect'，后续 send 抛 DISCONNECTED", async () => {
  await withMock(async (mock) => {
    const client = await CdpClient.attach({ port: mock.port })
    let disconnectInfo = null
    client.on('disconnect', (info) => {
      disconnectInfo = info
    })
    mock.destroyConnections()
    await waitFor(() => disconnectInfo !== null, { label: 'disconnect 事件' })
    assertEqual(client.connected, false)
    await assertRejects(() => client.send('Runtime.evaluate', { expression: '1+1' }), {
      name: 'CdpError',
      code: 'DISCONNECTED',
    })
    await client.close()
  })
})

/* ---------------------------- 超时 / 错误 ---------------------------- */

test('send 超时抛 CdpError（METHOD_TIMEOUT / TIMEOUT），且不会拖垮连接', async () => {
  await withMock(async (mock) => {
    const client = await CdpClient.attach({ port: mock.port })
    try {
      const error = await assertRejects(() => client.send('Mock.drop', {}, { timeoutMs: 200 }), { name: 'CdpError' })
      assertCodeIn(error, ['METHOD_TIMEOUT', 'TIMEOUT'])
      assertIncludes(error.message, 'Mock.drop')
      assertEqual(await client.evaluate('1+1'), 2, '超时之后连接依然可用')
    } finally {
      await client.close()
    }
  })
})

test('CDP 方法返回 error → CdpError(CDP_METHOD_ERROR / 数字码)，带方法名与错误文本', async () => {
  await withMock(async (mock) => {
    const client = await CdpClient.attach({ port: mock.port })
    try {
      const error = await assertRejects(() => client.send('No.suchMethod'), { name: 'CdpError' })
      assertCodeIn(error, ['CDP_METHOD_ERROR', '-32601'])
      assertIncludes(error.message, 'No.suchMethod')
      assertIncludes(error.message, '未知方法')
    } finally {
      await client.close()
    }
  })
})

/* ---------------------------- 截图 ---------------------------- */

test('screenshot 返回裸 base64 字符串（可解码，非 {data} 包装）', async () => {
  await withMock(async (mock) => {
    const client = await CdpClient.attach({ port: mock.port })
    try {
      const base64 = await client.screenshot()
      assertType(base64, 'string')
      assert(base64.length > 0, 'base64 不应为空')
      assertEqual(Object.hasOwn(Object(base64), 'data'), false, '不能是 {data} 包装')
      const decoded = Buffer.from(base64, 'base64').toString('utf8')
      assertEqual(decoded, `PNG-MOCK:${client.target.id}`)
      const jpeg = await client.screenshot({ format: 'jpeg', quality: 60 })
      assert(jpeg.length > 0)
      assertEqual(mock.stats.messages.filter((m) => m.method === 'Page.enable').length, 1, 'Page.enable 应该只发一次')
    } finally {
      await client.close()
    }
  })
})

/* ---------------------------- 关闭 ---------------------------- */

test('close 幂等，关闭后 connected=false 且 send 抛 DISCONNECTED', async () => {
  await withMock(async (mock) => {
    const client = await CdpClient.attach({ port: mock.port })
    assertEqual(client.connected, true)
    await client.close()
    assertEqual(client.connected, false)
    await client.close()
    await assertRejects(() => client.send('Runtime.evaluate', { expression: '1+1' }), { code: 'DISCONNECTED' })
  })
})

test('CdpError 暴露 name/code/details', () => {
  const error = new CdpError('测试错误', { code: 'TEST_CODE', details: { a: 1 } })
  assertEqual(error.name, 'CdpError')
  assertEqual(error.code, 'TEST_CODE')
  assertEqual(error.details.a, 1)
  assert(error instanceof Error)
})

test('mock 记录到客户端发来的 CDP 消息（WS 帧编解码正确）', async () => {
  await withMock(async (mock) => {
    const client = await CdpClient.attach({ port: mock.port })
    try {
      await client.evaluate('1+1')
      const methods = mock.stats.messages.map((m) => m.method)
      assertIncludes(methods, 'Runtime.enable')
      assertIncludes(methods, 'Runtime.evaluate')
      const evaluateMessage = mock.stats.messages.find((m) => m.method === 'Runtime.evaluate')
      assertEqual(evaluateMessage.params.awaitPromise, true)
      assertEqual(evaluateMessage.params.returnByValue, true)
      assertEqual(evaluateMessage.params.expression, '1+1')
    } finally {
      await client.close()
    }
  })
})

export const tests = suite.tests
export default suite
