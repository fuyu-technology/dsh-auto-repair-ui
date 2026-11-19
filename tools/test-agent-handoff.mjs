// 「让 AI 修」的连通性实测：真建一个 DSH 会话、真投一条 prompt、真收回复。
//
// ⚠️ 这次**会消耗 token**（agent 要跑一次模型）。
//    但投的是一条无害的假故障 + 一句「别改任何文件」的备注，
//    目的只是验证 API 形状对不对：
//      workspace.create → sessions.create → events.follow → sessions.prompt → turn/end
//
// 用法：node D:\大肥鱼\auto-repair\tools\test-agent-handoff.mjs

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HERE = path.dirname(path.resolve(process.argv[1] || '.'))
const ROOT = 'D:\\大肥鱼'
const mod = await import(pathToFileURL(path.join(ROOT, 'auto-repair', 'agent-repair.mjs')).href)

const finding = {
  severity: 'warn',
  code: 'TEST_PROBE_NO_SUCH_ISSUE',
  title: '【连通性测试】这是一条假故障',
  detail: '这条故障是测试用的，系统里并不存在。它存在的唯一目的是验证「交给 AI 修」这条链路能不能通。',
  evidence: { probe: true },
  at: Date.now()
}

console.log('=== 让 AI 修 · 连通性实测 ===\n')
console.log('投一条假故障给 DSH agent，等它回话…\n')

const t0 = Date.now()
try {
  const r = await mod.handoffToAgent([finding], {
    waitMs: Number(process.env.AGENT_REPAIR_WAIT_MS || 150000),
    note: '这是**连通性测试**：故障是假的，请只回复一句「收到」并说明你判断这不需要动手，不要修改任何文件。'
  })
  console.log('✅ 会话建立成功')
  console.log('   sessionId :', r.sessionId)
  console.log('   workspace :', r.workspaceId)
  console.log('   baseUrl   :', r.baseUrl)
  console.log('   用时      :', Math.round((Date.now() - t0) / 1000), '秒')
  console.log('   agent 回复:', r.reply ? r.reply.slice(0, 400).replace(/\s+/g, ' ') : '(没收到回复)')
  console.log('\n交接记录已写入 state/agent-handoff.json：')
  const h = mod.readHandoffs()
  console.log('  ', JSON.stringify(h[finding.code] || {}, null, 2).slice(0, 500))
} catch (e) {
  console.log('❌ 交接失败：', e?.message || e)
  console.log(e?.stack?.split('\n').slice(0, 6).join('\n') || '')
  process.exit(1)
}
