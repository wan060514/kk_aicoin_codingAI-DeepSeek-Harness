# kk_aicoin_codingAI · DeepSeek Harness

把 **AiCoin 桌面客户端** 和 **DeepSeek Harness** 接成一个闭环：让 AI 直接读你屏幕上的图表、把 AiScript 脚本**写进客户端并拿回服务端编译结论**，再用同一套知识库离线校验、交付脚本。

不提供回测，不产出任何绩效数字（拆包后的 AiCoin 编辑器本来就没有回测功能，这类数字只能是编造的）。

```
需求（口语）
  ↓  量化规格 spec.md / spec.json
  ↓  生成 AiScript（带仓位状态机的模板）
  ↓  aicoin_validate                    离线静态校验，36 条规则，改到 0 error
  ↓  aicoin_app_indicator_publish(mode:"verify")   写进客户端 → 真编译 → 删探针
  ↓  aicoin_app_indicator_publish(mode:"publish")  确认无误再留在账号里
  ↓  交付 strategy.txt
```

## 这个仓库里有什么

| 包 | 作用 | 形态 |
|---|---|---|
| [`aicoin-mcp/`](aicoin-mcp/README.md) | 通过 CDP 控制 AiCoin 客户端 + 消费 AiCoin Open Data 行情接口 | MCP 服务器（27 个工具）+ DSH 侧栏面板 |
| [`kk-aicoin-coding-ai/`](kk-aicoin-coding-ai/README.md) | AiScript 知识库、静态校验器、策略模板、交付流程 | DSH 插件（12 个工具） |

两个包不是重复关系：**前者是「手」**（能操作客户端、能读行情），**后者是「脑子」**（知道 AiScript 该怎么写、哪里会编译失败）。DSH 侧栏面板把两者放进同一张页。

`AGENTS.md` 是长驻工作区约定：交付文件命名规则、脚本交付三件套、真机排错五步流程。它也是仓库的一部分，方便别的 AI 会话接手。

## 快速上手

```bash
git clone https://github.com/kkezzzz/kk_aicoin_codingAI-DeepSeek-Harness
cd kk_aicoin_codingAI-DeepSeek-Harness

# 1) MCP 桥（控制 AiCoin + 行情数据）
cd aicoin-mcp && node install.mjs      # 装进 ~/.dsh/profiles/<profile>/plugins/

# 2) AiScript 工具链
cd ../kk-aicoin-coding-ai && node install.mjs
```

装完**重启 DeepSeek Harness**（插件宿主半在进程内存里；热重载只对 MCP 子进程有效）。

AiCoin 的 CDP 只能在**启动时**开启，事后无法附加。第一次用先让工具替你重启一次客户端：

```js
aicoin_app_connect({ allowRestart: true })   // 会关掉当前 AiCoin 窗口，几秒后带调试端口重开
```

## 能力边界（写在最前面）

- **不提供回测**。仓库里没有任何收益率/胜率/夏普/回撤数字，将来也不会有。
- **Open Data 只用免费档**，且**只调 GET 只读接口**。衍生品、资讯、指标 K 线要付费 key，代码里会明确回 `needs_paid_key`，不会假装有数据。
- **不接交易所密钥、不下单**。官方包里的 `create_order` / `transfer` 一类接口，本仓库一个都没接。
- **写账号只有两条路**：`indicator_publish`（建/改自定义指标）与 `indicator_del`（删）。两者默认 dryRun，必须 `confirm:true`；`mode:"verify"` 会自己收拾探针，账号里不留垃圾指标。
- 静态校验不是编译器 —— `aicoin_validate` 0 error 只代表静态层面自洽，能否编译以服务端 `compileResult` 为准，所以有 `mode:"verify"` 这一步。

## 为什么值得一看

价值不在「让 AI 写指标」，而在**把客户端的真实行为变成可执行的约束**：

- `time` 在客户端里是 `float`，写成 `var int t0 = time` 服务端直接报 `cannot use float as type int in assignment` → 现在是静态规则 `TIME_IS_FLOAT`。
- 绘图函数的 `display` **只认字面量布尔**：传 `barstate.islast` 编译不报错，但**整组线一个都不画** → 现在是静态规则 `DISPLAY_NON_CONSTANT`，并把「只画最新一根」的正确做法（几何门控）写进 hint。
- `line.new` / `label.new` 是**按调用点维护同一对象、后写覆盖**，不是每根 K 线堆新对象（A/B 探针实测）→ 老式「每根都画」的写法其实是对的，不必自己加门控。
- 客户端函数库 334 条，本地快照会随版本漂移 → `aicoin_library_refresh` 用客户端自己的 `functionLib` 接口对齐，缺失条目降级成 stub（不猜签名），从此不再误报 `UNKNOWN_FUNCTION`。

这些不是从文档里读出来的，是 2026-10-24 用二分探针 + 保存接口的 `compileResult` 一条条测出来的。方法与踩坑记录见 [`docs/pitfalls.md`](docs/pitfalls.md)。

## 文档

- [`docs/architecture.md`](docs/architecture.md) — 两个包的进程模型、数据流、为什么这么切
- [`docs/pitfalls.md`](docs/pitfalls.md) — AiCoin 客户端已确认行为 + 排错流程（含二分探针模板）
- [`docs/validation-rules.md`](docs/validation-rules.md) — 36 条静态校验规则，逐条给出依据
- [`docs/changelog.md`](docs/changelog.md) — 版本变更与本次修掉的六个真 bug
- [`AGENTS.md`](AGENTS.md) — 长驻约定：交付命名、脚本三件套、排错五步

## 环境

- macOS / Windows 均可（macOS 自动把 `AiCoin.app` 解析成 `Contents/MacOS/AiCoin`）。
- Node 18+（也可以用 Electron 自带运行时：`ELECTRON_RUN_AS_NODE=1 <App 可执行文件>`）。
- AiCoin 桌面客户端（实测版本 2.16.29 / Chrome 150）。
- DeepSeek Harness（插件宿主）。

## License

MIT，见 [LICENSE](LICENSE)。AiCoin 客户端本身是商业软件，本仓库不含其任何二进制或代码副本，只包含对公开接口的使用方式与自行整理的函数库数据。
