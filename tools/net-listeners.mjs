// 可靠的「本机监听端口」探测。
//
// ⚠️ 为什么不能只靠 netstat / Get-NetTCPConnection -State Listen：
//
//   本机（Windows 11 10.0.26100）有约 98 个 socket 的 State 枚举值是非法的 **0**
//   （MSFT_NetTCPConnection 的合法值是 1=Closed / 2=Listen / 5=Established …）。
//   后果是：
//     · netstat -ano            **完全不列出** state=0 的 socket
//     · Get-NetTCPConnection -State Listen **过滤掉** state=0 的 socket
//   而 3100（桥接）/ 3200（需求箱）/ 5099（SnowLuma WebUI）/ 5199（Cookie 注入器）/
//   3000 / 3001（OneBot）**恰好全在 state=0 这一批里** —— 也就是本项目所有服务端口。
//
//   只认上面那两张表 ⇒ 守护进程把「服务好好地在跑」误判成「服务没起来」⇒
//   反复拉起 ⇒ 新实例撞端口 EADDRINUSE ⇒ 秒退 ⇒ 崩溃循环。
//   （真实案例：2026-11-08 桥接每 10~20 秒被拉起一次，全是 EADDRINUSE。）
//
//   这里的做法：
//   ① 用 Get-NetTCPConnection **不带 -State 过滤**取全部 socket（能看见 state=0 的）
//   ② 再用**真实 TCP 连接**探活，确认它确实是监听端口
//
// 用法：
//   import { listeningPorts, pidsByCommandLine } from './auto-repair/tools/net-listeners.mjs'
//   const ports = listeningPorts()      // Map<port, pid>
//   const pids  = pidsByCommandLine('bridge\\.js')

import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync, execFileSync } from 'node:child_process'

// 跑一段 PowerShell。
//
// ⚠️ **必须走临时脚本文件**，不能用 `execSync('powershell.exe -Command ' + JSON.stringify(script))`：
//    cmd.exe 不认反斜杠转义，遇到脚本里同时有 `"` / `$` / `|` 时会把命令拆坏
//    （实测报「'$' 不是内部或外部命令」，或者引号提前闭合导致管道被 cmd 接管）。
//    写成 .ps1 再 `-File` 跑，完全没有引号问题。
//
// ⚠️ .ps1 必须是 **ASCII**（或带 BOM 的 UTF-8）：Windows PowerShell 5.1 读无 BOM 的
//    UTF-8 脚本时会按 ANSI 解释，里面的中文会变乱码。我们的脚本都是纯 ASCII。
const PS = (script, timeoutMs = 25000) => {
  const tmp = path.join(
    os.tmpdir(),
    `ar-ps-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`
  )
  fs.writeFileSync(tmp, script, 'utf8')
  try {
    return execFileSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp],
      { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }
    )
  } finally {
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
  }
}

/** socket 能不能真的连上（state=0 的 socket 只有连一下才知道是不是在监听） */
function canConnect(port, host = '127.0.0.1', timeoutMs = 900) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      try { sock.destroy() } catch { /* ignore */ }
      resolve(ok)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
    try { sock.connect(port, host) } catch { done(false) }
  })
}

/**
 * 列出本机监听端口 → Map<port, pid>
 * @param {string[]} onlyPorts 只保留这些端口（可选，省掉探活开销）
 * @returns {Promise<Map<number, number>>}
 */
export async function listeningPorts(onlyPorts = null) {
  const map = new Map()
  const candidates = takeSnapshot().ports
  const wanted = onlyPorts ? new Set(onlyPorts) : null
  for (const [port, pid] of candidates) {
    if (wanted && !wanted.has(port)) continue
    if (await canConnect(port)) map.set(port, pid)
  }
  return map
}

/**
 * 列出本机监听端口 → Map<port, pid>（**同步**版，不做 TCP 探活）
 *
 * 判定依据：监听 socket 的 RemoteAddress 是 0.0.0.0/::，RemotePort 是 0；
 * 而 TIME_WAIT / Established 的 socket 本地端口虽是 0.0.0.0 但**远端端口非 0**，
 * 所以「RemotePort = 0」能把两者干净分开。
 *
 * 比 async 版快一个数量级（单次 CIM 查询 ~2.9s，但和进程表合并后共摊），
 * 适合做健康检查。
 *
 * @param {number[]|null} onlyPorts 只保留这些端口
 * @returns {Map<number, number>}
 */
export function listeningPortsSync(onlyPorts = null) {
  const all = takeSnapshot().ports
  if (!onlyPorts) return new Map(all)
  const wanted = new Set(onlyPorts)
  const map = new Map()
  for (const [port, pid] of all) if (wanted.has(port)) map.set(port, pid)
  return map
}

/**
 * 一次拿到「监听端口」和「进程表」。
 *
 * 为什么合并：Get-NetTCPConnection 要 ~2.9s，Get-CimInstance Win32_Process 要 ~1.9s，
 * 分两次跑就是 4.8s；写在**同一个 .ps1** 里只花 3.1s（省掉一次 PowerShell 启动 +
 * 一次 WMI 会话初始化）。一轮诊断只需要一份快照，所以合并最划算。
 *
 * 快照缓存 5 秒：同一轮诊断里问几次端口都是同一份答案。
 */
let _snap = null
let _snapAt = 0
const SNAP_TTL_MS = 5000

function takeSnapshot() {
  const now = Date.now()
  if (_snap && now - _snapAt < SNAP_TTL_MS) return _snap

  const ports = new Map()
  const procs = []
  const script = [
    'Get-NetTCPConnection -ErrorAction SilentlyContinue | ' +
    'ForEach-Object { "P" + [string]::Join(",", @($_.LocalAddress, $_.LocalPort, $_.RemoteAddress, $_.RemotePort, $_.OwningProcess)) }',
    'Get-CimInstance Win32_Process | ' +
    'ForEach-Object { "X" + [string]::Join([char]1, @($_.ProcessId, $_.Name, $_.CommandLine)) }'
  ].join(' ; ')

  let rows = ''
  try {
    rows = PS(script)
  } catch {
    return _snap || { ports, procs }
  }

  const LOCAL = new Set(['127.0.0.1', '0.0.0.0', '::', '::1'])
  for (const line of rows.split(/\r?\n/)) {
    if (!line) continue
    if (line[0] === 'P') {
      const p = line.slice(1).split(',')
      if (p.length !== 5) continue
      const [addr, portStr, , remotePort, pidStr] = p
      if (remotePort !== '0') continue
      if (!LOCAL.has(addr)) continue
      const port = Number(portStr)
      if (!Number.isFinite(port)) continue
      const pid = Number(pidStr)
      if (!ports.has(port)) ports.set(port, Number.isFinite(pid) ? pid : 0)
    } else if (line[0] === 'X') {
      const parts = line.slice(1).split('\u0001')
      if (parts.length < 3) continue
      const pid = Number(parts[0])
      if (!Number.isFinite(pid)) continue
      procs.push({ pid, name: String(parts[1] || ''), commandLine: String(parts[2] || '') })
    }
  }

  _snap = { ports, procs }
  _snapAt = now
  return _snap
}

/**
 * 列出**所有**进程 → [{ pid, name, commandLine }]
 * 复用统一快照（同一次 PowerShell 调用里一起取回来的）。
 */
export function processTable() {
  return takeSnapshot().procs
}

/**
 * 按命令行正则找进程 pid 列表（比按端口认人可靠，端口表在本机不可信）
 * @param {string} pattern 正则，匹配 Win32_Process.CommandLine（**忽略大小写**，与旧实现一致）
 * @param {string} nameFilter 可选：只匹配该进程名（node.exe / DeepSeek Harness.exe 等）
 */
export function pidsByCommandLine(pattern, nameFilter = 'node.exe') {
  try {
    const re = new RegExp(pattern, 'i')
    return processTable()
      .filter((p) => {
        if (nameFilter && p.name.toLowerCase() !== String(nameFilter).toLowerCase()) return false
        return re.test(p.commandLine)
      })
      .map((p) => p.pid)
  } catch { return [] }
}

/** 某个 pid 的命令行（用来确认杀之前没杀错进程） */
export function commandLineOf(pid) {
  const hit = processTable().find((p) => p.pid === Number(pid))
  return hit ? hit.commandLine : ''
}

/** HTTP 探活：能应答（200/401/403 都算活着）就是有 Web 服务在监听 */
export async function httpProbe(port, host = '127.0.0.1', timeoutMs = 1500) {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const r = await fetch(`http://${host}:${port}/`, { signal: ctrl.signal, redirect: 'manual' })
      return r.status === 200 || r.status === 401 || r.status === 403
    } finally { clearTimeout(t) }
  } catch { return false }
}

/**
 * DSH 桌面进程（DeepSeek Harness.exe）的 pid 集合
 *
 * ⚠️ 这里刻意**不走 PowerShell**：原来那版用 `chr(34)`（C 风格）去替换引号，
 *    但 PowerShell 里没有 `chr` 这个函数（是 `[char]34`），
 *    结果整条命令解析失败 → dshPids() 永远返回空 → DSH 端口判定永远为 0。
 *    tasklist 的 CSV 输出用正则解析更稳，也不受引号规则影响。
 */
export function dshPids() {
  try {
    const out = execSync(
      'tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /FO CSV',
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }
    )
    const pids = []
    for (const line of out.split(/\r?\n/)) {
      const m = /^"DeepSeek Harness\.exe","(\d+)"/.exec(line)
      if (m) pids.push(Number(m[1]))
    }
    return pids
  } catch { return [] }
}

/**
 * 找 DSH 的 **Web 应用端口**。
 *
 * ⚠️ DSH 进程会持有**好几个**监听端口（实测 7 个：主 Web 端口 + 若干 worker/ws 端口），
 *    所以「PID 归属取第一个」会挑到辅助端口上（辅助端口不监听 HTTP，表现为
 *    Cookie 注入器指向一个死端口、浏览器打开设置页未认证）。
 *    必须再加一层 **HTTP 探活**：只有主 Web 端口会应答（未带 cookie 时返回 401）。
 *
 * @param {number[]} skipPorts 本地自有服务端口（3000/3001/3100/3200/5099/5199…）
 * @returns {Promise<number>} 0 = 没找到
 */
export async function findDshWebPort(skipPorts = [3000, 3001, 3100, 3200, 5099, 5100, 5101, 5199]) {
  const ids = dshPids()
  if (!ids.length) return 0
  const skip = new Set(skipPorts)
  const candidates = [...listeningPortsSync().entries()]
    .filter(([port, pid]) => ids.includes(Number(pid)) && !skip.has(port))
    .sort((a, b) => a[0] - b[0])
  for (const [port] of candidates) {
    if (await httpProbe(port)) return port
  }
  return 0
}
