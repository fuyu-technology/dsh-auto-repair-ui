// 按会话审计：agentPreset + 实际调用过的工具。
// 用途：确认 QQ preset 的会话有没有真的执行过本地工具（守卫是否守住）。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const ROOT = 'C:\\Users\\Administrator\\.dsh\\sessions'
const LOCAL = new Set(['pwsh', 'read', 'write', 'edit', 'grep', 'glob', 'bash', 'read_image', 'web_fetch', 'web_search', 'subagent', 'skill', 'send_message', 'schedule_create'])

const rows = []
for (const ws of fs.readdirSync(ROOT)) {
  const wsd = path.join(ROOT, ws)
  let entries; try { entries = fs.readdirSync(wsd) } catch { continue }
  for (const s of entries) {
    if (!s.startsWith('session-')) continue
    const file = path.join(wsd, s, 'session.v4.jsonl.zstd')
    if (!fs.existsSync(file)) continue
    let text
    try { text = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8') } catch { continue }
    let preset = null
    const called = new Map()
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let ev; try { ev = JSON.parse(line) } catch { continue }
      if (ev.type === 'session' && ev.agentPreset) preset = ev.agentPreset
      if (ev.type === 'tool/call') {
        const name = ev.data?.name ?? ev.data?.tool?.name
        if (name) called.set(name, (called.get(name) ?? 0) + 1)
      }
    }
    if (called.size || preset) {
      rows.push({ id: s, preset, called })
    }
  }
}

const qq = rows.filter((r) => (r.preset ?? '').startsWith('qq-'))
console.log(`会话总数 ${rows.length}，其中 qq-* preset 的 ${qq.length} 个\n`)
for (const r of qq.sort((a, b) => b.called.size - a.called.size)) {
  const local = [...r.called.keys()].filter((n) => LOCAL.has(n))
  console.log(`${r.id}  preset=${r.preset}  调过 ${r.called.size} 个工具`)
  console.log(`   本地/开发类工具调用：${local.length ? local.map((n) => `${n}×${r.called.get(n)}`).join(', ') : '无 ✓'}`)
  const mcp = [...r.called.keys()].filter((n) => n.startsWith('mcp__'))
  console.log(`   MCP 工具调用：${mcp.length ? `${mcp.length} 个（${[...mcp].slice(0, 6).join(', ')}${mcp.length > 6 ? ' …' : ''}）` : '无'}`)
  console.log('')
}

const nonQqLocal = rows.filter((r) => !(r.preset ?? '').startsWith('qq-'))
  .filter((r) => [...r.called.keys()].some((n) => LOCAL.has(n)))
console.log(`非 QQ preset 的会话里有本地工具调用：${nonQqLocal.length} 个（正常，那是开发用的会话）`)
