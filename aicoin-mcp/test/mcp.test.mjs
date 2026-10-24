/**
 * mcp.test.mjs — MCP stdio 服务器端到端测试。
 *
 * 用真实子进程：`node src/server.mjs --port <mockPort>`，通过 stdin/stdout 发
 * JSON-RPC 2.0，用本地 mock CDP 提供页面能力。**不依赖真实 AiCoin**。
 *
 * 覆盖：initialize 协商 / notifications/initialized / ping / tools/list /
 * tools/call（正常/对象/content/isError/未知工具/坏参数）/ 未知方法 -32601 /
 * 坏 JSON -32700 / 半行缓冲 / 批量请求 / stdout 只有协议帧 / 坏工具模块容错 /
 * stdin EOF 后进程 0 退出。
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockCdp, findDeadPort } from './helpers/mock-cdp.mjs'
import { startMockMcpClient } from './helpers/mock-mcp-client.mjs'
import { createSuite, assert, assertEqual, assertIncludes, assertRejects, sleep, waitFor } from './helpers/harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures', 'tools')

const suite = createSuite('mcp')
const { test } = suite

/**
 * 起一个 server 子进程（可选同时起 mock CDP），跑完自动清理。
 * @param {(client: any, mock: any, deadPort: number) => Promise<void>} fn
 */
async function withServer(fn, { cdp = 'dead', env = {} } = {}) {
  const deadPort = await findDeadPort()
  let mock = null
  let port = deadPort
  if (cdp === 'mock') {
    mock = await startMockCdp()
    port = mock.port
  }
  const client = await startMockMcpClient({
    args: ['--port', String(port)],
    env: { AICOIN_TOOLS_DIR: FIXTURES, AICOIN_LOG_LEVEL: 'info', ...env },
  })
  try {
    await fn(client, mock, deadPort)
  } finally {
    client.kill()
    if (mock) await mock.close().catch(() => {})
  }
}

const INITIALIZE_PARAMS = {
  protocolVersion: '2025-06-18',
  capabilities: { roots: { listChanged: false } },
  clientInfo: { name: 'mock-mcp-client', version: '0.0.0' },
}

/** initialize + initialized 的公共前置。 */
async function handshake(client, params = INITIALIZE_PARAMS) {
  const response = await client.request('initialize', params)
  client.notify('notifications/initialized')
  return response
}

/* ---------------------------- 协议 ---------------------------- */

test('initialize 协商协议版本并返回 serverInfo/capabilities', async () => {
  await withServer(async (client) => {
    const response = await handshake(client)
    assertEqual(response.jsonrpc, '2.0')
    assertEqual(typeof response.id, 'number')
    assertEqual(response.result.protocolVersion, '2025-06-18')
    assertEqual(response.result.serverInfo.name, 'aicoin-mcp')
    assertEqual(typeof response.result.serverInfo.version, 'string')
    assertEqual(response.result.capabilities.tools.listChanged, false)
    assertIncludes(response.result.instructions, 'AiCoin')
  })
})

test('initialize 收到不支持的协议版本 → 回退到服务端最新版本（不报错）', async () => {
  await withServer(async (client) => {
    const response = await client.request('initialize', { protocolVersion: '1999-01-01', clientInfo: { name: 'old' } })
    assertEqual(response.result.protocolVersion, '2025-06-18')
    await client.waitForStderr('不受支持', { timeoutMs: 5000 })
  })
})

test('initialize 完全省略 protocolVersion 也能成功', async () => {
  await withServer(async (client) => {
    const response = await client.request('initialize', {})
    assertEqual(response.result.protocolVersion, '2025-06-18')
  })
})

test('notifications/initialized 是通知：不回任何包', async () => {
  await withServer(async (client) => {
    await handshake(client)
    const before = client.rawLines.length
    client.notify('notifications/initialized')
    await sleep(250)
    assertEqual(client.rawLines.length, before, '通知不应该产生 stdout 行')
  })
})

test('ping 返回空 result', async () => {
  await withServer(async (client) => {
    const response = await client.request('ping')
    assertEqual(response.jsonrpc, '2.0')
    assertEqual(JSON.stringify(response.result), '{}')
  })
})

test('未知方法 → JSON-RPC 错误 -32601', async () => {
  await withServer(async (client) => {
    const error = await assertRejects(() => client.request('no/such/method'), { includes: '未知方法' })
    assertEqual(error.rpcError.code, -32601)
    assertIncludes(error.rpcError.message, 'no/such/method')
  })
})

test('坏 JSON → -32700（id=null），之后连接仍可正常请求', async () => {
  await withServer(async (client) => {
    await handshake(client)
    client.writeRaw('{this is not json}\n')
    const errorFrame = await client.waitForMessage((message) => message?.error?.code === -32700, { label: '解析错误帧' })
    assertEqual(errorFrame.jsonrpc, '2.0')
    assertEqual(errorFrame.id, null)
    assertEqual((await client.request('ping')).result !== undefined, true)
  })
})

test('半行缓冲：分两次写入的请求也能正确解析', async () => {
  await withServer(async (client) => {
    client.writeRaw('{"jsonrpc":"2.0","id":77,"method":"pi')
    await sleep(120)
    client.writeRaw('ng"}\n')
    const frame = await client.waitForMessage((message) => message?.id === 77, { label: '半行请求的响应' })
    assertEqual(frame.jsonrpc, '2.0')
    assertEqual(JSON.stringify(frame.result), '{}')
  })
})

test('批量请求 → 单个数组帧回应（JSON-RPC 2.0 语义）', async () => {
  await withServer(async (client) => {
    const batch = [
      { jsonrpc: '2.0', id: 101, method: 'ping' },
      { jsonrpc: '2.0', id: 102, method: 'tools/list' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    ]
    client.writeRaw(`${JSON.stringify(batch)}\n`)
    const frame = await client.waitForMessage((message) => Array.isArray(message), { label: '批量响应数组' })
    assertEqual(frame.length, 2, '通知不应出现在批量响应里')
    assertEqual(frame[0].id, 101)
    assertEqual(frame[1].id, 102)
    assert(Array.isArray(frame[1].result.tools), 'tools/list 结果应带 tools 数组')
  })
})

test('空的批量数组 → -32600', async () => {
  await withServer(async (client) => {
    client.writeRaw('[]\n')
    const errorFrame = await client.waitForMessage((message) => message?.error?.code === -32600, { label: '空批量错误' })
    assertEqual(errorFrame.id, null)
  })
})

/* ---------------------------- tools/list ---------------------------- */

test('tools/list 返回动态加载的工具 + 内置 framework_info，schema 完整', async () => {
  await withServer(async (client) => {
    await handshake(client)
    const response = await client.request('tools/list', {})
    const tools = response.result.tools
    assert(Array.isArray(tools) && tools.length >= 8, `工具数应 >= 8，实际 ${tools?.length}`)
    const names = tools.map((tool) => tool.name)
    for (const expected of ['echo_tool', 'object_tool', 'content_tool', 'fail_tool', 'mock_eval', 'mock_where', 'mock_shot', 'framework_info']) {
      assert(names.includes(expected), `tools/list 应包含 ${expected}，实际：${names.join(', ')}`)
    }
    assertEqual(names.join(','), [...names].sort().join(','), 'tools/list 应按名字排序')
    for (const tool of tools) {
      assert(typeof tool.name === 'string' && tool.name.length > 0, '每个工具都要有 name')
      assert(typeof tool.description === 'string' && tool.description.length > 0, `${tool.name} 要有 description`)
      assertEqual(tool.inputSchema?.type, 'object', `${tool.name} 的 inputSchema.type 应为 object`)
      assertEqual(Object.hasOwn(tool, 'handler'), false, '不能把 handler 泄露到 tools/list')
    }
  })
})

/* ---------------------------- tools/call ---------------------------- */

test('tools/call：字符串结果 / 对象结果 / content 透传', async () => {
  await withServer(async (client) => {
    await handshake(client)

    const echo = await client.request('tools/call', { name: 'echo_tool', arguments: { text: 'hi' } })
    assertEqual(echo.result.content[0].type, 'text')
    assertEqual(echo.result.content[0].text, 'echo: hi')
    assertEqual(echo.result.isError, undefined)

    const object = await client.request('tools/call', { name: 'object_tool', arguments: {} })
    assertEqual(JSON.parse(object.result.content[0].text).ok, true)

    const content = await client.request('tools/call', { name: 'content_tool', arguments: {} })
    assertEqual(content.result.content[0].text, 'custom-content')
    assertEqual(content.result.isError, true)
  })
})

test('tools/call：handler 抛错 → isError:true（不是 JSON-RPC 错误）', async () => {
  await withServer(async (client) => {
    await handshake(client)
    const response = await client.request('tools/call', { name: 'fail_tool', arguments: {} })
    assertEqual(response.result.isError, true)
    assertIncludes(response.result.content[0].text, '故意失败')
    assertIncludes(response.result.content[0].text, 'fail_tool')
  })
})

test('tools/call：未知工具 → -32602；arguments 非对象 → -32602；缺 name → -32602', async () => {
  await withServer(async (client) => {
    await handshake(client)
    const unknown = await assertRejects(() => client.request('tools/call', { name: 'no_such_tool', arguments: {} }), {
      includes: '未知工具',
    })
    assertEqual(unknown.rpcError.code, -32602)

    const badArgs = await assertRejects(() => client.request('tools/call', { name: 'echo_tool', arguments: 'not-an-object' }), {
      includes: 'arguments',
    })
    assertEqual(badArgs.rpcError.code, -32602)

    const noName = await assertRejects(() => client.request('tools/call', { arguments: {} }), { includes: 'name' })
    assertEqual(noName.rpcError.code, -32602)
  })
})

test('tools/call：framework_info 自检工具可用，返回工具清单', async () => {
  await withServer(async (client) => {
    await handshake(client)
    const response = await client.request('tools/call', { name: 'framework_info', arguments: {} })
    const info = JSON.parse(response.result.content[0].text)
    assertEqual(info.name, 'aicoin-mcp')
    assert(info.toolCount >= 8, 'toolCount 应 >= 8')
    assert(info.tools.includes('echo_tool'), 'tools 清单应包含 echo_tool')
    assertEqual(typeof info.cdp.port, 'number')
  })
})

/* ---------------------------- 与 CDP 的联调（mock） ---------------------------- */

test('tools/call → ctx.evaluate 走到 mock CDP（mock_eval 返回 1+1=2）', async () => {
  await withServer(
    async (client, mock) => {
      await handshake(client)
      const response = await client.request('tools/call', { name: 'mock_eval', arguments: { expression: '1+1' } })
      assertEqual(response.result.content[0].text, '2')
      assert(mock.stats.connections >= 1, '应建立过 ws 连接')
      assertIncludes(mock.stats.messages.map((m) => m.method), 'Runtime.evaluate')
    },
    { cdp: 'mock' },
  )
})

test('tools/call → mock_where 报出连的是主窗口（ctx.attach 默认 #/main）', async () => {
  await withServer(
    async (client) => {
      await handshake(client)
      const response = await client.request('tools/call', { name: 'mock_where', arguments: {} })
      const where = JSON.parse(response.result.content[0].text)
      assertIncludes(where.url, '#/main/exchange')
      assertEqual(where.attached, true)
      assertEqual(typeof where.port, 'number')
      assertIncludes(where.title, 'ETH/USDT')
    },
    { cdp: 'mock' },
  )
})

test('tools/call → mock_shot 截图返回长度（走 ctx.screenshot → client.screenshot）', async () => {
  await withServer(
    async (client) => {
      await handshake(client)
      const response = await client.request('tools/call', { name: 'mock_shot', arguments: {} })
      const shot = JSON.parse(response.result.content[0].text)
      assert(shot.length > 0, 'base64 长度应 > 0')
      assertIncludes(shot.head, 'PNG-MOCK:')
    },
    { cdp: 'mock' },
  )
})

/* ---------------------------- 健壮性 ---------------------------- */

test('没有 AiCoin 也能启动并提供协议（工具照常列出，attach 失败才报错）', async () => {
  await withServer(async (client) => {
    const response = await handshake(client)
    assertEqual(response.result.serverInfo.name, 'aicoin-mcp')
    const list = await client.request('tools/list', {})
    assert(list.result.tools.length >= 8)
    // 死端口上调用需要页面的工具 → 工具层返回 isError，而不是让服务器崩
    const call = await client.request('tools/call', { name: 'mock_eval', arguments: { expression: '1+1' } })
    assertEqual(call.result.isError, true)
    assertIncludes(call.result.content[0].text, 'aicoin_launch')
    // 服务器仍然活着
    assertEqual((await client.request('ping')).jsonrpc, '2.0')
  })
})

test('坏工具模块只 warn 不崩：stderr 有告警，tools/list 仍有其它工具', async () => {
  await withServer(async (client) => {
    await handshake(client)
    await client.waitForStderr('broken.mjs', { timeoutMs: 5000 })
    const stderr = await client.waitForStderr('工具加载完成', { timeoutMs: 5000 })
    assertIncludes(stderr, 'broken.mjs')
    const response = await client.request('tools/list', {})
    assert(response.result.tools.some((tool) => tool.name === 'echo_tool'))
  })
})

test('stdout 纯净：整个过程只出现 JSON-RPC 帧（非 JSON 行数为 0）', async () => {
  await withServer(async (client) => {
    await handshake(client)
    await client.request('tools/list', {})
    await client.request('tools/call', { name: 'echo_tool', arguments: { text: 'x' } })
    client.writeRaw('{bad json}\n')
    await client.waitForMessage((message) => message?.error?.code === -32700, { label: '解析错误帧' })
    await client.request('ping')
    assertEqual(client.nonJsonLines.length, 0, `stdout 出现非 JSON 行：${client.nonJsonLines.join(' | ')}`)
    for (const message of client.messages) {
      assertEqual(message.jsonrpc, '2.0', `所有 stdout 帧都应是 JSON-RPC 2.0：${JSON.stringify(message).slice(0, 120)}`)
    }
    assert(client.rawLines.length >= 4, '应有足够多的协议帧')
  })
})

test('stdin EOF → 刷新输出后进程以 0 退出', async () => {
  const deadPort = await findDeadPort()
  const client = await startMockMcpClient({ args: ['--port', String(deadPort)], env: { AICOIN_TOOLS_DIR: FIXTURES } })
  try {
    client.writeRaw(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INITIALIZE_PARAMS })}\n`)
    await client.waitForMessage((message) => message?.id === 1, { label: 'initialize 响应', timeoutMs: 8000 })
    const exit = await client.close({ timeoutMs: 8000 })
    assertEqual(exit.code, 0, `期望退出码 0，实际 ${exit.code}（signal=${exit.signal}）`)
    assert(client.rawLines.length >= 1, 'EOF 前的请求应有响应输出')
  } finally {
    client.kill()
  }
})

export const tests = suite.tests
export default suite
