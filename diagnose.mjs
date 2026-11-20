// auto-repair · 诊断模块
//
// 职责：**只做诊断，不做修复**。把「现在坏在哪」判断清楚，交给 repair.mjs 去修。
// 分开的理由：诊断是只读的，可以随时跑、可以放心在生产环境跑；
// 修复有副作用，必须经过 repair.mjs 的安全阀（白名单 + 备份 + 频次限制）。
//
// 设计原则：
//   1. 每个诊断结论都要有**证据**（文件字节、崩溃日志、端口状态），不能靠猜。
//   2. 诊断不出来就返回 null，交给上层上报 —— 绝不「猜一个原因去修」。
//   3. 严重程度分级，调用方据此决定是自动修还是通知人。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync, execFileSync } from 'node:child_process'
import { MCP_CLIENT_IDS } from './tools/mcp-registration.mjs'
import { listeningPortsSync, dshPids, processTable } from './tools/net-listeners.mjs'

// 仓库根：优先环境变量 AUTO_REPAIR_ROOT；否则按本文件自身位置推导，
// 结果就是本仓库所在目录（换机器 / 换用户名 / 换目录都不用改代码）。
// 若仓库被作为子目录部署（与 qq-bridge 同级），用 AUTO_REPAIR_ROOT 指定那一级。
const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = process.env.AUTO_REPAIR_ROOT
  ? path.resolve(process.env.AUTO_REPAIR_ROOT)
  : HERE
export const DSH_HOME = path.join(process.env.USERPROFILE || '', '.dsh')
export const DSH_EXE = path.join(ROOT, 'DeepSeek Harness.exe')
export const APP_LOG_DIR = path.join(
  process.env.APPDATA || '',
  '@deepseek-ai', 'dsh-desktop', 'logs'
)

// ── 严重程度 ────────────────────────────────────────────────────────────────
export const SEVERITY = {
  FATAL: 'fatal',     // 应用起不来，必须立刻修
  WARN: 'warn',       // 功能降级，能跑但不对
  INFO: 'info'        // 提示，无需动作
}

/** 诊断结论的统一结构 */
export function finding(severity, code, title, detail, evidence = {}) {
  return { severity, code, title, detail, evidence, at: Date.now() }
}

// ── 通用工具 ────────────────────────────────────────────────────────────────

/** 读文件头几个字节判断是否带 UTF-8 BOM */
export function hasBom(file) {
  try {
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(3)
    const n = fs.readSync(fd, buf, 0, 3, 0)
    fs.closeSync(fd)
    return n === 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  } catch {
    return false
  }
}

/**
 * 列出本机 127.0.0.1 的监听端口 → Map<port, pid>
 *
 * ⚠️ 这里**不能**用 netstat -ano：本机约 98 个 socket 的 State 枚举值是非法的 0，
 *    netstat 完全不列出它们 —— 而本项目所有服务端口（3000/3001/3100/3200/5099/5199）
 *    恰好全在这一批里。用 netstat 的后果是「桥接明明在跑，却被诊断成 BRIDGE_DOWN」，
 *    守护进程于是反复拉起桥接 → 新实例撞端口 EADDRINUSE → 秒退。
 *    详细原理见 tools/net-listeners.mjs。
 *
 * 一次 CIM 查询约 0.9s，而一轮诊断要问好几次，所以加了个 2 秒的短缓存。
 */
let _portsCache = null
let _portsCacheAt = 0
const PORTS_CACHE_MS = 5000

export function listeningPorts() {
  const now = Date.now()
  if (_portsCache && now - _portsCacheAt < PORTS_CACHE_MS) return _portsCache
  const map = listeningPortsSync()
  _portsCache = map
  _portsCacheAt = now
  return map
}

/** 某类进程是否在跑（按命令行匹配，不只看进程名，避免同名误判） */
export function processRunning(pattern) {
  try {
    const out = execSync(
      'tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /FO CSV',
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }
    )
    if (!/DeepSeek Harness\.exe/i.test(out)) return false
  } catch {
    return false
  }
  // 进程名匹配不足以确认 DSH 在跑，还要确认有监听端口
  return true
}

/** DSH 进程持有的监听端口（DSH 端口是随机的） */
export function dshPorts(ports = listeningPorts()) {
  // 从统一快照里挑 DSH 进程 —— 比再起一次 tasklist 快（快照本来就查了进程表）
  const pids = dshProcessIds()
  const out = []
  for (const [port, pid] of ports) if (pids.includes(Number(pid))) out.push(port)
  return out
}

/** DSH 进程 pid 列表（取自进程快照，不额外起进程） */
export function dshProcessIds() {
  return processTable()
    .filter((p) => p.name.toLowerCase() === 'deepseek harness.exe')
    .map((p) => p.pid)
}

// ── 崩溃日志 ────────────────────────────────────────────────────────────────

/** 读最近一个崩溃日志，解析出错误类型 */
export function latestCrash() {
  try {
    const files = fs.readdirSync(APP_LOG_DIR)
      .filter((f) => /^crash-.*-host\.log$/.test(f))
      .sort()
    if (!files.length) return null
    const file = path.join(APP_LOG_DIR, files[files.length - 1])
    const text = fs.readFileSync(file, 'utf8')
    const stat = fs.statSync(file)

    const time = /time:\s*(.+)/.exec(text)?.[1]?.trim() || ''
    const phase = /phase:\s*(.+)/.exec(text)?.[1]?.trim() || ''
    const errMatch = /--- error ---\s*\n([\s\S]*?)\n\s*at /i.exec(text)
    const errText = errMatch ? errMatch[1] : ''

    let kind = 'unknown'
    if (/Unexpected token|is not valid JSON/i.test(errText)) kind = 'json-parse'
    else if (/Cannot find module|ERR_MODULE_NOT_FOUND/i.test(errText)) kind = 'module-missing'
    else if (/EADDRINUSE|address already in use/i.test(errText)) kind = 'port-conflict'
    else if (/ENOENT|no such file/i.test(errText)) kind = 'file-missing'
    else if (/EACCES|permission denied/i.test(errText)) kind = 'permission'
    else if (/out of memory|heap/i.test(errText)) kind = 'memory'

    // 定位是哪个文件出的问题（JSON.parse 场景从栈帧反推）
    let culprit = null
    if (kind === 'json-parse') {
      // readProfileManifest → profile 目录下的 package.json
      const pkg = path.join(DSH_HOME, 'profiles', 'desktop', 'package.json')
      if (fs.existsSync(pkg) && hasBom(pkg)) culprit = pkg
      else {
        // 退而求其次：扫 profile 目录里所有 json
        const dir = path.join(DSH_HOME, 'profiles', 'desktop')
        if (fs.existsSync(dir)) {
          for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith('.json')) continue
            const p = path.join(dir, f)
            if (fs.existsSync(p) && hasBom(p)) { culprit = p; break }
          }
        }
      }
    }

    return {
      file, kind, time, phase,
      errText: errText.slice(0, 400),
      culprit,
      mtime: stat.mtimeMs
    }
  } catch {
    return null
  }
}

// ── 各项诊断 ────────────────────────────────────────────────────────────────

/** 诊断 1：DSH 崩溃且原因是 JSON 带 BOM —— 这是最常见、也最好修的一类 */
export function diagnoseBomCrash() {
  const crash = latestCrash()
  if (!crash) return null
  if (crash.kind !== 'json-parse') return null
  if (!crash.culprit) return null

  // 崩溃日志必须是新鲜的（10 分钟内），否则那是历史遗留，不算「现在坏了」
  const age = Date.now() - crash.mtime
  if (age > 10 * 60 * 1000) return null

  return finding(
    SEVERITY.FATAL,
    'BOM_CRASH',
    'DSH 因配置文件带 UTF-8 BOM 而无法启动',
    `崩溃日志显示 JSON 解析失败，元凶是 ${crash.culprit}。`,
    {
      culprit: crash.culprit,
      crashFile: crash.file,
      crashTime: crash.time,
      crashErr: crash.errText
    }
  )
}

/** 诊断 2：DSH 进程一个都没有（但没有新鲜崩溃日志） */
export function diagnoseDshDead() {
  const ports = listeningPorts()
  const dshPortList = dshPorts(ports)
  if (dshPortList.length > 0) return null  // 还活着

  // 确认进程真的不在（从进程快照里看，不用再起一次 tasklist）
  try {
    const alive = dshProcessIds().length > 0
    if (alive) {
      // 进程在但没有监听端口：可能还在启动中，或者卡住了
      return finding(
        SEVERITY.WARN,
        'DSH_NO_PORT',
        'DSH 进程存在但没有监听端口',
        '进程在跑却没有对外服务端口，可能卡在启动阶段。',
        { alive: true }
      )
    }
  } catch {}

  const crash = latestCrash()
  return finding(
    SEVERITY.FATAL,
    'DSH_DEAD',
    'DSH 进程完全不在了',
    crash
      ? `最近一次崩溃类型：${crash.kind}（${crash.time}）`
      : '没有找到崩溃日志，可能是被手动关掉了。',
    { crashKind: crash?.kind || null }
  )
}

/** 诊断 3：桥接不在监听 */
export function diagnoseBridgeDown() {
  const ports = listeningPorts()
  if (ports.has(3100)) return null
  return finding(
    SEVERITY.FATAL,
    'BRIDGE_DOWN',
    'QQ 桥接没有在监听 3100',
    '桥接进程不在，QQ 消息不会被处理。',
    {}
  )
}

/** 诊断 4：桥接在，但 DSH 没连上（端口漂移后不会自愈，必须重启桥接） */
export async function diagnoseBridgeUnhealthy(ports) {
  if (!ports.has(3100)) return null
  try {
    const tokenFile = path.join(ROOT, 'qq-bridge', 'state', 'console-token')
    const token = fs.readFileSync(tokenFile, 'utf8').trim()
    const res = await fetch('http://127.0.0.1:3100/api/status', {
      headers: { 'x-console-token': token },
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) return null
    const s = await res.json()
    const sl = s?.snowluma || {}
    if (s.dshReady === false) {
      return finding(
        SEVERITY.FATAL,
        'BRIDGE_DSH_STALE',
        '桥接连不上 DSH（DSH 端口漂移后不会自愈）',
        'DSH 重启后端口变了，桥接的客户端地址是启动时固定的，必须重启桥接才能跟上。',
        { dshReady: false }
      )
    }
    // QQ 未登录 —— 这是外部依赖，不是故障，不该自动「修」
    if (sl.connected === false) {
      const onebot = ports.has(3000) || ports.has(3001)
      if (!onebot) {
        return finding(
          SEVERITY.INFO,
          'QQ_OFFLINE',
          'QQ 未登录，OneBot 端点未监听',
          'SnowLuma 的 OneBot 服务只在 QQ 登录后才启动。等 QQ 登录即可自动恢复，不需要人工干预。',
          { onebotOnline: false }
        )
      }
      return finding(
        SEVERITY.WARN,
        'BRIDGE_WS_DOWN',
        '桥接的 WS 连不上，但 OneBot 是在线的',
        'OneBot 端口在监听，说明 QQ 在线，可能是 token 不匹配或 hook 退化。',
        { onebotOnline: true }
      )
    }
  } catch {}
  return null
}

/** 诊断 5：profile 配置文件带 BOM（还没崩，但迟早会崩） */
export function diagnoseLatentBom() {
  const profileDir = path.join(DSH_HOME, 'profiles', 'desktop')
  if (!fs.existsSync(profileDir)) return null
  const risky = []
  for (const f of fs.readdirSync(profileDir)) {
    if (!/\.(json|ya?ml)$/i.test(f)) continue
    if (/\.bak/i.test(f)) continue
    const p = path.join(profileDir, f)
    try {
      if (!fs.statSync(p).isFile()) continue
      if (hasBom(p)) risky.push(p)
    } catch {}
  }
  if (!risky.length) return null
  return finding(
    SEVERITY.WARN,
    'LATENT_BOM',
    'profile 配置文件带 BOM（尚未导致崩溃）',
    `这些文件当前还没让 DSH 崩，但下次启动就会：${risky.join(', ')}`,
    { files: risky }
  )
}

/**
 * 诊断 6：QQ 桥接的 MCP 工具注册丢失。
 *
 * 2026-11-02「QQ 桥接掉了」的根因：DSH 保存设置时重写 profile 的 cordis.patch.yml，
 * 只保留它自己管理的行，把外部托管的 `- insert:` 注册整段抹掉
 * （2257B → 1052B），QQ 会话里 qq_* 工具全没了，只剩「提问」和「待办」。
 *
 * 判定口径：
 *   · bundle 层（bridge.patch.yml）是**权威来源**——缺了就是真故障，可自动修。
 *   · profile 层只是**热备**——缺了不影响运行（bundle 层兜着），只报 INFO。
 */
export function diagnoseMcpRegistration() {
  const bundleFile = path.join(ROOT, 'qq-bridge', 'plugins', 'qq-agent-presets', 'bridge.patch.yml')
  const profileFile = path.join(DSH_HOME, 'profiles', 'desktop', 'cordis.patch.yml')
  const readSafe = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }

  const bundle = readSafe(bundleFile)
  const bundleMissing = MCP_CLIENT_IDS.filter((id) => !bundle.includes(id))
  if (bundleMissing.length) {
    return finding(
      SEVERITY.WARN,
      'MCP_PATCH_MISSING',
      'QQ 桥接的 MCP 工具注册丢了（AI 将拿不到 qq_* 工具）',
      `bundle 层补丁 ${bundleFile} 缺少：${bundleMissing.join(', ')}。` +
      '这正是「QQ 桥接掉了」的根因：DSH 保存设置时重写 profile patch，把外部托管的注册整段抹掉。',
      { missing: bundleMissing, bundlePatch: bundleFile, profilePatch: profileFile }
    )
  }

  const profile = readSafe(profileFile)
  const profileMissing = MCP_CLIENT_IDS.filter((id) => !profile.includes(id))
  if (profileMissing.length) {
    return finding(
      SEVERITY.INFO,
      'MCP_PROFILE_BACKUP_MISSING',
      'profile 层的 MCP 热备被 DSH 写回抹掉了（不影响运行）',
      `bundle 层注册完整，QQ 工具仍可用。缺的是 profile 热备：${profileMissing.join(', ')}。`,
      { missing: profileMissing, bundlePatch: bundleFile, profilePatch: profileFile }
    )
  }
  return null
}

/** MCP client 进程（DSH 以 stdio 方式拉起它们）在不在 */
export function mcpClientPids() {
  try {
    // 复用进程表（一次 CIM 查询，缓存 10s）—— 之前这里单独起一次 PowerShell，
    // 光启动就要 2 秒，把一轮诊断拖到 10 秒以上。
    const re = /mcp-(snowluma-safe|host-server|web-search-safe)[.]js/i
    return processTable()
      .filter((p) => p.name.toLowerCase() === 'node.exe' && re.test(p.commandLine))
      .map((p) => String(p.pid))
  } catch {
    return []
  }
}

/**
 * 诊断 7：MCP client 进程没跑 —— 这就是「AI 说工具一个都没挂上」的直接症状。
 *
 * 判定要点：
 *   · DSH 必须在跑（否则进程当然不在）。
 *   · 连续缺失超过 3 分钟才报（防 DSH 启动那一两秒的竞态）。
 */
export function diagnoseMcpClientsDown() {
  const stateDir = path.join(ROOT, 'auto-repair', 'state')
  const stateFile = path.join(stateDir, 'mcp-down-since.json')
  const readSince = () => {
    try { return Number(JSON.parse(fs.readFileSync(stateFile, 'utf8')).since) || 0 } catch { return 0 }
  }
  const writeSince = (since) => {
    try {
      fs.mkdirSync(stateDir, { recursive: true })
      fs.writeFileSync(stateFile, JSON.stringify({ since }), 'utf8')
    } catch {}
  }

  if (dshPorts().length === 0) {
    // DSH 没起来，进程不在是正常的，别添乱
    try { fs.unlinkSync(stateFile) } catch {}
    return null
  }

  const pids = mcpClientPids()
  if (pids.length) {
    try { fs.unlinkSync(stateFile) } catch {}
    return null
  }

  const now = Date.now()
  const since = readSince() || now
  writeSince(since)
  if (now - since < 3 * 60 * 1000) return null   // 刚起的，别急

  return finding(
    SEVERITY.WARN,
    'MCP_CLIENTS_DOWN',
    'QQ 桥接的 MCP client 进程没在跑（AI 会说「qq_* 工具一个都没挂上」）',
    `DSH 在跑，但三个 MCP client 进程都不在了（已持续 ${Math.round((now - since) / 1000)} 秒）。` +
    '注册配置本身可能是好的，需要重启 DSH 让插件重新拉起它们。',
    { since, durationMs: now - since }
  )
}

/**
 * 跑一遍完整诊断，返回所有结论。
 * 按严重程度排序，FATAL 在前。
 *
 * ⚠️ 去重：BOM_CRASH 和 LATENT_BOM 可能指向**同一个文件**
 * （崩溃刚发生时，那个文件既导致了崩溃，也确实带 BOM）。
 * 两个都报会导致修复阶段连剥两次 —— 那是真实踩过的坑，会把 `{` 一起吃掉。
 * 所以这里按「文件」去重：同一个文件只保留严重度最高的那个结论。
 */
export async function diagnoseAll() {
  const ports = listeningPorts()
  const out = []

  const bom = diagnoseBomCrash()
  if (bom) out.push(bom)

  const dead = diagnoseDshDead()
  if (dead) out.push(dead)

  const bridge = diagnoseBridgeDown()
  if (bridge) out.push(bridge)

  const unhealthy = await diagnoseBridgeUnhealthy(ports)
  if (unhealthy) out.push(unhealthy)

  const latent = diagnoseLatentBom()
  if (latent) out.push(latent)

  const mcpReg = diagnoseMcpRegistration()
  if (mcpReg) out.push(mcpReg)

  const mcpDown = diagnoseMcpClientsDown()
  if (mcpDown) out.push(mcpDown)

  const order = { fatal: 0, warn: 1, info: 2 }
  out.sort((a, b) => order[a.severity] - order[b.severity])

  // 按文件去重：同一文件被多个 code 指向时，只留严重度最高的
  const seenFiles = new Set()
  const deduped = []
  for (const f of out) {
    const files = [
      ...(f.evidence?.culprit ? [f.evidence.culprit] : []),
      ...(f.evidence?.files ? f.evidence.files : [])
    ]
    if (files.length && files.every((x) => seenFiles.has(x))) continue
    for (const x of files) seenFiles.add(x)
    deduped.push(f)
  }
  return deduped
}
