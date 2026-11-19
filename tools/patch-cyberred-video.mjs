import fs from 'node:fs'

const P = 'C:\\Users\\Administrator\\.dsh\\plugins\\dsh-cyber-red-ui\\client.js'
const src = fs.readFileSync(P, 'utf8')

const ts = new Date().toISOString().replace(/[:.]/g, '-')
fs.writeFileSync(`${P}.bak-${ts}`, src, 'utf8')
console.log('backup ->', `${P}.bak-${ts}`)

const patches = [
  {
    label: 'error handler: 摘掉 data-cr-chat-video-bg 会让整块背景在视频/静态图之间来回跳',
    from: "              failedSource = source;\n              document.documentElement.removeAttribute('data-cr-chat-video-bg');\n              video.pause();",
    to: "              failedSource = source;\n              video.pause();"
  },
  {
    label: 'sync(): 同一个源连续失败时同样不要摘属性，否则每 5 秒整块背景闪一次',
    from: "            if (failedSource && failedSource === nextSource) {\n              document.documentElement.removeAttribute('data-cr-chat-video-bg');\n              video.pause();",
    to: "            if (failedSource && failedSource === nextSource) {\n              video.pause();"
  }
]

let cur = src
for (const p of patches) {
  const n = cur.split(p.from).length - 1
  if (n !== 1) { console.error(`!! ${p.label} 匹配数=${n}，中止`); process.exit(1) }
  cur = cur.replace(p.from, p.to)
  console.log(`patched: ${p.label}`)
}

fs.writeFileSync(P, cur, 'utf8')
console.log('written, size', cur.length)
