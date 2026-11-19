const fs = require('fs');
const f = process.argv[2];
const s = fs.readFileSync(f, 'utf8');
const kw = process.argv[3] || 'V4vHZW_toBottom';
let i = s.indexOf(kw);
let n = 0;
while (i !== -1 && n < 40) {
  const a = s.lastIndexOf('}', i) + 1;
  const b = s.indexOf('}', i) + 1;
  console.log('>>>', s.slice(a, b));
  i = s.indexOf(kw, i + 1);
  n++;
}
console.log('total hits:', n);
