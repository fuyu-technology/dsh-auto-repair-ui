// 审批流的端到端实测：造一个**真的**故障，看三种策略下的行为对不对。
//
// ⚠️ 造的是「潜伏 BOM」：在 DSH profile 目录里放一个带 BOM 的
//    **自建**探测文件（不是 DSH 会读的任何配置），它会被诊断成 LATENT_BOM。
//    测完删掉，DSH 不受影响。
//
// 验的是：
//   manual       → 守护进程只报告，**不**动手（文件里 BOM 还在）
//   手动点修复   → --repair 把 BOM 剥了
//   reject-all   → 手动点修复也被拒绝

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ENTRY = 'D:\\大肥鱼\\auto-repair\\auto-repair.mjs'
const PROFILE = path.join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'desktop')
const PROBE = path.join(PROFILE, 'ar-approval-probe.json')
const NODE = process.execPath

let pass = 0
let fail = 0
const ok = (m) => { pass++; console.log('  ✅ ' + m) }
const bad = (m) => { fail++; console.log('  ❌ ' + m) }

function run(args) {
  try {
    const out = execFileSync(NODE, [ENTRY, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000 })
    return { out, json: (() => { try { return JSON.parse(out.trim()) } catch { return null } })() }
  } catch (e) {
    return { out: String(e.stdout || ''), json: null }
  }
}
const setMode = (mode) => run(['--set-policy', JSON.stringify({ mode })])
const hasBom = () => {
  if (!fs.existsSync(PROBE)) return false
  const b = fs.readFileSync(PROBE)
  return b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf
}
const makeProbe = () => fs.writeFileSync(PROBE, Buffer.concat([
  Buffer.from([0xef, 0xbb, 0xbf]),
  Buffer.from(JSON.stringify({ probe: 'approval-test', note: '临时文件，测完会删' }, null, 2), 'utf8')
]))

function cleanup() {
  try { fs.unlinkSync(PROBE) } catch {}
}

console.log('=== 审批流端到端实测 ===\n')
cleanup()

try {
  // ① 造故障
  makeProbe()
  console.log('[1] 造一个潜伏 BOM 故障')
  if (hasBom()) ok('探测文件已带 BOM')
  else bad('探测文件没带上 BOM')

  let r = run(['--check'])
  const found = (r.json || []).some((f) => f.code === 'LATENT_BOM')
  found ? ok('诊断出 LATENT_BOM') : bad('诊断没认出 LATENT_BOM')

  // ② 逐条审批：守护进程不该动手
  console.log('\n[2] 策略=manual，跑一轮 --once')
  setMode('manual')
  r = run(['--once'])
  if (hasBom()) ok('BOM 还在 —— 守护进程没有自动动手 ✅')
  else bad('守护进程在 manual 模式下竟然动手了！')

  // ③ reject-all：连手动点修复也该被拒
  console.log('\n[3] 策略=reject-all，试着手动修这一条')
  setMode('reject-all')
  r = run(['--repair', 'LATENT_BOM'])
  if (r.json?.ok === false && /全拒绝/.test(String(r.json.error || ''))) {
    ok('被正确拒绝：' + r.json.error)
  } else {
    bad(`reject-all 下居然修了：${JSON.stringify(r.json).slice(0, 160)}`)
  }
  if (hasBom()) ok('BOM 还在（确实没动）')
  else bad('文件被动过了')

  // ④ 逐条审批下手动点「修复」＝ --repair
  console.log('\n[4] 策略=manual，手动点「修复」（--repair）')
  setMode('manual')
  r = run(['--repair', 'LATENT_BOM'])
  if (r.json?.ok === true) ok(`修复成功：${r.json.results?.[0]?.action || ''}`)
  else bad(`手动修复失败：${JSON.stringify(r.json).slice(0, 200)}`)
  if (!hasBom()) ok('BOM 已剥掉 ✅')
  else bad('BOM 还在')

  // ⑤ 全自动：守护进程自己就该动手
  console.log('\n[5] 策略=approve-all，造故障后跑一轮 --once')
  setMode('approve-all')
  makeProbe()
  r = run(['--once'])
  if (!hasBom()) ok('守护进程自动把 BOM 剥了 ✅')
  else bad('approve-all 下守护进程没动手')

  // ⑥ 还原
  console.log('\n[6] 还原策略')
  setMode('manual')
  r = run(['--get-policy'])
  r.json?.policy?.mode === 'manual' ? ok('策略已还原为 manual') : bad('还原失败')
} finally {
  cleanup()
  setMode('manual')
  console.log('\n（探测文件已删除，策略已还原）')
}

console.log(`\n通过 ${pass} · 失败 ${fail}`)
process.exit(fail ? 1 : 0)
