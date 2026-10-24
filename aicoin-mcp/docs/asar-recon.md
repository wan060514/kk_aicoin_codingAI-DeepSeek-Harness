# AiCoin 2.16.27 静态拆包报告（REA + 手工解析 app.asar）

> 目标：`D:\Program Files\AiCoin`，Electron 43.2.0 / Chromium 150 / aicoin 2.16.27。
> 本文只记录**从安装包静态得到**的事实，运行时验证见 `runtime-probe.md`。
> 所有结论都可在括号里的路径/偏移处复核。

## 1. 包结构

| 项 | 值 |
| --- | --- |
| 外壳 | `AiCoin.exe`（Electron 43.2.0，Chromium 150.0.7871.129） |
| 应用包 | `resources\app.asar`（195,878,623 字节，asar 头 JSON 443,711 字节） |
| 解包产物 | 1,554 个文件 / 186.4 MB（另有 125 个 unpacked-only 原生模块在 `app.asar.unpacked`） |
| 主进程入口 | `dist/main/main.js`（1,923,460 字节） |
| 预加载 | `dist/main/preload.js`（26,364 字节）+ `dist/main/vendor.js` |
| 渲染层 | `dist/renderer/`：1,098 个文件 / 185 MB，含 `main.js`(1.4MB)、`chart-core.js`(1.67MB)、`im-client.js`(6.8MB)、`vendor.js`、`echarts.js`、Monaco `editor.worker.js` |
| 原生依赖 | `keytar`（系统钥匙串）、`better-sqlite3-multiple-ciphers`（加密 SQLite）、`@aicoin/cryptaddon`（RSA/AES 请求加密）、`@aicoin/data_server_addon` |
| 附带进程 | `library/win64/Helper.dist/Helper.exe`（PyInstaller，内含 websockets/sqlite3/Crypto/websocket-client） |
| 数据目录 | `C:\Users\11\AppData\Roaming\aicoin` |

`package.json`：`{"name":"aicoin","version":"2.16.27","main":"./dist/main/main.js"}`。

解包方法（本仓库 `aicoin-re\extract_asar.mjs`，零依赖）：asar 头布局是
`uint32 = 4` → `uint32 pickleSize` → pickle(`uint32 payloadSize`,`uint32 jsonLen`,json)，
所以 **JSON 起点是偏移 16、长度取偏移 12 的 uint32**，数据区起点 = `8 + pickleSize`。
（先用偏移 8 当长度会多读 4 字节，JSON.parse 报 "invalid primitive: func"。）

## 2. 我们自己就能打开的调试面：`remote-debugging-port`

主进程里有一段显式开关（`dist/main/main.js` @1,343,058 附近的 `_0x99d348`）：

```js
function _0x99d348(app, cfg) {
  const port = (function ({ rawPort, isDevelopment, isAlpha }) {
    if (!isDevelopment && !isAlpha) return null            // 生产版默认不给
    if (!rawPort || !/^[1-9]\d{0,4}$/.test(rawPort)) return null
    const n = Number(rawPort)
    return n >= 1 && n <= 0xffff ? String(n) : null
  })(cfg)
  return !!port && (app.appendSwitch(<inspect 相关 switch>),
                    app.appendSwitch('remote-debugging-port', port), true)
}
```

结论：**生产渠道下客户端不会自己开调试端口**，必须由启动参数 `--remote-debugging-port=<port>`
交给 Chromium 解析。实测可行（见 runtime-probe 的 `/json/version`）。相关的另一个旁路是
`process.env.OPEN_DEVTOOLS_IN_PRODUCTION`，但它和 `isAlpha` 绑定，生产渠道不生效。

> 启动坑：DSH 会给子进程注入 `ELECTRON_RUN_AS_NODE=1`。此时 `AiCoin.exe` 当成 Node 跑，
> 直接报 `bad option: --remote-debugging-port=9222` 并退出。启动前必须从 env 里删掉它。

## 3. 主进程能力（可被 CDP / IPC 驱动的部分）

`preload.js` 通过 `contextBridge` 暴露了三个全局：

| 全局 | 内容 |
| --- | --- |
| `window.electron` | `ipcRenderer` 的封装：`getSetting/setSettings/insertOrUpdateSettings/insertOrReplaceCoinsInfo/getCoinsInfo/openNewWin/openNewWinSync/invoke/send/on` 等 |
| `window.node` | `{ os: { platform, arch, isWin } }` |
| `window.process` | `{ env:{NODE_ENV,TEST,INSTALLER_NAME}, type, defaultApp, versions, platform, arch }` |

`ipcMain` 侧可见的频道（节选，`main.js` @688k–1.40M）：`SIGN_MESSAGE`、
`APPROVE_BUILDER_FEE_SIGN`、`GET_WALLET_ADDRESS`、`TOGGLE_LOGIN`、`PUSH_MAIN_ROUTE`、
`SET_WIN_STATE`、`CLOSE_MSG_NOTICE`、`CLOSE_CHILD_PROCESS`、`SUB_NOTICE`、`MONITOR`、
`GET_MACHINE_ID`、`SAVE_FILE_RECORD`、`UPDATE_COMPLETED_ACK`、`RECORD_ERROR`、
`SHOW_MAIN_WINDOW`、`SET_TITLE`、`TOGGLE_FLOAT_VISIBLE` 等。

安全存储（keytar）里保存的键集合在 `main.js` @1,343,058 之后：
`['preferences','authToken','trading','credentials']`，另一处
`['uid', …]`。也就是说 **登录 token 不只在 localStorage**，主进程还经钥匙串用。

加密本地库：`better-sqlite3-multiple-ciphers`，用户数据库有「clearUserDatabase /
rebuildUserDatabase / deleteTradePassword / cleanKeychain」这类维护路径
（`main.js` @1,343,000 之后），交易密码与钱包签名也在主进程（`SIGN_MESSAGE` 等）。

### 3.1 单实例锁：为什么「打不开调试端口」是常态

`main.js` @1,508,778 的 `checkSingleInstance()`：

```js
const got = app.requestSingleInstanceLock()          // 拿不到锁 → 典型实现会 app.quit()
return got && app.on('second-instance', (...args) => {
  // 已有实例：恢复/显示/聚焦主窗口，并把 URL 交给 setOpenUrl 处理
  mainWindow.isMinimized() && mainWindow.restore()
  mainWindow.isVisible() || mainWindow.show()
  mainWindow.focus()
  this.setOpenUrl(argv)
})
```

结论：**用户已经手动打开 AiCoin 时，再带 `--remote-debugging-port` 启动的第二个进程
拿不到锁，会立刻退出并聚焦已有窗口，端口永远不会打开**。所以「端口不通但进程在」不是
bug，而是必须显式处理的诊断分支（本项目 `aicoin_app_launch` 返回
`reason:"single-instance-conflict"` 并报出挡路 pid；`force` / `--user-data-dir` 是两条出路）。

### 3.2 渲染层隔离：为什么控制必须走「页面内」

`main.js` @1,352,107 的 `webPreferences`：

```js
{ webSecurity: true, nodeIntegration: false, nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: false,
  allowRunningInsecureContent: false, experimentalFeatures: false, webviewTag: false,
  preload: <...>/preload.js }
```

`nodeIntegration:false` + `contextIsolation:true` 意味着页面里**没有 `require`**。
能用的只有三条路，本项目用的是第 1、2 条：

1. webpack 打包器自带的 `__webpack_require__`（通过真实的 chunk 全局
   `webpackChunkaicoin` 的 `push` 钩子拿到）——用它 `require(31438)` 拿 axios；
2. `contextBridge` 暴露的 `window.electron`（preload 的 IPC 桥）；
3. 改安装包/注入 preload ——本项目**不做**（会破坏完整性，且每次更新失效）。

## 4. 渲染层：受登录态保护的业务 API

axios 实例集中在渲染层，路径都是相对 baseURL 的字符串。与自定义指标/AiScript 相关：

| 端点 | 用途 | 备注 |
| --- | --- | --- |
| `upgrade/customIndicator/script/list` | 我的指标列表 | 返回 `{success, data:{customList:[{id,name,chartType,…}]}}` |
| `upgrade/customIndicator/script/save` | 保存/新建指标脚本 | body `{name, value, version:'v4', id?, buildType?, position?, visualCode?}`；**无 id 即新建** |
| `upgrade/customIndicator/script/detail` | 读取单个脚本 | |
| `upgrade/customIndicator/script/del` | 删除脚本 | |
| `upgrade/customIndicator/indicator/gen` | 生成指标实例 | body `{scriptId, layoutHash}` |
| `upgrade/customIndicator/script/functionLib` | 函数库元数据 | 旧版插件用它取线上函数库 |
| `upgrade/customIndicator/quickGen` | AI 快速生成 | |
| `upgrade/customIndicator/trade/*` | 信号/交易记录（`list/tpslList/triggerHistory/detail`） | |
| `upgrade/customIndicator/executor/*` | 执行器租约（`claim/renew/renewBatch/release`） | |
| `upgrade/customIndicator/screener/*` | 选币任务 | |

**不重试名单**（渲染层 @main.js @899,936，说明这些接口有副作用，客户端自己都不自动重试）：

```js
['trade','biztrip','upgrade/customIndicator/script/save',
 'upgrade/customIndicator/screener/config','upgrade/customIndicator/screener/execTask',
 'upgrade/custom/dynamic-group-edit','upgrade/warning/quotes-special','warning/quotes/tag']
```

把 `script/save` 当「免费校验探针」会真的写用户账号（还吃 VIP/`securityCount` 配额），
因此本项目的 MCP 把它做成**必须显式 confirm 的写操作**，默认只读。

路由：主窗口用 hash 路由，实测 URL 形如
`file:///…/app.asar/dist/renderer/index.html#/login`，其它页面（图表/自选/行情）同为
`#/<page>`。图表状态（交易对、周期、指标实例）落在渲染层 store 与
`window.electron.ipcRenderer.getSetting({uid,key})` 的持久化设置里（如 `chartTab`、
`showCoinLogo`、`chainTab`、`commonPlatform`、`alertSetting`、`depthCoin…`）。

## 5. 对「用 Agent 控制 AiCoin」意味着什么

1. **控制通道**：`--remote-debugging-port` + CDP `Runtime.evaluate`，页面里能直接拿到
   `window.electron.ipcRenderer`（主进程能力）与 axios 实例（业务 API）。两条路都不需要
   修改安装目录里的任何文件。
2. **两种控制粒度**
   - 粗粒度/稳：`window.electron.ipcRenderer.invoke/send` 走主进程频道（开关窗口、取设置、
     推路由）。
   - 细粒度：渲染层 axios + 业务端点（指标列表/保存、图表数据）。需要登录态。
3. **不能做的**：没有本地编译器，`script/save` 才会触发服务端编译；因此「离线校验」只能做
   语法/语义静态检查（kk_aicoin_codingAI 已实现 34 条规则），真正的编译结果只能由
   客户端「保存并校验」或保存接口返回。
4. **风险**：调试端口等于把渲染层交给本机任意进程；保存/删除指标、交易相关接口会改用户账号。
   MCP 侧因此默认只读，写操作要求 `confirm: true`，并建议用完关闭调试端口。

## 6. 复核用命令

```powershell
# 1) 解析 asar 头（零依赖）
node aicoin-re\extract_asar.mjs 'D:\Program Files\AiCoin\resources\app.asar' 'aicoin-re\unpacked'

# 2) 上下文安全地搜压缩后的 bundle（打印匹配点前后窗口，不打印整行）
node aicoin-re\grepsrc.mjs aicoin-re\unpacked\dist\renderer 'customIndicator/[a-zA-Z/]+' --ext .js --max 30 --win 60

# 3) 跑起来并确认调试端口
$env:ELECTRON_RUN_AS_NODE = $null
Start-Process 'D:\Program Files\AiCoin\AiCoin.exe' -ArgumentList '--remote-debugging-port=9222'
Invoke-WebRequest http://127.0.0.1:9222/json/version
```
