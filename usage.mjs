// 本地用量账本（插件「用量」页的数据源）。
//
// 口径：只记本机观察到的调用，**不是厂商账单**。价格在读取时用价目表折算，
// 价目表里没有的模型一律标「未计价」，不猜价格。
//
// 两个来源合并读取：
//   1. 本文件：`state/usage.jsonl`，逐条 JSON（修复 / 队列 / 桥接兜底等由本仓库发起的调用）。
//   2. 桥接既有账本：`qq-bridge/state/token-usage.jsonl` 的 `k:"turn"` 行，
//      那是全天回复每一轮里每一次模型请求的 token 采样（已按 turn/step/retry 去重）。
//
// 保留 90 天；追加时低频清理，清理走锁 + 临时文件原子替换，避免并发写丢行。
import fs from 'node:fs'
import path from 'node:path'

const ROOT = 'D:\\大肥鱼'
export const USAGE_FILE = path.join(ROOT, 'auto-repair', 'state', 'usage.jsonl')
const TOKEN_LEDGER_FILE = path.join(ROOT, 'qq-bridge', 'state', 'token-usage.jsonl')
const LOCK_FILE = path.join(ROOT, 'auto-repair', 'state', 'usage.lock')
const KEEP_DAYS = 90
const MAX_BYTES = 4 * 1024 * 1024

const SOURCES = new Set(['repair', 'queue', 'reply', 'bridge'])

function sumInput(b) {
  return (b?.cacheMiss ?? 0) + (b?.cacheHit ?? 0) + (b?.cacheWrite ?? 0)
}

/** 归一化一条待落盘记录；字段尽量短，避免账本膨胀。 */
function normalize(entry) {
  if (!entry || typeof entry !== 'object') return null
  const t = Number(entry.t) || Date.now()
  const src = SOURCES.has(entry.src) ? entry.src : 'repair'
  const b = entry.b && typeof entry.b === 'object' ? {
    cacheMiss: Number(entry.b.cacheMiss) || 0,
    cacheHit: Number(entry.b.cacheHit) || 0,
    cacheWrite: Number(entry.b.cacheWrite) || 0,
    output: Number(entry.b.output) || 0
  } : null
  const input = Number.isFinite(Number(entry.input)) ? Math.max(0, Math.round(Number(entry.input))) : (b ? sumInput(b) : 0)
  const output = Number.isFinite(Number(entry.output)) ? Math.max(0, Math.round(Number(entry.output))) : (b?.output ?? 0)
  return {
    v: 1,
    t,
    src,
    // 落盘用短键 p/m，读取时也接受长键 provider/model（老格式兼容）
    p: String(entry.provider ?? entry.p ?? ''),
    m: String(entry.model ?? entry.m ?? ''),
    input,
    output,
    ms: Number.isFinite(Number(entry.ms)) ? Math.max(0, Math.round(Number(entry.ms))) : 0,
    ok: entry.ok !== false,
    err: entry.err ? String(entry.err).slice(0, 120) : '',
    // tokens 是否缺失（调用没回传用量）：UI 显示 0 并标注「缺失」
    missing: entry.missing === true,
    test: entry.test === true,
    ...(b ? { b } : {})
  }
}

/** 低频清理：超过 90 天的行删掉；失败不影响本次追加。 */
function maybePrune(force = false) {
  try {
    const st = fs.statSync(USAGE_FILE)
    if (!force && st.size < MAX_BYTES) return
  } catch {
    return
  }
  let lock = null
  try {
    lock = fs.openSync(LOCK_FILE, 'wx')
  } catch {
    return // 别的进程正在清理，跳过
  }
  try {
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000
    const kept = []
    for (const line of fs.readFileSync(USAGE_FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const rec = JSON.parse(line)
        if (Number(rec?.t) >= cutoff) kept.push(JSON.stringify(rec))
      } catch { /* 坏行直接丢弃 */ }
    }
    const tmp = `${USAGE_FILE}.tmp`
    fs.writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '', 'utf8')
    fs.renameSync(tmp, USAGE_FILE)
  } finally {
    try { fs.closeSync(lock) } catch {}
    try { fs.unlinkSync(LOCK_FILE) } catch {}
  }
}

/** 追加一条调用记录。任何异常都不向外抛，记账不能影响调用主链路。 */
export function appendUsage(entry, { prune = false } = {}) {
  const rec = normalize(entry)
  if (!rec) return false
  try {
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true })
    fs.appendFileSync(USAGE_FILE, JSON.stringify(rec) + '\n', 'utf8')
    if (prune) maybePrune(true)
    return true
  } catch {
    return false
  }
}

function readJsonLines(file) {
  const out = []
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return out }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* 跳过坏行 */ }
  }
  return out
}

/**
 * 合并读取两个账本，返回统一结构的原始记录（不含价格，价格由调用方按价目表折算）。
 * @param {object} opts
 * @param {number} opts.sinceMs 只看这个时间之后的记录
 * @param {boolean} [opts.includeTest] 是否包含 test:true 的测试记录
 */
export function readUsageRecords({ sinceMs = 0, includeTest = false } = {}) {
  const since = Number(sinceMs) || 0
  const out = []
  for (const rec of readJsonLines(USAGE_FILE)) {
    if (rec?.test && !includeTest) continue
    if (Number(rec?.t) < since) continue
    const n = normalize(rec)
    if (n) { n.kind = 'ledger'; out.push(n) }
  }
  for (const rec of readJsonLines(TOKEN_LEDGER_FILE)) {
    if (rec?.k !== 'turn') continue
    if (Number(rec?.t) < since) continue
    const b = rec.b && typeof rec.b === 'object' ? {
      cacheMiss: Number(rec.b.cacheMiss) || 0,
      cacheHit: Number(rec.b.cacheHit) || 0,
      cacheWrite: Number(rec.b.cacheWrite) || 0,
      output: Number(rec.b.output) || 0
    } : null
    const input = sumInput(b)
    const output = b?.output ?? 0
    if (input + output <= 0) continue
    out.push({
      v: 1, t: Number(rec.t) || 0, src: 'reply',
      p: String(rec.provider || ''), m: String(rec.model || ''),
      input, output, ms: 0, ok: true, err: '',
      missing: false, test: false, kind: 'reply-ledger',
      ...(b ? { b } : {})
    })
  }
  out.sort((a, b) => a.t - b.t)
  return out
}

/** 删掉所有 test:true 的测试记录（验证完清场用）。返回删掉的行数。 */
export function purgeTestRecords() {
  let lock = null
  try { lock = fs.openSync(LOCK_FILE, 'wx') } catch { return -1 }
  try {
    const kept = []
    let dropped = 0
    for (const rec of readJsonLines(USAGE_FILE)) {
      if (rec?.test === true) { dropped += 1; continue }
      kept.push(JSON.stringify(rec))
    }
    const tmp = `${USAGE_FILE}.tmp`
    fs.writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '', 'utf8')
    fs.renameSync(tmp, USAGE_FILE)
    return dropped
  } catch {
    return -1
  } finally {
    try { fs.closeSync(lock) } catch {}
    try { fs.unlinkSync(LOCK_FILE) } catch {}
  }
}
