/**
 * test/pipe-check.mjs — 校验 MCP stdio 服务器的 stdout：每一行都必须是合法 JSON-RPC 2.0 帧。
 *
 * 用法（PowerShell 管道）：
 *   @($init,'{"jsonrpc":"2.0","id":2,"method":"tools/list"}') | node src/server.mjs | node test/pipe-check.mjs
 */

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
})
process.stdin.on('end', () => {
  const lines = buffer.split(/\r?\n/).filter((line) => line.trim().length > 0)
  const frames = []
  let bad = 0
  for (const line of lines) {
    try {
      const frame = JSON.parse(line)
      frames.push(frame)
      if (frame.jsonrpc !== '2.0') {
        bad += 1
        console.log(`✗ 帧缺少 jsonrpc:"2.0"：${line.slice(0, 160)}`)
      }
    } catch {
      bad += 1
      console.log(`✗ non-JSON stdout line：${line.slice(0, 160)}`)
    }
  }
  console.log(`stdout 帧数=${frames.length} 非协议行=${bad}`)
  for (const frame of frames) {
    const keys = Object.keys(frame).join(',')
    let summary
    if (frame.error) {
      summary = `error code=${frame.error.code} message=${JSON.stringify(frame.error.message).slice(0, 120)}`
    } else if (Array.isArray(frame.result?.tools)) {
      summary = `tools=${frame.result.tools.length} [${frame.result.tools.map((tool) => tool.name).join(', ')}]`
    } else if (Array.isArray(frame.result?.content)) {
      summary = `content=${JSON.stringify(frame.result.content[0]?.text).slice(0, 100)} isError=${frame.result.isError === true}`
    } else if (frame.result?.serverInfo) {
      summary = `serverInfo=${frame.result.serverInfo.name}@${frame.result.serverInfo.version} protocol=${frame.result.protocolVersion}`
    } else {
      summary = JSON.stringify(frame.result ?? null).slice(0, 140)
    }
    console.log(`  id=${JSON.stringify(frame.id)} keys=[${keys}] ${summary}`)
  }
  process.exit(bad === 0 ? 0 : 1)
})
