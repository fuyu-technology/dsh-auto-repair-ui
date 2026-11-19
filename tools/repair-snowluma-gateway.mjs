// 修复 SnowLuma 网关僵尸状态：
//   ① 清掉重复的网关实例（多实例会抢 5099 / OneBot 端口）
//   ② 打开 hookAutoLoad —— 网关启动后自动把 SnowLuma 的 hook DLL 注入已运行的 QQ 进程
//      （原先是 false，只能在 WebUI 里手动注入，所以 QQ 一重启链路就断，桥接收不到任何消息）
//   ③ 拉起唯一网关实例
//
// 用法：node repair-snowluma-gateway.mjs [--dry-run]

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

const SNOW = 'D:\\大肥鱼\\SnowLuma'
const STATE = 'D:\\大肥鱼\\state'
const RUNTIME = path.join(SNOW, 'config', 'runtime.json')
const EXE = path.join(SNOW, 'node.exe')
const ENTRY = path.join(SNOW, 'index.mjs')
const dryRun = process.argv.includes('--dry-run')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ps = (script) => execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
  encoding: 'utf8', windowsHide: true
})

/** 找出所有 SnowLuma 网关实例（只认 index.mjs，不碰 watchdog/supervisor/bridge/box） */
function gatewayPids() {
  const out = ps(
    "@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    "Where-Object { $_.CommandLine -match 'index\\.mjs' -and $_.CommandLine -match 'SnowLuma|node\\.exe\"?\\s+index\\.mjs' } | " +
    'ForEach-Object { $_.ProcessId }) -join ","'
  ).trim()
  return out ? out.split(',').map((x) => Number(x.trim())).filter(Boolean) : []
}

console.log('=== SnowLuma 网关修复 ===\n')

// ① 备份 runtime.json
if (!dryRun) {
  const bak = `${RUNTIME}.bak-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
  fs.copyFileSync(RUNTIME, bak)
  console.log(`[1] runtime.json 已备份 → ${path.basename(bak)}`)
} else {
  console.log('[1] [dry-run] 跳过备份')
}

// ② 停掉所有网关实例
let pids = gatewayPids()
console.log(`[2] 当前网关实例：${pids.length ? pids.join(', ') : '无'}`)
if (!dryRun) {
  for (const pid of pids) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true })
      console.log(`    已停止 pid=${pid}`)
    } catch (e) {
      console.log(`    pid=${pid} 停止失败：${e.message}`)
    }
  }
  await sleep(3000)
  const left = gatewayPids()
  console.log(`    剩余网关实例：${left.length}`)
}

// ③ hookAutoLoad = true
if (!dryRun) {
  const rt = JSON.parse(fs.readFileSync(RUNTIME, 'utf8'))
  rt.hookAutoLoad = true
  fs.writeFileSync(RUNTIME, JSON.stringify(rt, null, 2), 'utf8')
  console.log('\n[3] hookAutoLoad = true（网关会自动注入已运行的 QQ 进程）')
} else {
  console.log('\n[3] [dry-run] 跳过 hookAutoLoad')
}

// ④ 拉起唯一网关
if (!dryRun) {
  const out = fs.openSync(path.join(STATE, 'snowluma.out.log'), 'a')
  const err = fs.openSync(path.join(STATE, 'snowluma.err.log'), 'a')
  const child = spawn(EXE, [ENTRY], {
    cwd: SNOW, detached: true, windowsHide: true, stdio: ['ignore', out, err]
  })
  child.unref()
  console.log(`\n[4] 网关已拉起 pid=${child.pid}`)
  console.log('    等待 hook 注入 + OneBot 监听…\n')

  for (let i = 0; i < 15; i++) {
    await sleep(4000)
    const ports = ps(
      "@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | " +
      "Where-Object { $_.LocalPort -in @(3000,3001,5099) } | " +
      'ForEach-Object { $_.LocalPort }) -join ","'
    ).trim()
    const has = (p) => ports.split(',').includes(String(p))
    const hooked = ps(
      "$p = Get-Process -Id 41952 -ErrorAction SilentlyContinue; " +
      "if (-not $p) { 'no-qq' } else { " +
      "if (@($p.Modules | Where-Object { $_.FileName -match 'snowluma' }).Count -gt 0) { 'hooked' } else { 'not-hooked' } }"
    ).trim()
    console.log(`    t+${(i + 1) * 4}s  端口=[${ports || '无'}]  QQ=${hooked}`)
    if (has(3000) && has(3001)) { console.log('\n✅ OneBot 3000/3001 已就绪，QQ 链路恢复'); break }
  }
} else {
  console.log('\n[4] [dry-run] 跳过拉起')
}

console.log('\n完成。')
