#!/usr/bin/env node
/**
 * build_data.mjs — kk_aicoin_codingAI 数据层构建脚本
 * ---------------------------------------------------------------------------
 * 把 AiCoin 客户端解包出的 AiScript 函数库结构化数据，转换成插件要随包发布的
 * 机器可读 JSON / Markdown。零第三方依赖，Node >= 18 (ESM)。
 *
 * 用法:
 *   node tools/build_data.mjs
 *   node tools/build_data.mjs --source "<结构化数据目录>" --out <输出目录>
 *   node tools/build_data.mjs --out ../data --now 2026-10-07T00:00:00.000Z
 *
 * 参数:
 *   --source <dir>   源目录（含 函数库结构化数据.json / AiScript语言定义.json）
 *                    默认: C:\Users\11\Desktop\AiScript编辑器架构与函数库\结构化数据
 *   --out <dir>      输出目录，默认相对本脚本 ../data
 *   --now <ISO>      meta.generated_at 使用固定时间（也可用环境变量 SOURCE_DATE_EPOCH）
 *
 * 生成（全部覆盖写入，UTF-8）:
 *   aiscript_functions.json   函数 / 变量 / 运算符 全量数据（334 条）
 *   aiscript_language.json    语言定义（关键字 / 运算符 / 内置变量 / 限制）
 *   aiscript_rules.json       校验规则目录（单一事实来源，29 条）
 *   quick_index.md            按分类分组的单行速查索引
 *   README.md                 data 目录说明
 *
 * 退出码: 源缺失 / total_items 与展平条目数不一致 -> 非 0（FAIL LOUDLY）。
 *
 * 确定性: 除 meta.generated_at 外，所有输出仅由源数据决定；对象键序固定，
 *         数组按规则排序（localeCompare 'en'）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_REL = 'tools/build_data.mjs';

const LIB_FILE = '函数库结构化数据.json';
const LANG_FILE = 'AiScript语言定义.json';

const DEFAULT_SOURCE_DIR = 'C:\\Users\\11\\Desktop\\AiScript编辑器架构与函数库\\结构化数据';
const DEFAULT_OUT_DIR = path.resolve(HERE, '..', 'data');

const GENERATED_BY = 'tools/build_data.mjs';

/* ------------------------------------------------------------------ utils */

function die(msg) {
  console.error(`\n[build_data] 错误: ${msg}\n`);
  process.exit(1);
}
function warn(msg) {
  console.error(`[build_data] 警告: ${msg}`);
}

/** localeCompare('en') 升序 —— 全程唯一的排序口径。 */
function byName(a, b) {
  return String(a).localeCompare(String(b), 'en');
}
function sortByName(arr, pick = (x) => x.name) {
  return arr.slice().sort((a, b) => byName(pick(a), pick(b)));
}
function uniqSorted(values) {
  return [...new Set(values)].sort(byName);
}

function parseArgs(argv) {
  const opts = { source: DEFAULT_SOURCE_DIR, out: DEFAULT_OUT_DIR, now: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === '-h' || raw === '--help') { opts.help = true; continue; }
    const eq = raw.indexOf('=');
    const key = raw.startsWith('--') && eq !== -1 ? raw.slice(0, eq) : raw;
    let val = raw.startsWith('--') && eq !== -1 ? raw.slice(eq + 1) : null;
    const take = () => {
      if (val !== null) return val;
      if (i + 1 >= argv.length) die(`参数 ${key} 缺少取值`);
      return argv[++i];
    };
    switch (key) {
      case '--source': case '-s': opts.source = take(); break;
      case '--out': case '-o': opts.out = take(); break;
      case '--now': opts.now = take(); break;
      default: die(`未知参数: ${raw}（可用: --source --out --now --help）`);
    }
  }
  opts.source = path.resolve(opts.source);
  opts.out = path.resolve(opts.out);
  return opts;
}

function readJson(file, label) {
  if (!fs.existsSync(file)) die(`${label}不存在: ${file}`);
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 容忍 UTF-8 BOM
  try {
    return JSON.parse(text);
  } catch (err) {
    return die(`${label}不是合法 JSON: ${file}\n  ${err.message}`);
  }
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return Buffer.byteLength(text, 'utf8');
}
function writeJson(file, value) {
  return writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function resolveNow(opts) {
  if (opts.now) {
    const d = new Date(opts.now);
    if (Number.isNaN(d.getTime())) die(`--now 不是合法时间: ${opts.now}`);
    return d.toISOString();
  }
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch && /^\d+$/.test(epoch)) return new Date(Number(epoch) * 1000).toISOString();
  return new Date().toISOString();
}

/* ------------------------------------------------- source value semantics */

const REQUIRED = '(必要参数)';
const OPTIONAL_NO_DEFAULT = '(非必要参数)';

/** 文档里的「默认值」列 -> (required, defaultValue) */
function classifyDefault(raw) {
  if (raw === REQUIRED) return { required: true, value: null };
  if (raw === null || raw === undefined) return { required: false, value: null };
  if (raw === OPTIONAL_NO_DEFAULT) return { required: false, value: null };
  return { required: false, value: String(raw) };
}

const ROOT_SCOPE_NAMES = new Set([
  'label.new', 'line.new', 'box.new',
  'enterLong', 'exitLong', 'enterShort', 'exitShort',
  'enterLongAmount', 'enterLongPercent', 'enterShortAmount', 'enterShortPercent',
  'exitLongAmount', 'exitLongPercent', 'exitShortAmount', 'exitShortPercent',
]);
const SINGLE_DECLARATION_NAMES = new Set(['enterLong', 'exitLong', 'enterShort', 'exitShort']);
const UNIQUE_ID_NAMES = new Set([
  'enterLongAmount', 'enterLongPercent', 'enterShortAmount', 'enterShortPercent',
  'exitLongAmount', 'exitLongPercent', 'exitShortAmount', 'exitShortPercent',
]);
const CONDITION_FIRST_NAMES = new Set(['plotText', 'plotShape']);
const ROOT_SCOPE_PHRASE = '必须在根作用域';

/**
 * 取签名里的被调用者（`label.new([a], b)` -> `label.new`；`ma(a, b)` -> `ma`）。
 * 函数库中画图函数条目的 name 是 `label` / `line` / `box` / `new`，
 * 而真实调用名是签名头 `label.new` / `line.new` / `box.new`，flag 判定按签名头兜底。
 */
function signatureHead(signature) {
  const m = /^\s*([A-Za-z_$\u4e00-\u9faf][\w$\u4e00-\u9faf]*(?:\.[\w$\u4e00-\u9faf]+)*)\s*\(/.exec(String(signature ?? ''));
  return m ? m[1] : null;
}

/** 去掉围栏代码块/行内代码后再做「必须在根作用域」的正文判定，避免示例注释误伤。 */
function stripCode(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
}

/* ------------------------------------------------------------ build: lib */

function buildLibrary(lib, sourceDir, now) {
  const categories = Array.isArray(lib?.categories) ? lib.categories : [];
  if (categories.length === 0) die(`源数据没有 categories: ${path.join(sourceDir, LIB_FILE)}`);

  // ---- 完整性校验 -------------------------------------------------------
  const flat = [];
  for (const cat of categories) {
    const items = Array.isArray(cat.items) ? cat.items : [];
    if (typeof cat.count === 'number' && cat.count !== items.length) {
      warn(`分类「${cat.title}」count=${cat.count} 与实际条目数 ${items.length} 不一致（已按实际条目处理）`);
    }
    for (const item of items) {
      if (item?.type && cat.type && item.type !== cat.type) {
        warn(`条目「${item.name}」type=${item.type} 与分类 type=${cat.type} 不一致`);
      }
      flat.push({ item, category: cat });
    }
  }
  const declared = lib.total_items;
  if (declared !== flat.length) {
    die(
      `total_items 与实际展平条目数不一致: 源声明 total_items=${declared}，`
      + `实际 categories[].items[] 展平后 ${flat.length} 条。源数据可能被截断或改写。`,
    );
  }
  if (typeof lib.total_categories === 'number' && lib.total_categories !== categories.length) {
    warn(`total_categories=${lib.total_categories} 与实际分类数 ${categories.length} 不一致`);
  }

  // ---- 条目归一化 -------------------------------------------------------
  const entries = flat.map(({ item, category }) => {
    const rawParams = Array.isArray(item.params) ? item.params : [];
    const params = rawParams.map((p) => {
      const { required, value } = classifyDefault(p?.default);
      return {
        name: String(p?.name ?? ''),
        type: String(p?.type ?? ''),
        required,
        default: value,
        desc: String(p?.desc ?? ''),
      };
    });

    // 「没有参数表」= 参数为空，或**源数据里**所有参数的默认值都是 null
    // （客户端文档里 3 列表格没有「默认值」列，抽取结果全为 null）。
    // 注意必须用归一化之前的原始 default 判断：`(必要参数)` 归一化后也是 null，
    // 但它恰恰证明参数个数是已知的，不能算 arityUnknown。
    const arityUnknown = rawParams.length === 0
      || rawParams.every((p) => (p?.default ?? null) === null);
    const minArgs = params.filter((p) => p.required).length;
    const maxArgs = String(item.signature ?? '').includes('...') ? null : params.length;

    const head = signatureHead(item.signature);
    const prose = [
      String(item.summary ?? ''),
      stripCode(item.doc_markdown),
      Array.isArray(item.notes) ? item.notes.join('\n') : '',
    ].join('\n');

    // 签名头兜底只对 function 条目生效：客户端里个别运算符条目（如 `"`）的签名被
    // 抽取成了示例代码 `label.new([time, high], ...)`，不加这个约束会误判为根作用域函数。
    const isFunction = String(item.type ?? category.type ?? '') === 'function';
    const rootScopeOnly = ROOT_SCOPE_NAMES.has(item.name)
      || (isFunction && head !== null && ROOT_SCOPE_NAMES.has(head))
      || prose.includes(ROOT_SCOPE_PHRASE);

    const flags = {
      rootScopeOnly,
      singleDeclaration: SINGLE_DECLARATION_NAMES.has(item.name),
      requiresUniqueId: UNIQUE_ID_NAMES.has(item.name),
      conditionFirstParam: CONDITION_FIRST_NAMES.has(item.name),
      arityUnknown,
    };

    return {
      name: String(item.name ?? ''),
      category: String(category.title ?? item.category ?? ''),
      type: String(item.type ?? category.type ?? ''),
      signature: String(item.signature ?? ''),
      version: item.version === null || item.version === undefined ? null : String(item.version),
      summary: String(item.summary ?? ''),
      returns: typeof item.returns === 'string' ? item.returns : '',
      params,
      minArgs,
      maxArgs,
      examples: Array.isArray(item.examples) ? item.examples.map(String) : [],
      notes: Array.isArray(item.notes) ? item.notes.map(String) : [],
      snippet: String(item.snippet ?? ''),
      doc: String(item.doc_markdown ?? ''),
      flags,
    };
  });

  const functions = sortByName(entries.filter((e) => e.type === 'function'));
  const variables = sortByName(entries.filter((e) => e.type === 'variable'));
  const operators = sortByName(entries.filter((e) => e.type === 'operators'));

  const catSummary = sortByName(
    categories.map((c) => ({
      type: String(c.type ?? ''),
      title: String(c.title ?? ''),
      count: Array.isArray(c.items) ? c.items.length : 0,
    })),
    (c) => c.title,
  );

  const library = {
    meta: {
      source: String(lib.source ?? ''),
      source_api: String(lib.source_api ?? ''),
      generated_by: GENERATED_BY,
      generated_at: now,
      total_categories: categories.length,
      total_items: entries.length,
    },
    categories: catSummary,
    functions,
    variables,
    operators,
  };

  return { library, entries, categories, functions, variables, operators };
}

/* ------------------------------------------------------- build: language */

const LANGUAGE_TYPES = ['int', 'float', 'bool', 'string', 'dict', 'any'];

function buildLanguage(lang, entries) {
  const src = lang ?? {};
  const config = src.languageConfig ?? {};
  const comments = config.comments ?? {};

  const builtinVars = uniqSorted([
    ...(Array.isArray(src.builtinVars) ? src.builtinVars : []),
    ...entries.filter((e) => e.type === 'variable').map((e) => e.name),
  ]);

  // 命名空间：从函数库条目名 + 签名头里出现的点号前缀推导，不做臆测。
  const ns = [];
  for (const e of entries) {
    if (e.name.includes('.')) ns.push(e.name.split('.')[0]);
    const head = signatureHead(e.signature);
    if (head && head.includes('.')) ns.push(head.split('.')[0]);
  }
  const namespaces = uniqSorted(ns.filter(Boolean));

  return {
    languageId: String(src.languageId ?? 'AIScript'),
    versionDirective: '// @version=2',
    keywords: Array.isArray(src.keywords) ? src.keywords.map(String) : [],
    operators: Array.isArray(src.operators) ? src.operators.map(String) : [],
    builtinVars,
    namespaces,
    types: LANGUAGE_TYPES.slice(),
    comments: {
      line: String(comments.lineComment ?? '//'),
      block: Array.isArray(comments.blockComment) ? comments.blockComment.map(String) : ['/*', '*/'],
    },
    historyRef: {
      syntax: 'series[n]',
      maxLookback: 500,
    },
    indexRef: {
      syntax: 'array{k}',
      maxLength: 1000,
      zeroBased: true,
    },
    limits: {
      forLoopMaxIterations: 500,
      historyLookbackMax: 500,
      indexLengthMax: 1000,
    },
    folding: {
      start: '// region',
      end: '// endregion',
    },
  };
}

/* ---------------------------------------------------------- build: rules */

const RULE_IDS = [
  'PARSE_ERROR',
  'UNKNOWN_FUNCTION',
  'UNKNOWN_VARIABLE',
  'ARITY_TOO_FEW',
  'ARITY_TOO_MANY',
  'UNKNOWN_NAMED_ARG',
  'DUPLICATE_NAMED_ARG',
  'NAMED_ARG_CASE',
  'SINGLE_DECLARATION',
  'ROOT_SCOPE_REQUIRED',
  'FOR_LOOP_LIMIT',
  'HISTORY_LOOKBACK_LIMIT',
  'INDEX_LENGTH_LIMIT',
  'INDEX_ON_NON_COLLECTION',
  'CONFIG_ONCE',
  'CONFIG_NOT_AT_TOP',
  'MISSING_UNIQUE_ID',
  'DUPLICATE_TRADE_ID',
  'ASSIGN_IN_BLOCK_SHADOWS',
  'TYPE_HINT_MISMATCH',
  'TERNARY_TYPE_MISMATCH',
  'REQUIRE_CONDITION_FIRST_ARG',
  'UNUSED_VARIABLE',
  'NAN_COMPARISON',
  'SUSPICIOUS_DIVISION',
  'TRAILING_SEMICOLON_OK',
  'NO_PLOT_OUTPUT',
  'NO_TRADE_SIGNAL',
  'MISSING_VERSION_DIRECTIVE',
  'NO_POSITION_STATE',
  'REPEATED_TRADE_RISK',
  'STATE_NEVER_RESET',
  'EXIT_WITHOUT_ENTRY_RECORD',
  'NO_ENTRY_BAR_RECORD',
];

const RULES = [
  {
    id: 'PARSE_ERROR',
    severity: 'error',
    title: '语法错误',
    message: '脚本存在无法解析的语法结构，编译器无法继续。',
    hint: '检查括号/引号是否成对闭合、语句是否完整；AiScript 语句不以分号结尾，多写分号通常无害但不规范。',
    source: 'AiScript语言定义.json（languageConfig.brackets / autoClosingPairs）',
  },
  {
    id: 'UNKNOWN_FUNCTION',
    severity: 'error',
    title: '未知函数',
    message: '函数 `{name}` 不在 AiScript 函数库中，运行时会报未定义。',
    hint: '对照 quick_index.md 或 aiscript_functions.json 核对拼写；注意大小写与下划线（如 array_size、string_tolower、pivothigh）。',
    source: '函数库结构化数据.json（334 条，functions 270 条）',
  },
  {
    id: 'UNKNOWN_VARIABLE',
    severity: 'warning',
    title: '未知变量',
    message: '变量 `{name}` 在使用前没有声明或赋值。',
    hint: '先用 `=` 赋值再引用；行情内置变量见 aiscript_language.json 的 builtinVars 与「行情数据」分类。',
    source: 'AiScript语言定义.json builtinVars + 函数库「行情数据」分类（25 条 variable）',
  },
  {
    id: 'ARITY_TOO_FEW',
    severity: 'error',
    title: '参数过少',
    message: '`{name}` 至少需要 {minArgs} 个参数，当前只传了 {actual} 个。',
    hint: '查看该条目的 params 中 required=true 的项；label.new/line.new/box.new 的第一个坐标参数是一个数组，如 [time, high]。',
    source: '函数库结构化数据.json 各条目 params[].default === "(必要参数)"',
  },
  {
    id: 'ARITY_TOO_MANY',
    severity: 'error',
    title: '参数过多',
    message: '`{name}` 最多接受 {maxArgs} 个参数，当前传了 {actual} 个。',
    hint: 'maxArgs 为 null 表示可变参数（如 max/min/avg/string_format），可传任意多个。',
    source: '函数库结构化数据.json 各条目 signature 与 params 数量',
  },
  {
    id: 'UNKNOWN_NAMED_ARG',
    severity: 'error',
    title: '未知命名参数',
    message: '`{name}` 没有名为 `{arg}` 的命名参数。',
    hint: '命名参数只能用该条目 params[].name 中列出的名字，漏写会退化成位置参数导致错位。',
    source: '函数库结构化数据.json 各条目 params[].name',
  },
  {
    id: 'DUPLICATE_NAMED_ARG',
    severity: 'error',
    title: '命名参数重复',
    message: '同一调用里命名参数 `{arg}` 出现了多次。',
    hint: '删除重复项；位置参数与命名参数混用时，位置参数必须全部排在命名参数之前。',
    source: '函数库结构化数据.json 各条目 params[].name',
  },
  {
    id: 'NAMED_ARG_CASE',
    severity: 'error',
    title: '命名参数大小写不匹配',
    message: '命名参数 `{arg}` 大小写不正确，应为 `{expected}`。',
    hint: '命名参数大小写敏感：lineWidth 必须驼峰，写成 linewidth / LineWidth 会报错。',
    source: 'README 已知坑 1；函数库结构化数据.json 各条目 params[].name',
  },
  {
    id: 'SINGLE_DECLARATION',
    severity: 'error',
    title: '交易指令重复声明',
    message: '`{name}` 每种指令最多只能声明一次，重复声明会产生编译错误。',
    hint: '需要多次下单请改用 *Amount / *Percent 系列（必须带唯一 id）。',
    source: 'README 已知坑 2；函数库条目 enterLong / exitLong / enterShort / exitShort',
  },
  {
    id: 'ROOT_SCOPE_REQUIRED',
    severity: 'error',
    title: '必须在根作用域调用',
    message: '`{name}` 必须在根作用域调用，不能放在 if / for 等代码块内。',
    hint: '把调用移到最外层，用第一个 cond 参数控制是否触发；例如 enterLong(cond, ...) 而不是 if (cond) { enterLong(...) }。',
    source: 'README 已知坑 3；函数库条目 label / line / box / enterLong 等（flags.rootScopeOnly）',
  },
  {
    id: 'FOR_LOOP_LIMIT',
    severity: 'error',
    title: 'for 循环超出上限',
    message: 'for 循环单次迭代超过 {limit} 次会报错。',
    hint: '把循环上限压到 500 以内，或改用 range / array_* 系列函数批量处理。',
    source: 'README 已知坑 4；aiscript_language.json limits.forLoopMaxIterations = 500',
  },
  {
    id: 'HISTORY_LOOKBACK_LIMIT',
    severity: 'error',
    title: '历史引用超出上限',
    message: '`[]` 最多只能回溯最近 {limit} 个数据点，当前为 {actual}。',
    hint: '缩短回溯长度，或改用 highest/lowest/valuewhen 等函数间接取历史。',
    source: 'README 已知坑 5；aiscript_language.json historyRef.maxLookback = 500',
  },
  {
    id: 'INDEX_LENGTH_LIMIT',
    severity: 'error',
    title: '下标超出上限',
    message: '`{}` 的数组/字典最大长度为 {limit}，下标从 0 开始。',
    hint: '减小容器长度，或分片处理。',
    source: 'README 已知坑 6；aiscript_language.json indexRef.maxLength = 1000',
  },
  {
    id: 'INDEX_ON_NON_COLLECTION',
    severity: 'error',
    title: '下标运算符用错对象',
    message: '`{}` 只能用于数组/字典，历史 K 线取值请用 `[]`。',
    hint: '`[]` 取历史 K 线值（close[1]），`{}` 取数组/字典下标（arr{0}），两者是不同的运算符。',
    source: 'README 已知坑 7；函数库「引用运算符」条目 [ ] 与 { }',
  },
  {
    id: 'CONFIG_ONCE',
    severity: 'warning',
    title: '配置函数重复调用',
    message: '`{name}` 只能设置一次，重复调用不会生效。',
    hint: 'indicator / tradeConfig 各脚本只保留一处调用。',
    source: '函数库条目 indicator（用于设置显示的精度，只能设置一次）、tradeConfig（只能设置一次）',
  },
  {
    id: 'CONFIG_NOT_AT_TOP',
    severity: 'warning',
    title: '配置函数位置不当',
    message: '`{name}` 属于配置函数，应放在脚本顶部（版本声明之后、其他语句之前）。',
    hint: '把 indicator(...) / tradeConfig(...) 上移到 // @version=2 之后的第一段。',
    source: '函数库「配置函数」分类（indicator / tradeConfig）',
  },
  {
    id: 'MISSING_UNIQUE_ID',
    severity: 'error',
    title: '缺少唯一 id',
    message: '`{name}` 必须传入唯一的 id 参数作为订单标识符。',
    hint: '补上 id，例如 enterLongAmount(cond, id="long_buy", price="market", amount=100)。',
    source: '函数库条目 enterLongAmount 等（id为唯一标识符，不可重复）；flags.requiresUniqueId',
  },
  {
    id: 'DUPLICATE_TRADE_ID',
    severity: 'error',
    title: '交易 id 重复',
    message: '交易声明的 id `{id}` 重复，同一脚本内 id 必须唯一。',
    hint: '给每个 *Amount / *Percent 调用换一个语义化且唯一的 id。',
    source: '函数库条目 enterLongAmount / enterShortAmount / exitLongAmount / exitShortAmount 的 id 参数说明',
  },
  {
    id: 'ASSIGN_IN_BLOCK_SHADOWS',
    severity: 'warning',
    title: '块内赋值遮蔽/丢失',
    message: '在 if / for 块内对块外变量赋值，语义容易与预期不符。',
    hint: '`var` 只在第一根 K 线初始化；`varip` 在实时 K 线内也会持续更新。需要跨 K 线保持状态请显式使用 var / varip。',
    source: 'README 已知坑 8；函数库条目 var / varip',
  },
  {
    id: 'TYPE_HINT_MISMATCH',
    severity: 'warning',
    title: '类型不匹配',
    message: '`{name}` 的第 {index} 个参数期望 {expected}，实际传入 {actual}。',
    hint: '参考 params[].type；需要转换时用 int() / float() / string() / bool()（见「数据类型」分类）。',
    source: '函数库结构化数据.json 各条目 params[].type；函数库「数据类型」分类（int/float/string/bool 等）',
  },
  {
    id: 'TERNARY_TYPE_MISMATCH',
    severity: 'warning',
    title: '三元表达式分支类型不一致',
    message: '三元表达式（?: / iff）两个分支的返回类型不一致。',
    hint: '让两个分支返回同类型；需要缺省值时用 nz() 或 na() 判断后再取值。',
    source: '函数库条目 iff（三元运算）、?:（条件表达式）',
  },
  {
    id: 'REQUIRE_CONDITION_FIRST_ARG',
    severity: 'error',
    title: '第一个参数必须是布尔条件',
    message: '`{name}` 的第一个参数 cond 必须是布尔系列条件。',
    hint: '写成 plotText(close < open, ...) / plotShape(crossup(close, ma(close,20)), ...)，不要把数值序列当条件。',
    source: '函数库条目 plotText / plotShape 的 cond 参数说明（是否进行绘制的bool系列）；flags.conditionFirstParam',
  },
  {
    id: 'UNUSED_VARIABLE',
    severity: 'info',
    title: '未使用的变量',
    message: '变量 `{name}` 被赋值但从未使用。',
    hint: '删除无用赋值，或确认是否漏掉了绘图 / 交易调用。',
    source: 'AIScript 语言定义（变量声明与作用域）',
  },
  {
    id: 'NAN_COMPARISON',
    severity: 'warning',
    title: 'NaN 比较写法可疑',
    message: '与 nan 直接比较（== nan / != nan）不会得到预期结果。',
    hint: '用 na(x) 判断是否为 NaN，用 nz(x, fallback) 提供缺省值。',
    source: '函数库条目 na（判断数值是否为 NaN）、nz、nan（数据类型）',
  },
  {
    id: 'SUSPICIOUS_DIVISION',
    severity: 'warning',
    title: '可疑的除法',
    message: '除法运算的除数可能为 0 或为字面量 0。',
    hint: '先用 nz(divisor, 1) 兜底，或加条件判断后再相除。',
    source: '函数库「算术运算符」条目 /；函数库条目 nz',
  },
  {
    id: 'TRAILING_SEMICOLON_OK',
    severity: 'info',
    title: '行尾分号',
    message: 'AiScript 语句以换行结束，行尾分号会被忽略，不影响编译。',
    hint: '无需修改；函数库 snippet 模板本身也带分号，可直接粘贴。',
    source: '函数库结构化数据.json 各条目 snippet（普遍以分号结尾）',
  },
  {
    id: 'NO_PLOT_OUTPUT',
    severity: 'warning',
    title: '没有任何绘图输出',
    message: '指标脚本没有任何 plot / plot* / label / line / box 输出，运行时图表上是空白的。',
    hint: '至少调用一次 plot(series, title=..., color=...) 或 plotColumn / plotHist / plotCandle 等。',
    source: '函数库「画图函数」分类（plot / plotColumn / plotHist / plotCandle / plotOhlc / plotText / plotShape / label / line / box / fill 等 12 条）',
  },
  {
    id: 'NO_TRADE_SIGNAL',
    severity: 'warning',
    title: '没有任何交易指令',
    message: '脚本声明了交易配置，但没有任何 enterLong / enterShort / exit* 交易指令。',
    hint: '补上交易指令，或删除无用的 tradeConfig。',
    source: '函数库「交易函数」分类（14 条）',
  },
  {
    id: 'MISSING_VERSION_DIRECTIVE',
    severity: 'warning',
    title: '缺少版本声明',
    message: '脚本开头缺少 `// @version=2` 版本声明。',
    hint: '在脚本第一行写 // @version=2；函数库绝大多数条目都要求语法版本 2。',
    source: '函数库 doc_markdown「语法版本需要 // @version=2」；aiscript_language.json versionDirective',
  },
  {
    id: 'NO_POSITION_STATE',
    severity: 'error',
    title: '没有记录仓位状态',
    message: '脚本里有交易指令，但没有任何跨 K 线保持的仓位状态变量（var/varip），也没有读取 strategy.position。',
    hint: '至少声明一个状态变量，例如 var in_long = false，并在开仓/平仓分支里用 := 更新它；否则脚本无从知道自己是否已有持仓。',
    source: '函数库「数据类型」条目 var/varip（跨 K 线保持）；函数库条目 strategy.position（获取当前策略持仓）',
  },
  {
    id: 'REPEATED_TRADE_RISK',
    severity: 'error',
    title: '下单条件会重复触发',
    message: '交易指令 `{name}` 的触发条件既不是边沿信号（crossup / crossdown / rising / falling），也没有引用任何仓位状态变量。',
    hint: '条件每根 K 线都成立时会重复下单。改成「边沿信号 + 状态保护」，例如 crossup(fast, slow) and not in_long，并在平仓后把状态复位。',
    source: '函数库条目 crossup / crossdown / rising / falling（边沿判断）；交易函数 cond 参数说明',
  },
  {
    id: 'STATE_NEVER_RESET',
    severity: 'warning',
    title: '状态变量只置位未复位',
    message: '状态变量 `{name}` 被赋值为 true，但脚本里从未被赋值为 false。',
    hint: '状态机必须能回到空仓：在平仓分支里写 {name} := false，否则平仓后会一直认为自己仍持仓。',
    source: '函数库「数据类型」条目 var；仓位状态机通用要求',
  },
  {
    id: 'EXIT_WITHOUT_ENTRY_RECORD',
    severity: 'warning',
    title: '止盈止损没有记录入场价',
    message: '出场条件按百分比或价格比例计算，但脚本既没有读取 strategy.position 的持仓均价，也没有用变量记录入场价。',
    hint: '开仓分支里记 entry_price := close（或读 strategy.position 的 long_price / short_price），止盈止损都基于这个记录值计算。',
    source: '函数库条目 strategy.position（long_price / short_price）；交易函数 cond 参数说明',
  },
  {
    id: 'NO_ENTRY_BAR_RECORD',
    severity: 'info',
    title: '没有记录入场 K 线',
    message: '脚本没有记录开仓发生在哪一根 K 线，因此无法实现时间止损、最长持仓或平仓后冷却。',
    hint: '开仓分支里记 entry_bar := bar_index，之后可用 bar_index - entry_bar >= N 做时间止损或冷却。',
    source: 'AiScript 内置变量 bar_index；仓位状态机通用要求',
  },
];

const SEVERITIES = new Set(['error', 'warning', 'info']);

function buildRules() {
  const ids = RULES.map((r) => r.id);
  if (ids.length !== RULE_IDS.length) {
    die(`规则数量不一致: 定义 ${ids.length} 条，期望 ${RULE_IDS.length} 条`);
  }
  for (let i = 0; i < RULE_IDS.length; i++) {
    if (ids[i] !== RULE_IDS[i]) die(`规则 id 顺序/名称不符: 第 ${i + 1} 条为 ${ids[i]}，期望 ${RULE_IDS[i]}`);
  }
  for (const r of RULES) {
    if (!SEVERITIES.has(r.severity)) die(`规则 ${r.id} 的 severity 非法: ${r.severity}`);
    for (const k of ['id', 'severity', 'title', 'message', 'hint', 'source']) {
      if (typeof r[k] !== 'string' || r[k].length === 0) die(`规则 ${r.id} 缺少字段 ${k}`);
    }
    if (!/^[A-Z0-9_]+$/.test(r.id)) die(`规则 id 必须为 ASCII 大写下划线: ${r.id}`);
  }
  return { rules: RULES, ids: RULE_IDS };
}

/* ---------------------------------------------------- build: quick index */

/** 摘要取第一句（。！？； 或句末 ". " 结尾），并压缩到 <=60 字。 */
function firstSentence(text, max = 60) {
  const flat = String(text ?? '')
    .replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, '$1') // [文字](链接) -> 文字，避免把 URL 带进表格
    .replace(/`([^`]*)`/g, '$1')                // 行内代码去反引号
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return '';
  let end = flat.length;
  for (let i = 0; i < flat.length; i++) {
    const ch = flat[i];
    if (ch === '。' || ch === '！' || ch === '？' || ch === '；' || ch === ';') { end = i; break; }
    if (ch === '.' && (i === flat.length - 1 || flat[i + 1] === ' ')) { end = i; break; }
  }
  let s = flat.slice(0, end).trim().replace(/[。．.!！?？,，、\s]+$/u, '');
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s;
}
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();

function buildQuickIndex(entries, categories, total) {
  const lines = [];
  lines.push(`# AiScript 函数库速查索引（${total} 项）`);
  lines.push('');
  lines.push('> 由 `tools/build_data.mjs` 自动生成，请勿手工修改。数据源：AiCoin 桌面客户端内置 AiScript 函数库。');
  lines.push('');
  lines.push('## 分类统计');
  lines.push('');
  lines.push('| # | 分类 | 类型 | 条目数 |');
  lines.push('| --- | --- | --- | --- |');
  categories.forEach((c, i) => {
    lines.push(`| ${i + 1} | ${cell(c.title)} | ${cell(c.type)} | ${c.count} |`);
  });
  lines.push(`| | **合计** | | **${total}** |`);
  lines.push('');

  for (const cat of categories) {
    const items = sortByName(entries.filter((e) => e.category === cat.title));
    lines.push(`## ${cat.title}（${cat.type}，${items.length} 项）`);
    lines.push('');
    lines.push('| 名称 | 分类 | 签名 | 摘要 |');
    lines.push('| --- | --- | --- | --- |');
    for (const e of items) {
      lines.push(`| ${cell(e.name)} | ${cell(e.category)} | ${cell(e.signature)} | ${cell(firstSentence(e.summary))} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/* --------------------------------------------------------- build: README */

function buildDataReadme({ total, categories, functions, variables, operators, namespaces, builtinVars, sizes }) {
  const sizeRows = Object.entries(sizes)
    .map(([f, b]) => `| \`${f}\` | ${b.toLocaleString('en-US')} B |`)
    .join('\n');
  return `# kk_aicoin_codingAI · data 目录说明

本目录是插件随包发布的 **AiScript 数据层**，由 \`tools/build_data.mjs\` 从 AiCoin 桌面客户端解包出的
函数库结构化数据自动生成。**请勿手工修改**，改数据请改构建脚本后重新生成。

## 文件一览

| 文件 | 内容 | 主要消费者 |
| --- | --- | --- |
| \`aiscript_functions.json\` | 函数库全量数据：${total} 条（functions ${functions} / variables ${variables} / operators ${operators}），含签名、参数、必填性、默认值、示例、flags | 补全、跳转、参数提示、函数检索 |
| \`aiscript_language.json\` | 语言定义：关键字、运算符、内置变量、命名空间、类型、注释/折叠语法与各项上限 | 词法高亮、语法配置、常量校验 |
| \`aiscript_rules.json\` | 校验规则目录（29 条），每条含 id / severity / title / message / hint / source | 校验器（\`validator\` 直接 import，规则文案的单一事实来源） |
| \`quick_index.md\` | 按分类分组的单行速查索引，一页看完 ${total} 条 | 喂给模型的紧凑上下文、人工速查 |
| \`README.md\` | 本文件 | 人 |

## 数据来源

- 源文件：\`结构化数据/函数库结构化数据.json\`（${total} 条，17 个分类）、\`结构化数据/AiScript语言定义.json\`
- 上游：AiCoin 桌面客户端内置接口 \`POST /api/upgrade/customIndicator/script/functionLib\`
- 提取日期：2026-10-05

## 字段约定（aiscript_functions.json）

- \`params[].required\`：源数据 \`default === "(必要参数)"\` 时为 \`true\`。
- \`params[].default\`：源数据里的 \`"(必要参数)"\` / \`"(非必要参数)"\` / \`null\` 一律归一化为 \`null\`，其余保留原始字面量（如 \`'gray'\`、\`true\`、\`[0]\`）。
- \`minArgs\` = 必填参数个数；\`maxArgs\` = 参数个数，签名含 \`...\` 的可变参数函数为 \`null\`。
- \`flags.arityUnknown\`：该条目在客户端文档里没有「默认值」列（参数全为 \`null\`），或本身没有参数表，**参数个数不可信，校验时应当放宽**。
- \`flags.rootScopeOnly\`：必须在根作用域调用（不能放进 \`if\` 块），共 16 条（12 个交易指令 + label/line/box/new）。
- \`flags.singleDeclaration\`：每种指令最多声明一次（enterLong / exitLong / enterShort / exitShort，共 4 条）。
- \`flags.requiresUniqueId\`：8 个 \`*Amount\` / \`*Percent\` 交易函数，\`id\` 必须唯一。
- \`flags.conditionFirstParam\`：\`plotText\` / \`plotShape\` 的第一个参数必须是布尔条件。
- 数组排序：\`functions\` / \`variables\` / \`operators\` 按 \`name\` 升序（\`localeCompare('en')\`），\`categories\` 按 \`title\` 升序。

## aiscript_language.json

- \`builtinVars\`：语言定义内置变量 ∪ 函数库 25 个 \`variable\` 条目，去重排序（共 ${builtinVars} 个）。
- \`namespaces\`：从函数库条目名与签名头里的点号前缀推导（${namespaces.join(' / ')}）。
- \`limits\`：for 循环 500 次、历史引用回溯 500 点、下标长度 1000。

## 重新生成

\`\`\`bash
cd kk_aicoin_codingAI
node tools/build_data.mjs                     # 使用默认源目录与 ../data
node tools/build_data.mjs --source "<结构化数据目录>" --out ../data
node tools/verify_data.mjs                    # 自检：条目数 / flags / 排序 / 规则 id / 文件体积
\`\`\`

脚本零第三方依赖，确定性输出（仅 \`meta.generated_at\` 随时间变化，可用 \`--now <ISO>\` 或
环境变量 \`SOURCE_DATE_EPOCH\` 固定）。源文件缺失或 \`total_items\` 与展平条目数不一致时会以非 0 退出码报错。

## 本次生成的文件体积

| 文件 | 字节 |
| --- | --- |
${sizeRows}
`;
}

/* ------------------------------------------------------------------ main */

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`用法: node ${SCRIPT_REL} [--source <dir>] [--out <dir>] [--now <ISO>]`);
    return;
  }
  const now = resolveNow(opts);

  if (!fs.existsSync(opts.source)) die(`源目录不存在: ${opts.source}`);
  const libPath = path.join(opts.source, LIB_FILE);
  const langPath = path.join(opts.source, LANG_FILE);

  const lib = readJson(libPath, '函数库结构化数据');
  const langRaw = readJson(langPath, 'AiScript 语言定义');

  const { library, entries, categories, functions, variables, operators } = buildLibrary(lib, opts.source, now);
  if (entries.length !== library.meta.total_items) {
    die(`内部不一致: 条目数 ${entries.length} != meta.total_items ${library.meta.total_items}`);
  }
  const language = buildLanguage(langRaw, entries);
  const { rules, ids } = buildRules();
  const quickIndex = buildQuickIndex(entries, categories, entries.length);

  fs.mkdirSync(opts.out, { recursive: true });

  const sizes = {};
  sizes['aiscript_functions.json'] = writeJson(path.join(opts.out, 'aiscript_functions.json'), library);
  sizes['aiscript_language.json'] = writeJson(path.join(opts.out, 'aiscript_language.json'), language);
  sizes['aiscript_rules.json'] = writeJson(path.join(opts.out, 'aiscript_rules.json'), { rules });
  sizes['quick_index.md'] = writeText(path.join(opts.out, 'quick_index.md'), quickIndex);
  sizes['README.md'] = writeText(
    path.join(opts.out, 'README.md'),
    buildDataReadme({
      total: entries.length,
      categories,
      functions: functions.length,
      variables: variables.length,
      operators: operators.length,
      namespaces: language.namespaces,
      builtinVars: language.builtinVars.length,
      sizes,
    }),
  );

  const flagged = (k) => entries.filter((e) => e.flags[k]).length;
  const lines = [];
  lines.push(`[build_data] source : ${opts.source}`);
  lines.push(`[build_data] out    : ${opts.out}`);
  lines.push(`[build_data] 条目   : ${entries.length} (functions ${functions.length} / variables ${variables.length} / operators ${operators.length})，分类 ${categories.length}`);
  lines.push(`[build_data] flags  : rootScopeOnly ${flagged('rootScopeOnly')} / singleDeclaration ${flagged('singleDeclaration')} / requiresUniqueId ${flagged('requiresUniqueId')} / conditionFirstParam ${flagged('conditionFirstParam')} / arityUnknown ${flagged('arityUnknown')}`);
  lines.push(`[build_data] 语言   : keywords ${language.keywords.length}, operators ${language.operators.length}, builtinVars ${language.builtinVars.length}, namespaces ${language.namespaces.length} (${language.namespaces.join(', ')})`);
  lines.push(`[build_data] 规则   : ${rules.length} 条 (${ids[0]} … ${ids[ids.length - 1]})`);
  lines.push('[build_data] 写出   :');
  let totalBytes = 0;
  for (const [file, bytes] of Object.entries(sizes)) {
    totalBytes += bytes;
    lines.push(`[build_data]   ${String(bytes).padStart(9, ' ')} B  ${file}`);
  }
  lines.push(`[build_data]   ${String(totalBytes).padStart(9, ' ')} B  TOTAL (${Object.keys(sizes).length} files)`);
  lines.push('[build_data] 完成。');
  console.log(lines.join('\n'));
}

main();
