// deob.js — print a region of a minified bundle with `_0x…(0xNNN)` string-table calls
// resolved inline as «"literal"». Comments out nothing; purely additive annotation.
// usage: node deob.js <file> <strtable.json> <needle> [before] [after] [occ]
const fs = require('fs');
const file = process.argv[2];
const stFile = process.argv[3];
const needle = process.argv[4];
const before = Number(process.argv[5] || 1200);
const after = Number(process.argv[6] || 3000);
const occ = Number(process.argv[7] || 0);

const table = JSON.parse(fs.readFileSync(stFile, 'utf8')); // [[idx, value], ...]
const byIndex = new Map(table.map(([i, v]) => [String(i), v]));
const s = fs.readFileSync(file, 'utf8');
const at = s.indexOf(needle);
if (at < 0) { console.error('needle not found'); process.exit(1); }
const a = Math.max(0, at - before);
const b = Math.min(s.length, at + needle.length + after);
const slice = s.slice(a, b);
// 0xb8 base is implicit in the table index; calls look like _0xabcdef(0xNN)
const out = slice.replace(/(_0x[0-9a-fA-F]+)\(0x([0-9a-fA-F]+)\)/g, (m, fn, hex) => {
  const idx = parseInt(hex, 16);
  if (byIndex.has(String(idx))) {
    const v = byIndex.get(String(idx));
    return `${fn}(0x${hex})«${JSON.stringify(v)}»`;
  }
  return m;
});
process.stdout.write(out);
