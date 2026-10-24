// vm-extract.js — boot the bundle's webpack chunk in a VM, then invoke one module
// factory and dump a chosen export as JSON.
// NOTE: these bundles contain a console-patching anti-debug prologue, so the VM gets a
// dummy console and all host logging goes through process.stdout/stderr captured up front.
// usage: node vm-extract.js <file> <moduleId(hex|dec)> [exportKey] [outFile]
const fs = require('fs');
const vm = require('vm');
const util = require('util');

// capture pristine host writers BEFORE the bundle can patch anything
const OUT = (s) => process.stdout.write(s);
const ERR = (s) => process.stderr.write(s);

const file = process.argv[2];
const modArg = process.argv[3];
const exportKey = process.argv[4] && process.argv[4] !== '-' ? process.argv[4] : null;
const outFile = process.argv[5] || null;
const modKey = String(Number(modArg)); // 0xf21f -> "16287"

const src = fs.readFileSync(file, 'utf8');
const captured = {};

const dummy = () => {};
const ctx = {};
ctx.console = { log: dummy, warn: dummy, info: dummy, error: dummy, exception: dummy, table: dummy, trace: dummy, debug: dummy, dir: dummy };
ctx.setTimeout = setTimeout; ctx.clearTimeout = clearTimeout; ctx.setInterval = setInterval;
ctx.self = ctx;
ctx.window = ctx;
ctx.globalThis = ctx;
ctx.document = { createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }), addEventListener() {}, documentElement: { style: {} }, head: { appendChild() {} }, body: { appendChild() {} } };
ctx.navigator = { userAgent: 'node', platform: 'Win32' };
ctx.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
ctx.webpackChunkaicoin = {
  _c: captured,
  push(arg) {
    const mods = arg[1] || {};
    for (const k of Object.keys(mods)) captured[k] = mods[k];
    return 0;
  },
};
vm.createContext(ctx);
try {
  vm.runInContext(src, ctx, { filename: file });
} catch (e) {
  ERR('[boot error] ' + (e && e.message) + '\n');
  ERR(((e && e.stack) || '').split('\n').slice(0, 8).join('\n') + '\n');
}

ERR('[captured modules] count=' + Object.keys(captured).length + '\n');
const factory = captured[modKey];
if (!factory) { ERR('[fatal] module key ' + modKey + ' not captured; have: ' + Object.keys(captured).join(',') + '\n'); process.exit(1); }

// ---- webpack require stub ----
function makeStub(name) {
  const f = function () { return makeStub(name + '()'); };
  return new Proxy(f, {
    get(t, p) {
      if (p === 'then') return undefined;
      if (typeof p === 'symbol') return undefined;
      if (p === 'toString' || p === 'valueOf') return () => '[stub ' + name + ']';
      if (p === 'inspect' || p === util.inspect.custom) return () => '[stub ' + name + ']';
      return makeStub(name + '.' + String(p));
    },
    apply() { return makeStub(name + '()'); },
    construct() { return makeStub('new ' + name); },
  });
}
const req = function (id) { return makeStub('req(' + id + ')'); };
// Faithful port of the bundle's own __webpack_require__.d, whose array form is
// [name, mode, value?] with mode===0 meaning "plain value" and mode being the getter otherwise.
// Evidence: renderer/main.js @1396506 (minified `_0x1004b5['d']=...`).
req.d = function (exports, definition) {
  if (Array.isArray(definition)) {
    let i = 0;
    while (i < definition.length) {
      const name = definition[i++];
      const mode = definition[i++];
      if (!Object.prototype.hasOwnProperty.call(exports, name)) {
        if (mode === 0) Object.defineProperty(exports, name, { enumerable: true, value: definition[i++] });
        else Object.defineProperty(exports, name, { enumerable: true, get: mode });
      } else if (mode === 0) i++;
    }
  } else {
    for (const key in definition) {
      if (Object.prototype.hasOwnProperty.call(definition, key) && !Object.prototype.hasOwnProperty.call(exports, key)) {
        Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
      }
    }
  }
};
req.o = (o, p) => Object.prototype.hasOwnProperty.call(o, p);
req.r = (exports) => { if (typeof exports === 'object' && exports) Object.defineProperty(exports, Symbol.toStringTag || '__esModule', { value: 'Module' }); };
req.n = (m) => m;
req.p = '';

const moduleObj = { id: modKey, exports: {}, loaded: false, children: [] };
moduleObj.r = req.r;
try {
  factory.call(moduleObj.exports, moduleObj, moduleObj.exports, req);
} catch (e) {
  ERR('[factory error] ' + (e && e.message) + '\n');
  ERR(((e && e.stack) || '').split('\n').slice(0, 14).join('\n') + '\n');
}
const out = moduleObj.exports;

// cross-realm safe: the module runs inside a vm context, so `instanceof RegExp` fails.
const isRe = (v) => Object.prototype.toString.call(v) === '[object RegExp]';
const replacer = (k, v) => (isRe(v) ? { __regex: v.source, __flags: v.flags } : v);

if (exportKey) {
  const val = out[exportKey];
  ERR('[export] ' + exportKey + ' typeof=' + typeof val + '\n');
  let text;
  try { text = JSON.stringify(val, replacer, 2); }
  catch (e) { text = null; }
  if (!text) text = util.inspect(val, { depth: 14, maxArrayLength: 1000, breakLength: 140, maxStringLength: 20000 });
  if (outFile) { fs.writeFileSync(outFile, text, 'utf8'); ERR('[written] ' + outFile + ' bytes=' + text.length + '\n'); }
  else OUT(text + '\n');
} else {
  ERR('[exports keys] ' + Object.keys(out).join(',') + '\n');
  let text;
  try { text = JSON.stringify(out, replacer, 2); } catch (e) { text = util.inspect(out, { depth: 4 }); }
  if (outFile) { fs.writeFileSync(outFile, text, 'utf8'); ERR('[written] ' + outFile + '\n'); }
  else OUT(text + '\n');
}
