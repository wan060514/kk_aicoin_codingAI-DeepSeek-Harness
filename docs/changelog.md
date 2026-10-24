# 变更记录

日期为本机实测/交付日期（Asia/Shanghai）。

## 2026-10-24 · 首次开源发布

两个包首次推到 GitHub。此前所有工作都在本地，仓库里只有一个 377 字节的 README。

**包含的能力**

- `aicoin-mcp` 0.5.0 — 27 个工具：客户端控制（status/launch/stop/restart/connect/screenshot/snapshot/eval/navigate/…）、指标读写（publish/del/save/list/get）、Open Data 行情（8 个：catalog/capabilities/query/quote/kline/indicator-kline/derivatives/news）、窗口与目标枚举。
- DSH 侧栏面板：MCP 桥、AiCoin 状态、工具台（任意工具 + JSON 参数直接跑）、行情卡、脚本卡、写进 AiCoin 卡。
- `kk-aicoin-coding-ai` 1.1.0 — 12 个工具：知识库（334 条函数库 = 270 函数 + 25 行情变量 + 39 运算符）、`aicoin_validate`（36 条静态规则）、`aicoin_language_reference`、spec/模板/优化建议/交付、live_check、library_refresh。

**修掉的六个真 bug**（都不是"重构"，是确实错了）

1. **POSIX 进程扫描把自己算成 AiCoin 主进程** —— `sh -c 'ps -axo … | grep -i aicoin'` 的 `sh` 和 `grep` 两行 cmdline 含 "aicoin"、argv[0] 是 `/bin/sh`、无 `--type=`，被 `classifyProcess` 判成 main。后果：AiCoin 根本没开时 `launch()` 也误判"已在运行"而拒绝启动。修法：新增 `isAiCoinBinary()`，只认 `basename(argv[0])` 匹配 `/^aicoin(\.exe)?$/i`。
2. **`launch()` 只要端口应答就报成功** —— 被环境限制的启动进程会先 bind 9222、打印 `DevTools listening on …`，然后在 ~1s 内死掉，却仍被算成功。修法：新增 `confirmStable({port, pid})`，settle 1.5s 探一次、700ms 后再探一次，要求端口仍应答且 pid 仍存活；失败时明确回 `single-instance-conflict` 或 `exited-after-port-open`。
3. **`findAppPath()` 没有 macOS 候选** —— 默认值写死 `D:\Program Files\AiCoin\AiCoin.exe`。修法：新增 `resolveBundleExecutable()`（读 `Info.plist` 的 `CFBundleExecutable`，把 `*.app` 解析成 `Contents/MacOS/<exe>`）+ darwin/linux 候选路径。
4. **`aicoin_live_check` 长期谎报「端口不可达」** —— `httpGet()` 用裸 socket 等 `close` 事件，Chrome 不保证遵守 `Connection: close`，端口健康时也必然 4 秒超时。修法：改用运行时自带 `fetch()` + AbortController。
5. **抓函数库时选错窗口** —— 取第一个 page 目标 = `#/notice` 通知窗，在那里调 axios 抛 `BUSINESS_REQUEST_DENIED`。修法：优先 `#/main`，其次 K 线窗，最后才 fallback。
6. **`window.__kk_wr` 缓存判定太松** —— `if (!window.__kk_wr)` 让一次坏 `require` 永久失败。修法：`typeof !== 'function'`。

**新增**

- `aicoin_app_connect`：一步把「正在跑但没开调试端口」的客户端变成可控状态（`allowRestart:true` 时带端口重启），`aicoin_app_status` 同时给出机器可读的 `nextAction`。
- `aicoin_app_indicator_publish` + `aicoin_app_indicator_del`：直接写进客户端并回传服务端 `compileResult`（`pass/errLine/errColumn/err/sourceLine/caret/warnings`），`verify` 模式自动删探针。
- `resyncTools()`：MCP 子进程重启后自动按新 `tools/list` 撤旧注册、重注册，不必再重启整个 DSH。
- 静态规则 `TIME_IS_FLOAT`（error）与 `DISPLAY_NON_CONSTANT`（warning），依据是对客户端的真机实测。
- `aicoin_library_refresh`：与客户端 `functionLib` 对齐，缺失条目落 `data/live-extra.json`，以 stub 并入知识库（不猜签名）。
- Open Data v3 客户端（HMAC-SHA1 签名）+ 8 个行情工具 + 免费档能力表。

**已知限制**

- MCP 子进程重启后，DSH 侧工具注册需要 `resyncTools()`（已自动接在 `restartClient()` 后）。
- 免费档 key 对衍生品/资讯/指标 K 线一律 403，代码里明确回 `needs_paid_key`，不造数据。
- 面板的 client 半要重启 DSH 才更新（宿主半同理）。
