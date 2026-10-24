/**
 * test/fixtures/tools/cdp_tool.mjs — 通过 ctx 走 CDP 的工具（测试 ctx.attach/evaluate 链路）。
 */

export const tools = [
  {
    name: 'mock_eval',
    description: '在页面里求值并返回结果（测试用，走 ctx.evaluate）',
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'JS 表达式' } },
    },
    handler: async (args, ctx) => {
      const value = await ctx.evaluate(args.expression ?? '1+1', { awaitPromise: false })
      return JSON.stringify(value)
    },
  },
  {
    name: 'mock_where',
    description: '返回当前附加的是哪个窗口（测试用，走 ctx.attach/client.target）',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, ctx) => {
      const client = await ctx.attach()
      return {
        port: ctx.port,
        title: client.target?.title ?? null,
        url: client.target?.url ?? null,
        attached: ctx.isAttached,
        ctxTarget: ctx.target?.id ?? null,
      }
    },
  },
  {
    name: 'mock_shot',
    description: '截图并返回 base64 长度（测试用，走 ctx.screenshot）',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, ctx) => {
      const data = await ctx.screenshot()
      return { length: data.length, head: Buffer.from(data, 'base64').toString('utf8').slice(0, 24) }
    },
  },
]
