// 自愈面板的审批流接口实测。
//
// 用法：node D:\大肥鱼\auto-repair\tools\test-approval-api.mjs
//
// 做的事：
//   1. 铸一枚 DSH 会话 Cookie
//   2. 依次调 /policy /status /repair-one /repair-all /agent-assist /ignore
//   3. 检查响应结构是否符合预期
//
// ⚠️ 它会**真的改策略文件**（state/repair-policy.json），
//    测完会把策略还原成「逐条审批 + 允许 AI 接手」。
// ⚠️ 它**不会**真的去修东西：测的是「没有这类问题」的路径，
//    真修起来会动 DSH/桥接，那是另一个话题。

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE_CFG = 'D:\\大肥鱼\\qq-bridge\\config.json'
const POLICY_FILE = 'D:\\大肥鱼\\auto-repair\\state\\repair-policy.json'

let pass = 0
let fail = 0
const ok = (m) => { pass++; console.log('  ✅ ' + m) }
const bad = (m) => { fail++; console.log('  ❌ ' + m) }

// ---------- 定位 DSH 端口 + 铸 Cookie ----------
let dshPort = 0
try {
  const cfg = JSON.parse(fs.readFileSync(BRIDGE_CFG, 'utf8'))
  const m = String(cfg?.dsh?.baseUrl || '').match(/:(\d+)/)
  if (m) dshPort = Number(m[1])
} catch {}
if (!dshPort) { console.error('拿不到 DSH 端口'); process.exit(1) }

let cookie = ''
try {
  cookie = execSync(
    `"${process.execPath}" "${path.join(HERE, 'dsh-session.mjs')}" --mint http://127.0.0.1:${dshPort}/`,
    { encoding: 'utf8', windowsHide: true }
  ).trim().split(/\r?\n/).pop()
} catch {}

function req(method, p, body) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const headers = { cookie }
    if (data) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(data.length)
    }
    const r = http.request(
      { host: '127.0.0.1', port: dshPort, path: p, method, headers, timeout: 120000 },
      (res) => {
        let b = ''
        res.on('data', (d) => (b += d))
        res.on('end', () => {
          let j = null
          try { j = JSON.parse(b) } catch {}
          resolve({ code: res.statusCode, body: b, json: j })
        })
      }
    )
    r.on('error', (e) => resolve({ code: 0, body: e.message, json: null }))
    r.on('timeout', () => { r.destroy(); resolve({ code: 0, body: 'TIMEOUT', json: null }) })
    if (data) r.write(data)
    r.end()
  })
}

console.log(`DSH 端口 ${dshPort}，Cookie ${cookie ? '已铸' : '没铸到（接口可能 401）'}\n`)

console.log('[1] GET /policy')
let r = await req('GET', '/dsh-auto-repair/policy')
if (r.code === 200 && r.json?.policy) {
  ok(`策略可读：mode=${r.json.policy.mode} agentAssist=${r.json.policy.agentAssist} rejected=${JSON.stringify(r.json.policy.rejectedCodes)}`)
} else {
  bad(`读策略失败 ${r.code} ${r.body.slice(0, 120)}`)
}

console.log('\n[2] POST /policy —— 切到「全部自动」')
r = await req('POST', '/dsh-auto-repair/policy', { mode: 'approve-all' })
if (r.code === 200 && r.json?.policy?.mode === 'approve-all') ok('已切到 approve-all')
else bad(`切策略失败 ${r.code} ${r.body.slice(0, 120)}`)

console.log('\n[3] 策略落盘校验（守护进程下一轮就读它）')
let disk = null
try { disk = JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8')) } catch {}
if (disk?.mode === 'approve-all') ok('state/repair-policy.json 已是 approve-all')
else bad(`磁盘上的策略是 ${disk?.mode}`)

console.log('\n[4] POST /ignore —— 忽略一个不存在的 code（只验接口通不通）')
r = await req('POST', '/dsh-auto-repair/ignore', { code: 'ZZZ_TEST_CODE', ignored: true })
if (r.code === 200 && r.json?.policy?.rejectedCodes?.includes('ZZZ_TEST_CODE')) ok('忽略已生效')
else bad(`忽略失败 ${r.code} ${r.body.slice(0, 120)}`)

r = await req('POST', '/dsh-auto-repair/ignore', { code: 'ZZZ_TEST_CODE', ignored: false })
if (r.code === 200 && !r.json?.policy?.rejectedCodes?.includes('ZZZ_TEST_CODE')) ok('取消忽略已生效')
else bad(`取消忽略失败 ${r.code} ${r.body.slice(0, 120)}`)

console.log('\n[5] POST /repair-one —— 对一个不存在的 code')
r = await req('POST', '/dsh-auto-repair/repair-one', { code: 'ZZZ_TEST_CODE' })
if (r.code === 200 && r.json?.ok === false && /没有/.test(String(r.json?.error || ''))) {
  ok('返回「当前没有这类问题」，没有乱动')
} else {
  bad(`repair-one 响应异常 ${r.code} ${r.body.slice(0, 160)}`)
}

console.log('\n[6] POST /repair-all —— 当前没有可修项时应给出提示')
r = await req('POST', '/dsh-auto-repair/repair-all', {})
if (r.code === 200 && r.json?.ok === false) ok(`返回明确提示：${r.json.error}`)
else bad(`repair-all 响应异常 ${r.code} ${r.body.slice(0, 160)}`)

console.log('\n[7] POST /agent-assist —— 对一个不存在的 code')
r = await req('POST', '/dsh-auto-repair/agent-assist', { code: 'ZZZ_TEST_CODE' })
if (r.code === 200 && r.json?.ok === false) ok(`返回明确提示：${r.json.error}`)
else bad(`agent-assist 响应异常 ${r.code} ${r.body.slice(0, 160)}`)

console.log('\n[8] GET /status —— 结构完整性')
r = await req('GET', '/dsh-auto-repair/status')
const s = r.json
if (r.code === 200 && s?.ok) {
  ok(`status 200：health=${s.health} 守护=${s.daemon?.alive ? 'alive pid ' + s.daemon.pid : '不在'} 策略=${s.policy?.mode}`)
  ok(`findings ${s.findings?.length ?? 0} 条，policy=${s.policy?.mode}，history ${s.history?.length ?? 0} 条`)
  const need = ['fixable', 'needsHuman', 'rejected', 'autoApproved']
  const badFlags = (s.findings || []).filter((f) => need.some((k) => typeof f[k] !== 'boolean'))
  if (badFlags.length) bad(`有 ${badFlags.length} 条 finding 缺标记`)
  else ok('每条 finding 都带 fixable/needsHuman/rejected/autoApproved 标记')
} else {
  bad(`status 异常 ${r.code} ${r.body.slice(0, 160)}`)
}

console.log('\n[9] 还原策略为「逐条审批 + 允许 AI 接手」')
r = await req('POST', '/dsh-auto-repair/policy', { mode: 'manual', agentAssist: true })
if (r.code === 200 && r.json?.policy?.mode === 'manual' && r.json?.policy?.agentAssist === true) {
  ok('策略已还原为 manual + agentAssist')
} else {
  bad(`还原失败 ${r.code} ${r.body.slice(0, 120)}`)
}

console.log(`\n通过 ${pass} · 失败 ${fail}`)
process.exit(fail ? 1 : 0)
