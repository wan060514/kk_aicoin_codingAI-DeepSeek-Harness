# AiScript Monaco 语言定义（模块 `0xf21f`）逐字段还原

**结论一句话**：`AIScript` 是一个**纯 Monarch 词法着色**语言——客户端里**没有任何** AiScript 语法分析器、类型检查器或编译前端；Monaco 侧只有 `setMonarchTokensProvider` + `setLanguageConfiguration` + 两个自定义主题。所有"编译"语义都来自服务端（见 `compile-flow.md`）。

---

## 0. 证据来源与提取方法（可复现）

| 项 | 值 |
|---|---|
| 主证据文件 | `C:\Users\11\Desktop\AiScript编辑器架构与函数库\aicoin_dist\extracted\dist\renderer\2776.js`（134 143 字节） |
| 副本证据文件 | `C:\Users\11\Desktop\AiScript编辑器架构与函数库\aicoin_dist\extracted\dist\renderer\551.js`（46 569 字节） |
| webpack 模块 id | `0xf21f`（十进制 61983），注册点 `2776.js` 字节偏移 **@4619**：`{0xf21f(_0x1f7f48,_0x15fa27,_0x2dfbbd){...` |
| 导出符号 | `BH`（Monarch 配置）`HL`（keywords）`SB`（operators）`MC`（builtinVars）`ZR`（languageId）`LH`（protocol URI）`Zm`/`di`（浅色/深色主题）`fR`/`Bt`（主题名）`xf`（languageConfiguration）`fF`（editor options） |

**提取方法（不是"读压缩代码"，而是真正执行它）**：
压缩包开头有一个明文字符串表 + 混淆解码器（`2776.js` 的 `a6_0x3842`，基址 `0xb8`）。模块工厂通过 `self['webpackChunkaicoin'].push([[0xad8],{0xf21f(...){...}}])` 注册。我用 Node `vm` 把整个 bundle 跑起来（给它一个**假的 `console`**，因为 bundle 头部有反调试代码会替换宿主 `console` 方法），劫持 `push` 捕获模块工厂，再按 bundle 自己的 `__webpack_require__.d` 语义（**数组形式 `[name, mode, value?]`，mode===0 表示直接值**，证据见 `renderer/main.js` @1396506）调用工厂，直接读出导出对象。

- 脚本：`research/_tools/vm-extract.js`
- 结果：`research/_tools/mod_f21f.json`（2776.js 副本）与 `research/_tools/mod_f21f_551.json`（551.js 副本）
- **交叉验证**：两份副本的导出 JSON 序列化完全一致，长度均为 8006 字符（实测 `deep-equal JSON: true lenA= 8006 lenB= 8006`）。这说明 551.js 内嵌了同一模块的另一份拷贝，两个 chunk 各带一份。
- 生成 JSON 交付物的脚本：`research/_tools/build-tokenizer-json.js` → `research/aiscript_monarch_tokenizer.json`

> 说明：`551.js` 内部还有一份**旧式粗体**定义（`_0x505bdc`，@7840 附近），字段与 `0xf21f` 的 `BH` 相同但变量名不同（`_0x12e5d6`/`_0x362805`/`_0x2ae11d`）；`551.js` 的编辑器组件通过 `_0x2b7614=_0x222b10(0xf21f)`（@12756）**import 的就是模块 `0xf21f`**。

---

## 1. 语言 id / 协议 URI / 主题名

`2776.js` @8155–8165 的导出表（原样）：

```js
_0x2dfbbd['d'](_0x15fa27,['BH',0x0,_0x2014c9,'Bt',0x0,'ace-dark','HL',0x0,_0x3a0eb4,
'LH',0x0,'aicoin://monaco','MC',0x0,_0xa5a8b2,'SB',0x0,_0x565288,'ZR',0x0,'AIScript',
'Zm',0x0,{'base':'vs','inherit':!0x0,'rules':[{'token':'','foreground':'#5c6773'}, ... ]}, ...
```

| 导出 | 语义 | 值 |
|---|---|---|
| `ZR` | languageId | `"AIScript"` |
| `LH` | protocol / model URI | `"aicoin://monaco"` |
| `Bt` | 深色主题名 | `"ace-dark"` |
| `fR` | 浅色主题名 | `"ace-light"` |
| `Zm` | 浅色主题对象 | 见 §6 |
| `di` | 深色主题对象 | 见 §6 |
| `fF` | Monaco editor options | 见 §6 |

**⚠ 关键细节（验证器必须知道）**：languageId 是 **`AIScript`（大写 A、大写 S）**，不是 `aiscript`。Monaco 会给所有 token 追加 `tokenPostfix`，即 `.AIScript`。证据 —— `551.js` hover provider @21700 附近：

```js
return _0x49fddd&&_0xc16a8e&&['function.AIScript','variable.builtin.AIScript']['includes'](_0xc16a8e['type'])?_0x49fddd:null;
```

所以实际 token 类型是 `function.AIScript`、`variable.builtin.AIScript`、`keyword.AIScript`、`string.invalid.AIScript` …。`aiscript`（小写）只是 highlight.js 那边注册的 alias（见 §7），与 Monaco 无关。

注册代码（`2776.js` @43457，`_0x18b0a7` 是 `monaco` 命名空间）：

```js
_0x18b0a7[_0x43b353(0xfa)]['defineTheme'](_0x5c8aa2['fR'],_0x5c8aa2['Zm']),
_0x18b0a7[_0x43b353(0xfa)]['defineTheme'](_0x5c8aa2['Bt'],_0x5c8aa2['di']),
_0x18b0a7['languages']['getLanguages']()['some'](({id:_0x9c8571})=>_0x9c8571===_0x5c8aa2['ZR'])
||(_0x18b0a7[_0x43b353(0x12b)]['register']({'id':_0x5c8aa2['ZR']}),
   _0x18b0a7['languages']['setLanguageConfiguration'](_0x5c8aa2['ZR'],_0x5c8aa2['xf']),
   _0x18b0a7['languages']['setMonarchTokensProvider'](_0x5c8aa2['ZR'],_0x5c8aa2['BH']));
```

解引用：`_0x43b353(0xfa)` = `"editor"`，`_0x43b353(0x12b)` = `"languages"`（由 `research/_tools/strtable.js` 还原 `2776.js` 字符串表得到，偏移 @43400）。

**注意**：`setMonarchTokensProvider` 与 `setLanguageConfiguration` 只在语言**尚未注册**时执行（`getLanguages().some(...) ||` 短路），并且**没有**调用 `monaco.languages.setLanguageConfiguration` 之外任何 setter。

---

## 2. `keywords`（`HL`）逐字还原

`2776.js` @4683 原文：

```js
_0x3a0eb4=['and',_0x1f9ef7(0x137),'bool','break','class','dict','else','false','finally',
_0x1f9ef7(0xc4),'for','if','iff','int',_0x1f9ef7(0xc2),'not','or','range','return',
'string','true','var','varip'],
```

解引用（`_0x1f9ef7` 即 `a6_0x3842`）：`0x137`=`"any"`，`0xc4`=`"float"`，`0xc2`=`"nan"`。

**23 个关键字（顺序即数组顺序）**：

```
and any bool break class dict else false finally float for if iff int nan
not or range return string true var varip
```

**中文说明（意外之处）**：
1. `iff`（双 f）是关键字，`if` 也是；这是 AiScript/Pine 风格的三元函数写法，**不要当成拼写错误**。
2. `nan` 是关键字而不是内建变量 —— 它被归到 `@keywords`，着色为 `keyword`。
3. 类型名 `bool / int / float / string / dict / class` 全部是关键字；`any` 也是。
4. `var` 和 `varip`（逐K线持久变量）成对出现。
5. **没有 `while` / `switch` / `for...in` / `continue` / `const`**：虽然 `tokenizer.common[0]` 的正则里写了 `(?!if|for|while|switch|return)` 这个前瞻，把 `while`、`switch` 当保留字排除在"函数调用"之外，但 `while`/`switch` **不在关键词表里**，所以它们会被染成 `identifier`。这是一个**不一致点**，验证器应以关键词表为准。

---

## 3. `operators`（`SB`）逐字还原

`2776.js` @4886 原文：

```js
_0x565288=['<=','>=','==','!=','+','-','*','/','%','++','--','^','!','&&','||','?',':',
'=','+=','-=','*=','/=','%=','^='],
```

**24 个运算符**：`<= >= == != + - * / % ++ -- ^ ! && || ? : = += -= *= /= %= ^=`

**中文说明**：
1. `^` 同时是"幂"运算符和"按位异或"运算符，词法上无法区分；`^=` 也随之存在。
2. **没有 `<` 和 `>`**（单独的尖括号不在表里）。这解释了词法器里那条奇怪的规则 `[/[<>](?!@symbols)/,'@brackets']`（见 §5）。
3. 没有位运算 `&`、`|`、`<<`、`>>`、`>>>`，也没有 `===`、`!==`、`??`、`?.`、`=>`。
4. 注意 `!` 被单独处理（`common[6]`），不走 `@operators` 分支。

---

## 4. `builtinVars`（`MC`）逐字还原

`2776.js` @5008 原文：

```js
_0xa5a8b2=['open','high','low','close',_0x1f9ef7(0x142),'amount',_0x1f9ef7(0xe8),
'timenow','timestart','timeend','bar_index','syminfo'],
```

解引用：`0x142`=`"volume"`，`0xe8`=`"time"`。

**12 个内建变量**：`open high low close volume amount time timenow timestart timeend bar_index syminfo`

**中文说明**：这 12 个被着色为 `variable.builtin`（不是 `keyword`）。**但运行时会被扩充** —— 见 §8，客户端会把服务端函数库里 `type === "variable"` 条目的 key 追加进来（去重，合并进 `MC`）。所以 `builtinVars` 是**下界**，不是全集。

---

## 5. `BH`：完整 Monarch 配置

`2776.js` @6253 原文（头部）：

```js
_0x2014c9={'defaultToken':'invalid','keywords':_0x3a0eb4,'operators':_0x565288,
'builtinVars':_0xa5a8b2,'symbols':/[=><!~?:&|+\-*\/\^%]+/,
'escapes':/\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,
'digits':/\d+(_+\d+)*/,'tokenizer':{'root':[[/[{}]/,'delimiter.bracket'],{'include':'common'}],
'common':[[/(?!if|for|while|switch|return)([a-zA-Z\u4E00-\u9FAF_$][0-9a-zA-Z\u4E00-\u9FAF_$]*)(\s*)(\()/,['function','','@brackets']],
[/#?[a-z_$][\w$]*/,{'cases':{'@keywords':_0x1f9ef7(0x124),'@builtinVars':'variable.builtin','@default':'identifier'}}],
[/[A-Z][\w\$]*/,'type.identifier'],{'include':'@whitespace'},[/[()\[\]]/,'@brackets'],
[/[<>](?!@symbols)/,'@brackets'],[/!(?=([^=]|$))/,'delimiter'],
[/@symbols/,{'cases':{'@operators':'delimiter','@default':''}}],
[/(@digits)[eE]([\-+]?(@digits))?/,_0x1f9ef7(0x13e)],
[/(@digits)\.(@digits)([eE][\-+]?(@digits))?/,_0x1f9ef7(0x13e)],[/(@digits)n?/,'number'],
[/[;,.]/,'delimiter'],[/"([^"\\]|\\.)*$/,'string.invalid'],[/'([^'\\]|\\.)*$/,'string.invalid'],
[/"/,'string','@string_double'],[/'/,'string','@string_single']],
'whitespace':[[/[ \t\r\n]+/,''],[/\/\*\*(?!\/)/,'comment.doc','@jsdoc'],[/\/\*/,'comment','@comment'],[/\/\/.*$/,'comment']],
'comment':[[/[^\/*]+/,'comment'],[/\*\//,'comment','@pop'],[/[\/*]/,'comment']],
'jsdoc':[[/[^\/*]+/,'comment.doc'],[/\*\//,'comment.doc','@pop'],[/[\/*]/,'comment.doc']],
'string_double':[[/[^\\"]+/,'string'],[/@escapes/,_0x1f9ef7(0xb9)],[/\\./,'string.escape.invalid'],[/"/,_0x1f9ef7(0x127),'@pop']],
'string_single':[[/[^\\']+/,'string'],[/@escapes/,'string.escape'],[/\\./,'string.escape.invalid'],[/'/,'string','@pop']],
'bracketCounting':[[/\{/,'delimiter.bracket','@bracketCounting'],[/\}/,'delimiter.bracket','@pop'],{'include':'common'}]}};
```

解引用：`0x124`=`"keyword"`，`0x13e`=`"number.float"`，`0xb9`=`"string.escape"`，`0x127`=`"string"`。

### 5.1 顶层 Monarch 属性

| 属性 | 值 | 说明 |
|---|---|---|
| `defaultToken` | `"invalid"` | **默认 invalid**：任何没被任何规则匹配到的字符会被染成 `invalid`（红色波浪）。AiScript 里中文标识符靠 `\u4E00-\u9FAF` 覆盖，但 `\u9FA0-\u9FFF` 及 `\u3400-\u4DBF`（扩展A）**会落到 invalid**。 |
| `keywords` | 21 项数组（§2） | 供 `cases: {'@keywords': ...}` 做**数组包含**判定 |
| `operators` | 24 项数组（§3） | 供 `cases: {'@operators': ...}` |
| `builtinVars` | 12 项数组（§4） | 供 `cases: {'@builtinVars': ...}` |
| `symbols` | `/[=><!~?:&\|+\-*\/\^%]+/` | **注意**：包含 `<`、`>`、`&`、`|`、`~`，但 `operators` 表里没有单独的 `<`/`>`/`&`/`|`/`~`。见 5.2 |
| `escapes` | `/\\(?:[abfnrtv\\"']\|x[0-9A-Fa-f]{1,4}\|u[0-9A-Fa-f]{4}\|U[0-9A-Fa-f]{8})/` | 在字符串状态内用 |
| `digits` | `/\d+(_+\d+)*/` | **支持数字千分位下划线**，如 `1_000_000` |

### 5.2 八个 tokenizer 状态和有序规则

（完整机器可读版本见 `research/aiscript_monarch_tokenizer.json`）

#### `root` — 2 条

| # | regex | action |
|---|---|---|
| 0 | `[{}]` | `"delimiter.bracket"` |
| 1 | — | `{"include":"common"}` |

**意外之处**：`root` 只显式处理 `{}`，然后立刻 `include common`。所以 `[` `(` 由 `common[4]` 的 `[()\[\]] → @brackets` 处理，`{}` 被 root 先吃掉（避免进入 `bracketCounting`）。

#### `common` — 16 条

| # | regex | action |
|---|---|---|
| 0 | `(?!if\|for\|while\|switch\|return)([a-zA-Z\u4E00-\u9FAF_$][0-9a-zA-Z\u4E00-\u9FAF_$]*)(\s*)(\()` | `["function","","@brackets"]` |
| 1 | `#?[a-z_$][\w$]*` | `{"cases":{"@keywords":"keyword","@builtinVars":"variable.builtin","@default":"identifier"}}` |
| 2 | `[A-Z][\w\$]*` | `"type.identifier"` |
| 3 | — | `{"include":"@whitespace"}` |
| 4 | `[()\[\]]` | `"@brackets"` |
| 5 | `[<>](?!@symbols)` | `"@brackets"` |
| 6 | `!(?=([^=]\|$))` | `"delimiter"` |
| 7 | `@symbols` | `{"cases":{"@operators":"delimiter","@default":""}}` |
| 8 | `(@digits)[eE]([\-+]?(@digits))?` | `"number.float"` |
| 9 | `(@digits)\.(@digits)([eE][\-+]?(@digits))?` | `"number.float"` |
| 10 | `(@digits)n?` | `"number"` |
| 11 | `[;,.]` | `"delimiter"` |
| 12 | `"([^"\\]\|\\.)*$` | `"string.invalid"` |
| 13 | `'([^'\\]\|\\.)*$` | `"string.invalid"` |
| 14 | `"` | `["string","@string_double"]` |
| 15 | `'` | `["string","@string_single"]` |

**中文说明（这里的"坑"很多）**：

1. **规则 0 的函数识别是"名字 + 空白 + 左括号"，并且把左括号交给了 `@brackets`。**
   `['function','','@brackets']` 三个 action 对应三个捕获组：组1=函数名→`function`，组2=空白→`''`（不着色），组3=`(`→`@brackets`。所以 `myFunc (` 中间的空格也会被匹配进去。
   前瞻 `(?!if|for|while|switch|return)` 只是把这几个字面量前缀排除，**它是前缀断言不是词边界**：`iffy(` 因为以 `if` 开头，**不会**被识别为函数调用。这是个真实的假阴性。

2. **规则 1 的标识符正则只允许小写开头。** `#?[a-z_$][\w$]*` —— `\w` 包含大写和数字，但**首字符必须是小写、`_`、`$` 或 `#`**。于是：
   - `MyVar` 落到规则 2 `[A-Z][\w\$]*` → `type.identifier`（会被染成"类型"色，而不是 identifier）。
   - **中文变量名 `收盘价` 不会被这条匹配**（首字符不在 `[a-z_$#]`），也不会被规则 2 匹配（不是 `[A-Z]`）→ 落到 `defaultToken: 'invalid'`。
   - 但规则 0 的函数正则**是**支持中文的（`\u4E00-\u9FAF`），所以 `收盘价(` 会被识别为 function，而单独的 `收盘价` 是 invalid。这是明显的不一致。
   - `\u4E00-\u9FAF` 少了 `\u9FB0-\u9FFF`（`鿰`–`龿` 段），这些字也会 invalid。

3. **规则 1 的 `cases` 用的是"数组包含"语义**：`@keywords` 指向的是**数组** `HL`，Monarch 会把数组编译成查找表，所以是**全等匹配**（`ands` 不会命中 `and`）。

4. **规则 5 `[<>](?!@symbols)` + 规则 7 `@symbols` 的组合是本配置最反直觉的地方。**
   `symbols` 是 `[=><!~?:&|+\-*\/\^%]+`（**贪婪、可多字符**）。规则 5 的负向前瞻 `(?!@symbols)` 意思是"当前位置不是 symbols 的开头"，即当字符是 `<` 或 `>` **且**后面紧跟任何 symbols 字符时不匹配。由于 `<`/`>` 本身属于 symbols：
   - 源文本 `<>`：位置0 的 `<` 后面是 `>`，`(?!@symbols)` 失败 → 规则5 不匹配 → 规则7 `@symbols` 匹配 `<>` → `cases['@operators']` 未命中（`<>` 不在 operators 里）→ `@default: ''` → **染成空 token（无色）**。
   - 源文本 `a < b`（`<` 后面是空格）：规则5 匹配 `<` → `@brackets`。
   - 源文本 `x <= y`：`<` 后面是 `=` → 规则5 失败 → 规则7 匹配 `<=` → operators 命中 → `delimiter`。
   - **结论**：比较运算符 `<` `>` 单独出现时被当成**括号**（`@brackets`），只有 `<=` `>=` 才走运算符分支；而 `<>`、`<<`、`>>` 这类组合会**变成无色 token**。验证器若要按 token 类型判断，必须复刻这个顺序，不能只看 `operators` 数组。

5. **规则 6 `!(?=([^=]|$))`**：`!` 后面不是 `=` 或已到行尾才匹配为单独的 `delimiter`。所以 `!=` 由规则 7 处理（operators 命中 → `delimiter`），而 `!x` 的 `!` 由规则 6 处理。两条都产出 `delimiter`，但路径不同。

6. **规则 8/9 产生 `number.float`，规则 10 产生 `number`。** `(@digits)` 展开为 `\d+(_+\d+)*`，所以 `1_000.5e3` 合法。**没有十六进制、没有 `0x` 前缀、没有 `.5`（前导点小数）**（`(@digits)\.` 要求整数部分）。`.5` 会被拆成 `.`(delimiter) + `5`(number)。

7. **规则 12/13 是"未闭合字符串"兜底**，锚定 `$`（行尾）。它们**排在开引号规则之前**，所以 `"abc`（没有闭合引号）→ `string.invalid`；`"abc"`（闭合）→ 规则12 的 `"([^"\\]|\\.)*$` 因为 `$` 断言失败而不匹配 → 落到规则 14 进入 `string_double` 状态。这个 `$` 是必要的，否则闭合字符串也会被判为 invalid。

8. **注释在外面**：`//` 和 `/* */` 不在这里，而在 `@whitespace`（规则 3）。

#### `whitespace` — 4 条

| # | regex | action |
|---|---|---|
| 0 | `[ \t\r\n]+` | `""`（空 token，无色） |
| 1 | `\/\*\*(?!\/)` | `["comment.doc","@jsdoc"]` |
| 2 | `\/\*` | `["comment","@comment"]` |
| 3 | `\/\/.*$` | `"comment"` |

**说明**：`/*` 必须紧跟（无空格）才进注释状态；`/**` 且后面不是 `/` 才进 `comment.doc`（JSDoc）；`/**/` 会走规则 2 进 `comment`。**行注释 `//` 没有 `#` 变体**，尽管 `folding` 的区域标记写的是 `// #region`。

#### `comment` — 3 条

| # | regex | action |
|---|---|---|
| 0 | `[^\/*]+` | `"comment"` |
| 1 | `\*\/` | `["comment","@pop"]` |
| 2 | `[\/*]` | `"comment"` |

#### `jsdoc` — 3 条

| # | regex | action |
|---|---|---|
| 0 | `[^\/*]+` | `"comment.doc"` |
| 1 | `\*\/` | `["comment.doc","@pop"]` |
| 2 | `[\/*]` | `"comment.doc"` |

**说明**：`comment` 和 `jsdoc` 是同一套骨架，只有 token 名不同。

#### `string_double` — 4 条

| # | regex | action |
|---|---|---|
| 0 | `[^\\"]+` | `"string"` |
| 1 | `@escapes` | `"string.escape"` |
| 2 | `\\.` | `"string.escape.invalid"` |
| 3 | `"` | `["string","@pop"]` |

#### `string_single` — 4 条

| # | regex | action |
|---|---|---|
| 0 | `[^\\']+` | `"string"` |
| 1 | `@escapes` | `"string.escape"` |
| 2 | `\\.` | `"string.escape.invalid"` |
| 3 | `'` | `["string","@pop"]` |

**中文说明**：
- **不支持多行字符串、不支持模板字符串（反引号 / `${}`）、不支持字符串内插值。**
- 单引号和双引号是**两个独立状态**，互不通用。
- 字符串内**没有转义换行续行**：`"\` + 换行 会走规则2 → `string.escape.invalid`。
- `@escapes` 解引用为 `BH.escapes`（见上表），**不支持 `\0`**（不在 `[abfnrtv\\"']` 里），支持 `\xNN`、`\uNNNN`、`\UNNNNNNNN`。

#### `bracketCounting` — 3 条

| # | regex | action |
|---|---|---|
| 0 | `\{` | `["delimiter.bracket","@bracketCounting"]` |
| 1 | `\}` | `["delimiter.bracket","@pop"]` |
| 2 | — | `{"include":"common"}` |

**中文说明（最反直觉的一条）**：
这个状态名叫 `bracketCounting`，语义是"数花括号"。它**递归压栈**（规则0 再 push 自己），遇 `}` 弹栈。但是——
- `root` 规则0 是 `[{}] → delimiter.bracket`，**不 push** `bracketCounting`；
- `bracketCounting` 只由它**自己**进入（`'@bracketCounting'`）；
- 全配置中**没有任何规则首次进入 `bracketCounting`**。

我用脚本穷举验证过：`BH.tokenizer` 里所有 action 字符串中出现 `@bracketCounting` 的位置只有 `bracketCounting[0]` 自己。因此 **`bracketCounting` 是一个死状态（unreachable state）**，AiScript 的 `{}` 永远由 `root[0]` 处理成 `delimiter.bracket`，不会做配对计数。

这可能是一个从模板（该配置明显改编自 Monaco/VS Code 的 `typescript`/`javascript` Monarch 定义，`"aicoin://monaco"`、`C_LINE_COMMENT_MODE` 等命名都指向这一来源）**复制过来但没接上**的残留。

#### `@whitespace`、`@brackets`、`@keywords`、`@builtinVars`、`@symbols`、`@operators`、`@digits`、`@escapes` 的解引用规则

- `@keywords` / `@builtinVars` / `@operators` / `@symbols` / `@digits` / `@escapes`：指向 `BH` 同名字段（数组或 RegExp）。
- `@whitespace`：**指向 tokenizer 里的 `whitespace` 状态**（`{"include":"@whitespace"}` 展开为该状态的所有规则）。
- `@brackets`：**不是** `BH` 的字段，而是 Monaco 的**内建属性**，由 `BH` 之外的信息解析。见 §5.3。

### 5.3 `@brackets` 的真实语义（Monaco 内部实现，已在客户端里定位）

`2776.js` 里没有 `brackets` 字段，`@brackets` 的解析发生在 Monaco 自己的 Monarch lexer 里。证据：`aicoin_dist\extracted\dist\renderer\1407.js`（4.9 MB，Monaco 主体）字节偏移 **@4219130**：

```js
if(_0x157fbc(_0x2dedb8)&&0x0===_0x2dedb8['indexOf']('@brackets')){
  const _0x3f0dc4=_0x2dedb8['substr'](0x9),
        _0x345ee3=_0x65907d(this['_lexer'],_0xf3e2ca);
  if(!_0x345ee3)throw _0x2f5ec1(this['_lexer'],'@brackets token returned but no bracket defined as: '+_0xf3e2ca);
  _0x2ce95a=_0x1e31f7(_0x345ee3['token']+_0x3f0dc4);
}else _0x2ce95a=_0x1e31f7(''===_0x2dedb8?'':_0x2dedb8+this['_lexer']['tokenPostfix']);
```

同一文件 @4220145 的 `getBracket`：

```js
function _0x65907d(_0x2bf288,_0x5e098c){
  if(!_0x5e098c)return null;
  _0x5e098c=_0x5089e1(_0x2bf288,_0x5e098c);           // 先反转义
  const _0x375c0f=_0x2bf288['brackets'];                // ← lexer.brackets
  for(const _0x382469 of _0x375c0f){
    if(_0x382469['open']===_0x5e098c)return{'token':_0x382469['token'],'bracketType':0x1};
    if(_0x382469['close']===_0x5e098c)return{'token':_0x382469['token'],'bracketType':-0x1};
  }
  return null;
}
```

**要点（已验证，不是猜测）**：
1. `@brackets` 取**匹配到的字面字符**，去 `lexer.brackets`（一个 `{open, close, token}` 数组）里查；
2. 找到就输出 `bracket.token + 后缀`。AiScript 定义里 `@brackets` 的后缀是 `''`，所以 token = `bracket.token`；
3. **找不到就 throw**：`'@brackets token returned but no bracket defined as: '`。所以 `lexer.brackets` 必须覆盖 `()[]{}` 和 `<`/`>`（因为 `common[5]` 也会产出 `@brackets`）。

**未找到**：我没有在客户端里定位到 `lexer.brackets` 的构造点（属于 Monaco 的 `monarchCompile`，在 4.9 MB 的 `1407.js` 里我的搜索没有命中）。因此"`lexer.brackets` 到底由什么填充"是**未找到**，不是已验证的事实。

**已确认的两件事**：
1. AiScript 的 `BH` 里**没有** `brackets` 字段（`BH` 的 key 只有 `defaultToken, keywords, operators, builtinVars, symbols, escapes, digits, tokenizer`，已由执行模块枚举确认）。
2. `xf.brackets` 只有 `[["{","}"],["[","]"],["(",")"]]`，**不含 `<`/`>`**。

**推断（未验证）**：既然 `BH` 没有 `brackets`，Monaco 只能使用其内建默认值或退回 `languageConfiguration.brackets`；两种情况下 `<`/`>` 都不在表里。而 `getBracket` 找不到就会 `throw`：
```
'@brackets token returned but no bracket defined as: '
```
所以 `[<>](?!@symbols)` 一旦匹配到孤立的 `<` 或 `>`（例如 `a < b`，`<` 后面是空格），**很可能在客户端里抛出 lexer 异常、导致整行 invalid**。这是一条**必须用运行时实测**才能定论的推断；建议用 CDP 跑 `monaco.editor.tokenize('a < b','AIScript')` 验证（方法见 `compile-flow.md` §5）。任何据此实现的验证器都应当**先实测再采信**。

---

## 6. `languageConfiguration`（`xf`）、主题（`Zm`/`di`）、editor options（`fF`）

### 6.1 `xf` — `2776.js` @5144 原文（节选）

```js
_0x5e6959={'wordPattern':/(-?\d*\.\d\w*)|([^\`\~\!\@\#\%\^\&\*\(\)\-\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\?\s]+)/g,
'comments':{'lineComment':'//','blockComment':['/*','*/']},
'brackets':[['{','}'],['[',']'],['(',')']],
'onEnterRules':[
  {'beforeText':/^\s*\/\*\*(?!\/)([^\*]|\*(?!\/))*$/,'afterText':/^\s*\*\/$/,'action':{'indentAction':0x2,'appendText':'\x20*\x20'}},
  {'beforeText':/^\s*\/\*\*(?!\/)([^\*]|\*(?!\/))*$/,'action':{'indentAction':0x0,'appendText':_0x1f9ef7(0xcf)}},
  {'beforeText':/^(\t|(\ \ ))*\ \*(\ ([^\*]|\*(?!\/))*)?$/,'action':{'indentAction':0x0,'appendText':'*\x20'}},
  {'beforeText':/^(\t|(\ \ ))*\ \*\/\s*$/,'action':{'indentAction':0x0,'removeText':0x1}}],
'autoClosingPairs':[{'open':'{','close':'}'},{'open':'[','close':']'},{'open':'(','close':')'},
  {'open':'\x22','close':'\x22','notIn':['string']},
  {'open':'\x27','close':'\x27','notIn':['string','comment']},
  {'open':'`','close':'`','notIn':['string','comment']},
  {'open':'/**','close':'\x20*/','notIn':['string']}],
'folding':{'markers':{'start':new RegExp('^\x5cs*//\x5cs*#?region\x5cb'),'end':new RegExp('^\x5cs*//\x5cs*#?endregion\x5cb')}}},
```

解引用：`_0x1f9ef7(0xcf)` = `" * "`（`indentAction: 0` = `None`，`0x2` = `IndentOutdent`）。

| 字段 | 值 / 说明 |
|---|---|
| `lineComment` | `"//"` |
| `blockComment` | `["/*","*/"]` |
| `brackets` | `[["{","}"],["[","]"],["(",")"]]` — **只有三种，没有 `<`/`>`** |
| `autoClosingPairs` | `{ }`, `[ ]`, `( )`, `"`(不在 string 内), `'`(不在 string/comment 内), `` ` ``(不在 string/comment 内), `/**` → ` */`(不在 string 内) |
| `folding.markers` | start `^\s*//\s*#?region\b`，end `^\s*//\s*#?endregion\b` |
| `wordPattern` | `(-?\d*\.\d\w*)|([^\`\~\!\@\#\%\^\&\*\(\)\-\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\?\s]+)` with flag `g` |
| `onEnterRules` | 4 条（见原文） |

**中文说明**：
1. **`autoClosingPairs` 里有反引号对，但 tokenizer 里没有反引号字符串状态** —— 输入 `` ` `` 会自动补全成 ``` `` ```，但内容是 `invalid`。这是一个明显的不一致。
2. **`autoClosingPairs` 里有 `/**` → ` */`**，配合 `onEnterRules` 的前两条（`indentAction: IndentOutdent` + `appendText: " * "`），说明这个配置是为 JSDoc 风格注释做的。
3. `autoClosingPairs` 的 `"` 只 `notIn: ['string']`（**没有排除 comment**），而 `'` 和 `` ` `` 排除了 `['string','comment']`。所以**在注释里输入 `"` 会自动补全，输入 `'` 和 `` ` `` 不会** —— 不一致。
4. `brackets` 里的顺序是 `{ [ (`，与 `root[0]` 只处理 `{}` 不矛盾（`brackets` 是给编辑器做括号高亮/匹配用的，和 Monarch 的 `root` 规则是两套东西）。
5. `wordPattern` 的字符类是"排除法"：**中文落在被排除的字符集之外**（不在 `[^\`\~\!\@...]` 的被排除列表里），所以双击中文会被当成一个"词"，这跟 tokenizer 里中文变 invalid 又是矛盾的。

### 6.2 `Zm` — 浅色主题（`2776.js` @8165 起，逐字）

```js
{'base':'vs','inherit':!0x0,'rules':[
 {'token':'','foreground':'#5c6773'},
 {'token':'keyword','foreground':'#0f8cff'},
 {'token':'function','foreground':'#0f8cff'},
 {'token':'comment','foreground':'#8c96a3'},
 {'token':_0x1f9ef7(0xde),'foreground':'#001734'},            // 'normal'
 {'token':'brackets','foreground':_0x1f9ef7(0xdf)},            // '#001734'
 {'token':'string','foreground':'#00b883'},
 {'token':'variable.builtin','foreground':'#bb5c4e'},
 {'token':'identifier','foreground':'#001734'},
 {'token':'number','foreground':'#dd8c42'},
 {'token':'delimiter','foreground':'#6aa998'}],
 'colors':{'editor.background':'#ffffff','editor.selectionBackground':'#0f8cff60',
 'editor.inactiveSelectionBackground':'#0f8cff50','editor.selectionHighlightBackground':'#0f8cff10',
 'editor.selectionHighlightBorder':'#0f8cff80','editorCursor.foreground':'#0f8cff',
 'editor.lineHighlightBackground':_0x1f9ef7(0x11b),             // '#0f8cff20'
 'editorLineNumber.foreground':'#bfc5cc','editorLineNumber.activeForeground':'#59677b',
 'diffEditor.insertedLineBackground':'#17a67312','diffEditor.insertedTextBackground':'#17a67324',
 'diffEditor.removedLineBackground':'#e45b5b12','diffEditor.removedTextBackground':'#e45b5b24',
 'diffEditorGutter.insertedLineBackground':'#17a6731a','diffEditorGutter.removedLineBackground':'#e45b5b1a',
 'editorHoverWidget.border':'#dee1e5','editorHoverWidget.background':_0x1f9ef7(0x170)}}  // '#ffffff'
```

### 6.3 `di` — 深色主题（`2776.js` @~11800 起）

```js
{'base':'vs-dark','inherit':!0x0,'rules':[
 {'token':'','foreground':'#c4c7cc'},
 {'token':'keyword','foreground':_0x1f9ef7(0x158)},            // '#0f8cff'
 {'token':'function','foreground':'#0f8cff'},
 {'token':'comment','foreground':'#747a8a'},
 {'token':'normal','foreground':'#c4c7cc'},
 {'token':'brackets','foreground':'#c4c7cc'},
 {'token':'string','foreground':'#19a96f'},
 {'token':'variable.builtin','foreground':_0x1f9ef7(0x171)},   // '#c36464'
 {'token':'identifier','foreground':'#c4c7cc'},
 {'token':'number','foreground':'#da7a43'},
 {'token':'delimiter','foreground':'#76b5a5'}],
 'colors':{'editor.background':'#0d0e0f', ... 'editor.selectionForeground':'',
 'editor.lineHighlightBackground':'#0f8cff20','editorLineNumber.foreground':'#747a8a',
 'editorLineNumber.activeForeground':'#aab6c4','diffEditor.insertedLineBackground':'#1ac98a18',
 ... 'searchEditor.findMatchBackground':'#23252a','searchEditor.findMatchBorder':'#2d2e34',
 'searchEditor.textInputBorder':'#34353c','editorHoverWidget.border':'#34353c',
 'editorHoverWidget.background':'#0d0e0f'}}
```

（完整 `colors` 见 JSON 交付物的 `colors.dark.theme`。）

**中文说明**：两个主题的 `rules` 都**没有**为以下 token 定义颜色 —— `string.invalid`、`string.escape`、`string.escape.invalid`、`comment.doc`、`type.identifier`。它们会继承 `base`（`vs` / `vs-dark`）的颜色，或者退回到 `{'token':'', foreground:...}`。

### 6.4 `fF` — Monaco editor options（`2776.js` @~12500 起）

```js
{'colorDecorators':!0x0,'fixedOverflowWidgets':!0x0,'fontSize':0xe,'formatOnPaste':!0x0,
 'links':!0x1,'minimap':{'enabled':!0x1},'overviewRulerBorder':!0x1,'overviewRulerLanes':0x2,
 'quickSuggestionsDelay':0x64,'renderControlCharacters':!0x1,'renderWhitespace':'none',
 'scrollBeyondLastLine':!0x1,'tabSize':0x2,'wordBasedSuggestions':'currentDocument'}
```

即：`fontSize:14`、`minimap.enabled:false`、`tabSize:2`、`wordBasedSuggestions:'currentDocument'`、`quickSuggestionsDelay:100`、`formatOnPaste:true`。**注意 `wordBasedSuggestions:'currentDocument'`**：Monaco 会基于当前文档里的词做补全，这会**叠加**在客户端自己注册的 `registerCompletionItemProvider` 之上 —— 验证器不能假定补全项只来自 `/functionLib`。

---

## 7. 同一文件里还有**第二套** AiScript 定义：highlight.js（**不是** Monaco）

`2776.js` @42625：

```js
_0x5b51be['registerLanguage']('aiscript',_0x1766a6=>({'name':'AIScript','aliases':['aiscript'],
'keywords':{'keyword':_0x5c8aa2['HL']['join']('\x20'),'built_in':_0x5c8aa2['MC']['join']('\x20')},
'contains':[_0x1766a6['C_LINE_COMMENT_MODE'],_0x1766a6[_0xc4cb5e(0x15c)],_0x1766a6['APOS_STRING_MODE'],
_0x1766a6['QUOTE_STRING_MODE'],
{'scope':'number','match':/\b(?:0x[0-9a-fA-F]+|[0-9]+\.[0-9]+|[0-9]+)\b/},
{'scope':'title.function','match':/\b(?!(?:if|else|for|while|switch|return)\b)[A-Za-z_]\w*(?=\s*\()/},
{'scope':'operator','match':_0x1... }]}),
```

解引用：`_0xc4cb5e(0x15c)` = `"C_BLOCK_COMMENT_MODE"`。`C_LINE_COMMENT_MODE` / `C_BLOCK_COMMENT_MODE` / `APOS_STRING_MODE` / `QUOTE_STRING_MODE` 是 **highlight.js** 的内建 mode 名，`registerLanguage(name, hljs => ({...}))` 是 hljs v11 的签名，且调用点紧跟着一个渲染 `<span data-syntax=...>` 的组件（@42625 之前）。

**中文说明**：这是给 **AI 对话框里的代码块**做高亮的，与 Monaco 编辑器无关。它的关键词/内建变量数组**直接复用** `HL` / `MC`。这套定义的数值正则支持 `0x` 十六进制（Monaco 那套不支持），函数正则用 `\b` 边界（Monaco 那套用前缀负向前瞻）。**两套定义的"函数/关键字"判定结果会不一样**，如果你的插件是给 AI 回答做高亮校验，要用这一套；如果是给编辑器做，用 Monarch 那套。

---

## 8. ⚠ 运行时 `keywords` / `operators` / `builtinVars` 会被**服务端函数库扩充**

**这是本文件最重要的"意外"**：静态 `BH` 并不是编辑器实际生效的配置。

证据：`551.js` @19343–20114（`research/_tools/deob.js 551.js st_551.json "'functionLibrary'"` 可复现）：

```js
if(!_0xef1f52)return()=>{};
const {keywords:_0x3cddea,operators:_0x3e05fc,..._0x4d6bec}=_0x2b7614['BH'],
      _0x3e9261=[],_0x2c8aa3=[],_0x582268=[..._0x3cddea],_0x577594=[..._0x3e05fc];
_0x2d51e3['forEach'](_0x42a5b6=>{
  const {type:_0x3f99e5,title:_0x34887c,list:_0xda9038}=_0x42a5b6;
  _0x3f99e5&&Array['isArray'](_0xda9038)&&_0xda9038['length']&&_0xda9038['forEach'](_0x5ccc9e=>{
    const {key:_0xafbabb,doc:_0x7aca11='',text:_0x1854f8=''}=_0x5ccc9e;
    _0xafbabb&&(_0x3e9261['push']({'key':_0xafbabb,'type':_0x3f99e5,'detail':_0x34887c,
      'description':_0x7aca11,'text':_0x1854f8}),
      'variable'===_0x3f99e5?_0x2c8aa3['push'](_0xafbabb)
      :'operators'===_0x3f99e5&&(/^[a-zA-Z_$]+$/['test'](_0xafbabb)
        ?!_0x582268['includes'](_0xafbabb)&&_0x582268['push'](_0xafbabb)
        :!_0x577594['includes'](_0xafbabb)&&_0x577594['push'](_0xafbabb)));
  });
}),
_0x383f1d['current']=_0x3e9261,
_0xef1f52['languages']['setMonarchTokensProvider'](_0x2b7614['ZR'],
  {..._0x4d6bec,'keywords':_0x582268,'operators':_0x577594,
   'builtinVars':Array['from'](new Set([..._0x2b7614['MC'],..._0x2c8aa3]))});
```

解引用：`'variable'`（索引 `0x1d5`）→ 并入 `builtinVars`；`'operators'` → 纯字母的并入 `keywords`，非纯字母的并入 `operators`。

**由此得到的三条硬结论**：

1. **`MC`（12 个）只是 `builtinVars` 的下界**。实际生效的 `builtinVars` = `MC` ∪ {服务端 `functionLib` 里 `type === 'variable'` 的全部 key}。
2. **`HL`（23 个）只是 `keywords` 的下界**。服务端函数库里 `type === 'operators'` 且 key 匹配 `/^[a-zA-Z_$]+$/` 的条目会被**并进 keywords**（例如某个 `andalso` 之类的词形运算符）。非纯字母的运算符并进 `operators`。
3. **`type` 的取值至少包含 `'variable'`、`'operators'`、以及函数类**（补全项 `kind` 由 `'function'===type` 判定为 `CompletionItemKind.Function`）。函数条目**不进 keywords/operators/builtinVars**，只进补全列表。

**对验证器的直接影响**：断一个标识符是不是"已知内建"，不能只查静态 `MC`；必须先拿到 `upgrade/customIndicator/script/functionLib` 的响应（结构见 `compile-flow.md` §2.5），或者接受"静态表 = 下界"这一保守假设。

---

## 9. 补全与 hover（`551.js`）—— 验证器若要对齐客户端行为必须复刻

`551.js` @20613 附近，补全项来源：

```js
const _0x5c284e=_0xef1f52['languages']['registerCompletionItemProvider'](_0x2b7614['ZR'],
 {'provideCompletionItems':(_0x52ae8e,_0x4ad1cb)=>{
   const _0x5d5c1b=_0x52ae8e['getWordUntilPosition'](_0x4ad1cb),
         _0x4fe42e=_0x5d5c1b['word']['toLowerCase']();
   return {'suggestions':_0x3e9261['reduce']((_0x364fd3,_0x53912b)=>
     (_0x53912b['key']['toLowerCase']()['startsWith'](_0x4fe42e)&&_0x364fd3['push']({
       'label':_0x53912b['key'],
       'kind':'function'===_0x53912b['type']?_0xef1f52['languages']['CompletionItemKind']['Function']
            :'variable'===_0x53912b['type']?_0xef1f52['languages']['CompletionItemKind']['Variable']
            :_0xef1f52['languages']['CompletionItemKind']['Text'],
       'documentation':{'value':_0x53912b['description']},
       'detail':_0x53912b['detail'],
       'insertText':_0x53912b['text']&&'string'==typeof _0x53912b['text']?_0x53912b['text']['replace'](/;$/,''):_0x53912b['key'],
       'insertTextRules':_0xef1f52['languages']['CompletionItemInsertTextRule']['InsertAsSnippet'],
       'range':{...}}),_0x364fd3),[])};}}),
```

**中文说明**：
- 补全匹配是 **`startsWith`（不是 includes）**，且**大小写不敏感**（两边都 `toLowerCase()`）。
- 补全数据（`_0x3e9261`）**完全来自服务端函数库**，不在本地；每一项有 `key/type/detail(title)/description(doc)/text`。
- `insertText` 用 `InsertAsSnippet` 规则，并**去掉行尾的 `;`**。这对校验器复刻"用户点补全后生成的代码"很重要。

Hover（@21797）：先用 `monaco.editor.tokenize(line, 'AIScript')` 对**当前行**重新分词，只有当光标处的 token 类型属于 `['function.AIScript','variable.builtin.AIScript']` 时才返回 `{contents:[{value: detail},{value: description}]}`。

```js
const _0x4dce2b=_0x26e37e['editor']['tokenize'](_0x4ace97,_0x2b7614['ZR'])[0x0];
if(!Array['isArray'](_0x4dce2b))return null;
// ... 找 offset === startColumn-1 的 token ...
return _0x49fddd&&_0xc16a8e&&['function.AIScript','variable.builtin.AIScript']['includes'](_0xc16a8e['type'])?_0x49fddd:null;
```

**这是客户端里唯一一处本地调用 Monarch 分词的地方**（`monaco.editor.tokenize`），而且只用于 hover 命中判定，**不产生任何诊断信息**。

---

## 10. 明确"未找到"的东西

以下内容我在 4 个 bundle 里**都没有找到**（搜索词见括号），因此**不存在**：

| 未找到 | 搜索证据 |
|---|---|
| AiScript 的本地 parser / Parser / AST | `551.js`、`2776.js`、`renderer/main.js`、`main/main.js` 全文搜索 `Parser` / `ast` / `parse(`——只有 `JSON.parse`、`Uri.parse`、`path.parse`、`parseFloat`、`parseInt` 等无关命中 |
| 本地 `compile` / `tokenize`（除 Monaco 内建）| `compile` 命中全部是 UI 文案键 `compile_result` / `compile_result_icon` / `compile_result_copy` / `compile-tips`；`tokenize` 只有 `551.js` 的 hover 那次 |
| 本地 diagnostic / `setModelMarkers` 之外的诊断源 | `diagnostic` 在 `551.js` 中 **0 命中**；`setModelMarkers` 在 `551.js` 中只有 1 处（@23118），其输入完全来自服务端 `compileResult`（见 `compile-flow.md` §3） |
| `languages.registerDocumentSymbolProvider` / `CodeActionProvider` / `DiagnosticsAdapter` for AIScript | 全 bundle 无 `AIScript` 相关的语言服务注册 |
| 独立的 AiScript Web Worker / language server | `dist/renderer/editor.worker.js`（499 KB）是 Monaco 通用 worker，搜索 `aiscript` 无命中 |

**结论**：客户端对 AiScript 只有**词法着色 + 前缀补全 + hover**，没有任何语义分析能力。验证器的语法/类型/编译判定必须**自己实现**或**走服务端**（见 `compile-flow.md`）。
