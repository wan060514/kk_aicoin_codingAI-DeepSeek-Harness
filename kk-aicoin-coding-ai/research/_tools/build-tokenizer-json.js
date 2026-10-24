// build-tokenizer-json.js — build research/aiscript_monarch_tokenizer.json from the
// module 0xf21f exports that vm-extract.js dumped out of 2776.js (and cross-checked
// against the byte-identical copy in 551.js).
// usage: node build-tokenizer-json.js <mod_f21f.json> <out.json>
const fs = require('fs');
const mod = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const outPath = process.argv[3];

const isRe = (v) => v && typeof v === 'object' && typeof v.__regex === 'string';
const reOf = (v) => (isRe(v) ? { regex: v.__regex, ...(v.__flags ? { regexFlags: v.__flags } : {}) } : v);

// Normalise one Monarch rule into a self-describing object.
function normRule(rule) {
  if (Array.isArray(rule)) {
    const [m, action] = rule;
    const o = isRe(m) ? { regex: m.__regex, ...(m.__flags ? { regexFlags: m.__flags } : {}) } : { regex: m };
    o.action = Array.isArray(action) ? action : action;
    return o;
  }
  if (rule && typeof rule === 'object') {
    if (typeof rule.include === 'string') return { include: rule.include };
    const o = {};
    for (const k of Object.keys(rule)) o[k] = reOf(rule[k]);
    return o;
  }
  return rule;
}

const tokenizer = {};
for (const state of Object.keys(mod.BH.tokenizer)) {
  tokenizer[state] = mod.BH.tokenizer[state].map(normRule);
}

const out = {
  _source: {
    files: [
      'aicoin_dist/extracted/dist/renderer/2776.js',
      'aicoin_dist/extracted/dist/renderer/551.js',
    ],
    webpackModuleId: '0xf21f (decimal 61983)',
    note:
      'Extracted by executing the module factory in a Node vm (research/_tools/vm-extract.js), ' +
      'not by reading the minified text. Both copies of module 0xf21f were executed; their ' +
      'JSON serialisations are byte-identical (8006 chars).',
  },
  languageId: mod.ZR,
  keywords: mod.HL,
  operators: mod.SB,
  builtinVars: mod.MC,
  tokenizer,
  languageConfiguration: {
    wordPattern: reOf(mod.xf.wordPattern),
    comments: mod.xf.comments,
    brackets: mod.xf.brackets,
    onEnterRules: mod.xf.onEnterRules.map((r) => ({
      beforeText: reOf(r.beforeText),
      ...(r.afterText ? { afterText: reOf(r.afterText) } : {}),
      action: r.action,
    })),
    autoClosingPairs: mod.xf.autoClosingPairs,
    folding: { markers: { start: reOf(mod.xf.folding.markers.start), end: reOf(mod.xf.folding.markers.end) } },
  },
  colors: {
    light: { name: mod.fR, theme: mod.Zm },
    dark: { name: mod.Bt, theme: mod.di },
  },
  protocol: mod.LH,
  extraMonarchAttributes: {
    defaultToken: mod.BH.defaultToken,
    symbols: reOf(mod.BH.symbols),
    escapes: reOf(mod.BH.escapes),
    digits: reOf(mod.BH.digits),
  },
  editorOptions: mod.fF,
  _runtimeAugmentation: {
    note:
      'The effective Monarch attributes are NOT the static ones above. At editor mount the ' +
      'client rebuilds them from BH plus the server function library. Evidence: ' +
      'renderer/551.js @19343-20114 (setMonarchTokensProvider with rebuilt keywords/operators/builtinVars).',
    evidence:
      "const {keywords, operators, ...rest} = BH; ... setMonarchTokensProvider(ZR, {...rest, keywords: kw, operators: ops, builtinVars: Array.from(new Set([...MC, ...variablesFromFunctionLib]))})",
  },
};

fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
console.log('written', outPath, fs.statSync(outPath).size, 'bytes');
console.log('states:', Object.keys(tokenizer).join(', '));
for (const s of Object.keys(tokenizer)) console.log('  ', s, tokenizer[s].length, 'rules');
