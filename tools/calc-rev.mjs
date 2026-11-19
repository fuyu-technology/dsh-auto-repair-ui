// 计算 DSH 插件 client bundle 的 rev（与 client-modules 的 artifactRevision 一致）
// 用法: node calc-rev.mjs <client.js 路径>
import fs from 'node:fs'
import { createHash } from 'node:crypto'

function framedHash(domain, parts) {
  const hash = createHash('sha1').update(domain).update('\0')
  for (const part of parts) hash.update(`${String(Buffer.byteLength(part))}:${part}`)
  return hash.digest('hex').slice(0, 12)
}
function artifactRevision(baseline) {
  return framedHash('plugin-artifact', [
    String(baseline.mtimeMs),
    String(baseline.ctimeMs),
    String(baseline.size)
  ])
}

const file = process.argv[2]
const st = fs.statSync(file)
const baseline = { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size }
const rev = artifactRevision(baseline)
console.log(JSON.stringify({ file, baseline, rev }, null, 2))
