import fs from 'node:fs';
import path from 'node:path';

const DATA = path.resolve(import.meta.dirname, '..', 'data');
const SRC = 'C:\\Users\\11\\Desktop\\AiScript编辑器架构与函数库\\结构化数据';
const fails = [];
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fails.push(label);
};
const P = (f) => path.join(DATA, f);
const read = (f) => JSON.parse(fs.readFileSync(P(f), 'utf8'));

const fn = read('aiscript_functions.json');
const lang = read('aiscript_language.json');
const rules = read('aiscript_rules.json');
const all = [...fn.functions, ...fn.variables, ...fn.operators];
const src = JSON.parse(fs.readFileSync(path.join(SRC, '函数库结构化数据.json'), 'utf8'));
const srcFlat = src.categories.flatMap((c) => c.items.map((i) => ({ ...i, cat: c.title })));
const srcByName = new Map(srcFlat.map((s) => [s.name, s]));

console.log('--- 1. counts ---');
ok(all.length === 334, 'functions+variables+operators === 334', `actual=${all.length}`);
ok(fn.functions.length + fn.variables.length + fn.operators.length === 334, 'sum via three buckets === 334');
ok(fn.meta.total_items === 334 && fn.meta.total_categories === 17, 'meta total_items/total_categories', JSON.stringify({ i: fn.meta.total_items, c: fn.meta.total_categories }));
ok(fn.categories.length === 17 && fn.categories.reduce((s, c) => s + c.count, 0) === 334, 'categories table sums to 334');

console.log('\n--- 2. flags ---');
const single = all.filter((e) => e.flags.singleDeclaration).map((e) => e.name).sort();
ok(single.length === 4, 'singleDeclaration === 4', JSON.stringify(single));
ok(JSON.stringify(single) === JSON.stringify(['enterLong', 'enterShort', 'exitLong', 'exitShort']), 'singleDeclaration names exact');
const uid = all.filter((e) => e.flags.requiresUniqueId);
ok(uid.length === 8, 'requiresUniqueId === 8', uid.map((e) => e.name).join(','));
ok(all.filter((e) => e.flags.conditionFirstParam).map((e) => e.name).sort().join(',') === 'plotShape,plotText', 'conditionFirstParam === plotText,plotShape');

const ROOT = ['label.new', 'line.new', 'box.new', 'enterLong', 'exitLong', 'enterShort', 'exitShort',
  'enterLongAmount', 'enterLongPercent', 'enterShortAmount', 'enterShortPercent',
  'exitLongAmount', 'exitLongPercent', 'exitShortAmount', 'exitShortPercent'];
const head = (s) => (/^\s*([A-Za-z_$][\w$]*(?:\.[\w$]+)*)\s*\(/.exec(s) || [])[1] || null;
const covered = ROOT.filter((n) => all.some((e) => (e.name === n || head(e.signature) === n) && e.flags.rootScopeOnly));
ok(covered.length === ROOT.length, `rootScopeOnly covers all ${ROOT.length} listed names`, `covered=${covered.length}`);
const rootTrue = all.filter((e) => e.flags.rootScopeOnly).map((e) => e.name).sort();
ok(rootTrue.length === 16, 'rootScopeOnly total (16 = 15 listed + duplicate `new`)', rootTrue.join(','));

console.log('\n--- 3. rules ---');
const WANT = ['PARSE_ERROR', 'UNKNOWN_FUNCTION', 'UNKNOWN_VARIABLE', 'ARITY_TOO_FEW', 'ARITY_TOO_MANY',
  'UNKNOWN_NAMED_ARG', 'DUPLICATE_NAMED_ARG', 'NAMED_ARG_CASE', 'SINGLE_DECLARATION', 'ROOT_SCOPE_REQUIRED',
  'FOR_LOOP_LIMIT', 'HISTORY_LOOKBACK_LIMIT', 'INDEX_LENGTH_LIMIT', 'INDEX_ON_NON_COLLECTION', 'CONFIG_ONCE',
  'CONFIG_NOT_AT_TOP', 'MISSING_UNIQUE_ID', 'DUPLICATE_TRADE_ID', 'ASSIGN_IN_BLOCK_SHADOWS', 'TYPE_HINT_MISMATCH',
  'TERNARY_TYPE_MISMATCH', 'REQUIRE_CONDITION_FIRST_ARG', 'UNUSED_VARIABLE', 'NAN_COMPARISON', 'SUSPICIOUS_DIVISION',
  'TRAILING_SEMICOLON_OK', 'NO_PLOT_OUTPUT', 'NO_TRADE_SIGNAL', 'MISSING_VERSION_DIRECTIVE'];
ok(rules.rules.length === 29, 'rules.length === 29', `actual=${rules.rules.length}`);
const badIds = rules.rules.map((r) => r.id).filter((id) => !WANT.includes(id));
ok(badIds.length === 0, 'every rule id is one of the 29 allowed ids', `unexpected=${JSON.stringify(badIds)}`);
ok(WANT.every((id) => rules.rules.some((r) => r.id === id)), 'all 29 ids present');
ok(new Set(rules.rules.map((r) => r.id)).size === 29, 'rule ids unique');
ok(rules.rules.every((r) => ['error', 'warning', 'info'].includes(r.severity)), 'severities valid');
ok(rules.rules.every((r) => r.id === r.id.replace(/[^A-Z0-9_]/g, '')), 'rule ids ASCII');
ok(rules.rules.every((r) => ['id', 'severity', 'title', 'message', 'hint', 'source'].every((k) => typeof r[k] === 'string' && r[k])), 'every rule has all 6 non-empty fields');
console.log('      severity 分布:', JSON.stringify(rules.rules.reduce((a, r) => (a[r.severity] = (a[r.severity] || 0) + 1, a), {})));

console.log('\n--- 4. language ---');
const srcLang = JSON.parse(fs.readFileSync(path.join(SRC, 'AiScript语言定义.json'), 'utf8'));
const varNames = all.filter((e) => e.type === 'variable').map((e) => e.name);
const expectBV = [...new Set([...srcLang.builtinVars, ...varNames])].sort((a, b) => a.localeCompare(b, 'en'));
ok(JSON.stringify(lang.builtinVars) === JSON.stringify(expectBV), 'builtinVars = language ∪ library variables, deduped+sorted', `n=${lang.builtinVars.length}`);
ok(lang.types.join(',') === 'int,float,bool,string,dict,any', 'types exact');
ok(lang.versionDirective === '// @version=2' && lang.historyRef.maxLookback === 500 && lang.indexRef.maxLength === 1000 && lang.indexRef.zeroBased === true, 'language constants');
ok(lang.limits.forLoopMaxIterations === 500 && lang.limits.historyLookbackMax === 500 && lang.limits.indexLengthMax === 1000, 'limits block');
ok(JSON.stringify(lang.namespaces) === JSON.stringify(['barstate', 'box', 'label', 'line', 'strategy', 'syminfo']), 'namespaces derived from library', lang.namespaces.join(','));
ok(lang.comments.line === '//' && lang.comments.block.join(',') === '/*,*/' && lang.folding.start === '// region', 'comments/folding');

console.log('\n--- 5. sorting + shape ---');
const sortedOk = (arr) => arr.every((e, i) => i === 0 || arr[i - 1].name.localeCompare(e.name, 'en') <= 0);
ok(sortedOk(fn.functions) && sortedOk(fn.variables) && sortedOk(fn.operators), 'functions/variables/operators sorted by name (en)');
ok(fn.categories.every((c, i) => i === 0 || fn.categories[i - 1].title.localeCompare(c.title, 'en') <= 0), 'categories sorted by title (en)');
const KEYS = ['name', 'category', 'type', 'signature', 'version', 'summary', 'returns', 'params', 'minArgs', 'maxArgs', 'examples', 'notes', 'snippet', 'doc', 'flags'];
ok(all.every((e) => JSON.stringify(Object.keys(e)) === JSON.stringify(KEYS)), 'every entry has the exact key order');
ok(all.every((e) => e.params.every((p) => JSON.stringify(Object.keys(p)) === JSON.stringify(['name', 'type', 'required', 'default', 'desc']))), 'param key order');
ok(all.every((e) => e.minArgs === e.params.filter((p) => p.required).length), 'minArgs = #required');
ok(all.every((e) => e.maxArgs === (e.signature.includes('...') ? null : e.params.length)), 'maxArgs rule');
ok(all.filter((e) => e.maxArgs === null).map((e) => e.name).sort().join(',') === 'avg,max,min,string_format', 'variadic => maxArgs null', all.filter((e) => e.maxArgs === null).map((e) => e.name).join(','));
ok(all.every((e) => e.params.every((p) => (p.default === null) || typeof p.default === 'string')), 'default is string|null');
const req = all.flatMap((e) => e.params.filter((p) => p.required));
ok(req.length === 54, 'required params === 54 (source "(必要参数)" count)', `actual=${req.length}`);
const expectArityUnknown = (e) => {
  const s = srcByName.get(e.name);
  return s.params.length === 0 || s.params.every((p) => (p.default ?? null) === null);
};
ok(all.every((e) => e.flags.arityUnknown === expectArityUnknown(e)), 'arityUnknown rule === source raw defaults');
const arityUnknownCount = all.filter((e) => e.flags.arityUnknown).length;
ok(arityUnknownCount === 313, 'arityUnknown count === 50 zero-param + 263 no-default-column', String(arityUnknownCount));
ok(!all.some((e) => e.flags.arityUnknown && e.params.length > 0 && e.params.every((p) => p.required)), 'all-required entries are NOT arityUnknown');
const pt = all.find((e) => e.name === 'plotText');
ok(pt && !pt.flags.arityUnknown && pt.minArgs === 4 && pt.maxArgs === 12 && pt.flags.conditionFirstParam, 'plotText: minArgs=4 maxArgs=12 arityKnown conditionFirstParam');
const maE = all.find((e) => e.name === 'ma');
ok(maE && maE.maxArgs === 2 && maE.minArgs === 0 && maE.flags.arityUnknown === true, 'ma: maxArgs=2 minArgs=0 arityUnknown (doc has no 默认值 column)', JSON.stringify({ min: maE.minArgs, max: maE.maxArgs, unk: maE.flags.arityUnknown }));

console.log('\n--- 6. files + bytes ---');
for (const f of ['aiscript_functions.json', 'aiscript_language.json', 'aiscript_rules.json', 'quick_index.md', 'README.md', 'build..']) break;
const files = ['aiscript_functions.json', 'aiscript_language.json', 'aiscript_rules.json', 'quick_index.md', 'README.md'];
for (const f of files) {
  const st = fs.statSync(P(f));
  console.log(`      ${String(st.size).padStart(9)} B  ${f}`);
  ok(st.size > 0, `${f} non-empty`);
}
const qi = fs.readFileSync(P('quick_index.md'), 'utf8');
ok(qi.startsWith('# AiScript 函数库速查索引（334 项）'), 'quick_index heading');
ok((qi.match(/^\| /gm) || []).length >= 334, 'quick_index has >= 334 table rows');

console.log('\n--- 7. cross-check against source ---');
ok(srcFlat.length === 334, 'source flattened === 334');
ok(all.every((e) => srcFlat.some((s) => s.name === e.name && s.cat === e.category)), 'every output entry traces back to a source entry');
const srcRootText = srcFlat.filter((s) => `${s.summary} ${s.doc_markdown}`.replace(/```[\s\S]*?```/g, '').includes('必须在根作用域'));
ok(srcRootText.length === 0, 'prose-only 根作用域 matches (code fences stripped) === 0', srcRootText.map((s) => s.name).join(','));

console.log('\n' + (fails.length ? `RESULT: ${fails.length} FAILED -> ${fails.join(' | ')}` : 'RESULT: ALL CHECKS PASSED'));
process.exit(fails.length ? 1 : 0);
