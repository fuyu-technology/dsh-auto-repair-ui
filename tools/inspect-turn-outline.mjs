// 读取会话投影里的「轮次大纲 / 会话统计 / 标题」等字段，
// 对比大肥鱼相关会话与普通会话，找出界面上「轮次没了」的原因。
// 只读。
import fs from 'node:fs'

const BASE = 'C:/Users/Administrator/.dsh/storages/session_projcache/sessions/'
const files = fs.readdirSync(BASE).filter((f) => f.endsWith('.json'))

const pick = (rows, key) => {
  const r = rows?.[key]
  if (!r) return undefined
  return r.val ?? r
}

for (const f of files) {
  const j = JSON.parse(fs.readFileSync(BASE + f, 'utf8'))
  const rows = j.record?.rows ?? {}
  const id = f.replace(/\.json$/, '')
  const title = pick(rows, 'title')
  const outline = pick(rows, 'turnOutline')
  const stats = pick(rows, 'sessionStats')
  const slm = pick(rows, 'sessionListMetadata')
  const cwd = j.record?.identity?.cwd ?? ''
  const isSlang = /slang-agent/i.test(cwd)
  const outlineLen = Array.isArray(outline) ? outline.length : (outline && typeof outline === 'object' ? Object.keys(outline).length : -1)
  console.log(
    `${id.slice(8, 16)} ${isSlang ? '[大肥鱼工作区]' : '            '} cwd=${cwd.slice(-22).padEnd(22)} outline=${String(outlineLen).padStart(3)} title=${JSON.stringify(title ?? null).slice(0, 46).padEnd(48)} stats=${JSON.stringify(stats ?? null).slice(0, 70)}`
  )
  if (isSlang) {
    console.log('        outline 原始:', JSON.stringify(outline).slice(0, 400))
    console.log('        slm 原始   :', JSON.stringify(slm).slice(0, 400))
  }
}
