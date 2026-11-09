// Copyright 2026 蝠羽科技 (fuyu-technology)
//
// 客户端发现 + 可选关联启动
// ----------------------------------------------------------------------------
// 解决一件事：用户选了 MiniMax / DeepSeek 这类模型之后，如果本机装了对应的
// 桌面客户端，希望「投喂报错」这一步能顺手把客户端拉起来。
//
// 三条原则：
//   1. **扫不到就说扫不到**。绝不猜路径、绝不编一个不存在的路径出来充数。
//   2. **只读**。扫描过程只读注册表 / 目录 / 开始菜单快捷方式，不写任何东西。
//   3. **降级到底**。没装任何客户端、注册表读不了、PowerShell 起不来，
//      都要正常返回「未检测到」，而不是抛错让整轮巡检挂掉。
//
// 客户端清单只放**已知的真实产品名**；判定靠关键词匹配 + 可执行文件名校验，
// 匹配不到就是未安装。用户可以手动改路径（存 state/clients.json 的 overrides）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STATE = process.env.REPAIR_STATE_DIR
  ? path.resolve(process.env.REPAIR_STATE_DIR)
  : path.join(HERE, 'state')
const CLIENTS_FILE = path.join(STATE, 'clients.json')

/**
 * 已支持的客户端（id 是稳定标识，写进配置文件的就是它）。
 * keywords 用来匹配注册表 DisplayName / 快捷方式名 / 可执行文件名。
 * exeNames 是可执行文件名（小写、不带路径），匹配优先级最高。
 */
export const CLIENT_CATALOG = Object.freeze([
  {
    id: 'trae',
    name: 'TRAE',
    keywords: ['trae'],
    exeNames: ['trae.exe', 'trae cn.exe'],
    hint: 'TRAE 编辑器（字节跳动的 AI IDE）'
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    keywords: ['minimax', '海螺', 'hailuo'],
    exeNames: ['minimax.exe', 'hailuo.exe'],
    hint: 'MiniMax 桌面客户端'
  }
])

// 明显不是主程序的东西，扫到了也不要（否则很容易匹配到一堆更新器/卸载器）。
const EXE_DENYLIST = [
  'unins',
  'uninstall',
  'update',
  'updater',
  'setup',
  'installer',
  'crash',
  'crashpad',
  'reporter',
  'helper',
  'elevate',
  'notification',
  'squirrel'
]

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const doc = JSON.parse(raw)
    return doc && typeof doc === 'object' ? doc : fallback
  } catch {
    return fallback
  }
}

/** 读用户设置：手动路径覆盖 + 每个客户端的「关联启动」开关 */
export function readClientConfig() {
  const doc = readJson(CLIENTS_FILE, {})
  const overrides = doc.overrides && typeof doc.overrides === 'object' ? doc.overrides : {}
  const launch = doc.launch && typeof doc.launch === 'object' ? doc.launch : {}
  const clean = {}
  for (const c of CLIENT_CATALOG) {
    clean[c.id] = {
      path: typeof overrides[c.id] === 'string' && overrides[c.id].trim() ? overrides[c.id].trim() : '',
      launch: launch[c.id] === true
    }
  }
  return { clients: clean, updatedAt: Number(doc.updatedAt) || 0 }
}

function writeClientConfig(cfg) {
  const doc = {
    overrides: {},
    launch: {},
    updatedAt: Date.now()
  }
  for (const [id, v] of Object.entries(cfg.clients || {})) {
    if (v?.path) doc.overrides[id] = v.path
    doc.launch[id] = v.launch === true
  }
  fs.mkdirSync(STATE, { recursive: true })
  fs.writeFileSync(CLIENTS_FILE, JSON.stringify(doc, null, 2) + '\n', 'utf8')
  return readClientConfig()
}

/** 改某个客户端的路径和/或开关（path 传空字符串 = 清掉手动路径） */
export function setClient(id, patch = {}) {
  const cid = String(id || '').trim()
  if (!CLIENT_CATALOG.some((c) => c.id === cid)) {
    return { ok: false, error: `没有 ${cid || '(空)'} 这个客户端` }
  }
  const cfg = readClientConfig()
  const cur = cfg.clients[cid] || { path: '', launch: false }
  if (patch.path !== undefined) {
    const p = String(patch.path || '').trim()
    if (p) {
      // 手填的路径要当场校验：填错就直接说错，别等启动时才炸
      let st = null
      try {
        st = fs.statSync(p)
      } catch {}
      if (!st || !st.isFile()) return { ok: false, error: `这个路径不存在或不是文件：${p}` }
      if (!/\.exe$/i.test(p)) return { ok: false, error: `不像可执行文件（需要 .exe）：${p}` }
    }
    cur.path = p
  }
  if (patch.launch !== undefined) cur.launch = patch.launch === true
  cfg.clients[cid] = cur
  const saved = writeClientConfig(cfg)
  return { ok: true, client: { id: cid, ...saved.clients[cid] } }
}

// ── 扫描 ────────────────────────────────────────────────────────────────────

function walkExe(dir, depth, sink) {
  if (depth < 0) return
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    try {
      if (e.isDirectory()) {
        walkExe(full, depth - 1, sink)
      } else if (e.isFile() && /\.exe$/i.test(e.name)) {
        sink.push(full)
      }
    } catch {}
  }
}

function isExeAllowed(file) {
  const base = path.basename(file).toLowerCase()
  return !EXE_DENYLIST.some((w) => base.includes(w))
}

function scoreCandidate(file, catalogEntry) {
  const base = path.basename(file).toLowerCase()
  let score = 0
  // 可执行文件名正好叫 trae.exe 这类，最可信
  if (catalogEntry.exeNames.includes(base)) score += 100
  // 名字里带关键词次之
  else if (catalogEntry.keywords.some((k) => base.includes(k))) score += 60
  // 装在这些目录里的更像主程序
  if (/\\program files/i.test(file)) score += 20
  if (/\\programs\\/i.test(file) || /\\localappdata\\/i.test(file)) score += 15
  if (/\\appdata\\roaming\\/i.test(file)) score += 5
  if (/\\windows\\/i.test(file)) score -= 50
  return score
}

function matchesEntry(text, entry) {
  const t = String(text || '').toLowerCase()
  return entry.keywords.some((k) => t.includes(k.toLowerCase()))
}

/** 起 PowerShell 拿注册表卸载项 + 开始菜单快捷方式（失败就返回空，不抛） */
function collectWindowsHints(timeoutMs = 12000) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ uninstall: [], shortcuts: [] })
    const script = `
$ErrorActionPreference='SilentlyContinue'
$out = [pscustomobject]@{ uninstall=@(); shortcuts=@() }
$roots = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$acc = @()
foreach($r in $roots){
  try {
    Get-ItemProperty $r | ForEach-Object {
      if($_.DisplayName){ $acc += [pscustomobject]@{ name=[string]$_.DisplayName; loc=[string]$_.InstallLocation; icon=[string]$_.DisplayIcon } }
    }
  } catch {}
}
$out.uninstall = $acc
$sc = @()
try {
  $sh = New-Object -ComObject WScript.Shell
  $dirs = @("$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs", "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs")
  foreach($d in $dirs){
    Get-ChildItem -Path $d -Recurse -Filter *.lnk | ForEach-Object {
      try { $t = $sh.CreateShortcut($_.FullName).TargetPath; if($t){ $sc += [pscustomobject]@{ name=[string]$_.BaseName; target=[string]$t } } } catch {}
    }
  }
} catch {}
$out.shortcuts = $sc
$out | ConvertTo-Json -Depth 4 -Compress
`
    let child
    try {
      child = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return resolve({ uninstall: [], shortcuts: [] })
    }
    let out = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      resolve({ uninstall: [], shortcuts: [] })
    }, timeoutMs)
    child.stdout.on('data', (d) => (out += d))
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ uninstall: [], shortcuts: [] })
    })
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const doc = JSON.parse(out.trim() || '{}')
        resolve({
          uninstall: Array.isArray(doc.uninstall) ? doc.uninstall : [],
          shortcuts: Array.isArray(doc.shortcuts) ? doc.shortcuts : []
        })
      } catch {
        resolve({ uninstall: [], shortcuts: [] })
      }
    })
  })
}

function uninstallPaths(hints, entry) {
  const found = []
  for (const u of hints.uninstall || []) {
    if (!matchesEntry(u.name, entry)) continue
    const icon = String(u.icon || '').replace(/^"|"$/g, '').split(',')[0].trim()
    if (icon && /\.exe$/i.test(icon) && isExeAllowed(icon)) {
      try {
        if (fs.statSync(icon).isFile()) found.push(icon)
      } catch {}
    }
    const loc = String(u.loc || '').trim()
    if (loc) {
      // InstallLocation 有时带引号，有时指向目录；目录就往下找一层
      const cleaned = loc.replace(/^"|"$/g, '')
      try {
        const st = fs.statSync(cleaned)
        if (st.isFile() && /\.exe$/i.test(cleaned) && isExeAllowed(cleaned)) found.push(cleaned)
        else if (st.isDirectory()) {
          const sink = []
          walkExe(cleaned, 2, sink)
          for (const f of sink) if (isExeAllowed(f)) found.push(f)
        }
      } catch {}
    }
  }
  return found
}

function shortcutPaths(hints, entry) {
  const found = []
  for (const s of hints.shortcuts || []) {
    if (!matchesEntry(s.name, entry)) continue
    const t = String(s.target || '').trim()
    if (!t || !/\.exe$/i.test(t) || !isExeAllowed(t)) continue
    try {
      if (fs.statSync(t).isFile()) found.push(t)
    } catch {}
  }
  return found
}

function knownPaths(entry) {
  const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const programDirs = [
    process.env.ProgramFiles || 'C:\\Program Files',
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  ]
  const roots = []
  for (const p of programDirs) {
    roots.push(p)
    roots.push(path.join(p, 'Trae'))
    roots.push(path.join(p, 'Trae CN'))
    roots.push(path.join(p, 'MiniMax'))
  }
  roots.push(path.join(localApp, 'Programs'))
  roots.push(localApp)
  roots.push(roaming)

  const found = []
  for (const root of roots) {
    for (const exe of entry.exeNames) {
      const guess = path.join(root, exe)
      try {
        if (fs.statSync(guess).isFile()) found.push(guess)
      } catch {}
    }
  }
  // Programs / LocalAppData 下常见的是 <厂商>\<产品>\app.exe，扫两层
  for (const root of [path.join(localApp, 'Programs'), localApp, roaming, ...programDirs]) {
    const sink = []
    walkExe(root, 2, sink)
    for (const f of sink) {
      const base = path.basename(f).toLowerCase()
      if (entry.exeNames.includes(base) || entry.keywords.some((k) => base.includes(k))) {
        if (isExeAllowed(f)) found.push(f)
      }
    }
  }
  return found
}

function dedupe(list) {
  const seen = new Set()
  const out = []
  for (const f of list) {
    // Windows 路径不区分大小写，去重也按小写算
    const key = path.resolve(f).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(path.resolve(f))
  }
  return out
}

/**
 * 扫本机已安装的模型客户端。
 *
 * @param {{timeoutMs?: number}} opts
 * @returns {Promise<{ok: boolean, at: number, clients: Array}>}
 *   clients[].installed = false 时 path 为 null —— 扫不到就是扫不到，不编。
 */
export async function scanClients({ timeoutMs = 12000 } = {}) {
  const cfg = readClientConfig()
  let hints = { uninstall: [], shortcuts: [] }
  try {
    hints = await collectWindowsHints(timeoutMs)
  } catch {
    hints = { uninstall: [], shortcuts: [] }
  }

  const clients = CLIENT_CATALOG.map((entry) => {
    const userPath = cfg.clients[entry.id]?.path || ''
    const launch = cfg.clients[entry.id]?.launch === true

    if (userPath) {
      // 手动指定优先，且不再被扫描结果覆盖
      let exists = false
      try {
        exists = fs.statSync(userPath).isFile()
      } catch {}
      return {
        id: entry.id,
        name: entry.name,
        hint: entry.hint,
        installed: exists,
        path: exists ? userPath : null,
        source: 'manual',
        manualPath: userPath,
        launch,
        error: exists ? null : '手动指定的路径已失效'
      }
    }

    let candidates = []
    try {
      candidates = dedupe([
        ...shortcutPaths(hints, entry),
        ...uninstallPaths(hints, entry),
        ...knownPaths(entry)
      ])
    } catch {
      candidates = []
    }

    // 按可信度排序：名字越对得上越靠前
    candidates.sort((a, b) => scoreCandidate(b, entry) - scoreCandidate(a, entry))
    const best = candidates[0] || ''
    const source = !best
      ? null
      : shortcutPaths(hints, entry).map((p) => p.toLowerCase()).includes(best.toLowerCase())
        ? 'shortcut'
        : uninstallPaths(hints, entry).map((p) => p.toLowerCase()).includes(best.toLowerCase())
          ? 'registry'
          : 'scan'

    return {
      id: entry.id,
      name: entry.name,
      hint: entry.hint,
      installed: !!best,
      path: best || null,
      source,
      manualPath: '',
      launch,
      candidates: candidates.slice(0, 5)
    }
  })

  return { ok: true, at: Date.now(), platform: process.platform, clients }
}

/**
 * 按 provider 找它该关联的客户端 id。
 *
 * 目前只映射到真实存在的两家：MiniMax 两个路由都归 MiniMax 客户端。
 * deepseek-account 的归属还没定（用户说要另行确认），这里**故意不映射**，
 * 保持「不额外拉起任何客户端」的现状。
 */
export const PROVIDER_CLIENT = Object.freeze({
  minimax: 'minimax',
  'minimax-cn': 'minimax'
})

export function clientIdForProvider(provider) {
  return PROVIDER_CLIENT[String(provider || '').trim()] || null
}

/**
 * 按需拉起客户端（只在用户勾了「关联启动」时才该调用）。
 * @returns {{ok: boolean, reason: string, client?: string, path?: string, pid?: number}}
 */
export async function launchClientForProvider(provider, { timeoutMs = 8000 } = {}) {
  const id = clientIdForProvider(provider)
  if (!id) return { ok: false, reason: `提供方 ${provider || '(空)'} 没有关联的客户端`, skipped: true }
  // 先看开关：默认全关，关着就不必扫描（扫描会起 PowerShell，没必要每次都跑）
  const cfg = readClientConfig()
  if (!cfg.clients[id]?.launch) {
    return { ok: false, reason: `${CLIENT_CATALOG.find((c) => c.id === id)?.name || id} 没有勾选「关联启动」`, client: id, skipped: true }
  }
  const res = await scanClients({ timeoutMs })
  const c = (res.clients || []).find((x) => x.id === id)
  if (!c) return { ok: false, reason: `没有 ${id} 这个客户端` }
  if (!c.installed || !c.path) return { ok: false, reason: `${c.name} 未检测到可执行文件`, client: id }
  try {
    const child = spawn(c.path, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      cwd: path.dirname(c.path)
    })
    child.unref()
    return { ok: true, reason: `已拉起 ${c.name}`, client: id, path: c.path, pid: child.pid }
  } catch (e) {
    return { ok: false, reason: `拉起 ${c.name} 失败：${e?.message || e}`, client: id, path: c.path }
  }
}
