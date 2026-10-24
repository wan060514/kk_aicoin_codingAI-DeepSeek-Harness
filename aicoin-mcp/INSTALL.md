# 安装说明（给收到分享包的人）

这个压缩包里是两样东西：

| 目录 | 作用 |
| --- | --- |
| `dsh-plugin/` | **DeepSeek Harness 插件**：宿主半（启动/管理 MCP 子进程、注册工具、暴露面板 API）+ 浏览器半（首页侧栏的控制台面板） |
| `src/` `scripts/` `test/` | **aicoin-mcp 服务器**本体（零依赖 Node MCP stdio 服务器），负责用 CDP 控制 AiCoin 客户端 |

装好之后你会得到：侧栏多一个 **AiCoin MCP** 图标 → 点开是控制台（启停桥接、看状态、探测/启动/停止 AiCoin），
以及模型可调用的 `aicoin_app_*` 工具。

---

## 0. 前置条件

- Windows + 已安装 **AiCoin 桌面客户端**（默认 `D:\Program Files\AiCoin\AiCoin.exe`，装在别处见下面 `--app-path`）
- Node.js **≥ 20**（`node -v` 能跑就行）
- DeepSeek Harness **桌面版或 Web 版**，且 `~/.dsh/profiles/<profile>/` 存在（默认 profile 叫 `desktop`）

> ⚠️ 插件会通过 `--remote-debugging-port` 控制 AiCoin：**本机任何进程都能连这个端口**。
> 不用的时候把 AiCoin 正常关掉再打开，端口就不在了（面板里也有「停止 AiCoin」）。

---

## 1. 解压

```powershell
Expand-Archive -Path 'aicoin-mcp-0.2.0.zip' -DestinationPath 'D:\dsh-plugins' -Force
cd 'D:\dsh-plugins\aicoin-mcp'
```

目录里应该有 `install.mjs`、`dsh-plugin\`、`src\`。

---

## 2. 安装（安全顺序：先停用 → 验证 → 再启用）

```powershell
# 2.1 先以「停用」状态写入，确认宿主没被影响
node scripts\profile-row.mjs --disabled true        # 已有旧版本时先停用（新装可跳过）
node install.mjs --enable --run-pnpm

# 2.2 确认宿主仍然健康（应打印 HTTP 200）
(Invoke-WebRequest 'http://127.0.0.1:<你的 DSH 端口>/plugins/rea-mcp/state' -UseBasicParsing).StatusCode

# 2.3 启用插件行（patch 层会热重载，几秒后生效）
node scripts\profile-row.mjs --disabled false
```

`install.mjs` 做了四件事（都会先备份）：

1. 复制 `dsh-plugin/` 到 `<profile>\plugins\dsh-plugin-aicoin-mcp`（旧版本自动备份为 `.bak-<时间戳>`）
2. 在 profile 的 `package.json` 里加 `link:` 依赖（以及 `dsh.profile.bundles` 不需要动）
3. 在 profile 的 `cordis.patch.yml` 里插入 `id: aicoin-mcp` 行
4. 跑 profile 的 `pnpm install`

**AiCoin 装在别处时**（服务器默认找 `D:\Program Files\AiCoin\AiCoin.exe`）：

```powershell
node install.mjs --enable --run-pnpm --app-path 'E:\Apps\AiCoin\AiCoin.exe'
```

**不用桌面 profile** 时：`--profile web`（或你实际的 profile 名）。

---

## 3. 打开面板

1. 刷新一下 Harness 页面（F5）。
2. 看左侧栏：会多一个 **AiCoin MCP** 图标（在面板列表里，排在既有面板附近）。
3. 点开 → **AiCoin MCP 控制台**：
   - **MCP 桥接**：显示阶段（已就绪/已停止/异常）、子进程 PID、服务器版本、已注册工具数；
     按钮：**启动连接 / 断开连接 / 重连**
   - **AiCoin 客户端**：调试端口是否可连、浏览器版本、窗口数、主窗口、登录态、进程判定；
     按钮：**探测 AiCoin / 启动 AiCoin / 停止 AiCoin**（停止会关掉当前窗口，登录态保留）
   - **已注册工具**：展开可看 `aicoin_app_*` 清单
4. 面板每 3 秒自动刷新（页面切到后台时暂停）。

面板打不开/显示“面板 API 不可用”？说明宿主半没加载成功 → 看第 5 节。

---

## 4. 常用命令

```powershell
# 只读状态（不开面板也能看）
curl http://127.0.0.1:<port>/plugins/aicoin-mcp/state

# 动作
curl -X POST http://127.0.0.1:<port>/plugins/aicoin-mcp/action `
  -H 'content-type: application/json' -d '{"action":"mcp.restart"}'
#   可用 action：refresh / mcp.start / mcp.stop / mcp.restart /
#                aicoin.probe / aicoin.launch / aicoin.stop

# 卸载
node install.mjs --uninstall --run-pnpm
```

---

## 5. 排障

| 现象 | 处理 |
| --- | --- |
| 侧栏没有图标 | 刷新页面；确认 `plugins/dsh-plugin-aicoin-mcp/client.js` 存在；确认 profile 的 `cordis.patch.yml` 里那一行 `disabled: false` |
| 面板空白/报错 | 打开浏览器控制台看有没有 `[aicoin-mcp]` 开头的报错；面板本身对 API 404 会显示提示而不是白屏 |
| 面板提示“面板 API 不可用” | 宿主半没加载：看 Harness 日志里有没有 `dsh-plugin-aicoin-mcp ready`；`enabled`/`disabled` 是否都为启用 |
| 工具列表里没有 `aicoin_app_*` | 插件配置 `autoStart: false` 时只在首次调用/面板启动后才连；面板点「启动连接」，或把 `autoStart` 改回 `true` |
| 启动 AiCoin 报 `bad option: --remote-debugging-port` | 环境里有 `ELECTRON_RUN_AS_NODE`；插件已自动剥离，若手工启动请先 `$env:ELECTRON_RUN_AS_NODE=$null` |
| 启动报单实例冲突 | AiCoin 已用手动方式开着（没开调试端口）：面板先「停止 AiCoin」再「启动 AiCoin」，或用隔离 profile：`node install.mjs` 里不改，直接在工具侧传 `userDataDir` |
| 想整插件回滚 | `node scripts\profile-row.mjs --disabled true`（立即停用）或 `node install.mjs --uninstall --run-pnpm`；旧版本仍在 `plugins\dsh-plugin-aicoin-mcp.bak-*` |

---

## 6. 安全与边界

- **默认只读优先**：`aicoin_app_api` 默认拒绝写接口；`aicoin_app_indicator_save` 必须 `confirm:true`；删指标类接口不实现。
- **面板的启动/停止 AiCoin 是改动类操作**，可用插件配置 `allowMutating: false` 一键关掉。
- **不提供任何回测/绩效数字**：AiCoin 编辑器没有本地回测能力，这类数字只能是编造的。
- 插件不修改 AiCoin 安装目录里的任何文件，只通过它的调试端口工作。
