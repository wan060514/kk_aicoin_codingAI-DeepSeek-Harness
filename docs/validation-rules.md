# 静态校验规则清单（36 条）

由 `kk-aicoin-coding-ai/data/aiscript_rules.json` 生成。级别 `error` 只给「平台官方文档或真机实测确认会编译失败」的构造；其余一律 `warning`，避免把推断当真理。


## error

### `ARITY_TOO_FEW` — 参数过少

- 说明：`{name}` 至少需要 {minArgs} 个参数，当前只传了 {actual} 个。
- 修法：查看该条目的 params 中 required=true 的项；label.new/line.new/box.new 的第一个坐标参数是一个数组，如 [time, high]。
- 依据：函数库结构化数据.json 各条目 params[].default === "(必要参数)"

### `ARITY_TOO_MANY` — 参数过多

- 说明：`{name}` 最多接受 {maxArgs} 个参数，当前传了 {actual} 个。
- 修法：maxArgs 为 null 表示可变参数（如 max/min/avg/string_format），可传任意多个。
- 依据：函数库结构化数据.json 各条目 signature 与 params 数量

### `DUPLICATE_NAMED_ARG` — 命名参数重复

- 说明：同一调用里命名参数 `{arg}` 出现了多次。
- 修法：删除重复项；位置参数与命名参数混用时，位置参数必须全部排在命名参数之前。
- 依据：函数库结构化数据.json 各条目 params[].name

### `DUPLICATE_TRADE_ID` — 交易 id 重复

- 说明：交易声明的 id `{id}` 重复，同一脚本内 id 必须唯一。
- 修法：给每个 *Amount / *Percent 调用换一个语义化且唯一的 id。
- 依据：函数库条目 enterLongAmount / enterShortAmount / exitLongAmount / exitShortAmount 的 id 参数说明

### `FOR_LOOP_LIMIT` — for 循环超出上限

- 说明：for 循环单次迭代超过 {limit} 次会报错。
- 修法：把循环上限压到 500 以内，或改用 range / array_* 系列函数批量处理。
- 依据：README 已知坑 4；aiscript_language.json limits.forLoopMaxIterations = 500

### `HISTORY_LOOKBACK_LIMIT` — 历史引用超出上限

- 说明：`[]` 最多只能回溯最近 {limit} 个数据点，当前为 {actual}。
- 修法：缩短回溯长度，或改用 highest/lowest/valuewhen 等函数间接取历史。
- 依据：README 已知坑 5；aiscript_language.json historyRef.maxLookback = 500

### `INDEX_LENGTH_LIMIT` — 下标超出上限

- 说明：`{}` 的数组/字典最大长度为 {limit}，下标从 0 开始。
- 修法：减小容器长度，或分片处理。
- 依据：README 已知坑 6；aiscript_language.json indexRef.maxLength = 1000

### `INDEX_ON_NON_COLLECTION` — 下标运算符用错对象

- 说明：`{}` 只能用于数组/字典，历史 K 线取值请用 `[]`。
- 修法：`[]` 取历史 K 线值（close[1]），`{}` 取数组/字典下标（arr{0}），两者是不同的运算符。
- 依据：README 已知坑 7；函数库「引用运算符」条目 [ ] 与 { }

### `MISSING_UNIQUE_ID` — 缺少唯一 id

- 说明：`{name}` 必须传入唯一的 id 参数作为订单标识符。
- 修法：补上 id，例如 enterLongAmount(cond, id="long_buy", price="market", amount=100)。
- 依据：函数库条目 enterLongAmount 等（id为唯一标识符，不可重复）；flags.requiresUniqueId

### `NAMED_ARG_CASE` — 命名参数大小写不匹配

- 说明：命名参数 `{arg}` 大小写不正确，应为 `{expected}`。
- 修法：命名参数大小写敏感：lineWidth 必须驼峰，写成 linewidth / LineWidth 会报错。
- 依据：README 已知坑 1；函数库结构化数据.json 各条目 params[].name

### `NO_POSITION_STATE` — 没有记录仓位状态

- 说明：脚本里有交易指令，但没有任何跨 K 线保持的仓位状态变量（var/varip），也没有读取 strategy.position。
- 修法：至少声明一个状态变量，例如 var in_long = false，并在开仓/平仓分支里用 := 更新它；否则脚本无从知道自己是否已有持仓。
- 依据：函数库「数据类型」条目 var/varip（跨 K 线保持）；函数库条目 strategy.position（获取当前策略持仓）

### `PARSE_ERROR` — 语法错误

- 说明：脚本存在无法解析的语法结构，编译器无法继续。
- 修法：检查括号/引号是否成对闭合、语句是否完整；AiScript 语句不以分号结尾，多写分号通常无害但不规范。
- 依据：AiScript语言定义.json（languageConfig.brackets / autoClosingPairs）

### `REPEATED_TRADE_RISK` — 下单条件会重复触发

- 说明：交易指令 `{name}` 的触发条件既不是边沿信号（crossup / crossdown / rising / falling），也没有引用任何仓位状态变量。
- 修法：条件每根 K 线都成立时会重复下单。改成「边沿信号 + 状态保护」，例如 crossup(fast, slow) and not in_long，并在平仓后把状态复位。
- 依据：函数库条目 crossup / crossdown / rising / falling（边沿判断）；交易函数 cond 参数说明

### `REQUIRE_CONDITION_FIRST_ARG` — 第一个参数必须是布尔条件

- 说明：`{name}` 的第一个参数 cond 必须是布尔系列条件。
- 修法：写成 plotText(close < open, ...) / plotShape(crossup(close, ma(close,20)), ...)，不要把数值序列当条件。
- 依据：函数库条目 plotText / plotShape 的 cond 参数说明（是否进行绘制的bool系列）；flags.conditionFirstParam

### `ROOT_SCOPE_REQUIRED` — 必须在根作用域调用

- 说明：`{name}` 必须在根作用域调用，不能放在 if / for 等代码块内。
- 修法：把调用移到最外层，用第一个 cond 参数控制是否触发；例如 enterLong(cond, ...) 而不是 if (cond) { enterLong(...) }。
- 依据：README 已知坑 3；函数库条目 label / line / box / enterLong 等（flags.rootScopeOnly）

### `SINGLE_DECLARATION` — 交易指令重复声明

- 说明：`{name}` 每种指令最多只能声明一次，重复声明会产生编译错误。
- 修法：需要多次下单请改用 *Amount / *Percent 系列（必须带唯一 id）。
- 依据：README 已知坑 2；函数库条目 enterLong / exitLong / enterShort / exitShort

### `TIME_IS_FLOAT` — time 是浮点，声明成 int 会编译失败

- 说明：`var int <name> = time` 在客户端会被服务端编译器拒绝：cannot use float as type int in assignment。
- 修法：把 int 改成 float（`var float t0 = time`），或去掉类型让它自动推导（`var t0 = time`）。
- 依据：真机实测 2026-10-24：AiCoin 2.16.29 保存接口返回 data.compileResult.err = "第 2 行第 8 列：cannot use float as type int in assignment"

### `UNKNOWN_FUNCTION` — 未知函数

- 说明：函数 `{name}` 不在 AiScript 函数库中，运行时会报未定义。
- 修法：对照 quick_index.md 或 aiscript_functions.json 核对拼写；注意大小写与下划线（如 array_size、string_tolower、pivothigh）。
- 依据：函数库结构化数据.json（334 条，functions 270 条）

### `UNKNOWN_NAMED_ARG` — 未知命名参数

- 说明：`{name}` 没有名为 `{arg}` 的命名参数。
- 修法：命名参数只能用该条目 params[].name 中列出的名字，漏写会退化成位置参数导致错位。
- 依据：函数库结构化数据.json 各条目 params[].name


## warning

### `ASSIGN_IN_BLOCK_SHADOWS` — 块内赋值遮蔽/丢失

- 说明：在 if / for 块内对块外变量赋值，语义容易与预期不符。
- 修法：`var` 只在第一根 K 线初始化；`varip` 在实时 K 线内也会持续更新。需要跨 K 线保持状态请显式使用 var / varip。
- 依据：README 已知坑 8；函数库条目 var / varip

### `CONFIG_NOT_AT_TOP` — 配置函数位置不当

- 说明：`{name}` 属于配置函数，应放在脚本顶部（版本声明之后、其他语句之前）。
- 修法：把 indicator(...) / tradeConfig(...) 上移到 // @version=2 之后的第一段。
- 依据：函数库「配置函数」分类（indicator / tradeConfig）

### `CONFIG_ONCE` — 配置函数重复调用

- 说明：`{name}` 只能设置一次，重复调用不会生效。
- 修法：indicator / tradeConfig 各脚本只保留一处调用。
- 依据：函数库条目 indicator（用于设置显示的精度，只能设置一次）、tradeConfig（只能设置一次）

### `DISPLAY_NON_CONSTANT` — display 只认字面量布尔

- 说明：drawing 函数的 display 参数只认 true/false；传序列（barstate.islast、a and b 等）在客户端不报错，但整组绘图一个都不显示。
- 修法：要做「只画最新一根」用几何门控：非最新根让线的 x1 == x2（零长度不可见），标签用空文本 + 透明底色。
- 依据：真机二分探针 2026-10-24：A=display 常量 true（画出）、B=display 序列（无输出），同一脚本同屏对照

### `EXIT_WITHOUT_ENTRY_RECORD` — 止盈止损没有记录入场价

- 说明：出场条件按百分比或价格比例计算，但脚本既没有读取 strategy.position 的持仓均价，也没有用变量记录入场价。
- 修法：开仓分支里记 entry_price := close（或读 strategy.position 的 long_price / short_price），止盈止损都基于这个记录值计算。
- 依据：函数库条目 strategy.position（long_price / short_price）；交易函数 cond 参数说明

### `MISSING_VERSION_DIRECTIVE` — 缺少版本声明

- 说明：脚本开头缺少 `// @version=2` 版本声明。
- 修法：在脚本第一行写 // @version=2；函数库绝大多数条目都要求语法版本 2。
- 依据：函数库 doc_markdown「语法版本需要 // @version=2」；aiscript_language.json versionDirective

### `NAN_COMPARISON` — NaN 比较写法可疑

- 说明：与 nan 直接比较（== nan / != nan）不会得到预期结果。
- 修法：用 na(x) 判断是否为 NaN，用 nz(x, fallback) 提供缺省值。
- 依据：函数库条目 na（判断数值是否为 NaN）、nz、nan（数据类型）

### `NO_PLOT_OUTPUT` — 没有任何绘图输出

- 说明：指标脚本没有任何 plot / plot* / label / line / box 输出，运行时图表上是空白的。
- 修法：至少调用一次 plot(series, title=..., color=...) 或 plotColumn / plotHist / plotCandle 等。
- 依据：函数库「画图函数」分类（plot / plotColumn / plotHist / plotCandle / plotOhlc / plotText / plotShape / label / line / box / fill 等 12 条）

### `NO_TRADE_SIGNAL` — 没有任何交易指令

- 说明：脚本声明了交易配置，但没有任何 enterLong / enterShort / exit* 交易指令。
- 修法：补上交易指令，或删除无用的 tradeConfig。
- 依据：函数库「交易函数」分类（14 条）

### `STATE_NEVER_RESET` — 状态变量只置位未复位

- 说明：状态变量 `{name}` 被赋值为 true，但脚本里从未被赋值为 false。
- 修法：状态机必须能回到空仓：在平仓分支里写 {name} := false，否则平仓后会一直认为自己仍持仓。
- 依据：函数库「数据类型」条目 var；仓位状态机通用要求

### `SUSPICIOUS_DIVISION` — 可疑的除法

- 说明：除法运算的除数可能为 0 或为字面量 0。
- 修法：先用 nz(divisor, 1) 兜底，或加条件判断后再相除。
- 依据：函数库「算术运算符」条目 /；函数库条目 nz

### `TERNARY_TYPE_MISMATCH` — 三元表达式分支类型不一致

- 说明：三元表达式（?: / iff）两个分支的返回类型不一致。
- 修法：让两个分支返回同类型；需要缺省值时用 nz() 或 na() 判断后再取值。
- 依据：函数库条目 iff（三元运算）、?:（条件表达式）

### `TYPE_HINT_MISMATCH` — 类型不匹配

- 说明：`{name}` 的第 {index} 个参数期望 {expected}，实际传入 {actual}。
- 修法：参考 params[].type；需要转换时用 int() / float() / string() / bool()（见「数据类型」分类）。
- 依据：函数库结构化数据.json 各条目 params[].type；函数库「数据类型」分类（int/float/string/bool 等）

### `UNKNOWN_VARIABLE` — 未知变量

- 说明：变量 `{name}` 在使用前没有声明或赋值。
- 修法：先用 `=` 赋值再引用；行情内置变量见 aiscript_language.json 的 builtinVars 与「行情数据」分类。
- 依据：AiScript语言定义.json builtinVars + 函数库「行情数据」分类（25 条 variable）


## info

### `NO_ENTRY_BAR_RECORD` — 没有记录入场 K 线

- 说明：脚本没有记录开仓发生在哪一根 K 线，因此无法实现时间止损、最长持仓或平仓后冷却。
- 修法：开仓分支里记 entry_bar := bar_index，之后可用 bar_index - entry_bar >= N 做时间止损或冷却。
- 依据：AiScript 内置变量 bar_index；仓位状态机通用要求

### `TRAILING_SEMICOLON_OK` — 行尾分号

- 说明：AiScript 语句以换行结束，行尾分号会被忽略，不影响编译。
- 修法：无需修改；函数库 snippet 模板本身也带分号，可直接粘贴。
- 依据：函数库结构化数据.json 各条目 snippet（普遍以分号结尾）

### `UNUSED_VARIABLE` — 未使用的变量

- 说明：变量 `{name}` 被赋值但从未使用。
- 修法：删除无用赋值，或确认是否漏掉了绘图 / 交易调用。
- 依据：AIScript 语言定义（变量声明与作用域）
