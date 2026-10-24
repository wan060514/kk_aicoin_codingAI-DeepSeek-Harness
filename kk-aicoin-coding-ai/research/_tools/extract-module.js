// extract-module.js — webpack module extractor for these bundles.
// usage: node extract-module.js <file> <moduleIdLiteral>   e.g. 0xf21f
const fs = require('fs');
const file = process.argv[2];
const id = process.argv[3];
if (!file || !id) { console.error('usage: node extract-module.js <file> <moduleIdLiteral>'); process.exit(2); }
const s = fs.readFileSync(file, 'utf8');
const probes = [`${id}(`, `${id}:`, `"${id}"`, `'${id}'`, `[${id}]`, `(${id},`];
for (const p of probes) {
  let i = -1, c = 0;
  while ((i = s.indexOf(p, i + 1)) !== -1) { c++; if (c <= 5) console.log(`[${p}] @${i}`); }
  if (c) console.log(`[${p}] total=${c}`);
}
