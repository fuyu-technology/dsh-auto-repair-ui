import fs from 'node:fs'

const P = 'C:\\Users\\Administrator\\.dsh\\plugins\\dsh-cyber-red-ui\\client.js'
const src = fs.readFileSync(P, 'utf8')

const ts = new Date().toISOString().replace(/[:.]/g, '-')
const bak = `${P}.bak-${ts}`
fs.writeFileSync(bak, src, 'utf8')
console.log('backup ->', bak)

const CODE_FROM = '  [data-cr-convo] :not(pre) > code {\n' +
  '        border-color: rgba(139, 0, 0, 0.22) !important;\n' +
  '        background-color: rgba(255, 255, 255, 0.06) !important;\n' +
  '        color: #ffe0e4 !important;\n' +
  '      }'

const CODE_TO = '  [data-cr-convo] :not(pre) > code {\n' +
  '        border-color: #6d1219 !important;\n' +
  '        background-color: #1c0709 !important;\n' +
  '        color: #ffe0e4 !important;\n' +
  '        box-shadow: none !important;\n' +
  '        animation: none !important;\n' +
  '        transition: none !important;\n' +
  '        text-shadow: none !important;\n' +
  '      }'

const BUBBLE_FROM = '        border-color: rgba(139, 0, 0, 0.22) !important;\n' +
  '        background-color: rgba(255, 255, 255, 0.04) !important;\n' +
  '        box-shadow: 0 0 10px rgba(139, 0, 0, 0.14),'

const BUBBLE_TO = '        border-color: rgba(139, 0, 0, 0.55) !important;\n' +
  '        background-color: rgba(24, 6, 8, 0.93) !important;\n' +
  '        box-shadow: 0 0 10px rgba(139, 0, 0, 0.14),'

let cur = src
for (const [from, to, label] of [[CODE_FROM, CODE_TO, 'inline-code chip'], [BUBBLE_FROM, BUBBLE_TO, 'bubble/card']]) {
  const n = cur.split(from).length - 1
  if (n !== 1) { console.error(`!! ${label} 匹配数=${n}，中止`); process.exit(1) }
  cur = cur.replace(from, to)
  console.log(`patched: ${label}`)
}

fs.writeFileSync(P, cur, 'utf8')
console.log('written. size', cur.length, 'was', src.length)
