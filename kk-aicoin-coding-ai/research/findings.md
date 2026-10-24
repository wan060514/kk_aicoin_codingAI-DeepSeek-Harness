# AiScript 验证器实现最依赖的 10 条事实

> 每条一行，末尾给出证据文件与位置。详细论证见 `editor-tokenizer.md` / `compile-flow.md`。
> 全部结论来自对 4 个 bundle 的**实际执行**（`research/_tools/vm-extract.js`）与字符串表还原（`research/_tools/strtable.js`），不是从压缩文本猜测。

---

1. **客户端没有 AiScript 编译器/解析器 —— 只有 Monarch 词法着色。** `Parser`/`ast` 在 4 个 bundle 里 0 命中；`script/compile`、`script/validate`、`indicator/compile` 也 0 命中；AIScript 只注册了 `register` + `setLanguageConfiguration` + `setMonarchTokensProvider` + 补全/hover。
   → `editor-tokenizer.md` §1（`2776.js` @43457–43849）、§3、§10

2. **"编译"就是保存本身：`POST upgrade/customIndicator/script/save`，编译结果在 `result.data.compileResult`。** loading 文案是 `script:savingAndValidating`（"正在保存并校验脚本"）；`success:true` ≠ 编译通过，要看 `compileResult.pass`。
   → `compile-flow.md` §2.1/2.2；`renderer/main.js` @451219；`renderer/1431.js` @127442；`locales/zh/script.json` `"savingAndValidating"`

3. **`compileResult` 的确切字段集（含类型陷阱）：** `{id, errLine:number(1基), errColumn:number(0基), err, pass:boolean, hasAlert, hasTrade, securityCount:string, warnMessage:[{line:string, column:string, message}], updateAt}`。`securityCount` 初始值是**字符串 `'0'`**，`warnMessage[].line/column` 也是**字符串**。
   → `renderer/main.js` @458129（redux 初始 state）

4. **Monaco 红/黄波浪线 100% 来自服务端响应，且规则很怪：只显示 `warnMessage[0]`；有 warning 时连 error 都不显示；`endColumn = column + 3`（固定宽 2，不 clamp）。**
   → `551.js` @23118（唯一一处 `setModelMarkers`）；标注为 `"owner"`（`551.js` 字符串表索引 `0x1db`）

5. **languageId 是 `"AIScript"`（大小写敏感），model URI 是固定的 `"aicoin://monaco"`，token 会带 `.AIScript` 后缀（如 `function.AIScript`）。** highlight.js 那边的 `aiscript` 小写 alias 是**另一套**（用于 AI 对话框代码块，不是编辑器）。
   → `editor-tokenizer.md` §1（`2776.js` @8155）、§7（`2776.js` @42625）

6. **静态 `keywords`(23)/`operators`(24)/`builtinVars`(12) 只是下界 —— 编辑器挂载时会用服务端 `/functionLib` 的响应扩充它们**（`type==='variable'` 并入 builtinVars；`type==='operators'` 且纯字母的并入 keywords）。断"未知标识符"前必须先拿函数库。
   → `editor-tokenizer.md` §8；`551.js` @19343–20114；`aiscript_monarch_tokenizer.json` 的 `_runtimeAugmentation`

7. **`defaultToken` 是 `invalid`，而标识符规则只允许小写/`_`/`$`/`#` 开头 —— 所以 `MyVar` 变 `type.identifier`、纯中文标识符（如 `收盘价`）变 `invalid`，但 `收盘价(` 又因函数正则支持 `\u4E00-\u9FAF` 而被识别为 function。这是配置自身的矛盾，验证器必须显式决定站在哪一边。**
   → `editor-tokenizer.md` §5.2 规则 1/2 说明；`2776.js` @6253

8. **`bracketCounting` 是死状态（不可达）**：全配置中没有任何规则首次进入它（我用脚本穷举验证），`{}` 一律由 `root[0]` 处理成 `delimiter.bracket`，不做配对计数。另外 `@brackets` 在 Monaco 里查 `lexer.brackets`，查不到会 **throw**，而 `AiScript` 的 `brackets` 只有 `{ [ (`——**孤立 `<`/`>` 可能触发 lexer 异常（推断，需实测）**。
   → `editor-tokenizer.md` §5（`bracketCounting` 段 + §5.3）；`1407.js` @4219130 / @4220145

9. **保存会真的写用户数据（新建或覆盖一条指标），客户端自己都把 `script/save` 列为"不可随意重试"的敏感端点。** 所以"保存即校验"必须做成 **opt-in**；`indicator/gen` 的失败分支虽会原样返回 `compileResult`，但成功会改图表布局，也有副作用。
   → `compile-flow.md` §2.4（`renderer/main.js` @899882 的 `_0x5538ed` 数组）、§6.3（`renderer/main.js` @473512 的 `myIndicators.push`）

10. **CDP 路线已被现有代码证明可行**：`01-从客户端导出函数库.js` 用 `GET /json/list` → websocket → `Runtime.evaluate{awaitPromise}`，取 `window.__wr(31438).A`（客户端 Axios 实例）并发起 `customIndicator/*` 请求，因此**自动复用其 RSA+AES 加密拦截器与登录态**。但 `ELECTRON_REMOTE_DEBUGGING_PORT` 在正式版 `v2.16.27` 上**无效**（守卫要求 `isAlpha`，`isDevelopment` 硬编码 false），必须靠 `.bat` 里的 `--remote-debugging-port=9222`。
    → `compile-flow.md` §5.1/§5.2；`01-从客户端导出函数库.js`；`main/main.js` @1342553 / @1507710 / @43471；`cdp_probe.txt`

---

## 一句话实现建议

**默认离线**：按 `aiscript_monarch_tokenizer.json` 复刻词法（重点覆盖第 7、8 条的两个矛盾点），用 `aicoin_dist\function_library_raw.json`（315 KB，已导出）做"函数是否存在 / 参数个数"检查，并把 `pass/err/errLine/errColumn/warnMessage` 一律标注为**"需运行时确认"**，绝不伪造 `pass:true`。
**需要真编译时**：做成用户显式开启的"连接本机 AiCoin 校验"，走 CDP + `Runtime.evaluate`，请求前明确告知副作用（会在账号下写一条指标），且**不自动重试**。

## 尚存的未解决疑点（不要当作已知）

| 疑点 | 状态 |
|---|---|
| `lexer.brackets` 由什么填充 | 未找到构造点 |
| 孤立 `<`/`>` 是否真的抛 lexer 异常 | 推断，需 `monaco.editor.tokenize('<','AIScript')` 实测 |
| `window.monaco` 是否可直接访问（及其 webpack module id） | 未验证 / 未定位 |
| redux store 的 webpack module id（读 `compileResult` 用） | 未定位 |
| `api_client.js` 的 AES 是 128 还是 256（头部注释与实现不一致） | 未解决 |
| `551.js` 的 selector `hb` ↔ `renderer/main.js` 的 `indicators.compileResult` | 强推断（字段集完全一致），未直接验证模块 id |
