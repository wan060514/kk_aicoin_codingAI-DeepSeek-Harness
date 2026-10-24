# AiScript 到底怎么"校验/编译"？—— 外部进程能否拿到真实编译结果

**一句话结论**：
AiCoin 客户端里**没有**任何 AiScript 的语法分析器/编译器/AST/类型检查器。所谓"编译"只有两条服务端路径：
**(A) 保存即编译** —— `POST upgrade/customIndicator/script/save`，响应里的 `data.compileResult` 就是编译结果；
**(B) 加指标即编译** —— `POST upgrade/customIndicator/indicator/gen`，失败时响应里带 `compileResult`。
Monaco 里看到的红/黄波浪线**全部**来自 (A)/(B) 的响应，不是本地解析。
外部进程**可以**拿到真实编译结果，但**只能通过 CDP 驱动正在运行的客户端**（复用它的 Axios + 加密拦截器 + 登录态），或者**自己重放加密协议直连 `apipc.aicoin.com` 并自备 token**。最后一条（保存）**会写用户数据**，不能当作无副作用的"纯校验"。

---

## 0. 调查方法与搜索词

| 工具 | 路径 |
|---|---|
| 窗口定位 | `research/_tools/win.js <file> <needle> [before] [after] [occ]` |
| 正则扫描 | `research/_tools/scan.js <file> <regex> [flags] [ctxBefore] [ctxAfter] [max]` |
| 安全换行美化 | `research/_tools/fmt.js <file> <needle> [len] [pre]` |
| 字符串表还原 | `research/_tools/strtable.js <file> <decoderFn> <base> <out.json>`（`2776.js`→`a6_0x3842`/`0xb8`；`551.js`→`a177_0x5a9d`/`0x1d0`；`main/main.js`→`a0_0x2347`/`0x1bb`） |
| 内联注解（把 `_0x…(0xNNN)` 展开成 `«"字面量"»`） | `research/_tools/deob.js <file> <strtable.json> <needle> [before] [after] [occ]` |
| 模块真实执行 | `research/_tools/vm-extract.js <file> <moduleIdHex> [exportKey\|-] [out]` |

搜索过的关键词（每个都在 4 个 bundle 里跑过）：
`AIScript`、`aiscript`、`parse`、`Parser`、`ast`、`compile`、`Compile`、`tokenize`、`diagnostic`、`marker`、`setModelMarkers`、`MarkerSeverity`、`syntax`、`编译`、`customIndicator`、`customIndicator/script/*`、`script/compile|check|validate|lint`、`indicator/compile`、`api/aiscript`、`indicatorAgent`、`AISCRIPT_AGENT_BASE_URL`。

**扫描覆盖的文件**：`dist/renderer/2776.js`、`551.js`、`1431.js`、`main.js`、`2080.js`、`2098.js`、`2991.js`、`6178.js`、`8428.js`、`browser.js`、`oauth.js`、`previewer.js`、`1407.js`、`dist/main/main.js`、`dist/main/preload.js`。

**覆盖整个 renderer 目录的"哪些文件提到 aiscript"清单**（`Select-String -SimpleMatch`，忽略大小写）：
```
1431.js  2080.js  2098.js  2776.js  2991.js  551.js  6178.js  8428.js
browser.js  main.js  oauth.js  previewer.js  tradingVideoPreviewer.js
```
其中 `6178.js` 的命中是 **highlight.js 自带的 `chaiscript`**（C++ 方言），与 AiScript 无关 —— 这是一个必须排除的假阳性；`2080.js`/`2098.js`/`8428.js`/`browser.js`/`oauth.js`/`previewer.js` 的命中全是 `aiscript-copilot-*` 布局 key 和 IPC 频道名（`aiscript-agent:request`、`aiscript-copilot:restore-sidebar`）。

---

## 1. `551.js`（编辑器组件）里**没有**保存逻辑 —— 明确"未找到"

任务假设保存流程在 `551.js`。**实测不成立**：

```
node research/_tools/scan.js <...>/551.js "customIndicator"           -> total shown = 0
node research/_tools/scan.js <...>/551.js "script/save"               -> total shown = 0
node research/_tools/scan.js <...>/551.js "addIndicatorStatus"        -> total shown = 0
node research/_tools/scan.js <...>/551.js "upgrade/"                  -> total shown = 0
node research/_tools/scan.js <...>/551.js "fetch\(|XMLHttpRequest|\.post\(|\.get\(" -> total shown = 0
```
`551.js` 里 `customIndicator` **0 命中**、任何 `upgrade/…` 路径 **0 命中**，而且**没有任何 `fetch(` / `XMLHttpRequest` / `.post(` / `.get(`** —— 即 **`551.js` 完全不发网络请求**。编辑器只 `dispatch` redux thunk / 调用注入的 props 回调；真正的 HTTP 调用在 `renderer/main.js`（和 `main/main.js`）的 redux slice 里。

`551.js` 实际包含的东西（都已定位）：

| 内容 | 位置 |
|---|---|
| 模块 `0xf21f` 的第二份拷贝（`BH/HL/SB/MC/ZR/LH/Zm/di/xf/fF`） | @9367 的 `['d'](_0x5328d7,['BH',0x0,...` |
| 编辑器组件 `_0x51af4f`（`forwardRef`） | @14572 附近，`const _0x51af4f=(0x0,_0x3c881d['forwardRef'])(function({isMainWin,tempIndicator,editorInitialed,readOnlyIndicator,addAlert,addToChart,createCopy,runRealTrading,runBacktestTask,runScreenerTask,setEditorInitialed,handleFuncClick,openAIScriptCopilot},ref){` |
| Monarch provider 的**运行时重建**（keywords/operators/builtinVars 用服务端函数库扩充） | @19343–20114 |
| `registerCompletionItemProvider` | @20613 |
| `registerHoverProvider` | @21797 |
| **`setModelMarkers`（唯一一处）** | @23118 |
| 自定义右键菜单动作（Change All Occurrences / find-replace / function-library 窗口） | @33769–@35205 |
| 默认导出 `A` = `_0x4639d3`，"还没有指标"空状态组件（`{t, addScriptIndic}`） | @43159 |

所以：**"编辑器 POST 到哪个 endpoint"这个问题的答案是：编辑器自己一个都不 POST。** 它只 `dispatch` redux thunk；真正的 HTTP 调用在 `renderer/main.js`（和 `main/main.js`）的 redux slice 里。

---

## 2. 端点全表（含请求/响应形状）

所有路径都相对于 `axios.defaults.baseURL = <env API_BASE>`（`renderer/main.js` @899882）：
```js
_0x3c873c['A']['defaults']['baseURL']=_0x2aacf9['API_BASE'],
console['assert'](!!_0x3c873c['A']['defaults']['baseURL'],'env\x20\x27API_BASE\x27\x20is\x20not\x20defined.');
```
真实主机（由抓包与 `api_client.js` 佐证）是 `apipc.aicoin.com`，完整 URL 形如 `https://apipc.aicoin.com/api/upgrade/customIndicator/script/save`。
证据：`aicoin_dist\captured\0001_REQUEST_apipc.aicoin.com.txt` →
```
HEADERS: {"host":"apipc.aicoin.com",...}
{"v":"1"}
```
`aicoin_dist\api_client.js` 里 `const HOST='apipc.aicoin.com'; ... '/api/' + endpoint`。

| 端点 | 文件@偏移 | 方法 | 请求体 | 用途 |
|---|---|---|---|---|
| `upgrade/customIndicator/script/list` | `renderer/main.js` @450023 | POST | 无 | 指标列表；顺带拉第一个的 detail |
| `upgrade/customIndicator/script/detail` | `renderer/main.js` @450532、@453199 | POST | `{id}` | 单个脚本源码 |
| **`upgrade/customIndicator/script/save`** | `renderer/main.js` @452189；`main/main.js` @199931 | POST | 见 §2.1 | **保存 + 编译** |
| `upgrade/customIndicator/script/template` | `renderer/main.js` @453613 | POST | `{version:'v2'}` | 模板列表 |
| `upgrade/customIndicator/script/dataConfig` | `renderer/main.js` @454363 | POST | 无 | 可视化编辑配置（`quoteData`/`indicatorFunc`） |
| `upgrade/customIndicator/script/functionLib` | `renderer/main.js` @454727 | POST | 无 | **函数库**（补全 + 扩充 keywords/builtinVars 的来源） |
| **`upgrade/customIndicator/indicator/gen`** | `renderer/main.js` @267154 | POST | `{scriptId, layoutHash}` | **把脚本加到K线时编译** |
| `upgrade/customIndicator/indicator/config` | `renderer/main.js` @454967 | POST | `{indicatorIds:[...]}` | 指标元信息 |
| `upgrade/customIndicator/public-indicator/config` | `renderer/main.js` @455306 | POST | `{publicScriptKeys}` | 公开指标 |
| `upgrade/customIndicator/screener/config` / `screener/execTask` | `renderer/main.js` @329036、@457706 | POST | — | 选币 |
| `upgrade/customIndicator/trade/*` | `renderer/main.js` @840100+ | POST | — | 信号交易 |
| `upgrade/d/indicator/tags` | `renderer/main.js` @451100 附近 | POST | 无 | 分享标签 |
| `upgrade/geoip` | `main/main.js` @1342500 附近 | POST | — | 地域 |
| `conn/load` | `renderer/main.js` @228851 | POST | `{v}`，**`{skipCrypt:true}`** | 取 RSA 公钥 + 版本号 |

### 2.1 `save` 的请求体（逐字）

`dist/renderer/main.js` @451219 起，thunk 名 `indicator/addIndicatorStatus`：

```js
_0x507c97=(0x0,_0x30cb17['zD'])('indicator/addIndicatorStatus',async({id:_0x1a2348,name:_0x4da059,value:_0x1ea803,buildType:_0x508aa5,chartType:_0x4d7b45,visualCode:_0x17fa55,templateId:_0x5753ea,editorDraftId:_0x1eb277,autoSaveUserUid:_0xe21f5b},_0x42d665)=>{
  ...
  try{
    _0x5201fd();     // 校验登录态未变：String(user.details.<uid字段>) === autoSaveUserUid，否则 throw '登录状态已变化，未写入当前账号'
    const {vipStatus:_0x226daf}=_0x42d665['getState']()['user'];
    _0x5874f7=!!(_0x226daf[...'CHART_PRO']||_0x226daf[...'SIGNAL']||_0x226daf[...'INDICATOR']);
    const _0xf38c8=await _0x573d69['A']['post']('upgrade/customIndicator/script/save',
      {'name':_0x4da059,'value':_0x1ea803,'version':'v4',
       ..._0x1a2348?{'id':_0x1a2348}:{},
       ..._0x508aa5?{'buildType':_0x508aa5}:{},
       ..._0x4d7b45?{'position':_0x4d7b45}:{},
       ..._0x17fa55&&_0x508aa5==='visual'?{'visualCode':_0x17fa55}:{}});
    return _0x5201fd(),
      {'result':_0xf38c8['data'],..._0x3c077c,'isVip':_0x5874f7};
  }catch(_0x38ae78){
    const {message:_0x5b7b73,status:_0x44b573}=_0x430159(_0x38ae78);
    return _0x42d665['rejectWithValue']({'result':{'success':![],'status':_0x44b573,'message':_0x5b7b73,'data':undefined},..._0x3c077c,'isVip':_0x5874f7});
  }})
```

**请求体字段**：

| 字段 | 来源 | 必填 | 说明 |
|---|---|---|---|
| `name` | 指标名 | 是 | |
| `value` | 源码文本 | 是 | 源码模式下是 AiScript 全文 |
| `version` | 常量 | 是 | **固定 `'v4'`** |
| `id` | 已有指标 id | 否 | 有 → 更新；无 → 新建 |
| `buildType` | `'source'` / `'visual'` | 否 | |
| `position` | 由 `chartType` 传入 | 否 | **注意：入参叫 `chartType`，出参叫 `position`** |
| `visualCode` | 可视化 DSL | 否 | 仅 `buildType==='visual'` 时携带 |

> `main/main.js` @199931 有同形实现：`['post']('upgrade/customIndicator/script/save',{'name':_0x5748bf,'value':_0x556ab9,'version':'v4',..._0x175d73?{'id':_0x175d73}:{},..._0x4b5178?{'buildType':_0x4b517...`。字段顺序完全一致。

### 2.2 `save` 的响应形状与失败处理

**(a) 成功路径** —— UI 在 `dist/renderer/1431.js` @127442（`_0x10aad3` 是保存按钮的处理函数）：

```js
const _0x388cb4=_0x444be1['iU']['loading'](_0x30ecd3('script:savingAndValidating'),0x0);
try{
  const {payload:_0x3ca2e1}=await _0x3bd529((0x0,_0x5be290['N2'])({
    'id':_0x86297b,'editorDraftId':_0x42bb14?.['editorDraftId'],
    'name':_0x1162e7??_0x4f0f93,'value':_0x3f0b1b,
    'buildType':_0x1adbc5,'chartType':_0x3c8ac9,'visualCode':_0x42bee2}));
  if(_0x3ca2e1?.['result']?.['success']){
    !_0x19c5ce&&_0x4f5532['current']&&_0x4f5532['current']['handleAfterSave']();
    const {compileResult:_0x1f6ece}=_0x3ca2e1['result']['data']||{};
    if(+_0x1f6ece?.['securityCount']>+(_0x488e29?_0xf0a70c:_0x2952fc))
      return _0xf2d0ae((0x0,_0x16e96a['YK'])(_0x16e96a['q3']['scriptLimit'],!0x0,
        {'type':'multiDataSource','securityCount':_0x1f6ece['securityCount']})),
        {'success':!0x1,'scriptLimit':!0x0};
    if((_0x86297b||_0x5d4d80)&&_0x444be1['iU']['success'](_0x30ecd3('global:message',
        {'context':'save','status':'success'})));
    (0x0,_0x5523a7['sx'])('自定义指标',_0x52f4c5(0x302),
        '指标编辑器_'+(_0x19c5ce?_0x52f4c5(0x1c8):'编程')+'脚本_运行'+(_0x1f6ece['pass']?'通过':'报错'),'',!0x0);
    ...
    return {'success':!0x0,'hasTrade':_0x1f6ece?.['hasTrade']};
  }
  throw new Error(_0x3ca2e1?.['result']?.['message']||'');
}catch(_0x14fcc9){
  return _0x444be1['iU']['error'](_0x14fcc9['message']||_0x30ecd3('global:message',
    {'context':'save','status':'fail'})),{'success':!0x1};
}finally{_0x388cb4(),_0x355607['current']=!0x1,_0x2fa071(!0x1);}
```

**证据要点（这是全案最关键的一段）**：
1. loading 文案是 **`script:savingAndValidating`**；`extracted/locales/zh/script.json` 里 `"savingAndValidating": "正在保存并校验脚本"`。**保存和校验是同一个请求。**
2. 遥测/埋点的第四个参数直接读 `compileResult.pass` → `'…脚本_运行' + (pass ? '通过' : '报错')`。同文件 `"compile-tips": "编译通过"`。
3. **成功 ≠ 编译通过。** `result.success === true` 只代表 HTTP/业务层成功；编译是否通过要看 `result.data.compileResult.pass`。`pass: false` 时仍然走 `success` 分支、仍然 `message.success`。
4. **失败处理**：`!result.success` → `throw new Error(result.message)` → `catch` → `message.error(...)` 弹 toast，函数返回 `{success:false}`。**失败时响应里的细节（`compileResult`）被丢掉了**（只有 `message` 被弹出来），因为 throw 前只取了 `message`。

**(b) 只读指标的保存路径** —— `dist/renderer/1431.js` @131926：

```js
{payload:_0x1ceeaf}=await _0x3bd529((0x0,_0x5be290['N2'])({'name':(0x0,_0x290f28['A'])(_0x4f0f93,_0x25eeac),'value':_0x26aad7,'buildType':_0x1adbc5,'chartType':_0x3c8ac9}));
if(_0x1ceeaf['result']['success']){
  const {id:_0x10caf7,compileResult:_0x427e83}=_0x1ceeaf[...]['data'];
  _0x565873=_0x10caf7,_0x5ed05d=_0x427e83?.['securityCount']>0x0;
}else _0x444be1['iU']['error'](_0x1ceeaf['result'][...]);
```
同样：**`compileResult` 只在 `result.data` 里**，失败分支只取 `message`。

**(c) redux 侧落库** —— `dist/renderer/main.js` @473512（`addIndicatorStatus.fulfilled` reducer）：

```js
[''+_0x507c97['fulfilled']]:(_0x1e2c60,_0xbef62a)=>{
  const {result:_0x5b34c2,oid:_0x20622c,name:_0x5ba956,value:_0x10af8e,buildType:buildType='source',
         chartType:chartType='sub',visualCode:_0xdbca10,templateId:_0x19dac2}=_0xbef62a['payload'],
        {id:_0x59f96d,compileResult:_0x3301b4}=_0x5b34c2['data']||{},
        {hasAlert:_0x151ff3,hasTrade:_0x3f8202,securityCount:_0x5e3323}=_0x3301b4||{},
        ...
        _0x2aa827=!_0xbef62a['payload']['autoSaveUserUid']||(_0x2389d5 && ... /* 状态完全一致 */);
  if(_0x5b34c2[...]){ ... }
  if(_0x2aa827)_0x1e2c60['compileResult']={'id':_0x20622c||_0x59f96d,..._0x3301b4,'updateAt':Date['now']()};
}
```

**要点**：
- 编译结果读的是 **`result.data.compileResult`**（`_0x5b34c2['data']['compileResult']`）。
- `compileResult` 里被 reducer 用到的字段：`hasAlert`、`hasTrade`、`securityCount`。
- `_0x2aa827` 这个守卫：**如果是自动保存（带 `autoSaveUserUid`），且编辑器状态不完全匹配，就不写 `compileResult`** —— 客户端刻意避免自动保存覆盖掉用户可见的编译结果。
- 初始 state（`renderer/main.js` @458129）给出了 `compileResult` 的**完整字段集**：
```js
'compileResult':{'id':'','errLine':0x0,'errColumn':0x0,'err':'','pass':!![],
 'hasAlert':![],'hasTrade':![],'securityCount':'0',
 'warnMessage':[{'line':'0','column':'0','message':''}],'updateAt':0x0},
```
注意 `securityCount` 初始是**字符串 `'0'`**，`warnMessage[].line/column` 也是**字符串**，`errLine`/`errColumn` 是数字。使用时都做了 `+` 转换。

### 2.3 `indicator/gen` 的形状（逐字）

`dist/renderer/main.js` @267154。
`_0x17a0ef` 是该文件的字符串解码器（`a0_0x5024`，基址 `0x1d6`）；用 `research/_tools/strtable.js` 还原后确认
**`_0x17a0ef(0x50f)` = `"chart/addScriptIndic"`**，**`_0x315727(0x33a)` = `"what add script indic"`**：

```js
(0x0,_0x231477['zD'])('chart/addScriptIndic',async({scriptRef:_0x3f8518,unPush:unPush=![],type:_0x21b468},_0x16961a)=>{

```js
(0x0,_0x231477['zD'])(_0x17a0ef(0x50f),async({scriptRef:_0x3f8518,unPush:unPush=![],type:_0x21b468},_0x16961a)=>{
  const {focusedWindowId:_0x8e04ac,currentTemplateHash:_0x477f75}=_0x16961a['getState']()['chart'];
  if(_0x8e04ac&&_0x8e04ac!==_0x315727(0x4a1))return{'errMsg':'脚本指标暂不支持在K线新窗口添加','scriptIndicator':null,'unPush':unPush};
  const {data:_0x56057a}=await _0x405394['A']['post']('upgrade/customIndicator/indicator/gen',
    {'scriptId':+_0x3f8518,'layoutHash':_0x477f75});
  console['log']('what add script indic',{'scriptId':+_0x3f8518,'layoutHash':_0x477f75},_0x56057a);
  const {data:_0x55e048,success:_0x7648c3,message:_0x17b460,status:_0x2fd3a6}=_0x56057a;
  if(!_0x7648c3)return{'errMsg':_0x17b460,'compileResult':_0x55e048?.['compileResult'],
                       'scriptIndicator':null,'unPush':unPush,'status':_0x2fd3a6,'data':_0x55e048};
  return{'scriptIndicator':_0x55e048['data'],'errMsg':'','unPush':unPush,'status':_0x2fd3a6,'type':_0x21b468};
})
```

**要点**：
- **`gen` 的失败分支会把 `data.compileResult` 原样带出来**（`'compileResult':_0x55e048?.['compileResult']`），所以 `gen` 是比 `save` **更适合做"纯校验"探针**的端点（它的失败路径不丢编译细节）。
- 成功时 `data.data` 是 `scriptIndicator`（已编译好的指标对象）。
- 但 `gen` 的语义是"把指标加进图表" —— 成功会**改变当前图表布局**（`layoutHash` 参与），并可能推送到其他窗口。**它不是无副作用的。**

### 2.4 `save` 被特殊对待：更保守的重试策略

`dist/renderer/main.js` @899882（`_0x43223c` 函数）：

```js
function _0x43223c(_0x4d8d5f,_0x5c1077){
  const _0x1a1360=_0x4d8d5f['url']||'',
    _0x5538ed=['trade','biztrip','upgrade/customIndicator/script/save',
               'upgrade/customIndicator/screener/config','upgrade/customIndicator/screener/execTask',
               'upgrade/custom/dynamic-group-edit','upgrade/warning/quotes-special','warning/quotes/tag'],
    _0x1ccf6d=_0x5538ed['some'](_0x36685f=>_0x1a1360['includes'](_0x36685f));
  return(_0x1ccf6d?_0x3b6335['Lt']:_0x3b6335['r4'])[_0x5c1077];
}
```

`_0x3b6335 = _0x315175(0x11701)` 是一个延时表模块；命中"敏感端点"列表的请求用 `Lt` 表、其他用 `r4` 表取重试延时。`axios-retry` 配置为 `{'retries':0x3, ...}`（@900136）。
**结论**：客户端自己就把 `script/save` 归为"不能随便重试"的端点（避免重复写）。这佐证了 §6 的"save 有副作用"判断。

### 2.5 `functionLib` 的响应（用于对齐补全/关键词）

`renderer/main.js` @454727：`const {data:_0x2b539c}=await _0x573d69['A']['post']('upgrade/customIndicator/script/functionLib'); return _0x2b539c;`
消费方 `renderer/main.js` @推 reducer（`indicator/fetchFunctionLibrary` fulfilled）把 `data.data.list` 存进 `state.indicators.functionLibrary`。
`551.js` @19343 再把它摊平：每一项是 `{type, title, list:[{key, doc, text}]}`，`type ∈ {'function','variable','operators',…}`（`'function'` 产生 `CompletionItemKind.Function`，`'variable'` → `Variable`，其他 → `Text`）。
**这是 `keywords`/`operators`/`builtinVars` 运行时扩充的唯一数据源**（详见 `editor-tokenizer.md` §8）。

已导出的完整函数库数据就在本仓库里：`aicoin_dist\function_library_raw.json`（315 KB，由 CDP 用 §5 的方法导出）、`结构化数据\函数库结构化数据.json`（678 KB）。

---

## 3. 客户端有没有任何本地 parser / compiler / AST / 类型检查器？—— **没有**

### 3.1 逐词扫描结果

| 搜索词 | `551.js` | `2776.js` | `renderer/main.js` | `main/main.js` | 结论 |
|---|---|---|---|---|---|
| `Parser` | 0 | 0 | 0 | 0 | 未找到 |
| `ast` | 0（"ast"子串命中全是 `ast`→`lastIndex`/`buildType` 等无关词） | 0 | 0 | 0 | 未找到 |
| `parse` | 只有 `parseInt`/`parseFloat` 与混淆器自检 | `JSON.parse`/`Uri.parse` | `JSON.parse` | `JSON.parse`/`path.parse` | **无 AiScript 语法解析** |
| `tokenize` | **1 处**（@14466，hover 用 `monaco.editor.tokenize(line,'AIScript')`） | 0 | 0 | 0 | 仅 monarch 分词 |
| `compile` / `Compile` | 全部是 UI 文案键 `compile_result*` / `compile-tips` / `compile_result_time` | 无 | 无 | 无 | 未找到编译器 |
| `编译` | 0（在 `551.js` 里 0 命中） | 有（**AI 提示词里的中文字符串**，见 3.3） | 有（toast 文案） | 0 | 未找到编译器 |
| `diagnostic` | **0** | `validation.diagnostics`（**服务端字段名**，见 3.3） | 0 | 0 | 未找到本地诊断器 |
| `setModelMarkers` | **1 处**（@23118） | 0 | 0 | 0 | 见 §4 |
| `MarkerSeverity` | 2 处（都在同一函数里） | 0 | 0 | 0 | 见 §4 |
| `syntax` | 0 | 0 | 0 | 0 | 未找到 |

**`script/compile`、`script/check`、`script/validate`、`script/lint`、`indicator/compile`、`compileScript`、`validateScript` 在 4 个 bundle 里全部 0 命中。**

### 3.2 一个决定性的反证：没有 language service 注册

`2776.js` @43457–43849 那段是**唯一**注册 AIScript 的地方，只调用三个 API：

```js
monaco.editor.defineTheme(fR, Zm)                    // ace-light
monaco.editor.defineTheme(Bt, di)                    // ace-dark
monaco.languages.register({id: 'AIScript'})
monaco.languages.setLanguageConfiguration('AIScript', xf)
monaco.languages.setMonarchTokensProvider('AIScript', BH)
```

`551.js` 额外只注册了 `registerCompletionItemProvider` 和 `registerHoverProvider`。
**全 bundle 没有** `registerDocumentSymbolProvider` / `registerCodeActionProvider` / `registerFoldingRangeProvider` / `registerDocumentFormattingEditProvider` / `registerDefinitionProvider` / `setDiagnosticsOptions`（后者是 JSON 专用）。Monaco 的 `DiagnosticsAdapter` / `LanguageServiceRegistry` 对 `AIScript` **完全没有注册**。

`dist/renderer/editor.worker.js`（499 KB，Monaco 通用 worker）里搜索 `aiscript` **无命中**。没有 AIScript 专属 worker。

### 3.3 `2776.js` 里的 `validation` / `compiler` / `diagnostics` —— 来自**远端 AI 服务**，不是本地

`2776.js` @17100–17976（AI 写指标的回答规范化）：

```js
Array['isArray'](_0x40b764['validation']?.['artifacts'])&&(_0x4c2f09=_0x40b764['validation']['artifacts']['filter'](...)),
...
'accepted':!0x0===_0x40b764['validation']?.['accepted'],
'compiler':'string'==typeof _0x40b764['validation']?.['compiler']?_0x40b764['validation']['compiler']:'unverified',
'diagnostics':Array['isArray'](_0x40b764['validation']?.['diagnostics'])?_0x40b764['validation']['diagnostics']:[],
'metadata':_0x40b764['validation']?.['metadata']&&'object'==typeof ... ?_0x40b764['validation']['metadata']:void 0x0
```

`_0x40b764` 是 **AI 会话 run 的响应对象**（同文件里有 `resultType`/`responseText`/`finalArtifacts`/`activity` 等 run 字段）。所以：
- `validation.accepted` / `validation.compiler` / `validation.diagnostics` / `validation.metadata.warnings` / `validation.artifacts[].code` 都是**服务端返回的数据结构**，客户端只是读它。
- `compiler` 缺省值是字符串 `'unverified'`；`2776.js` @107069 的逻辑是：
```js
return _0x3fd770['accepted']?{'kind':_0x35299c['length']?'warning':'passed','messages':_0x35299c}
     :{'kind':_0x3fd770['compiler']&&'unverified'!==_0x3fd770['compiler']?_0x4966a0(0x104):'unverified','messages':_0x35299c};
```
  即 `kind ∈ {'passed','warning','unverified','failed'}`（`0x104` 是失败类文案键）。**"编译器"跑在服务端。**

`2776.js` @98957 还把编译结果塞进**给 AI 的提示词**，这直接给出了字段名和语义：

```js
_0x439e48&&_0xc20315['compileError']
  ?_0x4de1ce(0xc8)+(_0xc20315['errorLine']||'?')+'\x20行，第\x20'+((_0xc20315['errorColumn']||0x0)+0x1)+'\x20列：'+_0xc20315['compileError']
  :'编译错误:\x20无',
'要求:\x20返回可直接编译的完整\x20AIScript；修改任务必须保留用户未要求改变的逻辑。'
```
@99630–99810：
```js
'compileError':'fix'===_0x41a911&&_0x3bf5d1['usesEditor']?_0x336ac3[...]:void 0x0,
'errorLine':'fix'===_0x41a911&&_0x3bf5d1['usesEditor']?_0x336ac3['errLine']:void 0x0,
'errorColumn':'fix'===_0x41a911&&_0x3bf5d1['usesEditor']?_0x336ac3['errColumn']:void 0x0,
```
所以 **`compileError` / `errorLine` / `errorColumn` 是 `compileResult.err` / `.errLine` / `.errColumn` 的别名**（客户端在发给 AI 时改名），并且 `errorColumn` 是 **0 基**（提示词里做了 `+1`），而 `errLine` 是 **1 基**（直接打印）。这与 §4 的 marker 计算完全一致。

### 3.4 AI 指标服务的真实地址（顺带发现，很重要）

`main/main.js` @976192：

```js
const _0xd22883='http://127.0.0.1:3003/api/aiscript',
      _0x4885d2=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function _0x6a905b(_0x55ed9c){
  const _0x256ece=process['env']['AISCRIPT_AGENT_BASE_URL']?.['trim']();
  return(_0x256ece||_0x55ed9c||_0xd22883)['replace'](/\/+$/,'');
}
```

`main/main.js` @259207：
```js
const _0x5bcaec='43.172.178.94:3100',_0x37502f='indicator-agent.aicoin.com',
      _0x574689=_0x1575c5['isAlpha']?_0x5bcaec:_0x37502f;
function _0x2f7a35(_0x4b1016,_0x5e09a7=_0x1575c5['isAlpha']){
  return _0x4b1016===_0x5bcaec?_0x5e09a7?'http://'+_0x4b1016+'/api/aiscript':'https://'+_0x37502f+'/api/aiscript'
       :'https://'+_0x4b1016+'/api/aiscript';
}
```

**AI 指标（含其编译校验）服务的基址优先级**：
`process.env.AISCRIPT_AGENT_BASE_URL` → 配置下发的 `ext.indicatorAgent` → `http://127.0.0.1:3003/api/aiscript`。
正式环境基址 = **`https://indicator-agent.aicoin.com/api/aiscript`**。

IPC 通道是 `'aiscript-agent:request'`（`renderer/main.js` @148471、`browser.js` @3651），由主进程 `main/main.js` @976192 的 `_0x18000d(...)` 处理器用 `net.request` 发出，带头：
```js
_0x2fdb73['setHeader']('Accept','application/json'),
_0x2fdb73['setHeader']('Authorization','Bearer '+_0x50b1be['token']),
_0x2fdb73['setHeader']('X-AiCoin-User-ID',_0x50b1be['uid']),
```
**操作分发是全枚举的，而且里面没有任何 compile/validate 操作**（prompt dump 见 `research/_tools/agent_ops_pretty.txt`）：

```js
switch(_0x1deff3['operation']){
  case 'listConversations': return {'method':'GET','pathname':'/conversations'};
  case 'createConversation': return {'method':'POST','pathname':'/conversations','headers':{'Content-Type':'application/json'},'body':JSON.stringify(title?{'title':title}:{})};
  case 'getConversation': return {'method':'GET','pathname':'/conversations/'+encodeURIComponent(id)};
  case 'getAttachment':  return {'method':'GET','pathname':'/attachments/'+encodeURIComponent(id),'responseType':'bytes'};
  case 'getRun':          return {'method':'GET','pathname':'/runs/'+encodeURIComponent(id)};
  case 'cancelRun':       return {'method':'DELETE','pathname':'/runs/'+encodeURIComponent(id)};
  case 'sendMessage':     return {'method':'POST','pathname':'/conversations/'+encodeURIComponent(conversationId)+'/messages',
                                  'headers':{'Content-Type':'multipart/form-data; boundary='+boundary},'body':body};
  default: throw new Error('不支持的 AI 指标操作');
}
```

> **未找到**：没有任何 IPC 操作或 HTTP 路径形如 `/compile`、`/validate`、`/check`。AI 的"编译校验"只能是服务端在 `POST /conversations/{id}/messages` 触发的 run 完成时，随 run 结果一起返回 `validation`。客户端**无法单独请求一次编译**。

---

## 4. `setModelMarkers` 的诊断到底从哪来 —— **来自服务端 `compileResult`**

`dist/renderer/551.js` @23118，唯一一处 `setModelMarkers`（用 `deob.js` 注解过，`_0x5c1e72(0x1db)` = `"owner"`）：

```js
(0x0,_0x3c881d['useEffect'])(()=>{
  const _0x5c1e72=_0x5187a0;
  if(!_0xef1f52||_0x14d6ee!==_0x32b98f['id'])return()=>{};
  const _0x3b5962=_0xef1f52['editor']['getModel'](_0xef1f52['Uri']['parse'](_0x2b7614['LH']));   // 'aicoin://monaco'
  if(_0x3b5962){
    const _0x420f50=[];
    if(Array['isArray'](_0x32b98f['warnMessage'])&&_0x32b98f['warnMessage']['length']){
      const {line:_0x15ee57,column:_0x34c5a5,message:_0xc2ec6b}=_0x32b98f['warnMessage'][0x0];
      _0x420f50['push']({'startLineNumber':+_0x15ee57,'endLineNumber':+_0x15ee57,
        'startColumn':+_0x34c5a5+0x1,'endColumn':+_0x34c5a5+0x3,
        'message':_0xc2ec6b,'severity':_0xef1f52['MarkerSeverity']['Warning']});
    }else{
      if(_0x32b98f['err']){
        const {errLine:_0x4259c7=0x1,errColumn:_0x51c6ab=0x0,err:_0x3b8eb0}=_0x32b98f;
        _0x420f50['push']({'startLineNumber':_0x4259c7,'endLineNumber':_0x4259c7,
          'startColumn':_0x51c6ab+0x1,'endColumn':_0x51c6ab+0x3,
          'message':_0x3b8eb0,'severity':_0xef1f52['MarkerSeverity']['Error']});
      }
    }
    _0xef1f52['editor']['setModelMarkers'](_0x3b5962,_0x5c1e72(0x1db),/*"owner"*/_0x420f50);
  }
  return()=>{_0x3b5962&&_0xef1f52['editor']['setModelMarkers'](_0x3b5962,'owner',[]);};
},[_0xef1f52,_0x14d6ee,_0x32b98f]);
```

**`_0x32b98f` 的来源**（@15722，同一组件顶部）：

```js
const _0x51af4f=(0x0,_0x3c881d['forwardRef'])(function({isMainWin,tempIndicator:_0x1b55f2,editorInitialed,readOnlyIndicator,addAlert,addToChart,createCopy,runRealTrading,runBacktestTask,runScreenerTask,setEditorInitialed,handleFuncClick,openAIScriptCopilot},_0x256103){
  ...
  _0x32b98f=(0x0,_0x46b340['d4'])(_0x35ea60['hb']),      // ← useSelector
```
其中 `_0x46b340=_0x222b10(0x17e5f)` 是 react-redux，`_0x35ea60=_0x222b10(0xd7b5)` 是指标 selector 模块，`hb` 对应 `renderer/main.js` @490592 里的
```js
_0x220c95=_0x928360=>_0x928360['indicators']['compileResult']
```
**（这条映射是推断，不是直接证据）**：`renderer/main.js` 的 selector 模块与 `551.js` 的模块 id `0xd7b5` 之间的对应关系我**没有**从 bundle 里直接验证；但 `hb` 取出的对象被用到的字段是 `id / err / errLine / errColumn / warnMessage / pass / updateAt`，与 `renderer/main.js` @458129 里 `indicators.compileResult` 的初始字段集**完全一致**，因此这条推断的置信度很高。标注为**强推断**。

**结论链（完全由代码闭合）**：
```
POST script/save (或 indicator/gen) 响应
  → result.data.compileResult            [renderer/main.js @473512]
  → redux state.indicators.compileResult [renderer/main.js @490592]
  → 551.js useSelector                    [@15722]
  → setModelMarkers(warnMessage[0] → Warning; err/errLine/errColumn → Error)  [@23118]
```

**给验证器的三条硬约束**：
1. **只显示第一条 `warnMessage`**（`warnMessage[0x0]`），不是全部。
2. **Warning 优先于 Error**：`if (warnMessage.length) {...} else if (err) {...}` —— 有警告时**连错误都不显示**。
3. **列号处理不对称**：`startColumn = column + 1`（输入是 0 基），`endColumn = column + 3`（固定宽 2 个字符，且**不 clamp 到行尾**）。`errLine`/`line` 都是 1 基、默认 `1`；`errColumn`/`column` 0 基、默认 `0`。
4. **marker 只在 `tempIndicator.id === compileResult.id` 时挂载**（`_0x14d6ee!==_0x32b98f['id']` 直接 return）—— 即编译结果与当前打开的指标不匹配时，旧 marker 会被清掉（cleanup 里 `setModelMarkers(model,'owner',[])`）。

---

## 5. CDP 路线：`ELECTRON_REMOTE_DEBUGGING_PORT` 开关 + 能做什么

### 5.1 开关的确切守卫（`main/main.js`）

**函数定义** —— @1342553：

```js
function _0x99d348(_0x573427,_0x3cf05f){
  const _0x9bff86=_0x214350,
    _0x3ab0aa=function({rawPort:_0x57a178,isDevelopment:_0x358fa3,isAlpha:_0x41c086}){
      const _0x17817e=a0_0x2347;
      if(!_0x358fa3&&!_0x41c086)return null;                                  // ← 第一道门
      if(!_0x57a178||!/^[1-9]\d{0,4}$/[_0x17817e(0x45e)](_0x57a178))return null;  // ← 第二道门：必须 1~5 位、非 0 开头
      const _0x77aa55=Number(_0x57a178);
      return _0x77aa55>=0x1&&_0x77aa55<=0xffff?String(_0x77aa55):null;      // ← 1..65535
    }(_0x3cf05f);
  return!!_0x3ab0aa&&(
    _0x573427['appendSwitch'](_0x9bff86(0x582),/*"remote-debugging-address"*/_0x9bff86(0x4c5)/*"127.0.0.1"*/),
    _0x573427['appendSwitch']('remote-debugging-port',_0x3ab0aa),
    !0x0);
}
```

**调用点** —— @1507710：

```js
_0xbc0670['app']['commandLine'][...appendSwitch]('disable-backgrounding-occluded-windows'),
_0x99d348(_0xbc0670['app']['commandLine'],
  {'rawPort':process['env']['ELECTRON_REMOTE_DEBUGGING_PORT'],
   'isDevelopment':!0x1,                      // 硬编码 false
   'isAlpha':_0x4bc1eb['isAlpha']}),
this[...'checkSingleInstance']()?(...):_0xbc0670['app']['quit'](),
```

**`isAlpha` 的定义** —— `main/main.js` @43471：

```js
const _0x1cad48=/-alpha\.\d+$/['test']('v2.16.27')||/-preview\.\d+$/['test']('v2.16.27')
  ||/-alpha\.\d+$/['test'](_0x5d3999||'')||/-preview\.\d+$/['test'](_0x5d3999||'')||!0x1,
```

**逐条结论（已证明）**：
| 项 | 事实 |
|---|---|
| 环境变量名 | **`ELECTRON_REMOTE_DEBUGGING_PORT`**（`process.env`，无 `VITE_`/`AICOIN_` 前缀） |
| 默认端口 | **没有默认值** —— 不设环境变量就 `null`，什么都不做 |
| 端口格式 | 必须匹配 `/^[1-9]\d{0,4}$/`（1–5 位、非 0 开头），数值范围 `1..65535`，否则静默放弃 |
| 绑定地址 | 同时 `appendSwitch('remote-debugging-address','127.0.0.1')` —— **只监听本地回环** |
| 开发模式门 | `isDevelopment` 被**硬编码为 `!0x1`（false）** |
| 版本门 | 必须 `isAlpha`（版本号匹配 `-alpha.N` 或 `-preview.N`）。当前打包版本 `v2.16.27` **不匹配** |
| 结果 | **在正式版 `v2.16.27` 上，单靠设 `ELECTRON_REMOTE_DEBUGGING_PORT` 是开不起来的** —— 第一道门 `if(!isDevelopment && !isAlpha) return null` 会直接返回 `null` |

**那为什么抓包工具能用？** 因为它的 `.bat` 用 **Chromium 命令行开关**绕过这段代码：

`aicoin_dist\launch_debug.bat`（逐字）：
```bat
@echo off
start "" "D:/Program Files/AiCoin/AiCoin.exe" --remote-debugging-port=9222 --remote-allow-origins=*
```
`aicoin_dist\start_aicoin_debug.bat`（逐字）：
```bat
@echo off
setlocal
set ELECTRON_REMOTE_DEBUGGING_PORT=9222
start "" "D:\Program Files\AiCoin\AiCoin.exe" --inspect=9229 --remote-debugging-port=9222 --remote-allow-origins=*
exit
```
Chromium 会直接接受命令行传入的 `--remote-debugging-port`，**与上面的应用层守卫无关**（守卫只是"应用自己再补一刀"）。

实测证据 —— `aicoin_dist\cdp_probe.txt`：
```
[9222] OK: { "Browser": "Chrome/150.0.7871.129", "Protocol-Version": "1.3",
  "User-Agent": "... aicoin/2.16.27 Chrome/150.0.7871.129 Electron/43.2.0 Safari/537.36", ...}
[9222 /json/list] OK: [ { "type": "page", "title": "AiCoin",
  "url": "file:///D:/Program Files/AiCoin/resources/app.asar/dist/renderer/index.html#/chat",
  "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/page/7D637307B2703AB427D62729123AB0FA" }, ... ]
[9229] fail: 无法连接到远程服务器
=== all listening ports of AiCoin ===
127.0.0.1:20941 pid=1660
127.0.0.1:9222 pid=4736
```
注意：`--inspect=9229` **没生效**（9229 连不上），只有 `--remote-debugging-port=9222` 生效了。`9222` 上拿到的是 **renderer 的 page target**（不是 Node main 进程）。

### 5.2 (a) 加载客户端自己的 Axios 并调 `script/save` —— **已被现有代码证明可行**

`原始数据与工具\构建脚本\01-从客户端导出函数库.js` 就是干这个的，**逐字关键片段**：

```js
const PORT = 9222;
...
const list = JSON.parse(await httpGet('/json/list'));
const target = list.filter(t => t.type === 'page')[0];
const socket = await wsConnect(target.webSocketDebuggerUrl);
...
await call('Runtime.enable');

// 第 1 步：确保页面内已缓存函数库 JSON
const setupResp = await call('Runtime.evaluate', {
  expression: `(async function(){
    if (window.__FL) return window.__FL.length;
    var req = window.__wr;
    var ax = req(31438).A;
    var res = await ax.post('upgrade/customIndicator/script/functionLib');
    window.__FL = JSON.stringify(res.data.data.list);
    return window.__FL.length;
  })()`,
  returnByValue: true, awaitPromise: true,
});
```

**这段代码证明的能力（不是推测）**：
1. `GET http://127.0.0.1:9222/json/list` → 取 `type === 'page'` 的 target → 连 `webSocketDebuggerUrl`。✅
2. `Runtime.enable` + **`Runtime.evaluate`（`awaitPromise: true, returnByValue: true`）**。✅
3. 在 renderer 里可以拿到 **`window.__wr`**（webpack 的 `__webpack_require__`），并用 **模块 id `31438`** 取到 **`A`（客户端的 Axios 实例）**。✅
4. 通过 `ax.post('upgrade/customIndicator/script/functionLib')` **走客户端自己的 Axios**（因此自动经过 §5.3 的请求加密拦截器 + 响应解密拦截器 + token 注入 + 重试）。✅
5. 返回值可以分段 `Runtime.evaluate('window.__FL.substr(pos, CHUNK)')` 回传（因为 `returnByValue` 有大小限制）。✅

**由 1–4 直接外推（同一机制，改动仅 endpoint + body）**：
```js
// 用自己的指标名 + 源码，经客户端 Axios 调保存（★有副作用，见 §6）
var ax = window.__wr(31438).A;
var res = await ax.post('upgrade/customIndicator/script/save',
  { name: '__probe__', value: source, version: 'v4' });
return res.data;               // { success, message, status, data:{ id, compileResult:{...} } }
```
这条**在机制上被证明可行**（同一个 axios 实例、同一套拦截器、同一个 `Runtime.evaluate` 通道），但**我没有实际执行过 `script/save`**，所以"save 一定返回 `data.compileResult`"这一步的**证据来自代码**（§2.1/2.2），不是来自一次真实调用。**标注：机制已证明，具体响应已由代码证明，但未经端到端实测。**

更安全的探针（同样机制，副作用小得多）：
```js
// indicator/gen 的失败分支会原样返回 compileResult（renderer/main.js @267154）
var res = await window.__wr(31438).A.post('upgrade/customIndicator/indicator/gen',
  { scriptId: <id>, layoutHash: <当前 layoutHash> });
```

### 5.3 为什么"走客户端 Axios"很关键：加密拦截器只在 renderer 里

`dist/renderer/main.js` @1028018（请求拦截器，节选逐字）：

```js
_0x107c48['interceptors']['request']['use'](_0x14e28f=>{
  const _0x41796f=a0_0x5024;
  if(_0x14e28f['skipCrypt'])return _0x14e28f;                      // ← 显式旁路
  ...
  const _0x1692b5=_0x350a05=>{return _0x58c4e6(_0x350a05)&&'p'in _0x350a05&&'k'in _0x350a05&&'v'in _0x350a05&&'iv'in _0x350a05;},
        _0xf34583=_0x238f77['includes'](_0x577fdb[...method]||'');   // _0x238f77=['post','put','delete','patch']
  if(_0x1692b5(_0xf34583?_0x577fdb['data']:_0x577fdb['params']))return _0x577fdb;  // 已经加密过就不重复加密
  const {app:{publicKey:_0x51d9d3}}=_0x483c59[...getState](), _0x38bd19=_0x51d9d3['version'];
  const _0x322d40=(0x0,_0x1a0fdf['rh'])(),      // 生成 key
        _0x14bcd6=(0x0,_0x1a0fdf['nl'])();      // 生成 iv
  _0x577fdb['key']=_0x322d40,_0x577fdb['iv']=_0x14bcd6;
  if(_0xf34583){
    ... const _0x234732=JSON['stringify'](_0x577fdb['data']),
    {p:_0x46fe40,k:_0xf20cf8,iv:_0x3d529f}=_0x2ea177['A']['encrypt'](_0x322d40,_0x14bcd6,_0x234732);
    _0x577fdb['data']={'p':_0x46fe40,'k':_0xf20cf8,'v':_0x38bd19,'iv':_0x3d529f};
  }else{ ... 同样，写进 params ... }
  return _0x577fdb;
},_0x4d3089=>{return Promise['reject'](_0x4d3089);});
```

响应拦截器 @1032929：
```js
_0x55eec9=_0x2ea177['A']['decrypt'](_0x4e4d1e/*key*/,_0x17d8cc/*iv*/,_0xd57ded?_0x5f04c9:_0x5f04c9['data'],_0x4a1c9e,_0xd57ded);
if(_0x4a1c9e){const _0x44dcdc=_0x27c9eb(_0x55eec9),_0x44a6c5=_0x27dba8['Ay']['ungzip'](_0x44dcdc,{'to':'string'});
  _0x25a486['data']['data']=_0x44a6c5?JSON['parse'](_0x44a6c5):_0x44a6c5;}
else _0x25a486['data']['data']=_0x55eec9;
```

加解密实现（`dist/renderer/main.js` @1126415，`_0x3651f0` 类）：
```js
['setPublicKey'](_0x450746,_0x246c9f=![]){ ... this['jsEncrypt']['setPublicKey'](_0x450746); }
['encrypt'](_0x3a73f4,_0x3fdb2a,_0x3e4318){
  if(!this['hasSetPublicKey'])throw new Error('No\x20Public\x20Key\x20Available!');
  const _0x5ec2c7=_0x40392c()['encrypt'](_0x3e4318,_0x285699()['parse'](_0x3a73f4[...toString]()),{'iv':_0x3fdb2a,'padding':_0x21a353()}), ...
}
['decrypt']=(_0x986864,_0x7a70ec,_0x2a3391,_0x32ec88,_0x32e703)=>{ ...
  const _0x645cda=_0x40392c()['decrypt'](_0x3fcdfb,_0x285699()['parse'](_0x986864['toString']()),{'iv':_0x7a70ec,'padding':_0x21a353()}); ...
}
```

公钥获取（唯一 `skipCrypt` 调用）—— `renderer/main.js` @228851：
```js
const _0x3a5368=(0x0,_0x1b38d7['zD'])('app/fetchPublicKeyStatus',async _0x482c17=>{
  const _0xf6d2f0=await _0x4628c7['A']['post']('conn/load',{'v':_0x482c17},{'skipCrypt':!![]});
  return _0xf6d2f0[...];
}),
```

**协议已由 `aicoin_dist\api_client.js` 独立复现**（纯 Node crypto，无 CryptoJS），其注释与代码一致：
```js
//   key = CryptoJS.lib.WordArray.random(16).toString()  -> 32 字符 hex 字符串
//   iv  = CryptoJS.lib.WordArray.random(8).toString()   -> 16 字符 hex 字符串
//   p   = AES-128-CBC( JSON.stringify(params), key=encUtf8(key), iv=encUtf8(iv), PKCS7 ) -> base64(OpenSSL)
//   k   = RSA_PKCS1v15_encrypt( key字符串 )             -> base64
//   iv字段 = RSA_PKCS1v15_encrypt( iv字符串 )           -> base64
//   body = { p, k, v: publicKeyVersion, iv }
...
function rsaEncryptB64(pubPem, plain) {
  return crypto.publicEncrypt({ key: pubPem, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(plain, 'utf8')).toString('base64');
}
```
**注意 `api_client.js` 的注释写"AES-128-CBC"，但它自己的代码是 `crypto.createCipheriv('aes-' + kb.length*8 + '-cbc', kb, ...)`，而 `kb` 是 32 字符 → AES-256**。这是那份脚本的**注释与实现不一致**（实现大概率是对的，因为 `RSA_PKCS1_PADDING` 且 key 是 32 字符 hex 串）。**这是一个需要实测才能定论的疑点**，我标注为**未解决**。

真实公钥（`captured\0002_RESPONSE_apipc.aicoin.com.txt`，逐字）：
```
POST /api/conn/load  STATUS: 200
{"success":true,"message":"","status":200,"data":{"v":"1744770600","info":"-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAh9Ls/JGedqcIGK8CTWTL... /wIDAQAB
-----END PUBLIC KEY-----","renew":true}}
```
标准失败信封（`aicoin_dist\resp_raw.txt`，逐字）：
```
{"success":false,"message":"invalid parameters","status":304,"data":null}
```
（这是 `api_client.js` 不带 token 调 `upgrade/customIndicator/script/functionLib` 得到的 —— 证明**该端点要求鉴权**。）

### 5.4 (b) 够到 Monaco 实例 / 它的 models —— **部分证明 + 部分推测**

**已证明的部分**：
- CDP `Runtime.evaluate` 能访问页面任意全局（`01-从客户端导出函数库.js` 就是靠这个拿到 `window.__wr`）。✅
- AiScript 的 model URI 是**固定字符串 `'aicoin://monaco'`**（`LH`），`551.js` @23118 就是这么取 model 的：
  `_0xef1f52['editor']['getModel'](_0xef1f52['Uri']['parse'](_0x2b7614['LH']))`。所以**只要知道 uri 字符串就能从 `monaco.editor.getModels()` 里挑出 AiScript 的 model**。✅（代码证明）
- Monaco 的全局入口：`dist/renderer/main.js` @148471 附近能看到 `monaco` 相关模块；客户端通过 `_0x5b7e52=_0x59b569(0xc3f5)` 之类拿到 monaco 命名空间，是 webpack 模块，**不一定挂在 `window` 上**。

**推测（未验证）**：
- `window.monaco` 是否存在，我**没有在 bundle 里找到证据**（动态 `import()` 的 monaco 通常在 `window.monaco` 上，但需要运行时确认）。如果没有，就需要像 `01-从客户端导出函数库.js` 那样用 `window.__wr(<monaco module id>)` 去取 —— 该手法**已证明可用**（它就是这么取的 axios），但**具体 monaco 的 module id 我没有定位**。
- 能不能拿到**编辑器实例**（不只是 model）来读 `editor.getModel()` 之外的东西（如当前 theme、`getOption`）—— 需要 React fiber 遍历或模块私有引用，**未验证**。

**能读到的"语言服务"到底有什么**：按 §3，AIScript **没有任何本地语言服务**。所以即使够到 Monaco 实例，也只能得到：
- `monaco.editor.tokenize(line,'AIScript')` → Monarch token 数组（本地、无诊断）；
- `monaco.editor.getModel(Uri.parse('aicoin://monaco')).getValue()` → 当前源码；
- 已注册的 completion/hover provider（只能调用，不能"读诊断"）。
**拿不到本地编译错误** —— 因为不存在。

**"读取客户端自己的编译结果"的正确姿势**（代码可证、无需碰 Monaco）：
- 从 **redux store** 读：`state.indicators.compileResult` —— 但 store 也是模块私有，需要用 `__wr` 取到 store 模块，或从 React fiber 里挖。**未验证具体 module id**。
- 或者**自己发一次请求**（§5.2），直接拿响应 —— 这是最干净的路径。

### 5.5 CDP 路线的可行性小结

| 能力 | 状态 | 证据 |
|---|---|---|
| 连上 `127.0.0.1:9222` 的 renderer page | **已证明（实测日志）** | `cdp_probe.txt` |
| `Runtime.evaluate`（含 `awaitPromise`） | **已证明（代码）** | `01-从客户端导出函数库.js` |
| 拿到客户端 Axios 实例 | **已证明（代码）** | 同上：`window.__wr(31438).A` |
| 经加密拦截器发出 `customIndicator/*` 请求 | **已证明（代码）** | 同上 + `renderer/main.js` @1028018 |
| `script/save` 会返回 `data.compileResult` | **代码证明，未端到端实测** | `renderer/main.js` @452189/@473512 |
| `indicator/gen` 失败分支返回 `compileResult` | **代码证明，未端到端实测** | `renderer/main.js` @267154 |
| 读 Monaco model（按 `aicoin://monaco`） | **代码证明存在该 uri，未实测选取** | `551.js` @23118 |
| 读本地编译诊断 | **不可能（不存在）** | §3 全表 |
| 读 redux `compileResult` | **机制可行，module id 未定位** | `renderer/main.js` @490592 |
| 走 `--inspect=9229` 进 main 进程 | **实测失败** | `cdp_probe.txt`（`[9229] fail`） |
| 用 `ELECTRON_REMOTE_DEBUGGING_PORT` 开调试 | **正式版无效**（`isAlpha=false`） | `main/main.js` @1342553/@1507710/@43471 |

---

## 6. 判决：本地离线 vs 运行时；以及保存是否会改用户数据

### 6.1 本地离线可做的验证

| 能做 | 依据 |
|---|---|
| **词法级校验**：按 `aiscript_monarch_tokenizer.json` 复刻 Monarch，检查是否有 token 落到 `invalid`（未闭合字符串、`<>`、中文标识符、`\u9FB0-\u9FFF` 段汉字等） | `editor-tokenizer.md` §5，`2776.js`/`551.js` |
| **关键字/运算符/内建变量白名单**（保守版 = 静态 `HL`/`SB`/`MC`；完整版需函数库数据） | `editor-tokenizer.md` §2–4、§8 |
| **括号/引号配对**（用 `xf.brackets`/`xf.autoClosingPairs`；注意 `bracketCounting` 是死状态） | `editor-tokenizer.md` §5/§6 |
| **注释、字符串转义**（`//`、`/* */`、`/** */`、`\xNN`、`\uNNNN`） | `editor-tokenizer.md` §5 |
| **函数库/补全一致性**：用 `aicoin_dist\function_library_raw.json`（315 KB，已导出）校验"调用的函数是否存在于函数库"、"参数个数是否匹配" | `function_library_raw.json`、`551.js` @19343/@20613 |
| **对齐客户端补全行为**（`startsWith` + 大小写不敏感 + `insertText` 去掉行尾 `;`） | `551.js` @20613 |
| **对齐 marker 呈现规则**（只取 `warnMessage[0]`、Warning 优先、`endColumn=col+3`） | `551.js` @23118 |
| **静态检查 `pass/err/errLine/errColumn/warnMessage` 的数据类型**（`securityCount` 是字符串、`errColumn` 0 基、`errLine` 1 基） | `renderer/main.js` @458129、`551.js` @23118 |

**离线做不到的**：真正的编译、类型检查、`pass` 判定、`securityCount`/`hasAlert`/`hasTrade`。

### 6.2 只有在 AiCoin 运行时才能得到的验证

| 只能运行时 | 证据 |
|---|---|
| `compileResult.pass`（编译通过与否） | 服务端返回，`renderer/main.js` @473512 |
| `compileResult.err` / `errLine` / `errColumn`（真实错误定位） | 同上 |
| `compileResult.warnMessage[]`（服务端警告） | 同上 |
| `compileResult.securityCount`（用到的标的数量 → VIP 限额判定） | `renderer/main.js` @458129 |
| `compileResult.hasAlert` / `hasTrade`（是否需要预警/交易权限） | `renderer/main.js` @471945 |
| AI 侧的 `validation.{accepted,compiler,diagnostics,metadata.warnings}` | `2776.js` @17100/@106635；`main/main.js` @976192 |
| 未闭合/异常的 Monarch 行为（`<` 单独出现是否抛 lexer 异常、`aicoin://monaco` 下 token 的真实 `.AIScript` 后缀） | 需 `monaco.editor.tokenize` 实测 |
| `lexer.brackets` 的真实内容 | 见 `editor-tokenizer.md` §5.3「未找到」 |
| 运行时 `keywords`/`operators`/`builtinVars` 的**实际**内容（含函数库扩充） | `551.js` @19343（代码证明会扩，但具体条目取决于服务端响应） |
| `api_client.js` 的 AES-128 vs AES-256 疑点 | 需实测一次真实请求 |

### 6.3 保存会不会改用户数据？—— **会。必须 opt-in。**

**会写的证据（三条独立）**：

1. **语义就是写**：`POST upgrade/customIndicator/script/save`，body 含 `name` + `value`（完整源码）+ `version:'v4'`；无 `id` → **新建一条指标**，有 `id` → **覆盖那条**。reducer 明确把新 id 推进 `myIndicators` / `scriptDetails`：
   `renderer/main.js` @473512 → `_0x1e2c60['myIndicators']['push'](_0x5f22fb),_0x1e2c60['scriptDetails']['push'](_0x534c98);`
2. **客户端自己把它列为敏感端点**：`_0x5538ed` 数组（@899882）包含 `'upgrade/customIndicator/script/save'`，用更保守的重试延时表，避免重复写。
3. **UI 的保存按钮就是它**：`1431.js` @127442，loading 文案 `script:savingAndValidating`（"正在保存并校验脚本"）。

**结论**：
- **不能拿 `script/save` 当"免费校验"**。用探测用源码（`name='__probe__'`）会**在用户账号里真的创建一条自定义指标**，而且 `save` 有 VIP 限额（`multiDataSourceVipLimit`/`multiDataSourceCommonLimit`，@127442）和 `securityCount` 限额，可能触发配额提示甚至写脏数据。
- **`indicator/gen` 也会改**：它会把指标推进当前图表（`layoutHash` 参与），成功路径返回 `scriptIndicator` 并触发 redux/chart 更新。
- **推荐做法（opt-in + 可撤销）**：
  1. **默认离线**（§6.1 的词法/函数库一致性检查），把 `pass/err/warnMessage` 标注为「需运行时确认」，**绝不伪造** `pass:true`。
  2. 需要真编译时，做成**用户显式勾选**的"连接本机 AiCoin 校验"开关，走 CDP + `Runtime.evaluate`。
  3. 请求前**让用户确认**：要么用 `id` 指向一个用户指定的**草稿指标**做覆盖（不新建），要么明确告知"将在你的账号下新建一条名为 `__AiScript 校验探针__` 的指标，校验后请手动删除"。
  4. **绝不自动重试 `save`**（客户端自己都禁用了默认重试节奏）；失败时只报 `result.message`，不要猜编译错误。
  5. 若只想拿 `pass/err`，**优先用 `indicator/gen` 的失败分支**（`renderer/main.js` @267154 会原样返回 `compileResult`），并注意它仍会尝试改图表。

---

## 7. 明确的"未找到"清单（避免猜测）

| 问题 | 答案 |
|---|---|
| `551.js` 里有保存/网络请求吗？ | **未找到**。`customIndicator` 0 命中，无 `upgrade/` 路径 |
| 有 `script/compile` / `script/check` / `script/validate` / `script/lint` / `indicator/compile` 端点吗？ | **未找到**。4 个 bundle 全部 0 命中 |
| 有本地 AiScript parser / Parser / AST / 类型检查器吗？ | **未找到**。`Parser`/`ast` 全 0；`parse` 全是 JSON/Uri/path/parseInt |
| 有本地诊断（`diagnostic` / `setDiagnosticsOptions` for AIScript）吗？ | **未找到**。`551.js` 中 `diagnostic` 0 命中；`setModelMarkers` 只有 1 处且输入来自服务端 |
| 有 AIScript 专属 worker / language server 吗？ | **未找到**。`editor.worker.js` 内搜索 `aiscript` 无命中 |
| `lexer.brackets` 由什么填充？ | **未找到**（Monaco `monarchCompile` 内部，搜索未命中） |
| `window.monaco` 是否可用？ | **未验证**。bundle 里无 `window.monaco =` 的直接证据 |
| Monaco 模块的 webpack id？ | **未定位**（axios 的 `31438` 已由 `01-从客户端导出函数库.js` 证明可用；monaco 的没找到） |
| redux store 模块的 webpack id？ | **未定位**（selector 定义在 `renderer/main.js` @490592，但未取到运行时 id） |
| 能从 CDP 读 redux `compileResult` 吗？ | **机制可行但未实测**（需先定位 store 模块 id 或走 React fiber） |
| `api_client.js` 是 AES-128 还是 AES-256？ | **未解决**（注释说 128，代码算出来是 256；需实测） |
| 保存是否幂等/可撤销？ | **未找到**任何"删除探针"或"幂等键"机制；`script/save` 无 `requestId`/`nonce` 字段 |
