// pretty.js — split a minified snippet into readable lines at safe punctuation
const fs = require('fs');
let s = fs.readFileSync(process.argv[2], 'utf8');
s = s.replace(/case'/g, "\ncase '");
s = s.replace(/return\{'method'/g, "\n  return {'method'");
s = s.replace(/'pathname'/g, "'pathname'");
s = s.replace(/\},\{/g, "},\n{");
s = s.replace(/;case/g, ";\ncase");
s = s.replace(/\}\}/g, "}\n}");
s = s.replace(/\},\s*'/g, "},\n'");
process.stdout.write(s);
