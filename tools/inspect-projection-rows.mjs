// 对比 DSH 会话投影（session_projcache）的结构，判断「轮次」是否还在投影里。
// 只读。
import fs from 'node:fs'

const BASE = 'C:/Users/Administrator/.dsh/storages/session_projcache/sessions/'

function describe(id) {
  const p = BASE + id + '.json'
  if (!fs.existsSync(p)) return { id, missing: true }
  const st = fs.statSync(p)
  const j = JSON.parse(fs.readFileSync(p, 'utf8'))
  const rows = j.record?.rows
  const out = { id, bytes: st.size, mtime: st.mtime.toLocaleString('zh-CN', { hour12: false }), rowsType: Array.isArray(rows) ? 'array' : typeof rows, buckets: {} }
  if (rows && typeof rows === 'object' && !Array.isArray(rows)) {
    for (const k of Object.keys(rows)) {
      const v = rows[k]
      if (Array.isArray(v)) {
        const roles = {}
        for (const x of v) {
          if (!x || typeof x !== 'object') { roles['?'] = (roles['?'] ?? 0) + 1; continue }
          const r = x.role ?? x.type ?? x.kind ?? '?'
          roles[r] = (roles[r] ?? 0) + 1
        }
        out.buckets[k] = { len: v.length, roles }
      } else {
        out.buckets[k] = { kind: v && typeof v === 'object' ? 'object:' + Object.keys(v).slice(0, 5).join(',') : typeof v }
      }
    }
  } else if (Array.isArray(rows)) {
    out.buckets.array = { len: rows.length }
  }
  out.identity = j.record?.identity
  return out
}

const targets = [
  'session-37431126-afb9-4c10-b18f-122cfd6b8326',
  'session-37431126-afb9-4c10-bd9d-12cfd6b8326',
  'session-eb5691cd-6da6-4fee-9f68-2736ec65dc9e',
  'session-314f11d2-e87f-4b88-8b30-52a392dbfff0',
  'session-19ecc254-033d-4bd0-892c-54e871a711e2',
  'session-e92c0880-9c9b-4d35-99b1-9717eba39c96'
]

// 先按真实文件名列出所有投影，避免手打错 id
const all = fs.readdirSync(BASE).filter((f) => f.endsWith('.json'))
console.log('投影文件总数:', all.length)
const interesting = all.filter((f) => /eb5691cd|314f11d2|37431126|19ecc254|e92c0880/.test(f))
for (const f of interesting) {
  const r = describe(f.replace(/\.json$/, ''))
  console.log('\n== ' + r.id.slice(0, 26))
  if (r.missing) { console.log('   缺失'); continue }
  console.log('   投影', r.bytes + 'B', 'mtime', r.mtime)
  console.log('   rows:', r.rowsType)
  for (const [k, v] of Object.entries(r.buckets)) {
    console.log('     ' + k.padEnd(22), v.roles ? 'len=' + v.len + '  ' + JSON.stringify(v.roles) : v.kind)
  }
  console.log('   identity:', JSON.stringify(r.identity))
}
