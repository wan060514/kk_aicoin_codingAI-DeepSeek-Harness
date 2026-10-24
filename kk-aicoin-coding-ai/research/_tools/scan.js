// scan.js — regex scan a file, print matches with line-ish offsets and small context.
// usage: node scan.js <file> <regex> [flags] [ctxBefore] [ctxAfter] [max]
const fs = require('fs');
const file = process.argv[2];
const pat = process.argv[3];
const flags = process.argv[4] || 'g';
const cb = Number(process.argv[5] || 60);
const ca = Number(process.argv[6] || 200);
const max = Number(process.argv[7] || 200);
if (!file || !pat) { console.error('usage: node scan.js <file> <regex> [flags] [ctxBefore] [ctxAfter] [max]'); process.exit(2); }
const s = fs.readFileSync(file, 'utf8');
const re = new RegExp(pat, flags.includes('g') ? flags : flags + 'g');
let m, n = 0;
console.log(`[file] ${file} len=${s.length}  [regex] /${pat}/${flags}`);
while ((m = re.exec(s)) !== null) {
  n++;
  const a = Math.max(0, m.index - cb);
  const b = Math.min(s.length, m.index + m[0].length + ca);
  console.log(`--- #${n} @${m.index} len=${m[0].length}`);
  console.log(s.slice(a, b).replace(/\n/g, '\\n'));
  if (n >= max) { console.log(`[stop] reached max=${max}`); break; }
  if (m[0] === '') re.lastIndex++;
}
console.log(`[total shown] ${n}`);
