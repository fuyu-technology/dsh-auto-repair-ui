// 重启守护进程（watchdog / port-guard / supervisor），让它们加载新的端口探测实现；
// 并清理重复的 SnowLuma 网关实例（多实例会抢 3000/3001/5099 与 QQ 注入）。
//
// 背景：本机 netstat -ano 看不到 state=0 的那批 socket（3000/3001/3100/3200/5099/5199），
// 守护进程据此误判「服务没起来」→ 反复拉起 → EADDRINUSE 崩溃循环。
// 修完端口探测后必须重启这些常驻进程才生效。
//
// 用法：node restart-guardians.mjs

import fs from 'node:fs'
import path from 'node:path'
import { spawn, execSync } from 'node:child_process'
import { listeningPortsSync, pidsByCommandLine, commandLineOf } from './net-listeners.mjs'

const ROOT = 'D:\\大肥鱼'
const STATE = path.join(ROOT, 'state')
const NODE = 'D:\\大肥鱼\\SnowLuma\\node.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const kill = (pid) => {
  try { execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore', windowsHide: true }); return true }
  catch { return false }
}

function startDetached(script, tag) {
  const out = fs.openSync(path.join(STATE, `${tag}.out.log`), 'a')
  const err = fs.openSync(path.join(STATE, `${tag}.err.log`), 'a')
  const child = spawn(NODE, [script], { cwd: ROOT, detached: true, windowsHide: true, stdio: ['ignore', out, err] })
  child.unref()
  return child.pid
}

console.log('=== 守护进程重启 ===\n')

// ① 停掉旧的守护进程
const guardians = [
  { name: 'watchdog', pattern: 'watchdog[.]mjs' },
  { name: 'port-guard', pattern: 'port-guard[.]mjs' },
  { name: 'supervisor', pattern: 'supervisor[.]mjs' },
  // auto-repair：改了审批策略/修复逻辑后必须重启它，否则它还在跑旧代码
  // （旧代码不看策略，会自己动手修）。supervisor 会把它保活回来。
  { name: 'auto-repair', pattern: 'auto-repair[.]mjs' }
]
for (const g of guardians) {
  const pids = pidsByCommandLine(g.pattern)
  for (const pid of pids) {
    console.log(`  停止 ${g.name} pid=${pid}`)
    kill(pid)
  }
}
await sleep(2500)

// ② 检查 SnowLuma 网关实例
//
// ⚠️ SnowLuma 是 **launcher + 应用本体** 两个进程（父子关系），所以「2 个实例」是**正常**的，
//    不是多实例。真正的多实例是 3 个以上（会抢 3000/3001 与 QQ 注入）。
//    这里只在 OneBot 没就绪且实例数 >= 3 时才清理多余的，避免误杀父子对。
const gwPids = pidsByCommandLine('index[.]mjs')
const onebotOwner = listeningPortsSync([3000, 3001]).get(3000)
const onebotReady = listeningPortsSync([3000, 3001]).size >= 2
if (gwPids.length > 2 && !onebotReady) {
  console.log(`\n  网关实例 ${gwPids.length} 个且 OneBot 未就绪，清理多余的（保留 ${onebotOwner ?? '第一个'}）`)
  for (const pid of gwPids) {
    if (pid === onebotOwner) { console.log(`    保留 pid=${pid}`); continue }
    console.log(`    停止多余网关 pid=${pid}`)
    kill(pid)
  }
} else {
  console.log(`\n  网关实例 ${gwPids.length} 个（launcher + 应用本体，2 个属正常），OneBot 就绪=${onebotReady}，无需清理`)
}
await sleep(2000)

// ③ 拉起 supervisor（它会保证 watchdog 活着）+ port-guard
const sup = startDetached(path.join(ROOT, 'supervisor.mjs'), 'supervisor-restart')
console.log(`\n  supervisor 已拉起 pid=${sup}`)
await sleep(4000)
const pg = startDetached(path.join(ROOT, 'port-guard.mjs'), 'port-guard-restart')
console.log(`  port-guard 已拉起 pid=${pg}`)

// ④ 验证
await sleep(6000)
console.log('\n=== 验证 ===')
for (const g of guardians) {
  const pids = pidsByCommandLine(g.pattern)
  console.log(`  ${g.name}: ${pids.length ? '在跑 ' + pids.join(',') : '❌ 没起来'}`)
}
const gw = pidsByCommandLine('index[.]mjs')
console.log(`  SnowLuma 网关: ${gw.length} 个实例 ${gw.join(',')}`)
const ports = listeningPortsSync([3000, 3001, 3100, 3200, 5099, 5199])
for (const [p, pid] of [...ports].sort((a, b) => a[0] - b[0])) {
  console.log(`  端口 ${p} -> pid ${pid}`)
}
const bridge = pidsByCommandLine('bridge[.]js')
console.log(`  桥接进程: ${bridge.join(',') || '❌ 没有'}`)
