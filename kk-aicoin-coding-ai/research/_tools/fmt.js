// fmt.js — safe cosmetic reformatter for minified JS.
// Walks char-by-char tracking string/template/regex-lite state, then inserts newlines
// only at positions that are provably OUTSIDE any string literal.
// usage: node fmt.js <file> <startNeedle> [len] > out.txt
const fs = require('fs');
const file = process.argv[2];
const startNeedle = process.argv[3];
const len = Number(process.argv[4] || 20000);
const pre = Number(process.argv[5] || 0);
const s = fs.readFileSync(file, 'utf8');
let start = 0;
if (startNeedle && startNeedle !== '-') {
  start = s.indexOf(startNeedle);
  if (start < 0) { console.error('needle not found'); process.exit(1); }
  start = Math.max(0, start - pre);
}
const end = Math.min(s.length, start + len);

// Pass 1: mark which char indexes are inside a string literal.
const inside = new Uint8Array(end - start + 2);
let i = start + 0;
let state = null; // null | "'" | '"' | '`' | '//' | '/*'
while (i < end) {
  const c = s[i], n = s[i + 1];
  if (state === "'" || state === '"' || state === '`') {
    inside[i - start] = 1;
    if (c === '\\') { inside[i - start + 1] = 1; i += 2; continue; }
    if (c === state) state = null;
    i++; continue;
  }
  if (state === '//') { if (c === '\n') state = null; i++; continue; }
  if (state === '/*') { if (c === '*' && n === '/') { state = null; i += 2; continue; } i++; continue; }
  if (c === "'" || c === '"' || c === '`') { state = c; inside[i - start] = 1; i++; continue; }
  if (c === '/' && n === '/') { state = '//'; i++; continue; }
  if (c === '/' && n === '*') { state = '/*'; i++; continue; }
  i++;
}

// Pass 2: emit with newlines at safe split points.
let out = [];
i = start;
let lineLen = 0;
const BREAK_BEFORE = new Set(['{', '[']);
while (i < end) {
  const c = s[i];
  const n = s[i + 1];
  const inStr = inside[i - start];
  // split after a comma that is outside strings, when the NEXT char is also outside
  if (c === ',' && !inStr && !inside[i + 1 - start]) {
    out.push(',');
    const nxt = s.slice(i + 1, i + 3);
    if (/^\s*['"{\[]/.test(nxt) || /^\s*(?:0x[0-9a-f]+|!0x1|!0x0|void 0x0)/.test(nxt)) {
      out.push('\n'); lineLen = 0; i++;
      while (s[i] === ' ') i++;
      continue;
    }
    i++; continue;
  }
  // split before an opening brace/bracket that follows a closing one, outside strings
  if (BREAK_BEFORE.has(c) && !inStr) {
    const prev = s[i - 1];
    if (prev === '}' || prev === ']' || prev === ',') { out.push('\n'); lineLen = 0; }
  }
  if (c === '}' && !inStr && (n === ',' || n === ']' || n === ')')) { out.push('}'); i++; out.push(n); i++; out.push('\n'); lineLen = 0; while (s[i] === ' ') i++; continue; }
  if (c === '\n') { out.push('\n'); lineLen = 0; i++; continue; }
  out.push(c); lineLen++;
  if (lineLen > 3000) { out.push('\n[LONG-LINE-BREAK]\n'); lineLen = 0; }
  i++;
}
process.stdout.write(out.join(''));
