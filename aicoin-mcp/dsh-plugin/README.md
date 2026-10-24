# dsh-plugin-aicoin-mcp v0.5.0

DeepSeek Harness 插件：把本地 `aicoin-mcp` 服务器（stdio MCP）的工具注册成
`aicoin_app_*`，并在**首页侧栏**提供一个控制台面板，用于启停桥接与查看 AiCoin 状态。

## 两个半边

```
Host   lib/index.js   →  spawn <serverRoot>/src/server.mjs
                         MCP initialize → tools/list → ctx.tools.register(aicoin_app_*)
                         暴露同源 JSON API：/plugins/aicoin-mcp/{state,tools,action}
Client client.js      →  window.__ModuleLoader__ 加载
                         sidebar.panellist（id aicoin-mcp, order 21）→ 图标
                         main（key aicoin-mcp）→ 控制台面板
```

面板能力：

| 区块 | 内容 | 按钮 |
| --- | --- | --- |
| MCP 桥接 | 阶段/子进程 PID/服务器版本/已注册工具/端口/连接时间 | 启动连接 · 断开连接 · 重连 |
| AiCoin 客户端 | 调试端口可达/浏览器版本/窗口数/主窗口/登录态/进程判定 | 探测 · 连上（必要时重启）· 以调试模式重启 · 启动 AiCoin · 停止 AiCoin |
| 工具台 | 选一个已注册工具 + 参数 JSON + 最近一次结果 | 运行（`tool.run`；写操作按 `allowMutating` 拦截） |
| AiScript 工具链 | 脚本路径静态校验、结构审查（止损/熔断/状态机/未来函数）、函数库查询、规格复查 | 静态校验 · 结构审查 · 查函数库 · 规格复查（全部转 `/plugins/kk-aicoin`） |
| 写进 AiCoin 并验证 | 指标名 + 脚本路径 + 模式（publish/verify）+ 主副图；服务端真编译，结论回填到「第 N 行第 M 列 + 出错行原文 + ^ 指示」 | 写进 AiCoin · 只验证（不留指标） |
| 行情数据（Open Data） | 币种输入 + 周期；报价/涨跌幅、K 线摘要、资金费率、清算汇总、快讯（走 `aicoin_data_*`，免费 key 只有行情与 K 线，其余 403 会显式提示填自己的 key） | 报价 · K 线 · 资金费率 · 清算汇总 · 快讯 |
| 已注册工具 | `aicoin_app_*` 名称清单（可展开，写操作标 ✱） | — |

「AiCoin 客户端」卡片在 `verdict = running-without-debug-port` 时会显式解释
「CDP 只能在启动时打开」并给出一键重启；这是「没通过本插件启动就连不上」的正解。

AiScript 卡片是跨插件的：面板属主是 `dsh-plugin-aicoin-mcp`，校验/函数库由
`kk_aicoin_codingAI` 自己的 `/plugins/kk-aicoin` 路由提供。那边没装时返回 404，
卡片降级成一句提示，不影响面板其它部分。

面板每 3 秒自动刷新（页面不可见时暂停）；API 404 时显示提示而不是白屏；
所有文案走 zh/en 词典，颜色只用 Harness 主题变量。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉就什么都不注册 |
| `serverRoot` | `''` | `aicoin-mcp` 包根绝对路径；空则按邻居/工作目录推断 |
| `port` | `9222` | CDP 端口，必须与 AiCoin 启动端口一致 |
| `appPath` | `''` | `AiCoin.exe` 路径；空则用服务器默认值 |
| `autoStart` | `true` | 加载时即连接并注册工具 |
| `requestTimeoutMs` | `120000` | 单次工具调用超时 |
| `maxTools` | `64` | 注册上限 |
| `allowMutating` | `true` | 关掉后 launch/stop/save 及面板的启动/停止 AiCoin 都拒绝 |
| `panel` | `true` | 是否挂载 `/plugins/aicoin-mcp`；无头 profile 可设 false |

## 安装 / 卸载

```powershell
node install.mjs --enable --run-pnpm      # 安装（旧版本自动备份）
node install.mjs --uninstall --run-pnpm   # 卸载
node scripts/profile-row.mjs --disabled true|false   # 只切启用开关（热重载）
```

## 自检（安装前就该跑）

```powershell
node scripts/panel-api-smoke.mjs   # 面板 HTTP API：路由/JSON/状态码
node scripts/client-smoke.mjs      # 浏览器半：加载器/槽位/词典/渲染
node scripts/bridge-selftest.mjs   # 宿主半：工具注册与代理（桩 ctx）
```

## 防护设计（为什么装不坏宿主）

- 浏览器半的 `apply()` 内部全程 try/catch：locale 或 slots 不可用时只 `console.warn`，不抛。
- 面板对 API 404 有专门提示（“面板 API 不可用”），组件内不抛异常。
- 宿主半的 HTTP 路由挂载失败只 warn；`webServer` 缺席时工具照常可用。
- 安装脚本先备份旧插件目录与本 profile 的 patch/package.json；`profile-row.mjs` 可一键停用。
- 推荐安装顺序：**先 disabled 写入 → 验证宿主健康 → 再启用**（见根目录 `INSTALL.md`）。
