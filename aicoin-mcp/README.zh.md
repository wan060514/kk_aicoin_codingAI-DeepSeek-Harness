# aicoin-mcp — 让 Agent 控制 AiCoin 桌面客户端

> 一个**零依赖**的 MCP（Model Context Protocol）服务器 + 一个 DeepSeek Harness 桥接插件。
> 它通过 Chrome DevTools Protocol 接管本机正在运行的 **AiCoin 桌面客户端**（Electron），
> 让 agent 能查询客户端状态、切交易对/周期、读我的指标源码、调用客户端自己的业务接口、
> 截图，甚至在明确确认后保存 AiScript 指标。

- 包本体：`aicoin-mcp/`（MCP 服务器，`node src/server.mjs`，纯 Node ≥ 20，无第三方依赖）
- Harness 插件：`aicoin-mcp/dsh-plugin/`（把 MCP 工具注册成 `aicoin_app_*`）
- 逆向依据：`docs/asar-recon.md`（静态拆包）+ `research/runtime-probe.md`（运行时实测）

---

## 1. 它解决什么问题

AiCoin 没有对外 API，也没有插件机制。它的能力都在 Electron 渲染层里：登录态、axios
实例（带 RSA/AES 加解密拦截器）、redux store、hash 路由、自定义指标编辑器。

本项目**不改安装目录里的任何文件**，只做两件事：

1. 用 `--remote-debugging-port=9222` 启动 AiCoin，拿到 CDP 端点；
2. 在页面里用 `Runtime.evaluate` 找到客户端自己的 axios 实例与 redux store，
   用**客户端自己的登录态和加密通道**发请求 / dispatch action。

所以读到的指标源码、行情、账号信息都是真实的客户端视角，而不是另起一套 HTTP 客户端去猜签名。

## 2. 架构

```
DeepSeek Harness
  └─ dsh-plugin-aicoin-mcp（DSH 插件，bin: lib/index.js）
       │  ① 启动子进程：node <serverRoot>/src/server.mjs --port 9222
       │  ② MCP 握手（initialize / tools/list）
       │  ③ 把每个 MCP 工具注册成 Harness 工具 aicoin_app_*
       └─ aicoin-mcp 服务器（stdio JSON-RPC 2.0）
            ├─ src/cdp.mjs       手写 WebSocket 的 CDP 客户端（多窗口选目标）
            ├─ src/inject.mjs    页面注入：拿 webpack require、定位 axios、redux action
            ├─ src/launcher.mjs  启停 AiCoin（清 ELECTRON_RUN_AS_NODE、单实例诊断）
            └─ src/tools/*.mjs   工具实现（lifecycle / system / api / domain）
```

MCP 服务器本身是通用的：Claude Desktop、Cursor、任何 MCP 客户端都能直接接它，
不依赖 DSH。

## 3. 安装

### 3.1 安装到 DeepSeek Harness（推荐）

```powershell
cd 'D:\deepseek Harness work\aicoin-mcp'
node install.mjs --enable --run-pnpm
```

`install.mjs` 只做四件事（都会先备份）：

1. 把 `dsh-plugin/` 复制到 `<profile>\plugins\dsh-plugin-aicoin-mcp`
2. 在 profile 的 `package.json` 里加 `link:` 依赖
3. 在 profile 的 `cordis.patch.yml` 里追加一行 `id: aicoin-mcp`（`serverRoot` 写本仓库绝对路径）
4. 跑 profile 的 `pnpm install`

安装完在 Harness 里问一句「用 aicoin_mcp_status 看看桥接状态」，能看到
`已注册工具：N 个` 就成功。卸载：`node install.mjs --uninstall --run-pnpm`。

### 3.2 接其它 MCP 客户端

服务器只走 stdin/stdout，直接在客户端配置里指过去即可（Claude Desktop 的
`claude_desktop_config.json` 示例）：

```json
{
  "mcpServers": {
    "aicoin": {
      "command": "node",
      "args": ["D:/deepseek Harness work/aicoin-mcp/src/server.mjs", "--port", "9222"],
      "env": { "AICOIN_CDP_PORT": "9222" }
    }
  }
}
```

> Harness 自己跑在 Electron 里，会把 `ELECTRON_RUN_AS_NODE=1` 传给子进程。插件用
> `process.execPath` 启动服务器所以没问题；**但服务器启动 AiCoin 时必须删掉这个变量**，
> 否则 `AiCoin.exe` 会以 Node 模式运行并报 `bad option: --remote-debugging-port=9222`。
> 这一点已在 `src/launcher.mjs` 里处理，手工排查时也请记得。

## 4. 工具一览

工具名统一 `aicoin_app_` 前缀（避免与 `kk_aicoin_codingAI` 的 `aicoin_validate` 等撞名）。
以服务器实际 `tools/list` 为准：`node scripts/mcp-handshake.mjs` 会打印完整清单。

| 工具 | 作用 | 关键参数 | 是否会改动客户端 |
| --- | --- | --- | --- |
| `aicoin_mcp_status` | 桥接自检（插件层提供，非 MCP） | — | 否 |
| `aicoin_app_launch` | 带调试端口启动/复用 AiCoin | `port` `appPath` `force` | 是（起进程） |
| `aicoin_app_stop` | 关闭 AiCoin | `port` `dryRun` `gracefulMs` | 是 |
| `aicoin_app_restart` | 重启（换端口/修复单实例冲突） | `port` `force` | 是 |
| `aicoin_app_status` | 端口/版本/全部窗口/登录态/进程 | — | 否 |
| `aicoin_app_targets` | 列出全部 CDP 目标（多窗口排查） | — | 否 |
| `aicoin_app_windows` | 可 attach 的窗口清单（下标/title/hash/是否主窗） | — | 否 |
| `aicoin_app_eval` | 在指定窗口执行 JS 表达式 | `expression` `target` `awaitPromise` | 取决于表达式 |
| `aicoin_app_console` | 抓页面 console 与未捕获异常 | `ms` `types` `trigger` | 否 |
| `aicoin_app_screenshot` | 截当前窗口 PNG | `path` `target` | 否 |
| `aicoin_app_snapshot` | 页面快照（路由/图表状态/DOM 选择器） | `target` | 否 |
| `aicoin_app_api` | 用客户端自己的 axios 调业务接口 | `method` `path` `data` `params` `allowWrite` | 默认只读；写接口需 `allowWrite:true` |
| `aicoin_app_navigate` | 切 hash 路由 / 切交易对与周期 | `route` \| `symbol` `timeframe` `type` | 是（改 UI 状态） |
| `aicoin_app_indicators_list` | 我的指标列表 | `includeSource` `limit` | 否 |
| `aicoin_app_indicators_get` | 取单个指标的完整 AiScript 源码 | `id` | 否 |
| `aicoin_app_indicator_save` | 保存/新建指标脚本 | `name` `value` `id` **`confirm:true`** | **是（写用户账号）** |

### 多窗口：必须选对 target

实测客户端同时开着 4 个 page：`#/main/exchange`（K 线主窗）、`#/chat`、`#/asset-sync`、
`#/notice`。每个窗口是独立渲染进程、独立 store，**选错窗口等于在控制另一个窗口**。
所有需要页面上下文的工具都接受 `target`：`main` | `chart` | `notice` | `chat` |
URL 子串 | 索引；默认选 `#/main` 那个。工具返回值里会回显实际连接窗口的 `title/url/id`。

### 业务错误码：HTTP 200 也可能是失败

客户端接口失败时返回 **HTTP 200 + `{success:false,status:<业务码>}`**。
`aicoin_app_api` 会同时给出 `httpOk / success / status / message`：

| status | 含义 |
| --- | --- |
| `403` + message 含「登录信息已过期」 | 登录态失效（客户端会因此登出） |
| `10510` | 指标已被删除 |
| `40003` | 自动切换线路重试 |

## 5. 典型用法

```
# 1. 状态（先看窗口和登录态）
用 aicoin_app_status 看一下客户端状态

# 2. 把 K 线窗口切到 BTC 永续 15 分钟
用 aicoin_app_navigate 切到 BTCUSDT 永续 900 秒周期

# 3. 读我的指标并做静态校验
用 aicoin_app_indicators_list 列出我的指标（不要源码）
用 aicoin_app_indicators_get 取 id=12345 的源码，再用 aicoin_validate 静态校验

# 4. 只读地查一个业务接口
用 aicoin_app_api 调 upgrade/customIndicator/script/list

# 5. 改脚本（会写账号，必须显式确认）
用 aicoin_app_indicator_save confirm=true 把 id=12345 的源码覆盖成 <新源码>
```

## 6. 安全与边界

- **调试端口 = 完全控制**：能连 9222 的本机进程都能读走登录态、改客户端行为。
  不用的时候先 `aicoin_app_stop` 再正常启动 AiCoin，端口就没开。
- **默认只读**：所有会写账号的接口（save/del/indicator gen/executor）里只保留
  `indicator_save`，并且**必须 `confirm:true`**，描述里也写明了副作用。删除类接口不实现。
- **不提供回测/绩效数字**：客户端没有本地编译器，真正的编译发生在服务端保存时；
  任何收益率/胜率/夏普/回撤数字都只能是编造的。本项目的定位是「控制与读取」，
  不是「回测」。
- **登录态**：工具使用客户端自己的登录态，不会另存或外传凭据。
  未登录时只读接口会返回 `success:false`，工具会把业务码原样报回来。

## 7. 排障

| 现象 | 原因 / 处理 |
| --- | --- |
| `bad option: --remote-debugging-port=9222` | `ELECTRON_RUN_AS_NODE=1` 漏进了 AiCoin 的环境；`aicoin_app_launch` 已处理，手工启动请先清掉 |
| 端口不通但 AiCoin 在跑 | 单实例锁：已在运行的实例没开调试端口，带端口再启动会直接退出聚焦旧窗口。`aicoin_app_launch` 会给出这个诊断，先 `aicoin_app_stop`（或在客户端里退出）再 launch |
| 工具只看到 `aicoin_mcp_status` | MCP 子进程没起来/`serverRoot` 指错；看 `aicoin_mcp_status` 的「最近错误」和 Harness 日志 |
| `evaluate` 拿到的是别的窗口 | `target` 没选对，用 `aicoin_app_targets` 看清 URL 再指定 |
| 修改 `src/*.mjs` 后工具没变 | Harness 侧插件缓存了第一次 `tools/list`；在 Settings → Plugins 里关开一次，或重启 Harness |
| 中文变成 `???`/`U+FFFD` | 用 pwsh 的 `Set-Content`/`>` 写含中文的源码会走 ANSI 编码；请用 write/edit 工具，并用 `node -e "…(s.match(/\uFFFD/g)||[]).length"` 自检 |

## 8. 自检命令

```powershell
cd 'D:\deepseek Harness work\aicoin-mcp'
node scripts/mcp-handshake.mjs     # MCP 协议 + 工具清单 + 一次真实调用
node scripts/bridge-selftest.mjs   # 不装插件也能验 DSH 桥接（桩 ctx）
node test/run.mjs                  # 框架层单测（mock CDP + mock MCP 客户端）
```

## 9. 目录

```
aicoin-mcp/
├─ package.json
├─ install.mjs               # 安装到 DSH profile
├─ dsh-plugin/               # Harness 插件（把 MCP 工具注册进 Harness）
├─ src/
│  ├─ server.mjs             # MCP stdio 服务器（JSON-RPC 2.0）
│  ├─ cdp.mjs                # CDP 客户端（手写 WebSocket）
│  ├─ inject.mjs             # 页面注入（require / axios / redux / DOM）
│  ├─ launcher.mjs           # 启停 AiCoin
│  ├─ registry.mjs           # 工具注册与 schema 校验
│  ├─ context.mjs            # 懒连接运行时上下文
│  └─ tools/                 # 工具实现（自动发现，新增文件即注册）
├─ test/                     # mock CDP + mock MCP 客户端单测
├─ scripts/                  # 集成自检脚本
├─ docs/asar-recon.md        # 静态拆包报告（REA + asar 解析）
└─ research/                 # 运行时探测记录与证据
```
