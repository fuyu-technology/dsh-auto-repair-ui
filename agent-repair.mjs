// auto-repair · 把修不了的问题**交给 DSH agent** 去修。
//
// 背景：auto-repair 的修复器是白名单（见 repair.mjs 的 FIXERS），
// 白名单外的故障（DSH 没起来、OneBot 端点不匹配、MCP client 掉了……）
// 只能「上报 + 等人管」。但等人管意味着问题一直挂着。
//
// 这里做的事：**建一个带本地工具的 DSH 会话，把诊断结论当 prompt 投进去**，
// 让 agent（也就是平时帮你写代码的那个）自己去看、自己去改、自己去验证。
//
// 用法：
//   node agent-repair.mjs --code BRIDGE_WS_DOWN     # 针对某个 code
//   node agent-repair.mjs --findings findings.json  # 针对一份诊断结果（数组）
//   node agent-repair.mjs --list                   # 列出当前所有诊断项
//
// 输出（stdout，**只有 JSON**）：
//   { ok, code, sessionId, reply, error }
//
// ⚠️ 这个脚本会**消耗 token**（agent 要跑模型），所以：
//   - 面板触发时是**后台**跑的（detach），面板不等它返回
//   - 守护进程自动触发时有 30 分钟的同 code 冷却

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { diagnoseAll, SEVERITY, ROOT } from './diagnose.mjs'
import { FIXERS, NEEDS_HUMAN } from './repair.mjs'
import { readChoice } from './models.mjs'
import { launchClientForProvider } from './clients.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// 交接记录目录。同样支持 REPAIR_STATE_DIR 覆盖（测试用）。
const STATE = process.env.REPAIR_STATE_DIR
  ? path.resolve(process.env.REPAIR_STATE_DIR)
  : path.join(HERE, 'state')
const HANDOFF_FILE = path.join(STATE, 'agent-handoff.json')
// 自动投喂的去重账本：同一个报错在窗口内只灌一次，避免死循环刷屏。
const FEED_FILE = path.join(STATE, 'feed-state.json')
// 报错全文硬上限（字符）。日志动辄几万字，整块灌进去既烧 token 又没法看。
const PROMPT_LIMIT = 3000
// 同一条报错（按特征哈希）多久之内不再重复投喂。
const FEED_WINDOW_MS = 30 * 60 * 1000
const BRIDGE_DIR = path.join(ROOT, 'qq-bridge')
// agent 的工作区放在大肥鱼根目录：它要能改 qq-bridge / auto-repair 这些地方，
// 工作区太窄会够不着。
const WORKSPACE_DIR = ROOT

const args = process.argv.slice(2)
const argOf = (name, fallback = '') => {
  const i = args.indexOf(name)
  return i >= 0 ? String(args[i + 1] ?? '').trim() : fallback
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return fallback
  }
}

/** 交接记录：面板靠它显示「已拉起 AI 协助」和 agent 的回复 */
export function readHandoffs() {
  const doc = readJson(HANDOFF_FILE, {})
  return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {}
}

export function writeHandoff(code, patch) {
  const all = readHandoffs()
  const prev = all[code] || {}
  all[code] = { ...prev, code, ...patch, updatedAt: Date.now() }
  fs.mkdirSync(STATE, { recursive: true })
  fs.writeFileSync(HANDOFF_FILE, JSON.stringify(all, null, 2) + '\n', 'utf8')
  return all[code]
}

// ── 自动投喂去重 ────────────────────────────────────────────────────────────
//
// 只按「错误特征」去重：code + 级别 + 现象文本。同一份日志反复出现同一行时
// 特征相同，30 分钟内只投喂一次；改了内容（比如错误码变了）就算新问题。

/** 读投喂账本（文件坏了当空账本，不抛错） */
export function readFeedState() {
  const doc = readJson(FEED_FILE, {})
  return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {}
}

/** 一条诊断项的报错特征哈希（不含时间戳，因此同一错误稳定） */
export function feedHashOf(finding) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
  const seed = [
    norm(finding?.code),
    norm(finding?.severity),
    norm(finding?.title),
    norm(finding?.detail).slice(0, 400)
  ].join('|')
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16)
}

/** 这个特征在窗口内投喂过吗？（窗口外的旧记录顺手忽略） */
export function shouldFeed(hash, now = Date.now()) {
  const rec = readFeedState()[hash]
  if (!rec) return { ok: true, lastAt: 0 }
  const last = Number(rec.at) || 0
  if (now - last > FEED_WINDOW_MS) return { ok: true, lastAt: last }
  return { ok: false, lastAt: last }
}

/** 记一笔「已投喂」 */
export function markFed(hash, finding) {
  const all = readFeedState()
  const prev = all[hash] || {}
  all[hash] = {
    code: String(finding?.code || ''),
    at: Date.now(),
    count: (Number(prev.count) || 0) + 1
  }
  // 顺带清掉窗口外的旧键，账本不会无限长大
  const now = Date.now()
  for (const [k, v] of Object.entries(all)) {
    if (now - (Number(v?.at) || 0) > FEED_WINDOW_MS * 4) delete all[k]
  }
  try {
    fs.mkdirSync(STATE, { recursive: true })
    fs.writeFileSync(FEED_FILE, JSON.stringify(all, null, 2) + '\n', 'utf8')
  } catch {}
  return all[hash]
}

/**
 * 组给 agent 的 prompt。
 *
 * 写法上的两个考虑：
 *   - 把「证据」原样带上：agent 能自己去核对，而不是照抄我们的结论。
 *   - 明确「先备份、先复现、不要乱重启」：agent 有本地工具，
 *     而这台机器上的配置/脚本有很多既有约定（见 qq-bridge/RULES.md）。
 *
 * @param {Array} findings 诊断项
 * @param {{note?: string, auto?: boolean}} opts
 *   auto=true 表示这是自愈面板**自动投喂**的报错，开头会打标记，方便在会话里认出来。
 *
 * ⚠️ 全文硬截断在 PROMPT_LIMIT（3000 字）：日志整块灌进去会淹掉真正的结论。
 */
export function buildAgentPrompt(findings, { note = '', auto = false } = {}) {
  const lines = []
  if (auto) {
    lines.push('【自动投喂·自愈面板】下面这段错误是自愈面板自动送进来的，不需要你确认收到，直接定位并修复。')
    lines.push('')
  }
  lines.push('【大肥鱼自愈告警】自动修复器处理不了以下问题，请你出手修。')
  lines.push('')
  for (const f of findings) {
    lines.push(`- 代码：${f.code}`)
    lines.push(`- 级别：${f.severity}`)
    lines.push(`- 标题：${f.title}`)
    if (f.at || f.updatedAt) lines.push(`- 发现时间：${new Date(f.at || f.updatedAt).toLocaleString('zh-CN', { hour12: false })}`)
    lines.push(`- 现象：${String(f.detail || '').replace(/\s+/g, ' ').slice(0, 600)}`)
    const ev = f.evidence && typeof f.evidence === 'object' ? f.evidence : {}
    if (Object.keys(ev).length) {
      lines.push(`- 证据：${JSON.stringify(ev).slice(0, 1200)}`)
    }
    // 有堆栈就单独抬出来：agent 一眼能看到出错的调用链，比翻日志快。
    const stack = typeof ev.stack === 'string' ? ev.stack : ''
    if (stack) {
      lines.push('- 关键堆栈：')
      lines.push(stack.split(/\r?\n/).slice(0, 12).map((l) => '    ' + l.trim()).join('\n'))
    }
    lines.push('')
  }
  if (note) {
    lines.push(`补充说明：${note}`)
    lines.push('')
  }
  lines.push('要求：')
  lines.push('1. 先自己复核一遍问题是否仍然存在（诊断结论可能是几分钟前的旧状态），再动手。')
  lines.push('2. 改动任何文件前先备份；这台机器上的配置和脚本有既有约定，别顺手改无关的地方。')
  lines.push('3. 修完自己验证一遍（能跑就跑一下），并在总结里写清：根因、改了哪些文件、怎么验证的。')
  lines.push('4. 需要重启 DSH 的话，先说明理由，尽量用 D:\\大肥鱼\\restart-dsh.mjs 这个脚本。')
  lines.push(`5. 工作目录：${WORKSPACE_DIR}`)
  lines.push('')
  lines.push('大肥鱼根目录：' + ROOT)

  const out = lines.join('\n')
  if (out.length <= PROMPT_LIMIT) return out
  const tail = `\n…（已截断，原文 ${out.length} 字，完整内容见 ${path.join(STATE, 'auto-repair.log')}）`
  return out.slice(0, PROMPT_LIMIT - tail.length) + tail
}

/**
 * 拉起一个 DSH 会话，把 prompt 投进去。
 *
 * 关键点：
 *   - **不指定 agentPreset** → DSH 会套用它的默认 preset（standard），
 *     那个 preset 带 bash / 文件读写等本地工具 —— agent 真的能动手改东西。
 *     （反例：qq-chat* 系列 preset 刻意没有本地工具，那是给 QQ 群用的，
 *      这里不能用。）
 *   - 会话建在 D:\\大肥鱼 上，agent 的工作目录就在项目根。
 */
export async function handoffToAgent(findings, { waitMs = 120000, note = '', auto = false } = {}) {
  const cfg = readJson(path.join(BRIDGE_DIR, 'config.json'), {})
  const baseUrl = String(cfg?.dsh?.baseUrl || '').trim()
  if (!baseUrl) throw new Error('拿不到 DSH 地址（qq-bridge/config.json 的 dsh.baseUrl）')

  // dsh-client 在 qq-bridge/src/ 下，依赖它的 node_modules —— 动态 import 让
  // Node 按「被 import 的文件所在目录」解析依赖，所以这里必须用文件 URL。
  const clientMod = await import(pathToFileURL(path.join(BRIDGE_DIR, 'src', 'dsh-client.js')).href)
  const { NodeApiClient, unwrap, createTurnCollector } = clientMod

  const api = new NodeApiClient(baseUrl, undefined, {
    token: String(cfg?.dsh?.authToken || ''),
    tokenExplicit: cfg?.dsh?.authTokenExplicit === true
  })

  fs.mkdirSync(WORKSPACE_DIR, { recursive: true })
  const wsValue = unwrap(await api.workspace.create({ path: WORKSPACE_DIR }), 'workspace.create')
  const workspaceId = wsValue?.workspace?.workspaceId
  if (!workspaceId) throw new Error('创建 workspace 失败：拿不到 workspaceId')

  // 不传 agentPreset → DSH 默认 preset（带本地工具）
  const created = unwrap(await api.sessions.create({ workspaceId }), 'sessions.create')
  const sessionId = String(created?.sessionId || '')
  if (!sessionId) throw new Error('创建 DSH 会话失败：拿不到 sessionId')

  // 新版 DSH 必须显式 follow，否则收不到 turn/end
  api.events.follow(sessionId)

  // 面板里选过模型 → 先把这个会话切过去；没选过就沿用 DSH 自己的默认模型。
  // 注意：DSH 的 selectModel 只接受真实存在的 provider/model，缺 Key 的
  // MiniMax 路由会在这一步或第一次请求时明确报错，不会静默降级。
  const choice = readChoice()
  let appliedModel = null
  if (choice) {
    try {
      const sel = unwrap(
        await api.sessions.selectModel({
          sessionId,
          provider: choice.provider,
          model: choice.model
        }),
        'session.selectModel'
      )
      appliedModel = `${sel?.selected?.provider || choice.provider}/${sel?.selected?.model || choice.model}`
    } catch (e) {
      throw new Error(`切换模型失败（${choice.provider}/${choice.model}）：${e?.message || e}`)
    }
  }

  // 可选关联启动：用户勾了「关联启动」的客户端，才在投喂前把它拉起来。
  // 默认全关 → 行为与以前完全一致；缺客户端/没勾/路径失效都只是记一笔，不阻断投喂。
  let launchedClient = null
  if (choice) {
    try {
      const lr = await launchClientForProvider(choice.provider)
      if (lr?.ok) {
        launchedClient = { client: lr.client, path: lr.path, pid: lr.pid }
        console.log(`[client] ${lr.reason} → ${lr.path}`)
      } else if (!lr?.skipped) {
        console.log(`[client] 未拉起：${lr?.reason || '未知原因'}`)
      }
    } catch (e) {
      console.log(`[client] 拉起异常（已忽略）：${e?.message || e}`)
    }
  }

  const prompt = buildAgentPrompt(findings, { note, auto })
  const accepted = await api.sessions.prompt({
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: prompt }]
  })
  if (!accepted?.result?.ok) {
    throw new Error(`DSH 拒绝了这次投递：${accepted?.result?.error?.code ?? '未知'} ${accepted?.result?.error?.message ?? ''}`)
  }

  // 等这一轮跑完，把 agent 的总结收回来（只是给面板看，不阻塞修复本身）
  const collector = createTurnCollector()
  const deadline = Date.now() + waitMs
  let reply = ''
  try {
    for await (const envelope of api.events.mux({})) {
      const frame = envelope?.payload
      if (!frame || frame.type !== 'session/event') continue
      if (String(frame.sessionId) !== sessionId) continue
      const done = collector.push(frame.event)
      if (done) { reply = typeof done === 'string' ? done : (done?.text ?? ''); break }
      if (Date.now() > deadline) break
    }
  } catch {
    // 事件流断了无所谓：prompt 已经被 DSH 接受，agent 照样会干活。
  }

  return {
    sessionId,
    workspaceId,
    reply: String(reply || '').slice(0, 4000),
    baseUrl,
    model: appliedModel,
    provider: choice?.provider || null,
    client: launchedClient,
    auto
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  if (args.includes('--list')) {
    const findings = await diagnoseAll()
    console.log(JSON.stringify(findings, null, 2))
    return
  }

  let findings = []
  const findingsFile = argOf('--findings')
  if (findingsFile) {
    findings = readJson(findingsFile, [])
    if (!Array.isArray(findings)) findings = []
  } else {
    const code = argOf('--code')
    if (!code) {
      console.log(JSON.stringify({ ok: false, error: '需要 --code <CODE> 或 --findings <file>' }))
      return
    }
    const all = await diagnoseAll()
    findings = all.filter((f) => f.code === code)
    if (!findings.length) {
      console.log(JSON.stringify({ ok: false, code, error: `当前没有 ${code} 这个问题（可能已经自己好了）` }))
      return
    }
  }
  if (!findings.length) {
    console.log(JSON.stringify({ ok: false, error: '没有要交给 agent 的问题' }))
    return
  }

  const code = String(findings[0].code || '')
  // --auto 由守护进程自动升级时传入：表示这是「自动投喂」，不是用户手点。
  const auto = args.includes('--auto')
  writeHandoff(code, { status: 'running', startedAt: Date.now(), reply: '', trigger: auto ? 'auto' : 'manual', route: 'model' })

  try {
    const r = await handoffToAgent(findings, {
      waitMs: Number(process.env.AGENT_REPAIR_WAIT_MS || 120000),
      note: argOf('--note'),
      auto
    })
    writeHandoff(code, {
      status: 'handed-off',
      sessionId: r.sessionId,
      reply: r.reply,
      model: r.model,
      provider: r.provider,
      trigger: auto ? 'auto' : 'manual',
      route: 'model',
      fed: auto,
      finishedAt: Date.now()
    })
    console.log(JSON.stringify({ ok: true, code, sessionId: r.sessionId, reply: r.reply, model: r.model, auto }))
  } catch (e) {
    writeHandoff(code, { status: 'failed', error: e?.message || String(e), trigger: auto ? 'auto' : 'manual', finishedAt: Date.now() })
    console.log(JSON.stringify({ ok: false, code, error: e?.message || String(e) }))
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
