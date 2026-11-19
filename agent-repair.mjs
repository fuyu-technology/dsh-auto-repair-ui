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
import { appendUsage } from './usage.mjs'

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
// 判定「这一轮到底有没有真的动手」：read / grep / glob / todo_write / web_* 一律不算，
// 它们全成功也可能一个文件都没改。
// 直接写盘的工具：调用成功即可认为改动过。
const DIRECT_MUTATING_TOOLS = new Set(['write', 'edit', 'apply_patch', 'delete_file', 'move_file', 'copy_file'])
// 命令类工具：本身既能读也能写，只有命令文本里出现写操作时才算改动。
// （实测：agent 用 pwsh 跑 Get-FileHash / Get-ChildItem 做只读核对，旧逻辑把 pwsh:ok 当成了「改过文件」。）
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'shell', 'powershell'])
const SHELL_WRITE_RE = /(^|[^>=\-0-9])>{1,2}[^>=]|Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content|WriteAllText|WriteAllBytes|WriteAllLines|sed\s+-i|\btee\b|\btouch\b|\bmkdir\b|\brmdir\b|\brm\s|\bmv\s|\bcp\s|Expand-Archive|Compress-Archive|\bgit\s+(apply|checkout|reset|clean|stash|commit|add)\b|\bpatch\b|\bapplypatch\b|\bdd\s+/i
const BARE_TOOL_NAME = (name) => String(name || '').split('__').pop().toLowerCase()
const BRIDGE_DIR = path.join(ROOT, 'qq-bridge')
// agent 的工作区默认放在大肥鱼根目录：它要能改 qq-bridge / auto-repair 这些地方，
// 工作区太窄会够不着。AGENT_REPAIR_WORKSPACE 可临时指到别的目录（自测/别的 checkout）。
const WORKSPACE_DIR = process.env.AGENT_REPAIR_WORKSPACE ? path.resolve(process.env.AGENT_REPAIR_WORKSPACE) : ROOT

// 工作区快照：判定「到底有没有真的落盘改动」的兜底口径。
// 工具轨迹可能骗人（只读命令也可能叫 pwsh），但文件大小/修改时间不会。
const SNAPSHOT_SKIP = new Set(['node_modules', '.git', '.venv', '__pycache__', 'dist', 'build', '.cache', '.next'])
function snapshotWorkspace(dir, { limit = 40000, budgetMs = 8000 } = {}) {
  const out = new Map()
  const startedAt = Date.now()
  const walk = (d) => {
    if (out.size >= limit || Date.now() - startedAt > budgetMs) return
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (out.size >= limit || Date.now() - startedAt > budgetMs) return
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (!SNAPSHOT_SKIP.has(e.name)) walk(p)
      } else if (e.isFile()) {
        try { const st = fs.statSync(p); out.set(p, `${st.size}:${st.mtimeMs}`) } catch {}
      }
    }
  }
  walk(dir)
  return out
}
function diffSnapshots(before, after) {
  let added = 0
  let removed = 0
  let modified = 0
  for (const [p, sig] of after) {
    const old = before.get(p)
    if (old === undefined) added += 1
    else if (old !== sig) modified += 1
  }
  for (const p of before.keys()) if (!after.has(p)) removed += 1
  return { added, removed, modified, total: added + removed + modified }
}

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
  lines.push('0. 本地文件一律用 read / write / edit / pwsh 工具读写；不要用 web_fetch 或 web_search 读本地路径（file:// 会被工具层直接拒绝，只是白费回合）。')
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
 *   - **显式挂 standard preset**：DSH 的默认 preset 可能被设成 qq-chat*（无本地工具），
 *     那种会话只能看不能改。standard 带 read/write/edit/pwsh，agent 才真的能动手改东西。
 *   - 会话建在 D:\\大肥鱼 上，agent 的工作目录就在项目根。
 *   - 判定成功与否看「有没有成功的写/改类工具调用」，不看 prompt 是否被接收。
 */
export async function handoffToAgent(findings, { waitMs = 120000, note = '', auto = false } = {}) {
  const cfg = readJson(path.join(BRIDGE_DIR, 'config.json'), {})
  const baseUrl = String(cfg?.dsh?.baseUrl || '').trim()
  if (!baseUrl) throw new Error('拿不到 DSH 地址（qq-bridge/config.json 的 dsh.baseUrl）')

  // dsh-client 在 qq-bridge/src/ 下，依赖它的 node_modules —— 动态 import 让
  // Node 按「被 import 的文件所在目录」解析依赖，所以这里必须用文件 URL。
  const clientMod = await import(pathToFileURL(path.join(BRIDGE_DIR, 'src', 'dsh-client.js')).href)
  const { NodeApiClient, unwrap, createTurnCollector } = clientMod
  // 用量记账：从 DSH 事件里取 provider usage（与桥接 token 账本同一套归一化口径）。
  const ledgerMod = await import(pathToFileURL(path.join(BRIDGE_DIR, 'src', 'token-ledger.js')).href)
  const priceMod = await import(pathToFileURL(path.join(BRIDGE_DIR, 'src', 'model-prices.js')).href)
  const usageOfEvent = ledgerMod.usageOfEvent
  const { normalizeUsage } = priceMod

  const api = new NodeApiClient(baseUrl, undefined, {
    token: String(cfg?.dsh?.authToken || ''),
    tokenExplicit: cfg?.dsh?.authTokenExplicit === true
  })

  fs.mkdirSync(WORKSPACE_DIR, { recursive: true })
  const wsValue = unwrap(await api.workspace.create({ path: WORKSPACE_DIR }), 'workspace.create')
  const workspaceId = wsValue?.workspace?.workspaceId
  if (!workspaceId) throw new Error('创建 workspace 失败：拿不到 workspaceId')

  // 显式挂带本地工具的 preset：DSH 的「默认 preset」被设成了 qq-chat-v2（无本地工具），
  // 不指定 agentPreset 时修复会话只能看不能改，最后空回复还被当成成功。
  // 优先 standard；没有就挑一个非 qq-chat 的；列表都读不到时仍按 standard 试一次。
  let repairPreset = 'standard'
  try {
    const { presets } = unwrap(await api.agentPresets.list({}), 'agentPresets.list')
    const ids = (presets || []).map((p) => String(p?.id || '')).filter(Boolean)
    if (ids.length && !ids.includes(repairPreset)) {
      repairPreset = ids.find((id) => !id.startsWith('qq-chat')) || ''
    }
  } catch { /* 读不到列表就按 standard 试，失败再退回默认 */ }

  let created
  try {
    created = unwrap(await api.sessions.create({ workspaceId, ...(repairPreset ? { agentPreset: repairPreset } : {}) }), 'sessions.create')
  } catch (error) {
    if (!repairPreset) throw error
    console.log(`[preset] 挂载 ${repairPreset} 失败（${error?.message || error}），退回 DSH 默认 preset`)
    created = unwrap(await api.sessions.create({ workspaceId }), 'sessions.create')
    repairPreset = ''
  }
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
  // 回合前的工作区快照：和回合后的快照对比，是「真的改了文件」的最终依据。
  const beforeSnapshot = snapshotWorkspace(WORKSPACE_DIR)
  const startedAt = Date.now()
  // 「让 AI 修」这一轮里每次模型请求的 usage（同一 turn/step/retry 后到覆盖先到）。
  const usageSamples = new Map()
  let turnError = ''
  // 工具轨迹：用来判定「这一轮到底改没改东西」，以及在没改动时保留原始输出。
  const toolCalls = []
  const callsById = new Map()
  let turnReason = null
  const collector = createTurnCollector()
  const deadline = Date.now() + waitMs
  let reply = ''
  let timedOut = false
  let streamLost = false
  let streamClosed = false
  let finished = false

  // 先挂事件流、等它真正打开再投递 prompt。
  // 之前是先 prompt 再订阅：模型半秒就跑完的回合会整个漏掉（turn/end 丢失 → 一直干等到超时）。
  const ac = new AbortController()
  const buffered = []
  let waiter = null
  const wake = () => { if (waiter) { const w = waiter; waiter = null; w() } }
  let markOpen = () => {}
  const opened = new Promise((resolve) => { markOpen = resolve })
  const pump = (async () => {
    try {
      for await (const envelope of api.events.mux({}, ac.signal, () => markOpen())) buffered.push(envelope)
    } catch { /* 流断了就按已收到的事件判定 */ }
    streamClosed = true
    wake()
  })()
  // 最多等 5 秒；DSH 不接受订阅时也别把整轮卡死。
  await Promise.race([opened, new Promise((resolve) => setTimeout(resolve, 5000))])

  const accepted = await api.sessions.prompt({
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: prompt }]
  })
  if (!accepted?.result?.ok) {
    throw new Error(`DSH 拒绝了这次投递：${accepted?.result?.error?.code ?? '未知'} ${accepted?.result?.error?.message ?? ''}`)
  }

  const handleEvent = (event) => {
    // 收集本轮的 token 用量（与桥接账本同口径：assistant/message|attempt 的 usage）
    try {
      const raw = usageOfEvent(event)
      const turn = Number(event?.data?.turn)
      const step = Number(event?.data?.step)
      if (raw && Number.isFinite(turn) && Number.isFinite(step)) {
        const retry = Number(event?.data?.retry) || 0
        const buckets = normalizeUsage(raw)
        usageSamples.set(`${turn}|${step}|${retry}`, {
          t: Number.isFinite(Number(event.time)) ? Number(event.time) : Date.now(),
          provider: event?.data?.provider ?? event?.data?.usage?.provider ?? '',
          model: event?.data?.usage?.model ?? event?.data?.model ?? '',
          buckets
        })
      }
      if (event?.type === 'tool/call') {
        // 记下参数：命令类工具要靠命令文本判断「这条 pwsh 到底是在读还是在写」。
        const rawArgs = event?.data?.args ?? event?.data?.input ?? event?.data?.arguments
        let argText = ''
        try { argText = typeof rawArgs === 'string' ? rawArgs : (rawArgs ? JSON.stringify(rawArgs) : '') } catch {}
        const item = { name: String(event?.data?.name || ''), ok: null, args: argText.slice(0, 4000) }
        toolCalls.push(item)
        const callId = String(event?.data?.callId || event?.data?.id || '')
        if (callId) callsById.set(callId, item)
      } else if (event?.type === 'tool/result') {
        const callId = String(event?.data?.callId || event?.data?.id || '')
        const item = callsById.get(callId) || toolCalls[toolCalls.length - 1]
        if (item && item.ok === null) item.ok = event?.data?.isError !== true
      }
      if (event?.type === 'turn/error' || event?.type === 'error') {
        turnError = String(event?.data?.message || event?.data?.code || 'error').slice(0, 120)
      }
    } catch { /* 记账采集失败不影响主链路 */ }
    const done = collector.push(event)
    if (done) {
      reply = typeof done === 'string' ? done : (done?.text ?? '')
      turnReason = typeof done === 'string' ? null : (done?.reason ?? null)
      finished = true
    }
  }

  while (!finished) {
    while (buffered.length && !finished) {
      const envelope = buffered.shift()
      const frame = envelope?.payload
      if (!frame || frame.type !== 'session/event') continue
      if (String(frame.sessionId) !== sessionId) continue
      handleEvent(frame.event)
    }
    if (finished) break
    if (streamClosed) { streamLost = true; break }
    if (Date.now() > deadline) { timedOut = true; break }
    await Promise.race([
      new Promise((resolve) => { waiter = resolve }),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ])
  }
  // 收尾：关掉订阅，否则 WS 会把这个一次性脚本挂住不退出。
  ac.abort()
  await pump.catch(() => {})

  // 把本轮每一次模型请求记进本地用量账本（来源：修复）。
  try {
    const ordered = [...usageSamples.values()].sort((a, b) => a.t - b.t)
    let prev = startedAt
    for (const s of ordered) {
      const b = s.buckets ?? {}
      appendUsage({
        t: s.t,
        src: 'repair',
        provider: s.provider || choice?.provider || '',
        model: s.model || (appliedModel ? appliedModel.split('/').slice(1).join('/') : ''),
        b,
        input: (b.cacheMiss ?? 0) + (b.cacheHit ?? 0) + (b.cacheWrite ?? 0),
        output: b.output ?? 0,
        ms: Math.max(0, s.t - prev),
        ok: !turnError,
        err: turnError,
        missing: false
      })
      prev = s.t
    }
  } catch { /* 记账失败不影响交接结果 */ }

  // ── 判定这一轮到底算不算「修了」 ───────────────────────────────────────────
  // 之前只要 DSH 接了 prompt 就记 handed-off，agent 交了空回复也照样显示成功。
  // 现在以「真的产生了落盘改动」为准（工作区快照 + 明确的写盘工具 + 带写操作的命令）：
  // 只读的 read/grep/glob/web_fetch，以及只读的 pwsh（Get-FileHash 之类）都不算。
  const afterSnapshot = snapshotWorkspace(WORKSPACE_DIR)
  const workspaceDiff = diffSnapshots(beforeSnapshot, afterSnapshot)
  const directWrites = toolCalls.filter((c) => c.ok === true && DIRECT_MUTATING_TOOLS.has(BARE_TOOL_NAME(c.name)))
  const shellWrites = toolCalls.filter((c) => c.ok === true && SHELL_TOOLS.has(BARE_TOOL_NAME(c.name)) && SHELL_WRITE_RE.test(c.args || ''))
  const changed = workspaceDiff.total > 0 || directWrites.length > 0 || shellWrites.length > 0
  const reasonKind = String(turnReason?.kind || '')
  const aborted = /abort|cancel/i.test(reasonKind) || /abort|cancel/i.test(String(turnReason?.reason?.kind || ''))
  let incompleteReason = ''
  if (turnError) incompleteReason = `turn-error: ${turnError}`
  else if (streamLost) incompleteReason = 'event-stream-lost: 事件流提前断开，无法确认回合结果'
  else if (timedOut) incompleteReason = `timeout: 超过 ${Math.round(waitMs / 1000)}s 未结束`
  else if (aborted) incompleteReason = `aborted: ${reasonKind || 'user'}`
  else if (!changed) incompleteReason = 'no-change: 工作区没有任何落盘改动（只读/查询或命令未真正写入）'
  const completed = !incompleteReason
  const toolsSummary = toolCalls.slice(0, 30).map((c) => `${c.name || '?'}:${c.ok === true ? 'ok' : c.ok === false ? 'err' : '?'}`)
  // 无论成败都保留原始输出：失败时 reply 常常是空的，工具轨迹就是唯一证据。
  const raw = String(reply || '').trim() || `（无文字回复）工具轨迹：${toolsSummary.join(' · ') || '无'}`

  return {
    sessionId,
    workspaceId,
    reply: String(reply || '').slice(0, 4000),
    raw: raw.slice(0, 4000),
    completed,
    reason: incompleteReason,
    turnReason: reasonKind,
    tools: toolsSummary,
    changed,
    workspaceDiff,
    preset: repairPreset,
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
    // 只有「确实动过文件且这一轮正常结束」才记 handed-off；
    // 空回复/没改动的，记 incomplete 并保留原始输出，面板会显示「未完成·无改动」。
    writeHandoff(code, {
      status: r.completed ? 'handed-off' : 'incomplete',
      reason: r.reason || '',
      raw: r.raw || '',
      tools: r.tools || [],
      changed: Boolean(r.changed),
      workspaceDiff: r.workspaceDiff || null,
      sessionId: r.sessionId,
      reply: r.reply,
      model: r.model,
      provider: r.provider,
      preset: r.preset,
      trigger: auto ? 'auto' : 'manual',
      route: 'model',
      fed: auto,
      finishedAt: Date.now()
    })
    console.log(JSON.stringify({
      ok: r.completed,
      code,
      status: r.completed ? 'handed-off' : 'incomplete',
      reason: r.reason,
      sessionId: r.sessionId,
      reply: r.reply,
      raw: r.raw,
      tools: r.tools,
      changed: r.changed,
      workspaceDiff: r.workspaceDiff,
      model: r.model,
      auto
    }))
  } catch (e) {
    writeHandoff(code, { status: 'failed', error: e?.message || String(e), trigger: auto ? 'auto' : 'manual', finishedAt: Date.now() })
    console.log(JSON.stringify({ ok: false, code, error: e?.message || String(e) }))
    // 出错时事件流可能还没关，留一点时间把 stdout 刷出去再强退，避免进程挂住。
    setTimeout(() => process.exit(1), 150)
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
