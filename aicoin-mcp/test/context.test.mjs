/**
 * context.test.mjs — createContext 的测试（本地 mock CDP，不依赖真实 AiCoin）。
 *
 * 重点覆盖：
 *   - 懒连接 + 复用
 *   - attach 失败时的中文提示（「先运行 aicoin_launch」）
 *   - 带选择器 attach 时「目标不同自动重连」（lifecycle-dev 提的需求）
 *   - evaluate / screenshot 的透传形状、页面异常不吞
 */

import { CdpClient, CdpError } from '../src/cdp.mjs'
import { createContext, createLogger, MAIN_WINDOW_URL_HINT } from '../src/context.mjs'
import { startMockCdp, findDeadPort } from './helpers/mock-cdp.mjs'
import { createSuite, assert, assertEqual, assertIncludes, assertRejects, assertType, sleep } from './helpers/harness.mjs'

const suite = createSuite('context')
const { test } = suite

async function withMock(fn, options) {
  const mock = await startMockCdp(options)
  try {
    return await fn(mock)
  } finally {
    await mock.close().catch(() => {})
  }
}

function silentLog() {
  const lines = []
  const log = (lvl, message) => lines.push(`${String(lvl)}: ${message}`)
  log.lines = lines
  return log
}

/* ---------------------------- 基础 ---------------------------- */

test('createContext 默认值：port=9222、appPath、config 归一化', () => {
  const ctx = createContext({ log: silentLog() })
  assertEqual(ctx.port, 9222)
  assertEqual(ctx.config.port, 9222)
  assertEqual(ctx.isAttached, false)
  assertEqual(ctx.target, null)
  assertEqual(ctx.client, null)
  assertEqual(typeof ctx.attach, 'function')
  assertEqual(typeof ctx.evaluate, 'function')
  assertEqual(typeof ctx.screenshot, 'function')
  assertEqual(typeof ctx.discover, 'function')
  assertEqual(typeof ctx.close, 'function')

  const custom = createContext({ config: { port: 9333, appPath: 'C:/x/AiCoin.exe' }, log: silentLog() })
  assertEqual(custom.port, 9333)
  assertEqual(custom.appPath, 'C:/x/AiCoin.exe')
})

test('createContext 读环境变量 AICOIN_CDP_PORT / AICOIN_APP_PATH', async () => {
  const previousPort = process.env.AICOIN_CDP_PORT
  const previousApp = process.env.AICOIN_APP_PATH
  process.env.AICOIN_CDP_PORT = '9444'
  process.env.AICOIN_APP_PATH = 'D:/fake/AiCoin.exe'
  try {
    const ctx = createContext({ log: silentLog() })
    assertEqual(ctx.port, 9444)
    assertEqual(ctx.appPath, 'D:/fake/AiCoin.exe')
  } finally {
    if (previousPort === undefined) delete process.env.AICOIN_CDP_PORT
    else process.env.AICOIN_CDP_PORT = previousPort
    if (previousApp === undefined) delete process.env.AICOIN_APP_PATH
    else process.env.AICOIN_APP_PATH = previousApp
  }
})

test('attach + evaluate + title + screenshot 走通（默认主窗口）', async () => {
  await withMock(async (mock) => {
    const log = silentLog()
    const ctx = createContext({ config: { port: mock.port }, log })
    try {
      const client = await ctx.attach()
      assertEqual(ctx.isAttached, true)
      assertEqual(ctx.client, client)
      assertIncludes(ctx.target.url, MAIN_WINDOW_URL_HINT)
      assertIncludes(ctx.target.title, 'ETH/USDT')

      assertEqual(await ctx.evaluate('1+1'), 2)
      assertEqual(await ctx.evaluate('document.title'), ctx.target.title)
      assertEqual(await ctx.client.title(), ctx.target.title)

      const base64 = await ctx.screenshot()
      assertType(base64, 'string')
      assert(base64.length > 0)
      assertIncludes(Buffer.from(base64, 'base64').toString('utf8'), 'PNG-MOCK:')

      assert(log.lines.some((line) => line.startsWith('info:') && line.includes('已附加到 AiCoin 目标')), '应记录附加日志')
    } finally {
      await ctx.close()
    }
  })
})

test('attach 复用同一个连接；ctx.close 后再 attach 会重建', async () => {
  await withMock(async (mock) => {
    const ctx = createContext({ config: { port: mock.port }, log: silentLog() })
    try {
      const first = await ctx.attach()
      const second = await ctx.attach()
      assertEqual(first === second, true, '重复 attach 应复用连接')
      assertEqual(mock.stats.connections, 1, 'mock 只应有 1 条 ws 连接')

      await ctx.close()
      assertEqual(ctx.isAttached, false)
      assertEqual(ctx.target, null)
      await ctx.close() // 幂等

      const third = await ctx.attach()
      assert(first !== third, 'close 后 attach 应新建连接')
      assertEqual(mock.stats.connections, 2)
    } finally {
      await ctx.close()
    }
  })
})

/* ---------------------------- 选窗口 / 自动重连 ---------------------------- */

test('带选择器 attach：目标不同 → 自动关闭旧连接并切到新窗口', async () => {
  await withMock(async (mock) => {
    const ctx = createContext({ config: { port: mock.port }, log: silentLog() })
    try {
      await ctx.attach()
      assertIncludes(ctx.target.url, '#/main/exchange')

      const notice = await ctx.attach({ urlIncludes: '#/notice' })
      assertIncludes(notice.target.url, '#/notice')
      assertIncludes(ctx.target.url, '#/notice')
      assertEqual(mock.stats.connections, 2, '切换窗口应重连一次')
      assertIncludes(await ctx.evaluate('location.href'), '#/notice')

      // 同一个选择器再 attach 应复用（不重连）
      const again = await ctx.attach({ urlIncludes: '#/notice' })
      assertEqual(again, notice)
      assertEqual(mock.stats.connections, 2)

      // 换回主窗口
      await ctx.attach({ urlIncludes: MAIN_WINDOW_URL_HINT })
      assertIncludes(ctx.target.url, '#/main/exchange')
      assertEqual(mock.stats.connections, 3)
    } finally {
      await ctx.close()
    }
  })
})

test('attach({index}) 按 page 下标选窗口，重复调用复用连接', async () => {
  await withMock(async (mock) => {
    const ctx = createContext({ config: { port: mock.port }, log: silentLog() })
    try {
      // mock 里 index 0 = #/chat，2 = #/main/exchange
      const chat = await ctx.attach({ index: 0 })
      assertIncludes(chat.target.url, '#/chat')
      assertEqual(mock.stats.connections, 1)

      const reuse = await ctx.attach({ index: 0 })
      assertEqual(reuse, chat, '相同 index 应复用')
      assertEqual(mock.stats.connections, 1)

      const main = await ctx.attach({ index: 2 })
      assertIncludes(main.target.url, '#/main/exchange')
      assertEqual(mock.stats.connections, 2)
    } finally {
      await ctx.close()
    }
  })
})

test('attach({target: targetObj}) 支持 discover 返回的目标对象（lifecycle-dev 的用法）', async () => {
  await withMock(async (mock) => {
    const ctx = createContext({ config: { port: mock.port }, log: silentLog() })
    try {
      const info = await ctx.discover()
      assertEqual(info.ok, true)
      const notice = info.pages.find((page) => page.url.includes('#/notice'))
      const client = await ctx.attach({ target: notice, urlIncludes: notice.url })
      assertIncludes(client.target.url, '#/notice')
      assertIncludes(ctx.target.url, '#/notice')
    } finally {
      await ctx.close()
    }
  })
})

test('attach({port}) 端口变化 → 自动重连到新端口（防 9339/9222 串台）', async () => {
  const mockA = await startMockCdp()
  const mockB = await startMockCdp()
  const ctx = createContext({ config: { port: mockA.port }, log: silentLog() })
  try {
    const first = await ctx.attach()
    assertEqual(first.port, mockA.port)
    assertEqual(ctx.port, mockA.port)
    assertEqual(mockA.stats.connections, 1)

    // 显式换端口（lifecycle-dev 的 aicoin_app_eval {port:9339} 场景）
    const second = await ctx.attach({ port: mockB.port })
    assertEqual(second.port, mockB.port)
    assertEqual(ctx.port, mockB.port, 'ctx.port 应反映当前连接端口')
    assert(first !== second, '换端口必须重建连接')
    assertEqual(mockB.stats.connections, 1)

    // 换端口之后 evaluate 必须留在新端口上（不能偷偷跳回配置端口）
    assertEqual(await ctx.evaluate('1+1'), 2)
    assertEqual(ctx.port, mockB.port, 'evaluate 不应把连接切回配置端口')
    assertEqual(mockB.stats.connections, 1, 'evaluate 不应新建连接')

    // 同一端口再 attach 复用，不重连
    assertEqual(await ctx.attach({ port: mockB.port }), second)
    assertEqual(mockB.stats.connections, 1)

    // 省略端口时复用当前连接（不主动跳回配置端口）
    assertEqual(await ctx.attach(), second)

    // 显式指定回配置端口才切换
    const back = await ctx.attach({ port: mockA.port })
    assertEqual(back.port, mockA.port)
    assertEqual(ctx.port, mockA.port)
    assertEqual(mockA.stats.connections, 2)

    // discover 也支持临时端口覆盖
    const info = await ctx.discover({ port: mockB.port })
    assertEqual(info.ok, true)
    assertEqual(info.port, mockB.port)
  } finally {
    await ctx.close()
    await mockA.close().catch(() => {})
    await mockB.close().catch(() => {})
  }
})

test('attach 找不到目标 → 包装成 ATTACH_FAILED 并带「先运行 aicoin_launch」提示', async () => {
  await withMock(async (mock) => {
    const ctx = createContext({ config: { port: mock.port }, log: silentLog() })
    try {
      const error = await assertRejects(() => ctx.attach({ target: 'no-such-window' }), { name: 'CdpError', code: 'ATTACH_FAILED' })
      assertIncludes(error.message, '先运行 aicoin_launch')
      assertIncludes(error.message, 'no page target matched')
      assertIncludes(ctx.lastError ?? '', '先运行 aicoin_launch', 'ctx.lastError 应记录失败原因')
    } finally {
      await ctx.close()
    }
  })
})

test('端口没监听 → ATTACH_FAILED，提示先运行 aicoin_launch', async () => {
  const deadPort = await findDeadPort()
  const ctx = createContext({ config: { port: deadPort, timeoutMs: 1200 }, log: silentLog() })
  const error = await assertRejects(() => ctx.attach(), { name: 'CdpError', code: 'ATTACH_FAILED' })
  assertIncludes(error.message, '先运行 aicoin_launch')
  assertIncludes(error.message, String(deadPort))
  assertEqual(ctx.isAttached, false)
})

/* ---------------------------- 异常透传 ---------------------------- */

test('evaluate 页面内异常不被吞：抛 CdpError（EVALUATION_ERROR / PAGE_EXCEPTION），保留页面文本', async () => {
  await withMock(async (mock) => {
    const ctx = createContext({ config: { port: mock.port }, log: silentLog() })
    try {
      const error = await assertRejects(() => ctx.evaluate('THROW'), { name: 'CdpError' })
      assertIncludes(error.message, 'mock-boom')
      assert(
        ['PAGE_EXCEPTION', 'EVALUATION_ERROR'].includes(error.code),
        `错误码应为 PAGE_EXCEPTION 或 EVALUATION_ERROR，实际 ${error.code}`,
      )
    } finally {
      await ctx.close()
    }
  })
})

test('discover 不需要 attach 就能列目标', async () => {
  await withMock(async (mock) => {
    const ctx = createContext({ config: { port: mock.port }, log: silentLog() })
    const info = await ctx.discover()
    assertEqual(info.ok, true)
    assertEqual(info.pages.length, 4)
    assertEqual(ctx.isAttached, false, 'discover 不应顺便 attach')
  })
})

test('disconnect 事件后 ctx 认为未附加，可重新 attach', async () => {
  await withMock(async (mock) => {
    const ctx = createContext({ config: { port: mock.port }, log: silentLog() })
    try {
      await ctx.attach()
      assertEqual(ctx.isAttached, true)
      mock.destroyConnections()
      // 等 disconnect 回调把 current 置空
      for (let i = 0; i < 100 && ctx.isAttached; i += 1) await sleep(20)
      assertEqual(ctx.isAttached, false)
      const again = await ctx.attach()
      assertEqual(again.connected, true)
    } finally {
      await ctx.close()
    }
  })
})

/* ---------------------------- 日志器 ---------------------------- */

test('createLogger：级别过滤、函数式与 .info() 两种写法、自定义 sink', () => {
  const lines = []
  const log = createLogger({ level: 'warn', write: (line) => lines.push(line), prefix: 'test-prefix' })
  log.debug('debug 不该出现')
  log.info('info 不该出现')
  log('warn', 'warn 应出现')
  log.error('error 应出现', { code: 1 })
  assertEqual(lines.length, 2)
  assertIncludes(lines[0], '[test-prefix][warn] warn 应出现')
  assertIncludes(lines[1], '[test-prefix][error] error 应出现')
  assertIncludes(lines[1], '{"code":1}')
  assertEqual(log.enabled('debug'), false)
  assertEqual(log.enabled('error'), true)
})

export const tests = suite.tests
export default suite
