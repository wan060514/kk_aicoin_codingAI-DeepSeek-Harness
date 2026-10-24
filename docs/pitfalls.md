# 已确认的客户端行为与排错流程

这份文档里的每一条都是 **2026-10-24 在本机实测**得出的（AiCoin 2.16.29 / Chrome 150 / macOS），不是从官方文档抄的。凡是「文档说」和「实测不一致」的地方，以实测为准，并在这里记一行。

## 一、AiScript 语言层

| 行为 | 结论 | 证据 |
|---|---|---|
| `time` 的类型 | **float**。`var int t0 = time` → `cannot use float as type int in assignment` | 客户端指标编辑器状态栏原文；现在是静态规则 `TIME_IS_FLOAT` |
| `display` 参数 | **只认字面量布尔**。传 `barstate.islast` / `a and b` 编译不报错，但**整组绘图一个都不渲染**（静默当 false） | A/B 二分探针同屏对照：A（常量 true）出线、B（序列）无输出；现在是规则 `DISPLAY_NON_CONSTANT` |
| `line.new` / `label.new` 的对象语义 | **按调用点维护同一对象、后写覆盖**，不是每根 K 线堆新对象 | 探针 A 只画出 1 条线、C 只出 1 个标签（脚本里每根 K 线都调用了） |
| 画图函数作用域 | `line.new` / `label.new` / `box.new` **必须在根作用域**，塞进 `if`/`for`/自定义函数都不行 | 官方函数库条目里明确标注；探针验证 |
| `hour(time, tz)` | tz 默认就是 `'UTC+8'`，格式 `'UTC+n'` / `'UTC-n'`。传 `'Asia/Shanghai'` 不认 | 函数库条目 + 实测 |
| `[ ]` / `{ }` | 历史引用与数组/字典下标两套语法，不能混用 | 语言定义 |
| `for` | 写法是 `for (init; cond; step)`，不是 `for i = 0 to 10`；单次循环上限 500 | 语言定义 |
| 块内赋值 | 改外层变量必须 `:=`，用 `=` 会新建局部变量（且不报错，最难查） | 语言定义；现为规则 `ASSIGN_IN_BLOCK_SHADOWS` |
| `nan` | 可以当值用；判断要用 `na(x)`，不能用 `==` | 语言定义 |

### 「只画最新一根」的正确写法

不要用 `display`。用**几何门控**：

```aicoin
draw_now = barstate.islast
dl  = draw_now ? session_len : 0.0
x1  = t0
x2  = t0 + dl          // 非最新根：x2 == x1 → 零长度线段 → 天然不可见
line.new([x1, p, x2, p], title='p', refSeries=close, color='black', lineWidth=1, lineDash=[0])
```

标签没法画零长度，就用**空文本 + 透明底色**在非最新根隐藏。

## 二、CDP / 客户端生命周期

| 现象 | 真相 |
|---|---|
| 「我没通过 MCP 打开 AiCoin，就连不通」 | **属实，但这是 Electron 的机制**：`--remote-debugging-port` 只在进程启动时生效，事后无法附加到已运行实例。唯一解是「以调试端口重启它」 |
| `aicoin_app_launch` 返回 `single-instance-conflict` | 单实例锁：已有实例在跑时新进程会静默退出。必须先停再启（`force:true`），不能硬 spawn |
| 工具说「端口 9222 不可达」，但 `curl 127.0.0.1:9222/json/version` 通 | **工具自己的 bug**（两个）：①裸 socket 等 `close` 事件导致必然 4 秒超时；②抓函数库时选中的是 `#/notice` 通知窗，调 axios 抛业务异常。均已修 |
| `ps` 里出现好几个「AiCoin 主进程」 | 旧版 POSIX 扫描把 `sh -c 'ps … \| grep aicoin'` 自己的 `sh`/`grep` 也算成主进程了。现按 argv[0] 只认 `aicoin`/`aicoin.exe` |
| 日志里 `sandbox initialization failed` / `GPU process exited` | 从 DSH 的 bash 沙箱里 spawn 出来的图形应用会继承文件沙箱限制。**生命周期测试必须走 MCP/面板通道，不要在 Agent 的 shell 里跑** |

## 三、排错流程（用户指定的固定套路）

**第 1 步：先要错误原文，不要猜。** 客户端一次只报一条编译错，拿到「第 N 行第 M 列: 原文」再动代码。

**第 2 步：编译通过但「不显示」→ 先跑二分探针，不要连续盲改。**
模板在 `aicoin-mcp/docs/` 的探针说明里，四组同屏：

```
A: line.new(..., display=true)                 ← 常量，应出线
B: line.new(..., display=barstate.islast)      ← 序列，看是否消失
C: label.new(..., display=true)                ← 常量，应出标签
D: label.new(..., display=barstate.islast)     ← 序列
```

一次只改一处、只验一个假设。2026-10-24 那次 21 行探针一次定位了「display 只认常量」。

**第 3 步：写进客户端验证，别再手工粘贴。**
`aicoin_app_indicator_publish(mode:"verify", confirm:true)` 会：建一个 `<名字> · 编译探针` → 读服务端 `data.compileResult` → **删掉探针**，返回结构化结论：

```json
{ "pass": false, "errLine": 2, "errColumn": 8,
  "err": "cannot use float as type int in assignment",
  "sourceLine": "var int t0 = time",
  "caret": "       ^" }
```

**第 4 步：改完重跑校验（`aicoin_validate`）并说清楚「改了什么、为什么、这条教训是否通用」。**

**第 5 步：函数库漂移**（客户端升级加了新函数）：
`aicoin_live_check` 看差异 → `aicoin_library_refresh({apply:true})` 落盘。
落盘**不重写** `aiscript_functions.json`（从 markdown 反推参数表需要离线抽取器，宁留 stub 不许猜签名），只把缺失条目写进 `data/live-extra.json`，重载后以 stub 并入知识库：不再误报 `UNKNOWN_FUNCTION`，也不误报 `ARITY_*`。

## 四、静态校验的边界

- 19 条 `error` 级规则只覆盖「官方文档或真机实测确认会编译失败」的构造；其余 14 条是 `warning`、3 条 `info`。
- **校验器不是编译器**：0 error 只代表静态自洽。字体层（类型推导、泛型、服务端特有检查）只有服务端知道，这也是 `mode:"verify"` 存在的理由。
- 误报比漏报更贵：遇到「明明能编译却报 error」，先怀疑规则，去 `docs/validation-rules.md` 找到那条规则的依据，按依据修正规则而不是绕过它。
