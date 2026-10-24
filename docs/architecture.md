# 架构

两个包，三种进程，一条 HTTP 面板通道。理解这张图就不会再有「为什么工具说不可达」「为什么改了代码没生效」这类疑问。

```
┌──────────────────────── DeepSeek Harness 主进程 ────────────────────────┐
│                                                                        │
│  Host 半（插件）                                  Client 半（面板）      │
│  aicoin-mcp/lib/index.js                         aicoin-mcp/client.js  │
│   ├─ 起/停 MCP 子进程   ─────────┐                  ├─ 侧栏图标         │
│   ├─ 把子进程工具注册成          │                  ├─ 面板页           │
│   │   aicoin_* 给模型            │                  │   MCP / AiCoin /  │
│   └─ 暴露 HTTP 路由              │                  │   工具台 / 行情 /  │
│       /plugins/aicoin-mcp/*  ◄───┼── 同源 fetch ────┤   脚本 / 写进 AiCoin│
│                                  │                  └───────────────────┘
│  kk_aicoin_codingAI Host 半      │
│   ├─ 12 个 aicoin_* 工具（纯本地）│
│   └─ /plugins/kk-aicoin/*  ◄─────┘   （面板的「脚本」卡走这里）
└──────────────────────────────────┼─────────────────────────────────────┘
                                   │ stdio JSON-RPC
┌──────────────────────────────────▼─────────────────────────────────────┐
│ MCP 子进程  aicoin-mcp/src/server.mjs（独立 Node 进程，27 个工具）        │
│   ├─ cdp.mjs      → 127.0.0.1:9222  Chrome DevTools Protocol            │
│   ├─ inject.mjs   → 在页面里执行内核脚本（读图表/写指标/截屏）             │
│   ├─ launcher.mjs → 找到 AiCoin 可执行文件、带 --remote-debugging-port 启动│
│   ├─ context.mjs  → 页面上下文与窗口选择（main/chart/chat/notice…）       │
│   └─ openapi.mjs  → https://open.aicoin.com  HMAC-SHA1 签名，GET 只读     │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ CDP (WebSocket)
┌──────────────────────────────────▼─────────────────────────────────────┐
│ AiCoin 桌面客户端（Electron）                                            │
│   窗口：#/main（K线）、#/chat、#/notice、#/login、#/asset-sync …          │
│   页面里直接能用客户端自己的 axios（带登录态 + AES 加密）→ 内部接口        │
└────────────────────────────────────────────────────────────────────────┘
```

## 为什么拆成两个包

| 关注点 | 放哪 | 理由 |
|---|---|---|
| 操作客户端（读图、写指标、截屏） | `aicoin-mcp` | 需要 CDP + 子进程生命周期，天生是「外部进程」的事 |
| AiScript 知识（334 条函数、36 条规则、模板） | `kk-aicoin-coding-ai` | 纯数据 + 纯函数，离线可跑，不该被客户端是否开着影响 |
| 行情数据 | `aicoin-mcp/src/openapi.mjs` | 直连 HTTPS，与 CDP 完全解耦（客户端关着也能取数） |
| 面板 UI | 各自包的 `client.js` + 同源路由 | DSH 的 client 半不能声明 `ctx.remote.*`，只能走自己前缀的 HTTP |

关键设计：**离线校验绝不依赖客户端**。`aicoin_validate` 在 AiCoin 没开、没装、甚至没登录时都照常工作；只有 `mode:"verify"` 那一步才需要 CDP。

## 面板为什么不直接调 MCP 工具

面板运行在浏览器渲染进程里，拿不到 Host 半的对象。所以走一条同源 HTTP：

```
GET  /plugins/aicoin-mcp/state      → 当前状态（MCP 子进程、AiCoin 探测、工具清单、最后一次运行结果）
GET  /plugins/aicoin-mcp/tools      → 工具清单
POST /plugins/aicoin-mcp/action     → { action: "mcp.restart" | "tool.run" | "aicoin.connect" | … , ...body }
```

`action: "tool.run"` 是通用逃生口：面板上任何按钮都能跑任意已注册工具，前提是它在 `advertised` 清单里，且写操作工具（名字命中 `launch|stop|restart|connect|publish|save|del|write|navigate`）要求配置 `allowMutating: true`。

## 工具为什么会「在内存里是旧代码」

- MCP 子进程：由 Host 半 spawn，改完 `src/` 后调 `mcp.restart` 立即生效（子进程读的是磁盘）。
- Host 半：在 DSH 启动时被 `import` 进主进程内存，改完必须**重启 DSH**。
- Client 半（面板）：DSH 启动时打包进浏览器，同样要重启。
- 新手最容易踩的坑：改了 `src/*.mjs` 忘了 `mcp.restart`，或者改了 `lib/index.js` 以为 `mcp.restart` 也能生效。

## Open Data 签名（实测核对过，非文档推断）

```
X-Aic-AccessKey-Id:  <keyId>
X-Aic-Signature-Nonce: <8 字节随机 hex>
X-Aic-Timestamp:     <unix 秒>
X-Aic-Signature:     base64( hex( HMAC-SHA1("AccessKeyId=<key>&SignatureNonce=<nonce>&Timestamp=<ts>", secret) ) )
```

注意那句 **hex 之后再 base64**：直接用 `digest('base64')` 会得到一串无效签名，而且服务端只会回 401，看不出是编码问题。

免费档（官方仓库里公开的内置 key，15 req/min）：行情快照/K 线/币种搜索可用；衍生品、资讯、指标 K 线、指数类全部 403。见 `aicoin-mcp/README.md` 的两张表。

## 版本与清单

两个包各自 `package.json` 带 `dsh.bundle.patch` 指向 `cordis.patch.yml`；`MANIFEST.json` 由 `scripts/manifest.mjs` 重新生成（文件数、大小、五个哈希）。改完代码跑一次，别让清单撒谎。
