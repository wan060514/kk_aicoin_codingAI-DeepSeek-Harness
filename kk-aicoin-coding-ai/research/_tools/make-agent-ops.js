// make-agent-ops.js — regenerate research/_tools/agent_ops_pretty.txt as clean UTF-8.
// Reads main/main.js through deob.js and pretty-prints the aiscript-agent operation switch.
const fs = require('fs');
const cp = require('child_process');
const T = __dirname;
const MAIN = process.argv[2];
const OUT = process.argv[3];

const raw = cp.execFileSync(
  process.execPath,
  [T + '\\deob.js', MAIN, T + '\\st_main.json', "case'listConversations'", '200', '11000', '0'],
  { maxBuffer: 1 << 28 }
).toString('utf8');

const s = raw
  .replace(/case'/g, "\ncase '")
  .replace(/\}default:/g, "}\ndefault:")
  .replace(/return\{'method'/g, "\n  return {'method'");

fs.writeFileSync(OUT, s, 'utf8');
const cases = [...s.matchAll(/case '([A-Za-z]+)'/g)].map((m) => m[1]);
console.log('bytes =', fs.statSync(OUT).size);
console.log('cases found:', cases.join(', '));
