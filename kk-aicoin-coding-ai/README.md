# kk_aicoin_codingAI

**量化工程师视角的 AiCoin AiScript 策略助手（DeepSeek Harness 插件）**

它把用户嘴里那句「涨得猛就买，跌了就跑」变成**可编译的 AiScript 脚本**，并且全程不撒谎。

---

## 一、它解决什么问题

普通 AI 写指标脚本的三个坑：

| 坑                 | 本插件怎么处理                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------- |
| 需求太模糊，AI 自己编参数    | `aicoin_spec_draft` 把口语需求拆成 13 个量化槽位，识别「涨得猛 / 放量 / 超买 / 突破 / 稳赚」等模糊词，给出可计算改写，并**列出必答问题去问用户** |
| 函数名、参数名凭记忆写，一跑就报错 | 内置从 AiCoin 客户端提取的 **334 条函数库**（含参数表、必要参数、返回值、官方示例），写前先查                                      |
| 改来改去没法验证          | `aicoin_validate` 做词法 + 语法 + 语义 + 函数库签名比对，返回带行列的诊断，**循环到 error = 0** 才算完                     |

还有一条最重要的：

> ### 它不会给你回测数据。
>
> 拆包的 AiCoin 编辑器里**不存在回测功能**。所以任何「胜率 65%」「年化 120%」都只能是编造的。  
> 本插件不输出收益率、胜率、夏普、最大回撤、盈亏比——一个都不输出。它只做**代码逻辑层面的客观校验**和**结构层面的优化建议**。

---

## 二、安装

```bash
# 1. 进入插件目录
cd kk_aicoin_codingAI

# 2. 装进 desktop profile（默认先装成 disabled，确认后再打开）
node install.mjs --profile desktop --enable --run-pnpm --workspace "D:/my-strategies"

# 3. 重启 DSH（或等 patch 层热重载）
```

装好后新会话里应该能看到这些工具：

```
aicoin_status  aicoin_library_search  aicoin_library_get  aicoin_language_reference
aicoin_spec_draft  aicoin_spec_status  aicoin_validate  aicoin_scaffold
aicoin_optimize_advice  aicoin_deliver  aicoin_live_check
```

第一句话建议说：**「用 aicoin_status 看看插件状态」**。

卸载：

```bash
node install.mjs --profile desktop --uninstall
```

---

## 三、工作流

```
① aicoin_spec_draft   把用户原话变成量化规格，拿到「必答问题清单」+ 仓位模式选项
        ↓
② ask_user_question   一次问 2~4 个必答项（必须包含仓位运行模式，带建议选项）
        ↓
③ aicoin_spec_draft   把答案写回 values，直到 readyToCode = true
        ↓
④ aicoin_library_search / aicoin_library_get   逐个确认要用的函数真实存在
        ↓
⑤ aicoin_scaffold     按仓位模式取模板（模板自带状态机，保证能过校验）
        ↓
⑥ aicoin_validate  ←→ 修正 ——循环，直到 error = 0
        ↓
⑦ aicoin_optimize_advice   结构审查：仓位状态机/止损/未来函数/重绘/过拟合/外部依赖
        ↓
⑧ aicoin_deliver      输出 strategy.txt + spec.md + 校验报告 + 建议 + README
```

同时注册了技能 **`aicoin-strategy-engineer`**，里面是完整的量化工程师方法论和反模式清单。

---

## 三之一、仓位运行模式：这一版最重要的改动

### 为什么必须让用户先选模式

一句 `enterLong(close > ma(close, 20))` **能通过语法校验，也是错的**：只要条件成立，脚本会在**每一根 K 线**上重复开仓；平仓条件同理，在没有持仓时也会反复触发。根因是脚本里没有任何东西记住「我现在是否持仓」。

所以插件现在把仓位管理做成**必答项**：`aicoin_spec_draft` 会列出 6 种模式让用户选，并说明每种模式需要哪些状态变量。

| 模式 | 运行方式 | 模板 | 记录的状态变量 |
| --- | --- | --- | --- |
| **一开一平** | 同一时间只持一仓，平掉才允许再开 | `ma-cross` / `donchian-breakout` / `rsi-reversal` | `in_long` `entry_price` `entry_bar` `last_exit_bar` |
| **反手** | 持多遇空信号 → 平多并开空，反之亦然 | `mode-reverse` | `pos`(1/-1/0) `entry_price` `entry_bar` `last_exit_bar` |
| **分批止盈** | 到 +3%/+6%/+9% 分别减 30%/30%/40% | `mode-scaled-tp` | `in_long` `entry_price` `tp_stage` `last_exit_bar` |
| **马丁加仓** | 首仓后每跌 1.5% 加一层，最多 4 层，按加权均价止盈止损 | `mode-martingale` | `layer` `avg_price` `last_add_price` `entry_bar` |
| **移动止盈** | 盈利超 2% 后启动跟踪，从持仓峰值回撤 1.5% 平仓 | `mode-trailing` | `peak_price` `entry_price` `entry_bar` |
| **自定义** | 用户描述规则，插件据此设计状态机 | — | 由规则决定 |

如果用户话里出现「加仓 / 反手 / 分批 / 移动止盈」，`aicoin_spec_draft` 会给出**预判**，但预判只作为问题去确认。

### 生成的脚本遵守的三条不变量

```javascript
// ① 跨 K 线的仓位状态（只有 var / varip 能跨 K 线保存）
var in_long = false
var entry_price = 0.0    // 止损止盈的唯一基准
var entry_bar = 0        // 时间止损 / 冷却的基准
var last_exit_bar = 0

// ② 每一笔下单都是边沿触发 或 状态保护
open_long  = crossup(fast, slow) and not in_long and cooled
close_long = in_long and (dead or stop_hit or tp_hit or timeout)

// ③ 状态先于交易更新，平仓后必须复位
if (open_long) {
    in_long := true
    entry_price := close
    entry_bar := bar_index
}
if (close_long) {
    in_long := false
    entry_price := 0.0
    last_exit_bar := bar_index
}

// 然后才是交易调用（根作用域，每个指令只声明一次）
tradeConfig(price = "market", amount = 1)
enterLong(open_long, price = "market", amount = 1)
exitLong(close_long, price = "market", amount = 1)
```

不遵守第 ①、② 条会被 `NO_POSITION_STATE` / `REPEATED_TRADE_RISK` 拦下；不遵守第 ③ 条（只置位不复位）会被 `STATE_NEVER_RESET` 拦下。

反过来，**把条件抽成变量的写法不会误报**——校验器会把标识符递归展开到定义再判断，所以 `enterLong(open_long)` 仍然被识别为「边沿触发 + 状态保护」。

---

## 四、工具说明

| 工具                          | 作用                                        |
| --------------------------- | ----------------------------------------- |
| `aicoin_status`             | 自检：函数库条数、规则数、默认工作目录、模板列表                  |
| `aicoin_library_search`     | 在 334 条函数库里检索（支持中文用途词）                    |
| `aicoin_library_get`        | 取完整条目：参数表、返回、全部官方示例、已知限制                  |
| `aicoin_language_reference` | 语言速查：关键字/运算符/内置变量/语法结构/硬上限/已知坑            |
| `aicoin_spec_draft`         | **需求客观化**：模糊词 → 可计算改写 + 必答问题 + **仓位运行模式选择** + 写入 spec.md |
| `aicoin_spec_status`        | 复查规格还缺什么                                  |
| `aicoin_validate`           | **静态自校验**：返回带行列的错误/警告/提示，可写报告             |
| `aicoin_scaffold`           | 从 9 个可校验通过的模板生成骨架（含 5 种仓位模式的状态机实现）        |
| `aicoin_optimize_advice`    | 结构审查与优化方向（无绩效数字）                          |
| `aicoin_deliver`            | 交付打包（有 error 会拒绝交付）                       |
| `aicoin_live_check`         | **只读**检查运行中的 AiCoin：调试端口、线上函数库与本地的差异      |

---

## 五、校验器到底校什么

`aicoin_validate` 是离线静态分析器，不联网、不需要 AiCoin 运行。规则全部来自客户端自己的资料：

**来自函数库（334 条签名）**

- 函数是否存在（`UNKNOWN_FUNCTION`）
- 参数个数（`ARITY_TOO_MANY` / `ARITY_TOO_FEW`）
- 命名参数大小写（`NAMED_ARG_CASE`，例如 `linewidth` → `lineWidth`，客户端会直接编译失败）
- 未知命名参数、重复命名参数
- 交易指令唯一性（`SINGLE_DECLARATION`）、唯一 id（`MISSING_UNIQUE_ID` / `DUPLICATE_TRADE_ID`）
- 根作用域限制（`ROOT_SCOPE_REQUIRED`，`label.new` / `line.new` / `box.new` / 交易函数）
- 首参必须布尔（`REQUIRE_CONDITION_FIRST_ARG`）

**来自语言定义与文档硬约束**

- `for` 循环 500 次上限（`FOR_LOOP_LIMIT`，会按步长换算）
- `[]` 历史引用 500 上限、`{}` 下标 1000 上限
- `[]` 与 `{}` 混用（`INDEX_ON_NON_COLLECTION`）
- 块内 `=` 遮蔽外层变量（`ASSIGN_IN_BLOCK_SHADOWS`）
- `nan` 用 `==` 比较（`NAN_COMPARISON`）、除零（`SUSPICIOUS_DIVISION`）
- 配置函数唯一性与位置（`CONFIG_ONCE` / `CONFIG_NOT_AT_TOP`）
- 未声明变量、未使用变量、类型标注不符、三元类型不一致

**仓位状态机规则（这一组才是「能跑」和「交易正确」的分界）**

- `NO_POSITION_STATE` —— 有交易指令，却没有任何 `var` 仓位状态变量，也没读 `strategy.position`
- `REPEATED_TRADE_RISK` —— **下单条件既不是边沿信号也没有状态保护，条件成立的每根 K 线都会重复下单**
- `STATE_NEVER_RESET` —— 状态变量只被置 `true`，从未置回 `false`（平仓后再也不会开仓）
- `EXIT_WITHOUT_ENTRY_RECORD` —— 按百分比止损/止盈，却没有记录入场价（跳空后止损位漂移）
- `NO_ENTRY_BAR_RECORD` —— 没有记录入场 K 线，做不了时间止损与平仓冷却

判定方式是**跨语句的**：校验器会把标识符展开到它的定义（最多递归展开），所以
`enterLong(open_long)` → `open_long = crossup(a,b) and not in_long` 能同时被识别为
「边沿触发」与「状态保护」，不会因为你把条件抽成变量就误报。

**实证质量**（`node test/validate.test.mjs`）

- 函数库全部 **335 段官方示例**：**0 个语言/函数库 error 级误报**（仓位状态类规则只命中文档里真实含下单语句的 16 个函数示例，且被单独断言过）
- 一份**平台逐根比对验证过的 110 行真实策略**（点金线还原版）：**0 诊断**
- 21 个专项 fixture（每个已知坑 + 仓位状态机反例各一个）：全部命中预期规则
- 16 组恶意/残缺输入：不崩溃
- 交付脚本文件名固定为 `strategy.txt`，测试里显式断言不会生成 `.aiscript`

---

## 五之一、给 AiCoin 侧栏面板用的 HTTP 路由（v1.0.2）

`lib/panel-api.js` 挂载 `/plugins/kk-aicoin`，让 `dsh-plugin-aicoin-mcp` 的侧栏面板
能显示一块「AiScript 工具链」卡片——两个插件之间不互相 import，只走同源 HTTP：

```
GET  /plugins/kk-aicoin/state    → { version, workspace, library:{entries,functions,variables,rules} }
POST /plugins/kk-aicoin/action   → { action, ... }
     validate        { path }              静态校验脚本文件（诊断最多回 60 条）
     library.search  { query, limit? }     函数库关键词检索（最多 40 条）
     library.get     { name }              单条完整条目（签名/参数/示例/文档）
     spec.status     { name | path }       读 spec.json，回完成度与待确认问题
     advice          { path }              结构审查（止损/熔断/仓位状态/未来函数/重绘），最多回 12 条
```

设计约束：面板属主是 aicoin-mcp 插件，所以路由挂在本插件自己的前缀下；没装本插件时
那边会收到 404 并显示一句降级提示。没有 `webServer`（无头 profile）时自动跳过，
工具照常可用。规格目录取插件配置的 `workspace` + `strategyDir`（本机是
`.../aicoin/strategies`），所以面板里的「策略名」和工具的 `name` 指的是同一个 slug。
`advice` 只给结构与逻辑层面的审查，**不产生任何绩效指标**。

## 六、能力边界（请如实告知用户）

| 能做                    | 不能做             |
| --------------------- | --------------- |
| 把模糊需求量化成可计算条件         | 不能回测            |
| 按客户端函数库生成脚本           | 不能给胜率/收益/夏普/回撤  |
| 离线静态逻辑校验（词法/语法/语义/签名） | 不能替代服务端编译器的最终判定 |
| 结构审查与优化方向             | 不能保证策略在实盘赚钱     |
| 只读比对线上函数库版本           | 不会替你保存脚本到账号     |

### 关于「真正的编译校验」

逆向结论（见 `research/compile-flow.md`，有代码级证据）：

- 客户端**没有本地 AiScript 编译器**。`Parser` / `ast` 在 4 个 bundle 里 0 命中；`script/compile|check|validate` 全部 0 命中。Monaco 里的红线黄线**全部来自服务端响应**。
- **「编译」就是「保存」**：`POST upgrade/customIndicator/script/save`，结果在 `data.compileResult`（字段：`pass` / `err` / `errLine`（1 基）/ `errColumn`（0 基）/ `warnMessage[]` / `securityCount` / `hasTrade` / `hasAlert`）。
- 这个请求**会真的**在你的账号里新建或覆盖一条自定义指标，并且受 VIP / `securityCount` 配额限制。客户端自己把它列进「不能随意重试」的敏感端点。

所以本插件**不代为保存**。真正的最终编译校验请在客户端里自己点「保存并校验」。`aicoin_live_check` 只做只读的版本比对。

---

## 七、目录结构

```
kk_aicoin_codingAI/
├── lib/
│   ├── index.js              插件入口：注册工具 + 技能 + 提示段落
│   ├── tools.js              11 个工具的实现
│   ├── data.js               知识库加载与索引（签名 → 参数分组）
│   ├── spec.js               需求客观化引擎（14 槽位 + 18 条模糊词规则 + 6 种仓位模式）
│   ├── templates.js          9 个可校验通过的策略模板（含 5 种仓位模式的状态机实现）
│   ├── advice.js             结构审查与优化建议（含仓位状态机检查）
│   ├── live.js               只读 CDP 检查（手写 WebSocket，无依赖）
│   └── aiscript/
│       ├── lexer.js          AiScript 词法分析（对齐客户端 Monarch 定义）
│       ├── parser.js         递归下降语法分析（含容错恢复）
│       ├── analyze.js        语义分析：作用域、调用、上限、仓位状态机
│       └── validate.js       公开 API：源码 → 诊断
├── data/                     内置知识库（构建产物，可用 tools/build_data.mjs 重建）
│   ├── aiscript_functions.json   334 条函数（733 KB）
│   ├── aiscript_language.json    语言定义 + 硬上限
│   ├── aiscript_rules.json       34 条规则文案（单一事实来源）
│   ├── quick_index.md            速查索引
│   └── README.md
├── skill/SKILL.md            量化工程师方法论（含仓位状态机三条不变量）
├── test/                     validate.test.mjs（92 项）+ smoke.mjs（88 项）
├── tools/build_data.mjs      从函数库资料包重建 data/
├── tools/package_bundle.mjs  生成可分享的单文件压缩包
├── research/                 逆向证据：编辑器词法、编译流程、结论
├── install.mjs               安装 / 卸载
└── cordis.patch.yml          bundle 形式的加载行
```

---

## 八、数据来源与重建

函数库来自 AiCoin 桌面客户端内置接口 `POST /api/upgrade/customIndicator/script/functionLib`，通过 CDP 注入客户端自身 axios（复用其 RSA+AES 拦截器）导出，见函数库资料包里的 `原始数据与工具/构建脚本/`。

客户端升级后想同步：

```bash
node tools/build_data.mjs --source "<函数库资料包目录>"    # 重建 data/
node test/validate.test.mjs && node test/smoke.mjs        # 回归
```

或者直接 `aicoin_live_check action=library-diff`，只读对比线上与本地的差异。

---

## 九、自测

```bash
node test/validate.test.mjs   # 校验器：语料 / 真实脚本 / fixture / 健壮性
node test/smoke.mjs           # 插件：注册、每个工具的实际调用、卸载
```

两个套件必须全绿再发布。

---

## 十、已知限制（诚实清单）

1. **参数表完整性**：客户端有 263 个条目的参数表没有「默认值」列，另有 50 个条目没有参数表。这些条目的必填性无法判定，校验器对它们**只做上限校验，不报缺参**，避免误报。工具输出里会标 `参数表不全`。
2. **文档自相矛盾**：例如 `line.new` 的参数表把 `refSeries` 标为必要参数，但函数库自己的示例省略了它。校验器把「可能缺参」降级为**警告**并说明原因。
3. **作用域解析是保守的**：同名变量在不同作用域只按名字统计使用情况，因此 `UNUSED_VARIABLE` 只会漏报不会误报。
4. **`aicoin_live_check` 未经端到端实测**：本机开发时 AiCoin 未运行，只有端口探测路径验证过；`library-diff` 依赖客户端 webpack 模块 id `31438`（axios 实例），客户端大版本更新后可能失效——失效时会给明确报错，不影响离线功能。
5. **不是编译器**：静态校验能抓到文档明确规定的错误和大量结构性缺陷，但**不能替代服务端编译器**。最终判定请在客户端「保存并校验」。

---

## 十一、许可

MIT。内置函数库文档版权归 AiCoin 所有，此处仅用于指标脚本编程辅助。
