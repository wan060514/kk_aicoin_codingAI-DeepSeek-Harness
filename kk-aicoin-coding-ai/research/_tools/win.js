// win.js — locate a substring in a minified bundle and print a window.
// usage: node win.js <file> <needle> [before=1200] [after=2500] [occ=0] [--all]
const fs = require('fs');
const [file, needle] = process.argv.slice(2);
const before = Number(process.argv[4] || 1200);
const after = Number(process.argv[5] || 2500);
const occ = Number(process.argv[6] || 0);
const all = process.argv.includes('--all');
if (!file || !needle) { console.error('usage: node win.js <file> <needle> [before] [after] [occ] [--all]'); process.exit(2); }
const s = fs.readFileSync(file, 'utf8');
let idxs = [];
let i = -1;
while ((i = s.indexOf(needle, i + 1)) !== -1) idxs.push(i);
console.log(`[file] ${file}  len=${s.length}`);
console.log(`[needle] ${JSON.stringify(needle)}  occurrences=${idxs.length}`);
if (!idxs.length) process.exit(0);
const list = all ? idxs : [idxs[Math.min(occ, idxs.length - 1)]];
for (const at of list) {
  const a = Math.max(0, at - before);
  const b = Math.min(s.length, at + needle.length + after);
  console.log(`\n===== @${at}  (window ${a}..${b}) =====`);
  console.log(s.slice(a, b));
}
