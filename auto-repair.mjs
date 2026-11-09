// auto-repair · 大肥鱼自愈守护
//
// 每 N 秒跑一轮：诊断 → 按**审批策略**决定动不动手 → 修完/修不了都播报。
//
// 定位：这是 **DSH 之外** 的守护进程。
// 为什么不能做成 DSH 插件？因为 DSH 自己起不来的时候插件也加载不了 ——
// 而「起不来」恰恰是最需要自动修的那一类（package.json 带 BOM 就是这么来的）。
// 所以它必须活在 DSH 之外，像 supervisor / watchdog / port-guard 那样独立常驻。
//
// 审批策略（见 policy.mjs，用户在设置页里改）：
//
//   manual       逐条审批（**默认**）
//                守护进程只诊断、只报告，**不自动动手**。
//                用户点某条错误的「修复」才真的修（= --repair <code>）。
//   approve-all  全部自动 —— 守护进程发现能修的直接修。
//   reject-all   全拒绝 —— 一律不修，面板上的修复按钮也禁用，只做报告。
//
// 「无法自动修复的让 AI 自己修」：
//   阶梯是「先插件、后模型」：能自动修的先动手修；修完仍然报错、或者压根没有
//   修复器时，才在 agentAssist 开启时**交给一个 DSH agent 会话**（见 agent-repair.mjs）。
//   autoFeed 开启时，会把报错原文自动投喂进那个会话（开头标【自动投喂·自愈面板】），
//   同一个报错按特征哈希 + 30 分钟窗口去重；缺 Key / 路由未启用这类配置问题只提示、不投喂。
//
// 用法：
//   node auto-repair.mjs                # 常驻巡检
//   node auto-repair.mjs --once         # 跑一轮就退出（按策略，排查用）
//   node auto-repair.mjs --check        # 只诊断不修复，输出 JSON
//   node auto-repair.mjs --repair CODE  # 手动修某一条（= 面板上点「修复」）
//   node auto-repair.mjs --repair-all    # 手动把能修的一次修完
//   node auto-repair.mjs --agent CODE    # 把某一条交给 AI 会话去修（手动拍板）
//   node auto-repair.mjs --get-policy   # 输出当前策略 JSON
//   node auto-repair.mjs --set-policy '{"mode":"approve-all"}'  # 改策略
//   node auto-repair.mjs --models       # 列出可选的 AI 模型/提供方 + 当前选择
//   node auto-repair.mjs --get-model    # 输出当前选择的模型
//   node auto-repair.mjs --set-model '{"provider":"minimax","model":"MiniMax-M3"}'

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { diagnoseAll, SEVERITY, ROOT, dshPorts } from './diagnose.mjs'
import { applyRepair, FIXERS, NEEDS_HUMAN } from './repair.mjs'
import { notify } from './notify.mjs'
import { readPolicy, writePolicy, canAutoRepair, isRejected, MODES } from './policy.mjs'
import { readHandoffs, writeHandoff, feedHashOf, shouldFeed, markFed } from './agent-repair.mjs'
import { listModels, readChoice, writeChoice, findModel, readinessOf } from './models.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STATE = path.join(HERE, 'state')
const LOG = path.join(STATE, 'auto-repair.log')
const PIDFILE = path.join(STATE, 'auto-repair.pid')
const AGENT_LOG = path.join(STATE, 'agent-repair.log')
const AGENT_ENTRY = path.join(HERE, 'agent-repair.mjs')

const INTERVAL = Number(process.env.AUTO_REPAIR_INTERVAL_MS || 30000)

fs.mkdirSync(STATE, { recursive: true })

// ── 命令行参数 ──────────────────────────────────────────────────────────────

const ARGS = process.argv.slice(2)
const argOf = (name, fallback = '') => {
  const i = ARGS.indexOf(name)
  return i >= 0 ? String(ARGS[i + 1] ?? '').trim() : fallback
}

// --check / --repair / --repair-all / --get-policy / --set-policy 是**命令式调用**
// （面板会调、排查时会调），stdout 必须**只有 JSON**，否则调用方解析不了。
// 所以那时日志只落文件，不写 stdout。
const JSON_ONLY = ARGS.some((a) =>
  ['--check', '--repair', '--repair-all', '--agent', '--get-policy', '--set-policy',
    '--models', '--get-model', '--set-model'].includes(a)
)
const QUIET_STDOUT = JSON_ONLY

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}`
  try {
    fs.appendFileSync(LOG, line + '\n', 'utf8')
  } catch {}
  if (!QUIET_STDOUT) console.log(line)
}

// ── 单实例锁 ────────────────────────────────────────────────────────────────

function acquireLock() {
  try {
    const old = Number(String(fs.readFileSync(PIDFILE, 'utf8')).trim())
    if (old && old !== process.pid) {
      try {
        process.kill(old, 0)
        return old   // 已经有一个在跑
      } catch {
        // 进程不在了，锁是陈旧的
      }
    }
  } catch {}
  fs.writeFileSync(PIDFILE, String(process.pid), 'utf8')
  return 0
}

// ⚠️ 命令式调用（--check / --once / --repair …）**不受单实例锁限制**：
//   - --check 只读诊断，多跑几个完全无害
//   - --once 是「手动修一轮」，本来就该允许在守护进程运行时手动触发
//   - --repair 是面板上点了「修复」，更该允许
// 只有「常驻模式」才需要独占锁 —— 否则两个常驻进程会互相打架。
const IS_ONESHOT = JSON_ONLY || ARGS.includes('--once')

if (!IS_ONESHOT) {
  const existing = acquireLock()
  if (existing) {
    log(`已有 auto-repair 在跑 (pid=${existing}))，本实例退出`)
    process.exit(0)
  }
  process.on('exit', () => {
    try {
      if (Number(String(fs.readFileSync(PIDFILE, 'utf8')).trim()) === process.pid) fs.unlinkSync(PIDFILE)
    } catch {}
  })
}

// ── 判定辅助 ────────────────────────────────────────────────────────────────

/** 这个 code 有没有白名单修复器 */
export function isFixable(f) {
  return !!FIXERS[f.code] && !NEEDS_HUMAN.has(f.code)
}

/**
 * 自动交给 agent 时**跳过**的 code。
 *
 * 理由各不相同，但结论一样：这些不该自动烧 token（或者根本拉不起来）。
 *   QQ_OFFLINE      外部状态 —— 等 QQ 登录自己就好了
 *   DSH_DEAD        DSH 自己不在 —— agent 就住在 DSH 里，DSH 没了拉不动它
 *   DSH_NO_PORT     同上（可能在启动中）
 *   MCP_CLIENTS_DOWN 修它要重启 DSH —— 那会把正在干活的 agent 自己杀掉
 *
 * 用户**手动**点「让 AI 修」时不受这个限制（除了 DSH 根本不在的情况），
 * 因为那是用户明确拍板的。
 */
const AGENT_AUTO_SKIP = new Set([
  'QQ_OFFLINE',
  'DSH_DEAD',
  'DSH_NO_PORT',
  'MCP_CLIENTS_DOWN'
])

/** 同一个 code 交给 AI 的冷却时间：30 分钟内不重复叫 */
const AGENT_COOLDOWN_MS = 30 * 60 * 1000

function agentCooldownOk(code, handoffs) {
  const h = handoffs?.[code]
  if (!h) return true
  const last = Number(h.startedAt || h.updatedAt || 0)
  if (!last) return true
  return Date.now() - last > AGENT_COOLDOWN_MS
}

// ── 「这一次走的是哪条路」 ────────────────────────────────────────────────────
//
// 面板要能直接看出来：这条问题是插件修好的，还是升级给模型了。
// 记在 state/repair-outcomes.json，每轮覆盖，读起来比翻日志快。
const OUTCOME_FILE = path.join(STATE, 'repair-outcomes.json')

export function readOutcomes() {
  try {
    const doc = JSON.parse(fs.readFileSync(OUTCOME_FILE, 'utf8').replace(/^\uFEFF/, ''))
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {}
  } catch {
    return {}
  }
}

function writeOutcome(code, route, detail = '') {
  const all = readOutcomes()
  all[String(code)] = { route, detail: String(detail).slice(0, 200), at: Date.now() }
  try {
    fs.mkdirSync(STATE, { recursive: true })
    fs.writeFileSync(OUTCOME_FILE, JSON.stringify(all, null, 2) + '\n', 'utf8')
  } catch {}
}

// 模型可用性查一次就够：一轮巡检里所有问题用的是同一个模型。
let readinessMemo = { at: 0, value: null }

/** 当前选中的模型现在能不能用（缺 Key / 路由未启用会被拦下） */
async function currentReadiness() {
  if (readinessMemo.value && Date.now() - readinessMemo.at < 5 * 60 * 1000) {
    return readinessMemo.value
  }
  const choice = readChoice()
  if (!choice) {
    const value = { ok: true, code: null, reason: '跟随 DSH 默认模型', provider: null, model: null }
    readinessMemo = { at: Date.now(), value }
    return value
  }
  let providers = []
  try {
    const catalog = await listModels({ timeoutMs: 6000 })
    providers = catalog.providers || []
  } catch {
    providers = []
  }
  const r = readinessOf(providers, choice.provider, choice.model)
  const value = { ...r, provider: choice.provider, model: choice.model }
  readinessMemo = { at: Date.now(), value }
  return value
}

/**
 * 把问题交给 DSH agent 去修（后台跑，面板不等它）。
 * @returns {{ok: boolean, reason: string}}
 */
function spawnAgentHandoff(finding, { manual = false } = {}) {
  if (!fs.existsSync(AGENT_ENTRY)) {
    return { ok: false, reason: '找不到 agent-repair.mjs，交接失败' }
  }
  // agent 住在 DSH 里 —— DSH 自己没在跑就拉不动它
  if (!dshPorts().length) {
    return { ok: false, reason: 'DSH 本身没在跑，拉不起 AI 协助（这题只能人工处理）' }
  }
  try {
    const out = fs.openSync(AGENT_LOG, 'a')
    // 自动升级带 --auto：会话里的消息会标【自动投喂·自愈面板】，和手点区分开。
    const argv = [AGENT_ENTRY, '--code', String(finding.code)]
    if (!manual) argv.push('--auto')
    const child = spawn(process.execPath, argv, {
      cwd: HERE,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', out, out]
    })
    child.unref()
    writeHandoff(String(finding.code), {
      status: 'queued',
      startedAt: Date.now(),
      reply: '',
      source: manual ? 'manual' : 'auto',
      trigger: manual ? 'manual' : 'auto',
      route: 'model'
    })
    log(`   🤖 已拉起 AI 协助修复（pid=${child.pid}，它会自己复核并动手）`)
    return { ok: true, reason: `已拉起 AI 协助（pid=${child.pid}）` }
  } catch (e) {
    const reason = `拉起 AI 协助失败：${e?.message || e}`
    log(`   ⚠️ ${reason}`)
    return { ok: false, reason }
  }
}

/**
 * 判断要不要把这条问题交给 agent。
 *
 * 自动这条路（manual=false）多两道闸：
 *   - autoFeed 关掉 → 不投喂（也就没有自动升级的必要），直接跳过
 *   - 缺 Key / 路由未启用 → 配置问题，只提示不投喂
 *   - 同一份报错 30 分钟内投喂过 → 去重，不死循环
 *
 * @returns {'skipped'|'cooldown'|'duplicate'|'config'|'spawned'}
 */
async function maybeHandoff(finding, policy, handoffs, { manual = false } = {}) {
  if (!policy.agentAssist) return 'skipped'
  if (policy.mode === 'reject-all') return 'skipped'
  if (isRejected(finding.code, policy)) return 'skipped'
  if (!manual && AGENT_AUTO_SKIP.has(finding.code)) return 'skipped'
  if (finding.severity === SEVERITY.INFO && !manual) return 'skipped'
  if (!agentCooldownOk(finding.code, handoffs)) {
    log('   ℹ️ 30 分钟内已经叫过 AI 了，等冷却完再叫')
    return 'cooldown'
  }

  if (!manual) {
    if (policy.autoFeed === false) {
      log('   ℹ️ 自动投喂已关闭，不把报错送进模型会话')
      return 'skipped'
    }
    // 配置问题（缺 Key / 路由未启用）不投喂：灌进去也只会再报一次。
    const ready = await currentReadiness()
    if (!ready.ok) {
      log(`   ⚠️ 当前模型用不了，不自动投喂：${ready.reason}`)
      return 'config'
    }
    const hash = feedHashOf(finding)
    const dup = shouldFeed(hash)
    if (!dup.ok) {
      const mins = Math.round((Date.now() - dup.lastAt) / 60000)
      log(`   ℹ️ 同一报错 ${mins} 分钟前已投喂过，跳过（去重）`)
      return 'duplicate'
    }
    const r = spawnAgentHandoff(finding, { manual: false })
    if (r.ok) markFed(hash, finding)
    return r.ok ? 'spawned' : 'skipped'
  }

  return spawnAgentHandoff(finding, { manual: true }).ok ? 'spawned' : 'skipped'
}

// ── 核心：一轮巡检 ──────────────────────────────────────────────────────────

let lastNotified = new Map()

/**
 * 跑一轮。
 *
 * @param {object} opts
 * @param {boolean} opts.dryRun      只诊断不修
 * @param {object}  opts.policy      策略（默认现读）
 * @param {boolean} opts.forceRepair 不看 manual 模式，一律修（面板上点「修复」时用）
 */
async function runOnce({ dryRun = false, policy = readPolicy(), forceRepair = false } = {}) {
  let findings
  try {
    findings = await diagnoseAll()
  } catch (e) {
    log(`❌ 诊断异常: ${e?.message || e}`)
    return
  }

  if (!findings.length) {
    log('巡检 ok：一切正常')
    return
  }

  const handoffs = readHandoffs()

  for (const f of findings) {
    const icon = f.severity === SEVERITY.FATAL ? '🔴' : f.severity === SEVERITY.WARN ? '🟡' : '🔵'
    log(`${icon} [${f.code}] ${f.title}`)

    if (dryRun) {
      log(`   （dry-run，不执行修复）${f.detail}`)
      continue
    }

    // ① 用户明确忽略过的 → 一律不动，也不叫 AI
    if (isRejected(f.code, policy)) {
      log('   ⛔ 你标记过「忽略」，跳过')
      continue
    }

    // ② 全拒绝 → 一律不动，也不叫 AI
    if (policy.mode === 'reject-all') {
      log('   ⛔ 策略是「全拒绝」，不自动处理')
      continue
    }

    // ③ 能不能自动动手
    const allowed = forceRepair || canAutoRepair(f.code, policy)

    if (!allowed) {
      // 逐条审批模式：只报告，等人在面板上点
      log('   ⏸ 逐条审批模式：等你在设置页点「修复」')
      if (f.severity === SEVERITY.FATAL) {
        const last = lastNotified.get(f.code) || 0
        if (Date.now() - last > 10 * 60 * 1000) {
          await notify(`❓ 待你审批：${f.title}`, `${f.detail}\n\n打开设置页 → 自愈 → 点「修复」。`, 'l1')
          lastNotified.set(f.code, Date.now())
        }
      }
      // 修不了的 ⇒ 交给 AI（manual 模式下也允许，这条与模式无关）
      if (!isFixable(f)) {
        const r = await maybeHandoff(f, policy, handoffs, { manual: false })
        if (r === 'spawned') writeOutcome(f.code, 'model', '插件没有对应的修复器，已升级给模型')
      }
      continue
    }

    // ④ 动手修
    const r = await applyRepair(f)

    if (r.ok) {
      log(`   ✅ ${r.action}`)
      if (r.detail) log(r.detail.split('\n').map((l) => '      ' + l).join('\n'))
      writeOutcome(f.code, 'plugin', r.action)
      await notify(`✅ 自动修复：${f.title}`, `${r.action}\n${r.detail || f.detail}`, 'l1')
    } else {
      const needHuman = r.action.includes('需人工')
      log(`   ${needHuman ? 'ℹ️' : '⚠️'} ${r.action}`)
      // 只对需要人管的严重问题播报，避免刷屏
      if (f.severity === SEVERITY.FATAL && !needHuman) {
        await notify(`⚠️ 自动修复未成功：${f.title}`, `${r.action}\n${f.detail}`, 'sos')
      } else if (needHuman && (f.severity === SEVERITY.FATAL || f.severity === SEVERITY.WARN)) {
        // 同一个问题 10 分钟内只播报一次
        const last = lastNotified.get(f.code) || 0
        if (Date.now() - last > 10 * 60 * 1000) {
          const hint = f.code === 'MCP_CLIENTS_DOWN'
            ? '\n\n处理办法：运行 node D:\\大肥鱼\\restart-dsh.mjs 2 重启 DSH，MCP client 会随启动重新拉起。'
            : ''
          await notify(`❓ 需要你处理：${f.title}`, f.detail + hint, f.severity === SEVERITY.FATAL ? 'sos' : 'l1')
          lastNotified.set(f.code, Date.now())
        }
      }
      // 修不好 ⇒ 交给 AI（插件这条路没走通，才升级到模型）
      const hr = await maybeHandoff(f, policy, handoffs, { manual: false })
      if (hr === 'spawned') writeOutcome(f.code, 'model', `插件修复未成功（${r.action}），已升级给模型`)
    }
  }
}

// ── 手动修复（面板上点按钮走这里） ───────────────────────────────────────────

/**
 * 手动修某一条 —— 等价于「用户在面板上点了这一条的修复」。
 *
 * 会绕过 manual 模式（否则点了也没用），但**仍然尊重 reject-all**：
 * 全拒绝就是全拒绝，面板上的按钮也应该点不动。
 */
async function repairCodes(codes, { policy = readPolicy() } = {}) {
  if (policy.mode === 'reject-all') {
    return { ok: false, error: '当前策略是「全拒绝」，不执行任何修复。请先在设置页改回「逐条审批」或「全部自动」。' }
  }
  const wanted = new Set(codes.map((c) => String(c).trim()).filter(Boolean))
  const findings = await diagnoseAll()
  const targets = findings.filter((f) => wanted.has(String(f.code)))
  if (!targets.length) {
    return { ok: false, error: `当前没有 ${[...wanted].join('、')} 这类问题（可能已经自己好了）` }
  }
  const results = []
  for (const f of targets) {
    const r = await applyRepair(f)
    if (r.ok) writeOutcome(f.code, 'plugin', r.action)
    results.push(r)
    log(`手动修复 [${f.code}] → ${r.ok ? '✅' : '⚠️'} ${r.action}`)
  }
  const okCount = results.filter((r) => r.ok).length
  return {
    ok: okCount > 0,
    code: targets[0].code,
    repaired: okCount,
    total: results.length,
    results
  }
}

/** 把诊断结果整成带「能不能修 / 要不要人管 / 上一次走的哪条路」的形状，给面板用 */
function enrich(findings, policy) {
  const handoffs = readHandoffs()
  const outcomes = readOutcomes()
  return findings.map((f) => {
    const outcome = outcomes[String(f.code)] || null
    return {
      ...f,
      fixable: isFixable(f),
      needsHuman: NEEDS_HUMAN.has(f.code),
      rejected: isRejected(f.code, policy),
      autoApproved: canAutoRepair(f.code, policy),
      handoff: handoffs[String(f.code)] || null,
      // 'plugin' = 插件自己修好了；'model' = 已升级给模型；null = 还没走过任何一条
      route: outcome?.route || null,
      routeAt: Number(outcome?.at) || 0,
      routeDetail: outcome?.detail || ''
    }
  })
}

// ── 入口 ────────────────────────────────────────────────────────────────────

if (ARGS.includes('--get-policy')) {
  console.log(JSON.stringify({ ok: true, policy: readPolicy(), modes: MODES }))
  process.exit(0)
}

if (ARGS.includes('--set-policy')) {
  const raw = argOf('--set-policy')
  let patch = {}
  try { patch = JSON.parse(raw || '{}') } catch { patch = {} }
  const policy = writePolicy(patch)
  console.log(JSON.stringify({ ok: true, policy }))
  process.exit(0)
}

if (ARGS.includes('--check')) {
  const policy = readPolicy()
  const findings = await diagnoseAll()
  console.log(JSON.stringify(enrich(findings, policy), null, 2))
  process.exit(0)
}

if (ARGS.includes('--repair')) {
  const code = argOf('--repair')
  if (!code) {
    console.log(JSON.stringify({ ok: false, error: '需要 --repair <CODE>' }))
    process.exit(0)
  }
  const r = await repairCodes([code])
  console.log(JSON.stringify(r))
  process.exit(0)
}

if (ARGS.includes('--repair-all')) {
  const policy = readPolicy()
  if (policy.mode === 'reject-all') {
    console.log(JSON.stringify({ ok: false, error: '当前策略是「全拒绝」，不执行任何修复。' }))
    process.exit(0)
  }
  const findings = await diagnoseAll()
  const codes = findings.filter((f) => isFixable(f)).map((f) => f.code)
  if (!codes.length) {
    console.log(JSON.stringify({ ok: false, error: '当前没有可以自动修复的问题' }))
    process.exit(0)
  }
  const r = await repairCodes(codes)
  console.log(JSON.stringify(r))
  process.exit(0)
}

if (ARGS.includes('--agent')) {
  const code = argOf('--agent')
  if (!code) {
    console.log(JSON.stringify({ ok: false, error: '需要 --agent <CODE>' }))
    process.exit(0)
  }
  const policy = readPolicy()
  if (policy.mode === 'reject-all') {
    console.log(JSON.stringify({ ok: false, error: '当前策略是「全拒绝」，不会拉起 AI 协助。' }))
    process.exit(0)
  }
  if (isRejected(code, policy)) {
    console.log(JSON.stringify({ ok: false, error: `你已忽略 ${code}，不再拉起 AI 协助。` }))
    process.exit(0)
  }
  const findings = await diagnoseAll()
  const targets = findings.filter((f) => String(f.code) === code)
  if (!targets.length) {
    console.log(JSON.stringify({ ok: false, error: `当前没有 ${code} 这个问题（可能已经自己好了）` }))
    process.exit(0)
  }
  const r = spawnAgentHandoff(targets[0], { manual: true })
  console.log(JSON.stringify({ ok: r.ok, code, reason: r.reason }))
  process.exit(0)
}

if (ARGS.includes('--models')) {
  const r = await listModels()
  console.log(JSON.stringify(r))
  process.exit(0)
}

if (ARGS.includes('--get-model')) {
  console.log(JSON.stringify({ ok: true, current: readChoice() }))
  process.exit(0)
}

if (ARGS.includes('--set-model')) {
  const raw = argOf('--set-model')
  let req = {}
  try { req = JSON.parse(raw || '{}') } catch { req = {} }
  const provider = String(req.provider || '').trim()
  const model = String(req.model || '').trim()
  if (!provider || !model) {
    console.log(JSON.stringify({ ok: false, error: '需要 provider 和 model（例：{"provider":"minimax","model":"MiniMax-M3"}）' }))
    process.exit(0)
  }
  const catalog = await listModels()
  if (!findModel(catalog.providers, provider, model)) {
    console.log(JSON.stringify({
      ok: false,
      error: `没有 ${provider}/${model} 这个模型。可选：${(catalog.providers || [])
        .map((p) => `${p.id} → ${(p.models || []).map((m) => m.id).join(', ')}`)
        .join('；')}`
    }))
    process.exit(0)
  }
  const current = writeChoice({ provider, model })
  console.log(JSON.stringify({ ok: true, current }))
  process.exit(0)
}

if (ARGS.includes('--once')) {
  await runOnce()
  process.exit(0)
}

// 常驻模式
log(`===== auto-repair 启动 pid=${process.pid}（每 ${INTERVAL / 1000}s 一轮）=====`)
log(`审批策略：${readPolicy().mode}（改策略下一轮生效，不用重启）`)
let running = true
process.on('SIGINT', () => { running = false; process.exit(0) })
process.on('SIGTERM', () => { running = false; process.exit(0) })

await runOnce()
while (running) {
  await new Promise((r) => setTimeout(r, INTERVAL))
  try {
    await runOnce()
  } catch (e) {
    log(`❌ 巡检异常: ${e?.stack || e}`)
  }
}
