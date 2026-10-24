/**
 * test/fixtures/tools/echo_tool.mjs — 测试用工具模块（验证动态加载 + tools/call 往返）。
 *
 * 注意：这个目录不是线上工具目录，只在测试里通过 AICOIN_TOOLS_DIR 指向它。
 */

export const tools = [
  {
    name: 'echo_tool',
    description: '回显输入文本（测试用，不连接 AiCoin）',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text'],
    },
    handler: async (args) => `echo: ${args.text ?? ''}`,
  },
  {
    name: 'object_tool',
    description: '返回一个对象（测试结果规范化，不连接 AiCoin）',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({ ok: true, nested: { n: 1 }, list: [1, 2, 3] }),
  },
  {
    name: 'content_tool',
    description: '返回标准 content 数组 + isError（测试透传）',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({ content: [{ type: 'text', text: 'custom-content' }], isError: true }),
  },
  {
    name: 'fail_tool',
    description: '总是抛错的工具（测试 isError:true）',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      throw new Error('故意失败 fail_tool')
    },
  },
]

export default { tools }
