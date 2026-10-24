# 工作区约定（长期有效）

## 交付文件命名：每次必须换新文件名（硬性）

**不要覆盖上一次交付的同一个文件名。**

原因：用户在本机上用编辑器/预览器打开 txt 时，客户端按**路径**缓存内容。我覆盖同名文件后，磁盘上是新的，但用户打开看到的还是旧内容 —— 已发生过两次（`玄枢-v5-TD4回调确认.txt`、`玄枢-通道均线超级趋势-v3-知识库版.txt`），用户两次都要重新问「这个还是老文件」。

规则：
1. 每次交付生成**新文件名**，带上变化要点与时间戳，例如
   `玄枢-v5b-EMA200绿红-EMA带透明-20261024-1421.txt`。
2. 旧文件保留不删（用户可能还在对照）。
3. 交付后用 `md5 -q` 打印新文件与源文件的哈希，确认一致再回复。
4. 根作用域副本文件只用于交付，真正维护的源始终是
   `aicoin/strategies/<策略名>/strategy.txt`。

## AiCoin 脚本交付三件套

- 静态校验 `aicoin_validate` 必须 error 0 才算完成；宣称"校验通过"前必须真的调过。
- 涉及新语法构造时，用 `aicoin_app_indicator_publish(mode:"verify", confirm:true)` 做真机编译探针：它建一个 `<名字> · 编译探针` → 读服务端 `data.compileResult` → **立刻删掉探针**，一次调用闭环（老办法 `indicator_save` + 手工删除仍然可用）。
- 交付前推荐顺序：`aicoin_validate`（离线）→ `aicoin_app_indicator_publish(mode:"verify")`（真编译，回填 `errLine`/`sourceLine`/`caret`）→ 改到 `pass:true` → `publish`（可选，留下指标）→ 交付 txt。
- 不提供回测、不编造任何绩效数字。

## 真机排错流程（用户指定：报错就按这个走，快而准）

**第 1 步：先要错误原文，不要猜。** 客户端一次只报一条编译错，拿到行号+原文再动代码。

**第 2 步：编译通过但不显示 → 一律先跑二分探针，不要连续盲改。**
探针模板：`aicoin/strategies/pivot-daily-no-security/probe-display.txt`
（A=`display` 常量 / B=`display` 序列 / C=label 常量 / D=label 序列，四组同屏对照）。
只改一处、只验一个假设，比连改三版快得多 —— 2026-10-24 那次就是靠这 21 行探针一次定位。

**第 3 步：已确认的客户端行为（别再踩）**

- `time` 是 **float**：`var int t0 = time` 报 `cannot use float as type int in assignment`。凡接 `time`/`timeclose` 的声明用 `var float`。
- **`display` 只认常量**。传序列布尔（`barstate.islast`、`x and y`）编译不报错，但**整组线/标签一个都不画**（静默当 false）。要做"只画最新一根"必须走**几何门控**（非最新根让 x1==x2 收成零长度；标签用空文本+透明底），不能靠 `display`。
- `line.new` / `label.new` 是**按调用点维护同一对象、后写覆盖**，不是每根 K 线堆新对象（探针 A 只出一条线、C 只出一个标签即证）。所以根作用域每根都调用的老写法，最终几何天然等于最新一根。
- `hour(time, tz)` 的 tz 默认就是 `'UTC+8'`，格式 `'UTC+n'`；不要传 `'Asia/Shanghai'`。
- ~~静态校验器查不出 float/int 类型不匹配~~ —— 自 kk_aicoin_codingAI 1.1.0 起已内置两条规则：`TIME_IS_FLOAT`（error，`var int x = time` 直接拦）与 `DISPLAY_NON_CONSTANT`（warning，`display=` 非字面量布尔时提示）。规则来源是真机实测，不是文档推断。
- 但静态校验依然不是编译器：`aicoin_validate` 0 error 只代表静态层面自洽，能否编译以服务端 `compileResult` 为准。

**第 4 步之前：能一步到位就别手工粘贴。**
`aicoin_app_indicator_publish` 会直接写进 AiCoin 并回传服务端编译结论：
`compile.pass / errLine / errColumn / err（原文）/ sourceLine（出错那行）/ caret（列对齐的 ^）/ warnings`。
`mode:"verify"` 验证完自动删探针、`mode:"publish"` 同名覆盖更新且编译失败时默认删坏草稿 ——
先用 verify 改到 `pass:true`，再决定要不要 publish 留在账号里。

**函数库与客户端不同步时（新版本客户端加了新函数）**
先跑 `aicoin_live_check` 看差异；要真正对齐就跑 `aicoin_library_refresh`（默认只比对，`apply:true` 才落盘）。
落盘不会重写 `aiscript_functions.json`（从 markdown 反推参数表需要离线抽取器，宁留 stub 不许猜签名），
只把「客户端有、插件没有」的条目写进 `data/live-extra.json`，重载后它们以 stub 并入知识库：
不再误报 `UNKNOWN_FUNCTION`、不误报 `ARITY_*`，`aicoin_library_get` 仍能读到客户端原始文档。

**第 5 步：改完必须重跑校验再把修好的点讲清楚**（改了什么、为什么、以及这条教训是不是通用）。
