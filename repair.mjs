// auto-repair · 修复执行模块
//
// 职责：执行**已被诊断确认**的修复动作。
//
// 安全阀（缺一不可）：
//   ① 白名单：只有 FIXERS 里登记过的 code 才允许修。未知 code 一律只上报不修。
//   ② 备份：任何写文件的修复，先备份原文件（带时间戳），留 `.auto-repair.bak`。
//
// ⚠️ 原来还有第三条「频次限制」（同一 code 30 分钟内最多修 N 次）。
//    **已按要求删除**：那条限制会让真故障卡住 —— 比如 BOM 反复被写回，
//    修到第三次就被限流了，剩下的次数只能干看着。
//    现在改成「次数只统计、不阻拦」：counters 里仍然记着每个 code 修过几次，
//    方便事后查，但不再拦人。
//
// 还有一条更重要的规则：
//   **不可逆 / 需要人判断的动作，一律不自动做。**
//   例如「QQ 没登录」——那不是故障，是外部状态；「DSH 进程不存在」——可能是用户主动关的，
//   这类只上报、不擅自拉起。

import fs from 'node:fs'
import path from 'node:path'
import { execSync, spawn } from 'node:child_process'
import { ROOT, DSH_EXE, DSH_HOME, SEVERITY, hasBom, listeningPorts, dshPorts } from './diagnose.mjs'
import { ensureBundlePatch, ensureProfilePatch } from './tools/mcp-registration.mjs'

const STATE = path.join(ROOT, 'auto-repair', 'state')
const COUNTER_FILE = path.join(STATE, 'repair-counter.json')
const HISTORY_FILE = path.join(STATE, 'repair-history.jsonl')

// counters 里每个 code 最多记多少条（只是统计，别让文件无限长）
const COUNTER_KEEP = 50

// ── 计数器 ──────────────────────────────────────────────────────────────────

function loadCounters() {
  try {
    return JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return {}
  }
}

function saveCounters(c) {
  fs.mkdirSync(STATE, { recursive: true })
  fs.writeFileSync(COUNTER_FILE, JSON.stringify(c, null, 2), 'utf8')
}

/**
 * 记一次修复尝试。
 *
 * ⚠️ 以前这里叫 takeQuota()，还会**拦人**（超出窗口上限就不许修）。
 *    频次限制已删除，现在只统计不阻拦 —— 留着是为了事后能查
 *    「这个 code 到底修过几次」。
 */
function recordAttempt(code) {
  try {
    const counters = loadCounters()
    const list = Array.isArray(counters[code]) ? counters[code] : []
    list.push(Date.now())
    counters[code] = list.slice(-COUNTER_KEEP)
    saveCounters(counters)
  } catch {}
}

function appendHistory(entry) {
  try {
    fs.mkdirSync(STATE, { recursive: true })
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n', 'utf8')
  } catch {}
}

// ── 工具 ────────────────────────────────────────────────────────────────────

/** 备份文件（带时间戳），返回备份路径；原文件不存在则返回 null */
function backup(file) {
  try {
    if (!fs.existsSync(file)) return null
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dest = `${file}.auto-repair.bak-${stamp}`
    fs.copyFileSync(file, dest)
    return dest
  } catch {
    return null
  }
}

/**
 * 剥掉 UTF-8 BOM —— 带**幂等保护**。
 *
 * ⚠️ 曾经的真实 bug：同一次巡检里 BOM_CRASH 和 LATENT_BOM 会**连续剥两次**，
 * 第二次把 `{` 也吃掉了，文件变成 `"name": ...` → DSH 报
 * 「Unexpected non-whitespace character after JSON at position 10」。
 * 所以这里必须在动手前**重新读一次字节**确认 BOM 还在，绝不能相信调用方的旧判断。
 */
export function stripBomIfPresent(file) {
  const buf = fs.readFileSync(file)
  if (buf.length < 3) return { changed: false, reason: '文件太短' }
  if (!(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)) {
    return { changed: false, reason: '已无 BOM（跳过，避免重复剥离）' }
  }
  const out = buf.subarray(3)
  // 剥离后必须是合法 JSON，否则回滚
  try {
    JSON.parse(out.toString('utf8'))
  } catch (e) {
    return { changed: false, reason: `剥离后不是合法 JSON，已放弃：${e.message}` }
  }
  fs.writeFileSync(file, out)
  return { changed: true, reason: 'BOM 已剥离' }
}

/**
 * 写文件，**强制 UTF-8 无 BOM**。
 * 这正是导致本次事故的那一步——必须保证写出去的文件不会再带 BOM 害死 DSH。
 */
export function writeJsonNoBom(file, obj) {
  const text = JSON.stringify(obj, null, 2) + '\n'
  fs.writeFileSync(file, text, { encoding: 'utf8' })
  // 自检：确保真的没有 BOM
  if (hasBom(file)) {
    const buf = fs.readFileSync(file)
    fs.writeFileSync(file, buf.subarray(3))
  }
  return true
}

function killProcess(pid) {
  try {
    execSync(`taskkill /PID ${pid} /F`, {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 8000
    })
    return true
  } catch {
    return false
  }
}

function killDsh() {
  try {
    const out = execSync(
      'tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /FO CSV',
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }
    )
    const pids = []
    for (const line of out.split(/\r?\n/)) {
      const m = /^"DeepSeek Harness\.exe","(\d+)"/.exec(line)
      if (m) pids.push(Number(m[1]))
    }
    for (const p of pids) killProcess(p)
    return pids
  } catch {
    return []
  }
}

async function startDshAsync() {
  try {
    if (!fs.existsSync(DSH_EXE)) return 0
    const child = spawn(DSH_EXE, [], {
      cwd: ROOT,
      detached: true,
      windowsHide: true,
      stdio: 'ignore'
    })
    child.unref()
    return child.pid
  } catch {
    return 0
  }
}

// ── 修复动作（白名单） ──────────────────────────────────────────────────────

/**
 * 每个 fixer 返回 { ok: boolean, action: string, detail?: string }
 * 只处理诊断已经确认的 code。
 */
export const FIXERS = {
  /**
   * BOM 崩溃：剥掉 BOM → 重启 DSH。
   * 这是本次事故的正主，也是最好修的一类。
   */
  async BOM_CRASH(f) {
    const file = f.evidence.culprit
    if (!file || !fs.existsSync(file)) {
      return { ok: false, action: '找不到元凶文件' }
    }
    const bak = backup(file)
    const r = stripBomIfPresent(file)

    if (!r.changed) {
      return { ok: false, action: `未能剥离 BOM：${r.reason}` }
    }

    const killed = killDsh()
    await sleep(3000)
    const pid = await startDshAsync()
    return {
      ok: true,
      action: '已剥离 BOM 并重启 DSH',
      detail: `文件=${file}\n备份=${bak || '(无)'}\n结束进程=${killed.join(',') || '无'}\n新进程pid=${pid}`
    }
  },

  /**
   * 潜伏 BOM：还没崩，但改掉以免下次启动暴毙。
   * 不重启 DSH —— 它现在跑得好好的，没必要打断。
   */
  async LATENT_BOM(f) {
    const files = f.evidence.files || []
    if (!files.length) return { ok: false, action: '没有目标文件' }
    const done = []
    const failed = []
    for (const file of files) {
      try {
        backup(file)
        const r = stripBomIfPresent(file)
        if (r.changed) done.push(file)
        else failed.push(`${file}（${r.reason}）`)
      } catch (e) {
        failed.push(`${file}（${e.message}）`)
      }
    }
    return {
      ok: done.length > 0,
      action: `已剥离 ${done.length} 个文件的 BOM（未重启 DSH）`,
      detail: [...done.map((x) => '  ✓ ' + x), ...failed.map((x) => '  ✗ ' + x)].join('\n')
    }
  },

  /**
   * 桥接不在：拉起来。
   * 端口由 start-bridge.mjs 自己探测 DSH 并对齐。
   */
  async BRIDGE_DOWN() {
    const starter = path.join(ROOT, 'qq-bridge', 'start-bridge.mjs')
    if (!fs.existsSync(starter)) return { ok: false, action: '缺 start-bridge.mjs' }
    const out = fs.openSync(path.join(ROOT, 'state', 'auto-repair-bridge.log'), 'a')
    const err = fs.openSync(path.join(ROOT, 'state', 'auto-repair-bridge.err.log'), 'a')
    const child = spawn(process.execPath, [starter], {
      cwd: path.join(ROOT, 'qq-bridge'),
      detached: true,
      windowsHide: true,
      stdio: ['ignore', out, err]
    })
    child.unref()
    return { ok: true, action: '已拉起桥接', detail: `pid=${child.pid}` }
  },

  /**
   * 桥接连不上 DSH：重启桥接，让它重新读对齐后的 baseUrl。
   */
  async BRIDGE_DSH_STALE() {
    const ports = listeningPorts()
    const pid = ports.get(3100)
    if (pid) killProcess(pid)
    await sleep(3000)
    const starter = path.join(ROOT, 'qq-bridge', 'start-bridge.mjs')
    const out = fs.openSync(path.join(ROOT, 'state', 'auto-repair-bridge.log'), 'a')
    const err = fs.openSync(path.join(ROOT, 'state', 'auto-repair-bridge.err.log'), 'a')
    const child = spawn(process.execPath, [starter], {
      cwd: path.join(ROOT, 'qq-bridge'),
      detached: true,
      windowsHide: true,
      stdio: ['ignore', out, err]
    })
    child.unref()
    return {
      ok: true,
      action: '已重启桥接以重新对齐 DSH 端口',
      detail: `旧pid=${pid || '无'} 新pid=${child.pid}`
    }
  },

  /**
   * MCP 注册丢了：把两层都补回去。
   *
   * bundle 层是权威（DSH 只在启动时读，永远不重写）；
   * profile 层是热备（DSH 保存设置时会重写它，外部托管的行会被抹掉）。
   * 两层都补，才不会下次保存设置又断一次。
   *
   * 这里**不重启 DSH**：profile 层若支持热重载则立即生效，
   * bundle 层在下次启动时生效。重启会打断用户正在跑的会话，
   * 那种情况交给 MCP_CLIENTS_DOWN 上报，人来决定。
   */
  async MCP_PATCH_MISSING(f) {
    const bundleFile = f.evidence.bundlePatch
    const profileFile = f.evidence.profilePatch
    const lines = []
    let changed = false

    const b = ensureBundlePatch(bundleFile)
    lines.push(`bundle 层：${b.reason}`)
    if (b.changed) changed = true

    const p = ensureProfilePatch(profileFile)
    lines.push(`profile 层：${p.reason}`)
    if (p.changed) changed = true

    return {
      ok: changed,
      action: changed ? '已补回 MCP 工具注册（两层）' : 'MCP 注册本就齐全，未改动',
      detail: lines.join('\n')
    }
  },

  /**
   * profile 层热备没了：补回去。
   * bundle 层兜着，不影响运行，但补上能让下一次 DSH 保存设置后仍有余量。
   */
  async MCP_PROFILE_BACKUP_MISSING(f) {
    const p = ensureProfilePatch(f.evidence.profilePatch)
    return {
      ok: p.changed,
      action: p.changed ? '已补回 profile 层的 MCP 热备' : `无需补：${p.reason}`,
      detail: p.changed ? `文件=${f.evidence.profilePatch}` : ''
    }
  }
}

// ── 不自动修的：需要人判断 ──────────────────────────────────────────────────
//
// DSH_DEAD       —— 可能是用户主动关的，擅自拉起会打断人家
// DSH_NO_PORT    —— 可能在启动中，误杀更糟
// BRIDGE_WS_DOWN —— OneBot 在线但 WS 连不上，原因可能是 token 不匹配，需人工查
// QQ_OFFLINE     —— 外部状态，等 QQ 登录
// 这些只上报。

export const NEEDS_HUMAN = new Set([
  'DSH_DEAD',
  'DSH_NO_PORT',
  'BRIDGE_WS_DOWN',
  'QQ_OFFLINE',
  // 重启 DSH 会打断用户正在跑的会话 —— 这属于要人拍板的事，只上报。
  'MCP_CLIENTS_DOWN'
])

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 执行一次修复。
 * 返回 { code, attempted, ok, action, detail }
 */
export async function applyRepair(f) {
  const entry = {
    code: f.code,
    title: f.title,
    severity: f.severity,
    at: Date.now()
  }

  if (NEEDS_HUMAN.has(f.code)) {
    entry.attempted = false
    entry.ok = false
    entry.action = '需人工判断，未自动处理'
    appendHistory(entry)
    return entry
  }

  const fixer = FIXERS[f.code]
  if (!fixer) {
    entry.attempted = false
    entry.ok = false
    entry.action = '无对应修复器（白名单外）'
    appendHistory(entry)
    return entry
  }

  entry.attempted = true
  recordAttempt(f.code)
  try {
    const r = await fixer(f)
    entry.ok = !!r.ok
    entry.action = r.action
    if (r.detail) entry.detail = r.detail
  } catch (e) {
    entry.ok = false
    entry.action = `修复过程抛异常：${e?.message || e}`
  }
  appendHistory(entry)
  return entry
}
