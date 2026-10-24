// strtable.js — boot a bundle in a VM (isolating its console anti-debug) and dump the
// resolved string table from its obfuscator decoder, so `_0x…(0xNNN)` calls in the
// minified source can be resolved to literals.
// usage: node strtable.js <file> <decoderFunctionName> <baseOffset> [outJson]
//   2776.js -> a6_0x3842   0xb8
//   551.js  -> a177_0x5a9d 0x1d0
const fs = require('fs');
const vm = require('vm');
const OUT = (s) => process.stdout.write(s);
const ERR = (s) => process.stderr.write(s);

const file = process.argv[2];
const fnName = process.argv[3];
const base = Number(process.argv[4]);
const outJson = process.argv[5] || null;

const src = fs.readFileSync(file, 'utf8');
const dummy = () => {};
const ctx = {};
ctx.console = { log: dummy, warn: dummy, info: dummy, error: dummy, exception: dummy, table: dummy, trace: dummy, debug: dummy };
ctx.setTimeout = setTimeout; ctx.clearTimeout = clearTimeout;
ctx.self = ctx; ctx.window = ctx; ctx.globalThis = ctx;
ctx.document = { createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }), addEventListener() {}, documentElement: { style: {} } };
ctx.navigator = { userAgent: 'node' };
ctx.localStorage = { getItem: () => null, setItem() {} };
ctx.webpackChunkaicoin = { push: () => 0 };
vm.createContext(ctx);
try { vm.runInContext(src, ctx, { filename: file }); }
catch (e) { ERR('[boot error] ' + (e && e.message) + '\n'); }

const dec = ctx[fnName];
if (typeof dec !== 'function') { ERR('[fatal] decoder ' + fnName + ' not found on the vm global\n'); process.exit(1); }

// resolve until out of range
const out = {};
let i = 0, misses = 0;
const MAX = base + 4000;
const vals = [];
for (let idx = 0; idx < 4000; idx++) {
  let v;
  try { v = dec(idx + base); } catch (e) { v = undefined; }
  if (v === undefined) { misses++; if (misses > 20) break; continue; }
  misses = 0;
  vals.push([idx + base, v]);
}
ERR('[resolved] ' + vals.length + ' entries (base=0x' + base.toString(16) + ')\n');
const text = JSON.stringify(vals, null, 0);
if (outJson) { fs.writeFileSync(outJson, text, 'utf8'); ERR('[written] ' + outJson + '\n'); }
else OUT(text + '\n');
