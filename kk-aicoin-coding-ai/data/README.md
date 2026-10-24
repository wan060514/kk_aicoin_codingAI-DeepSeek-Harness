# kk_aicoin_codingAI · data 目录说明

本目录是插件随包发布的 **AiScript 数据层**，由 `tools/build_data.mjs` 从 AiCoin 桌面客户端解包出的
函数库结构化数据自动生成。**请勿手工修改**，改数据请改构建脚本后重新生成。

## 文件一览

| 文件 | 内容 | 主要消费者 |
| --- | --- | --- |
| `aiscript_functions.json` | 函数库全量数据：334 条（functions 270 / variables 25 / operators 39），含签名、参数、必填性、默认值、示例、flags | 补全、跳转、参数提示、函数检索 |
| `aiscript_language.json` | 语言定义：关键字、运算符、内置变量、命名空间、类型、注释/折叠语法与各项上限 | 词法高亮、语法配置、常量校验 |
| `aiscript_rules.json` | 校验规则目录（29 条），每条含 id / severity / title / message / hint / source | 校验器（`validator` 直接 import，规则文案的单一事实来源） |
| `quick_index.md` | 按分类分组的单行速查索引，一页看完 334 条 | 喂给模型的紧凑上下文、人工速查 |
| `README.md` | 本文件 | 人 |

## 数据来源

- 源文件：`结构化数据/函数库结构化数据.json`（334 条，17 个分类）、`结构化数据/AiScript语言定义.json`
- 上游：AiCoin 桌面客户端内置接口 `POST /api/upgrade/customIndicator/script/functionLib`
- 提取日期：2026-10-05

## 字段约定（aiscript_functions.json）

- `params[].required`：源数据 `default === "(必要参数)"` 时为 `true`。
- `params[].default`：源数据里的 `"(必要参数)"` / `"(非必要参数)"` / `null` 一律归一化为 `null`，其余保留原始字面量（如 `'gray'`、`true`、`[0]`）。
- `minArgs` = 必填参数个数；`maxArgs` = 参数个数，签名含 `...` 的可变参数函数为 `null`。
- `flags.arityUnknown`：该条目在客户端文档里没有「默认值」列（参数全为 `null`），或本身没有参数表，**参数个数不可信，校验时应当放宽**。
- `flags.rootScopeOnly`：必须在根作用域调用（不能放进 `if` 块），共 16 条（12 个交易指令 + label/line/box/new）。
- `flags.singleDeclaration`：每种指令最多声明一次（enterLong / exitLong / enterShort / exitShort，共 4 条）。
- `flags.requiresUniqueId`：8 个 `*Amount` / `*Percent` 交易函数，`id` 必须唯一。
- `flags.conditionFirstParam`：`plotText` / `plotShape` 的第一个参数必须是布尔条件。
- 数组排序：`functions` / `variables` / `operators` 按 `name` 升序（`localeCompare('en')`），`categories` 按 `title` 升序。

## aiscript_language.json

- `builtinVars`：语言定义内置变量 ∪ 函数库 25 个 `variable` 条目，去重排序（共 29 个）。
- `namespaces`：从函数库条目名与签名头里的点号前缀推导（barstate / box / label / line / strategy / syminfo）。
- `limits`：for 循环 500 次、历史引用回溯 500 点、下标长度 1000。

## 重新生成

```bash
cd kk_aicoin_codingAI
node tools/build_data.mjs                     # 使用默认源目录与 ../data
node tools/build_data.mjs --source "<结构化数据目录>" --out ../data
node tools/verify_data.mjs                    # 自检：条目数 / flags / 排序 / 规则 id / 文件体积
```

脚本零第三方依赖，确定性输出（仅 `meta.generated_at` 随时间变化，可用 `--now <ISO>` 或
环境变量 `SOURCE_DATE_EPOCH` 固定）。源文件缺失或 `total_items` 与展平条目数不一致时会以非 0 退出码报错。

## 本次生成的文件体积

| 文件 | 字节 |
| --- | --- |
| `aiscript_functions.json` | 733,566 B |
| `aiscript_language.json` | 1,738 B |
| `aiscript_rules.json` | 14,773 B |
| `quick_index.md` | 39,752 B |
