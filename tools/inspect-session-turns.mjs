// 解开 ~/.dsh/sessions/<工作区>/session-<uuid>/session.v4.jsonl.zstd，统计每个会话的轮次。
// 只读，不修改任何数据。
import fs from 'node:fs'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ROOT = 'C:\\Users\\Administrator\\.dsh\\sessions'

function listSessions() {
  const out = []
  for (const ws of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue
    const wsDir = path.join(ROOT, ws.name)
    for (const sd of fs.readdirSync(wsDir, { withFileTypes: true })) {
      if (!sd.isDirectory()) continue
      const sDir = path.join(wsDir, sd.name)
      for (const f of fs.readdirSync(sDir)) {
        if (!f.endsWith('.zstd')) continue
        out.push({ ws: ws.name, sid: sd.name, file: f, full: path.join(sDir, f) })
      }
    }
  }
  return out
}

function stats(file) {
  const raw = zstdDecompressSync(fs.readFileSync(file))
  const lines = raw.toString('utf8').split('\n').filter((l) => l.trim().length)
  const types = new Map()
  let user = 0, assistant = 0, tool = 0, first = null, last = null, maxSeq = -1
  let lastUserText = ''
  const seqs = []
  for (const l of lines) {
    let o
    try { o = JSON.parse(l) } catch { continue }
    const t = o.type ?? o.event ?? '?'
    types.set(t, (types.get(t) ?? 0) + 1)
    const ts = o.ts ?? o.timestamp ?? o.data?.ts
    if (typeof ts === 'number') { if (!first || ts < first) first = ts; if (!last || ts > last) last = ts }
    if (typeof o.seq === 'number') { seqs.push(o.seq); if (o.seq > maxSeq) maxSeq = o.seq }
    const d = o.data ?? {}
    const role = d.role ?? o.role
    if (role === 'user') {
      user++
      const c = d.content ?? d.text ?? ''
      const s = typeof c === 'string' ? c : JSON.stringify(c)
      if (s) lastUserText = s.slice(0, 90)
    }
    if (role === 'assistant') assistant++
    if (t === 'tool-call' || t === 'toolCall' || d.toolName) tool++
  }
  seqs.sort((a, b) => a - b)
  const gaps = []
  for (let i = 1; i < seqs.length; i++) if (seqs[i] - seqs[i - 1] > 1) gaps.push(`${seqs[i - 1]}→${seqs[i]}`)
  return { lines: lines.length, types, user, assistant, tool, first, last, maxSeq, gaps: gaps.slice(0, 5), lastUserText }
}

const fmt = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '-')
const rows = []
for (const s of listSessions()) {
  try {
    rows.push({ ws: s.ws, sid: s.sid, file: s.file, bytes: fs.statSync(s.full).size, mtime: fs.statSync(s.full).mtimeMs, ...stats(s.full) })
  } catch (e) {
    rows.push({ ws: s.ws, sid: s.sid, err: String(e.message).slice(0, 70) })
  }
}

console.log('工作区目录:')
for (const ws of new Set(rows.map((r) => r.ws))) console.log('  ' + ws)
console.log('')
console.log('工作区 | session | 字节 | 行数 | 用户轮 | 助手轮 | 工具 | 最后时间 | seq断点')
for (const r of rows.sort((a, b) => (a.ws + a.sid).localeCompare(b.ws + b.sid))) {
  if (r.err) { console.log(`  ${r.ws.slice(0, 24).padEnd(24)} | ${r.sid.slice(8, 16)} | ERR ${r.err}`); continue }
  console.log(
    `  ${r.ws.slice(0, 24).padEnd(24)} | ${r.sid.slice(8, 16)} | ${String(r.bytes).padStart(7)} | ${String(r.lines).padStart(4)} | ${String(r.user).padStart(4)} | ${String(r.assistant).padStart(4)} | ${String(r.tool).padStart(4)} | ${fmt(r.last)} | ${r.gaps.join(',') || '-'}`
  )
}
console.log('')
console.log('各会话类型分布:')
for (const r of rows.filter((x) => !x.err)) {
  console.log(`  ${r.ws.slice(0, 22).padEnd(22)} ${r.sid.slice(8, 16)}  ${[...r.types.entries()].map(([k, v]) => `${k}=${v}`).join('  ')}`)
}
console.log('')
console.log('最后一条用户输入（按最后时间倒序）:')
for (const r of rows.filter((x) => !x.err).sort((a, b) => (b.last ?? 0) - (a.last ?? 0)).slice(0, 12)) {
  console.log(`  ${fmt(r.last)}  ${r.ws.slice(0, 20).padEnd(20)} ${r.sid.slice(8, 16)}  ${JSON.stringify(r.lastUserText.slice(0, 70))}`)
}
