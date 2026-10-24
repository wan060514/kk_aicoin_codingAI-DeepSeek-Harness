// offsets.js — report byte offsets of key needles in the two bundle copies.
const fs = require('fs');
const files = { '2776.js': process.argv[2], '551.js': process.argv[3] };
const needles = [
  '0xf21f(',
  '_0x3a0eb4=[',
  '_0x565288=[',
  '_0xa5a8b2=[',
  '_0x5e6959=',
  '_0x2014c9=',
  "'tokenizer':",
  "'bracketCounting':",
  "'ace-dark'",
  "'ace-light'",
  'aicoin://monaco',
  'setMonarchTokensProvider',
  'setLanguageConfiguration',
  'registerLanguage',
  'defineTheme',
];
for (const [n, f] of Object.entries(files)) {
  const s = fs.readFileSync(f, 'utf8');
  console.log('===== ' + n + ' (len ' + s.length + ') =====');
  for (const q of needles) {
    const i = s.indexOf(q);
    console.log('  ' + (i < 0 ? 'NOT FOUND' : '@' + i).padEnd(12) + ' ' + JSON.stringify(q));
  }
}
