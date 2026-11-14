// dsh-auto-repair-ui
// Copyright 2026 蝠羽科技 (fuyu-technology)  —  https://github.com/fuyu-technology
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// 允许二次修改与再分发，但必须保留上述署名与版权声明，不得删除或改写。
// 详见 LICENSE 与 NOTICE。
//

// dsh-auto-repair-ui · 宿主侧
//
// 职责：把 auto-repair 守护进程的数据暴露成 HTTP API，供客户端面板读取和操作。
//
// 它**不自己干活**——真正的诊断和修复都在 D:\大肥鱼\auto-repair\ 里，
// 由独立的守护进程执行。这里只是「读状态 + 转发手动触发」的一层壳。
//
// 为什么是这个结构：
//   - 面板是 DSH 插件，跑在 DSH 进程里。DSH 崩了它就没了。
//   - 所以「修 DSH」的逻辑必须在 DSH 之外（auto-repair 守护进程）。
//   - 面板只负责「看」和「手动戳一下」，能力边界清晰。

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const NS = 'dsh-auto-repair-ui'
const API_BASE = '/dsh-auto-repair'
const STATUS_PATH = `${API_BASE}/status`
const DIAGNOSE_PATH = `${API_BASE}/diagnose`
const REPAIR_PATH = `${API_BASE}/repair`
const HISTORY_PATH = `${API_BASE}/history`
const POLICY_PATH = `${API_BASE}/policy`
const REPAIR_ONE_PATH = `${API_BASE}/repair-one`
const REPAIR_ALL_PATH = `${API_BASE}/repair-all`
const AGENT_PATH = `${API_BASE}/agent-assist`
const IGNORE_PATH = `${API_BASE}/ignore`
const MODELS_PATH = `${API_BASE}/models`
const CLIENTS_PATH = `${API_BASE}/clients`
const PROVIDERS_PATH = `${API_BASE}/providers`
const ZHIPU_PATH = `${API_BASE}/zhipu`
const VENDORS_PATH = `${API_BASE}/vendors`
const MANAGE_PATH = `${API_BASE}/manage`
const NOTIFY_PATH = `${API_BASE}/notify-policy`
const REPEAT_ALERT_PATH = `${API_BASE}/repeat-alert`

// 智谱开放平台（bigmodel.cn）OpenAI 兼容接口的官方地址（docs.bigmodel.cn）。
const ZHIPU_DEFAULT_BASE = 'https://open.bigmodel.cn/api/paas/v4'
const PROVIDER_ENDPOINTS_FILE = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.dsh-auto-repair',
  'provider-endpoints.json'
)

const HERE = path.dirname(fileURLToPath(import.meta.url))
// auto-repair 守护进程的实际位置。
// 注意：本插件装在 ~/.dsh/plugins/ 下，而守护进程在 D:\大肥鱼\auto-repair\
// —— 两者**不在同一棵目录树**里，不能用相对路径推算，必须写死绝对路径。
// （用相对路径 ../.. 会算出 ~/.dsh/ 下面去，找不到脚本。）
// 绝对路径可用 REPAIR_DIR 覆盖，方便把插件搬到别的机器上。
const REPAIR_DIR = process.env.REPAIR_DIR || 'D:\\大肥鱼\\auto-repair'
const REPAIR_STATE = path.join(REPAIR_DIR, 'state')
const REPAIR_ENTRY = path.join(REPAIR_DIR, 'auto-repair.mjs')
const ZHIPU_QUEUE_FILE = path.join(REPAIR_STATE, 'zhipu-queue.json')
const PROVIDER_QUOTA_FILE = path.join(REPAIR_STATE, 'provider-quota.json')
const ROUTE_PATCH_FILE = path.join(HERE, 'cordis.patch.yml')

/** 找 node —— 用 DSH 自带的那个，和守护进程保持一致 */
function findNode() {
  const candidates = [
    path.join(process.env.USERPROFILE || '', '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    'D:\\大肥鱼\\SnowLuma\\node.exe'
  ]
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c } catch {}
  }
  return process.execPath
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

/** 读 POST 请求体（JSON） */
function readBody(req) {
  return new Promise((resolve) => {
    let buf = ''
    req.on('data', (c) => { buf += c; if (buf.length > 2e6) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}

/**
 * 调 auto-repair 的 CLI。
 *
 * ⚠️ 为什么不直接在插件里 import 守护进程的模块？
 *   插件装在 ~/.dsh/plugins/ 下，守护进程在 D:\大肥鱼\auto-repair\ ——
 *   两棵完全不同的目录树，import 不到。只能以子进程方式调 CLI。
 *   好处也在这里：**策略与修复逻辑只有一份实现**（在守护进程那边），
 *   插件只负责传参和显示结果，不会出现两边逻辑对不上的情况。
 */
function runCli(args, timeoutMs = 90000) {
  return new Promise((resolve) => {
    if (!fs.existsSync(REPAIR_ENTRY)) {
      resolve({ ok: false, error: '找不到 auto-repair 脚本', stdout: '', stderr: '' })
      return
    }
    try {
      execFile(
        findNode(),
        [REPAIR_ENTRY, ...args],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout, stderr) => {
          const out = String(stdout || '')
          const errOut = String(stderr || '')
          let json = null
          try { json = JSON.parse(out.trim() || 'null') } catch {}
          resolve({
            ok: !err,
            json,
            stdout: out,
            stderr: errOut,
            error: err ? err.message : ''
          })
        }
      )
    } catch (e) {
      resolve({ ok: false, error: e.message, stdout: '', stderr: '' })
    }
  })
}

// ── 智谱任务队列：持久化在 auto-repair/state/zhipu-queue.json ──────────────
// 队列只由本插件推进（串行），DSH 关掉再打开文件还在，队列也不会丢。
function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return fallback
  }
}

function zhipuBaseUrl() {
  const doc = readJsonFile(PROVIDER_ENDPOINTS_FILE, null)
  // 文件实际结构是 { providers: { zhipu: { baseUrl } } }，老结构才是 { zhipu: {...} }；
  // 两种都认，否则读不到会静默退回默认地址，页面上看起来像「地址没保存成功」。
  const v = doc && ((doc.providers && doc.providers.zhipu) || doc.zhipu)?.baseUrl
  const s = typeof v === 'string' ? v.trim() : ''
  return s || ZHIPU_DEFAULT_BASE
}

// 额度状态：只记录「额度类」失败，避免把普通网络错误、参数错误也标成欠费。
// 与队列里的任务分开存，清空已完成任务不会把「额度耗尽」的提示一起清掉。
// 1.6 起按 provider 分条存（provider-quota.json），旧的智谱单文件仍然兼容。
const ZHIPU_QUOTA_FILE = path.join(REPAIR_STATE, 'zhipu-quota.json')

function zhipuQuotaError(text) {
  const s = String(text || '')
  if (!s) return false
  return /余额|欠费|配额|额度|充值|quota|insufficient|payment required|\b402\b|billing/i.test(s)
}

// 「额度耗尽」不是永久标签：之后成功过、或者失败证据超过 24 小时没有更新，就不再挂红标。
const QUOTA_STALE_MS = 24 * 60 * 60 * 1000

function readQuotaFor(id) {
  const doc = readJsonFile(PROVIDER_QUOTA_FILE, null)
  const one = doc && doc.providers && doc.providers[id]
  if (one) {
    if (one.exhausted !== true) return { exhausted: false }
    const at = Number(one.at) || 0
    const okAt = Number(one.lastOkAt) || 0
    // 失败之后又有一次成功调用 → 立刻清掉
    if (okAt && okAt >= at) return { exhausted: false }
    // 太久没有新的失败证据 → 不再挂着红标
    if (!at || Date.now() - at > QUOTA_STALE_MS) return { exhausted: false }
    return {
      exhausted: true,
      at,
      message: typeof one.message === 'string' ? one.message.slice(0, 300) : ''
    }
  }
  // 兼容老文件：智谱的欠费记录原来单独存在 zhipu-quota.json
  if (id === 'zhipu') {
    const old = readJsonFile(ZHIPU_QUOTA_FILE, null)
    const at = Number(old?.at) || 0
    if (old && old.exhausted === true && at && Date.now() - at <= QUOTA_STALE_MS) {
      return {
        exhausted: true,
        at,
        message: typeof old.message === 'string' ? old.message.slice(0, 300) : ''
      }
    }
  }
  return { exhausted: false }
}

function writeQuotaFor(id, next) {
  try {
    fs.mkdirSync(REPAIR_STATE, { recursive: true })
    const doc = readJsonFile(PROVIDER_QUOTA_FILE, null)
    const providers = { ...(doc && doc.providers ? doc.providers : {}) }
    providers[id] = { ...next, updatedAt: Date.now() }
    const tmp = `${PROVIDER_QUOTA_FILE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: Date.now(), providers }, null, 2), 'utf8')
    fs.renameSync(tmp, PROVIDER_QUOTA_FILE)
  } catch {}
}

function readZhipuQuota() {
  return readQuotaFor('zhipu')
}

/** 记一次「真实调用成功」：额度标记立刻清掉，并留下成功时间供后续判定 */
function writeQuotaOk(id) {
  writeQuotaFor(id, { exhausted: false, lastOkAt: Date.now() })
}

function writeZhipuQuota(next) {
  writeQuotaFor('zhipu', next)
}

function readZhipuQueue() {
  const doc = readJsonFile(ZHIPU_QUEUE_FILE, null)
  const list = doc && Array.isArray(doc.tasks) ? doc.tasks : []
  const tasks = list
    .filter((t) => t && typeof t.id === 'string')
    .map((t) => ({
      id: t.id,
      provider: String(t.provider || 'zhipu'),
      prompt: String(t.prompt || ''),
      model: String(t.model || ''),
      status: ['pending', 'running', 'done', 'failed'].includes(t.status) ? t.status : 'pending',
      createdAt: Number(t.createdAt) || 0,
      startedAt: Number(t.startedAt) || 0,
      finishedAt: Number(t.finishedAt) || 0,
      attempts: Number(t.attempts) || 0,
      result: typeof t.result === 'string' ? t.result : '',
      error: typeof t.error === 'string' ? t.error : ''
    }))
  return { updatedAt: Number(doc && doc.updatedAt) || 0, tasks }
}

function writeZhipuQueue(tasks) {
  try {
    fs.mkdirSync(REPAIR_STATE, { recursive: true })
    const doc = { version: 1, updatedAt: Date.now(), tasks }
    const tmp = `${ZHIPU_QUEUE_FILE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8')
    fs.renameSync(tmp, ZHIPU_QUEUE_FILE)
  } catch {}
}

/**
 * 读当前审批策略。
 *
 * 直接读 state/repair-policy.json —— 这里**只是显示**，不参与任何判定，
 * 所以不调用 CLI 也行（省一次子进程启动）。真正的写操作一律走
 * `--set-policy`，保证合并语义只有 policy.mjs 一份实现。
 */
function readPolicyFile() {
  const doc = readJson(path.join(REPAIR_STATE, 'repair-policy.json'), null)
  const src = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {}
  return {
    mode: ['manual', 'approve-all', 'reject-all'].includes(String(src.mode)) ? String(src.mode) : 'manual',
    agentAssist: src.agentAssist !== false,
    autoFeed: src.autoFeed !== false,
    rejectedCodes: Array.isArray(src.rejectedCodes) ? src.rejectedCodes.map(String) : [],
    updatedAt: Number(src.updatedAt) || 0
  }
}

/** 写策略（走 CLI，合并语义由 policy.mjs 负责） */
async function writePolicy(patch) {
  const r = await runCli(['--set-policy', JSON.stringify(patch)], 20000)
  if (r.json?.policy) return { ok: true, policy: r.json.policy }
  return { ok: false, error: r.json?.error || r.error || r.stderr || '改策略失败' }
}

/** 「让 AI 修」用哪个模型：选择本身存在 state/model-choice.json */
function readModelChoiceFile() {
  const doc = readJson(path.join(REPAIR_STATE, 'model-choice.json'), null)
  const src = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {}
  const provider = String(src.provider || '').trim()
  const model = String(src.model || '').trim()
  if (!provider || !model) return null
  return { provider, model, updatedAt: Number(src.updatedAt) || 0 }
}

// ── 模型启用 / 三种用途的独立指定 ──────────────────────────────────────────
//
// 一家供应商下可以同时启用多个模型；「修复」「队列默认」「全天回复」三处
// 各自存一条指定，互不覆盖。用途表落在 state/model-uses.json：
//   { enabled: [{provider, model}], uses: { repair|queue|reply: {provider, model} } }
//
// 「修复」这条仍以 state/model-choice.json 为准（守护进程只认那个文件），
// 所以改修复用途时会同时通过 CLI --set-model 回写，保证两边一致。
const MODEL_USES_FILE = path.join(REPAIR_STATE, 'model-uses.json')
const MODEL_USES = ['repair', 'queue', 'reply']
const USE_LABEL = { repair: '修复', queue: '任务队列默认', reply: '全天回复' }

function normalizeModelPair(provider, model) {
  const p = String(provider || '').trim()
  const m = String(model || '').trim()
  if (!p || !m) return null
  return { provider: p, model: m }
}

function pairKey(pair) {
  return `${pair.provider}::${pair.model}`
}

function readModelUses() {
  const doc = readJson(MODEL_USES_FILE, null)
  const src = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {}
  const rawUses = src.uses && typeof src.uses === 'object' ? src.uses : {}
  const uses = {}
  for (const k of MODEL_USES) uses[k] = normalizeModelPair(rawUses[k]?.provider, rawUses[k]?.model)

  // 迁移：老版本只有一个全局选择（model-choice.json），它就是「修复」用途。
  // 这样升级后用户不用重选，原来的修复模型直接变成修复用途的指定。
  let migrated = false
  if (!uses.repair) {
    const legacy = readModelChoiceFile()
    if (legacy) {
      uses.repair = { provider: legacy.provider, model: legacy.model }
      migrated = true
    }
  }

  const enabled = []
  const seen = new Set()
  const pushEnabled = (pair) => {
    if (!pair) return
    const k = pairKey(pair)
    if (seen.has(k)) return
    seen.add(k)
    enabled.push(pair)
  }
  for (const one of Array.isArray(src.enabled) ? src.enabled : []) {
    pushEnabled(normalizeModelPair(one?.provider, one?.model))
  }
  // 迁移时把修复模型标成已启用，否则界面上会出现「指定了但没启用」的矛盾状态。
  if (migrated) pushEnabled(uses.repair)

  const out = { version: 1, enabled, uses, updatedAt: Number(src.updatedAt) || 0 }
  // 首次读取/迁移时落盘一次，之后读写同一份文件，避免每次请求都重复迁移。
  if (!doc || migrated) writeModelUses(out)
  return out
}

function writeModelUses(next) {
  try {
    fs.mkdirSync(REPAIR_STATE, { recursive: true })
    const doc = {
      version: 1,
      enabled: Array.isArray(next.enabled) ? next.enabled : [],
      uses: next.uses || {},
      updatedAt: Date.now()
    }
    const tmp = `${MODEL_USES_FILE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8')
    fs.renameSync(tmp, MODEL_USES_FILE)
    return doc
  } catch {
    return null
  }
}

const MANAGE_FILE = path.join(REPAIR_STATE, 'model-manage.json')
const BRIDGE_CONFIG_FILE = path.join(path.dirname(REPAIR_DIR), 'qq-bridge', 'config.json')
const PROFILE_PATCH_FILE = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.dsh',
  'profiles',
  'desktop',
  'cordis.patch.yml'
)

// 「接管范围」：哪些地方跟着「模型管理」页的切换走。
const MANAGE_SCOPES = ['agent', 'repair', 'queue', 'reply', 'bridge']
const MANAGE_SCOPE_DEFAULT = { agent: false, repair: true, queue: true, reply: true, bridge: false }

function readManageDoc() {
  const doc = readJson(MANAGE_FILE, null) || {}
  const t = doc && typeof doc.takeover === 'object' && doc.takeover ? doc.takeover : {}
  const takeover = {}
  for (const k of MANAGE_SCOPES) {
    takeover[k] = typeof t[k] === 'boolean' ? t[k] : MANAGE_SCOPE_DEFAULT[k]
  }
  return {
    version: 1,
    takeover,
    // 切换时若勾了 DSH 本体，只把目标值记在这里，等用户点「写入 DSH 本体」才落盘
    pendingAgent: normalizeModelPair(doc?.pendingAgent?.provider, doc?.pendingAgent?.model),
    updatedAt: Number(doc.updatedAt) || 0
  }
}

function writeManageDoc(next) {
  try {
    fs.mkdirSync(REPAIR_STATE, { recursive: true })
    const doc = {
      version: 1,
      takeover: next.takeover || MANAGE_SCOPE_DEFAULT,
      pendingAgent: next.pendingAgent || null,
      updatedAt: Date.now()
    }
    const tmp = `${MANAGE_FILE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8')
    fs.renameSync(tmp, MANAGE_FILE)
    return doc
  } catch {
    return null
  }
}

// 「自动修复通知策略」：一个总开关，管所有对外推送（需求箱 / QQ 私聊 / Windows 气泡）。
// 默认 notify（维持现状）；silent = 照常修、只不推送，面板历史与日志照常记录。
const NOTIFY_POLICY_FILE = path.join(REPAIR_STATE, 'notify-policy.json')

function readNotifyPolicy() {
  const doc = readJson(NOTIFY_POLICY_FILE, null) || {}
  const mode = doc.mode === 'silent' ? 'silent' : 'notify'
  return { mode, updatedAt: Number(doc.updatedAt) || 0 }
}

function writeNotifyPolicy(mode) {
  const next = mode === 'silent' ? 'silent' : 'notify'
  try {
    fs.mkdirSync(REPAIR_STATE, { recursive: true })
    const doc = { version: 1, mode: next, updatedAt: Date.now() }
    const tmp = `${NOTIFY_POLICY_FILE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8')
    fs.renameSync(tmp, NOTIFY_POLICY_FILE)
    return { ok: true, ...doc }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

// 「同一故障重复出现」的提醒开关：和通知总开关并列，互不影响。
// on（默认）= 照旧提醒；off = 同一故障再次出现时不弹提醒，但修复与历史照常。
const REPEAT_ALERT_FILE = path.join(REPAIR_STATE, 'repeat-alert.json')

function readRepeatAlert() {
  const doc = readJson(REPEAT_ALERT_FILE, null) || {}
  return {
    mode: doc.mode === 'off' ? 'off' : 'on',
    updatedAt: Number(doc.updatedAt) || 0
  }
}

function writeRepeatAlert(mode) {
  const next = mode === 'off' ? 'off' : 'on'
  try {
    fs.mkdirSync(REPAIR_STATE, { recursive: true })
    const old = readJson(REPEAT_ALERT_FILE, null)
    const doc = {
      ...(old && typeof old === 'object' ? old : {}),
      version: 1,
      mode: next,
      updatedAt: Date.now()
    }
    const tmp = `${REPEAT_ALERT_FILE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, REPEAT_ALERT_FILE)
    return { ok: true, mode: doc.mode, updatedAt: doc.updatedAt }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/** 读 profile 里的 agent-default-model（DSH 本体跑会话用的模型） */
function readAgentDefault() {
  try {
    const text = fs.readFileSync(PROFILE_PATCH_FILE, 'utf8')
    const i = text.indexOf('- id: agent-default-model')
    if (i < 0) return { exists: false, file: PROFILE_PATCH_FILE, provider: '', model: '', effort: '' }
    const rest = text.slice(i)
    const j = rest.search(/\n- /)
    const block = j < 0 ? rest : rest.slice(0, j)
    const pick = (k) => {
      const m = new RegExp(`^\\s+${k}:\\s*([^\\n#]*)`, 'm').exec(block)
      return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''
    }
    return {
      exists: true,
      file: PROFILE_PATCH_FILE,
      provider: pick('provider'),
      model: pick('model'),
      effort: pick('reasoningEffort')
    }
  } catch (e) {
    return { exists: false, file: PROFILE_PATCH_FILE, provider: '', model: '', error: e?.message || String(e) }
  }
}

/** 改 profile 里的 agent-default-model；改前备份，重启 DSH 才生效 */
function writeAgentDefault(provider, model) {
  try {
    const text = fs.readFileSync(PROFILE_PATCH_FILE, 'utf8')
    const i = text.indexOf('- id: agent-default-model')
    if (i < 0) return { ok: false, error: `profile 里找不到 agent-default-model（${PROFILE_PATCH_FILE}）` }
    const rest = text.slice(i)
    const j = rest.search(/\n- /)
    const head = text.slice(0, i)
    const block = j < 0 ? rest : rest.slice(0, j)
    const tail = j < 0 ? '' : rest.slice(j)
    if (!/^\s+provider:/m.test(block) || !/^\s+model:/m.test(block)) {
      return { ok: false, error: '这一块里没有 provider/model 行，不敢乱改' }
    }
    const next = block
      .replace(/^(\s+)provider:.*$/m, `$1provider: ${provider}`)
      .replace(/^(\s+)model:.*$/m, `$1model: ${model}`)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = `${PROFILE_PATCH_FILE}.bak-manage-${stamp}`
    fs.copyFileSync(PROFILE_PATCH_FILE, backup)
    const tmp = `${PROFILE_PATCH_FILE}.tmp`
    fs.writeFileSync(tmp, head + next + tail, 'utf8')
    fs.renameSync(tmp, PROFILE_PATCH_FILE)
    return { ok: true, backup }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/** QQ 桥接 config.json 里的兜底模型（reply 用途为空时才会用到） */
function readBridgeModel() {
  const doc = readJson(BRIDGE_CONFIG_FILE, null) || {}
  return {
    file: BRIDGE_CONFIG_FILE,
    provider: String(doc?.dsh?.provider || ''),
    model: String(doc?.dsh?.model || '')
  }
}

function writeBridgeModel(provider, model) {
  try {
    const doc = readJson(BRIDGE_CONFIG_FILE, null)
    if (!doc) return { ok: false, error: '读不到 qq-bridge/config.json' }
    if (!doc.dsh || typeof doc.dsh !== 'object') doc.dsh = {}
    doc.dsh.provider = provider
    doc.dsh.model = model
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = `${BRIDGE_CONFIG_FILE}.bak-manage-${stamp}`
    fs.copyFileSync(BRIDGE_CONFIG_FILE, backup)
    const tmp = `${BRIDGE_CONFIG_FILE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8')
    fs.renameSync(tmp, BRIDGE_CONFIG_FILE)
    return { ok: true, backup }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

// 需要 Key 的提供方：Key 不落配置、不落代码，由 DSH 凭据系统按名解析。
const PROVIDER_KEY_ENV = {
  minimax: 'MINIMAX_API_KEY',
  'minimax-cn': 'MINIMAX_CN_API_KEY'
}

/** 守护进程是否在跑（读它自己的 pid 锁） */
function daemonAlive() {
  try {
    const pid = Number(String(fs.readFileSync(path.join(REPAIR_STATE, 'auto-repair.pid'), 'utf8')).trim())
    if (!pid) return { alive: false, pid: 0 }
    try {
      process.kill(pid, 0)
      return { alive: true, pid }
    } catch {
      return { alive: false, pid }
    }
  } catch {
    return { alive: false, pid: 0 }
  }
}

/** 读最近 N 条修复历史 */
function recentHistory(limit = 40) {
  try {
    const file = path.join(REPAIR_STATE, 'repair-history.jsonl')
    if (!fs.existsSync(file)) return []
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    const out = []
    for (const line of lines.slice(-limit).reverse()) {
      try {
        const o = JSON.parse(line)
        out.push({
          at: o.at,
          code: o.code,
          title: o.title,
          ok: !!o.ok,
          attempted: o.attempted !== false,
          action: o.action,
          detail: o.detail || ''
        })
      } catch {}
    }
    return out
  } catch {
    return []
  }
}

/** 读巡检日志尾部 */
function recentLog(limit = 60) {
  try {
    const file = path.join(REPAIR_STATE, 'auto-repair.log')
    if (!fs.existsSync(file)) return []
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    return lines.slice(-limit).reverse()
  } catch {
    return []
  }
}

/** 频次计数 */
function counters() {
  return readJson(path.join(REPAIR_STATE, 'repair-counter.json'), {})
}

/** 跑一次 auto-repair CLI（只诊断不修复），拿到结构化结论 */
function runDiagnose(timeoutMs = 25000) {
  return new Promise((resolve) => {
    if (!fs.existsSync(REPAIR_ENTRY)) {
      resolve({ ok: false, error: '找不到 auto-repair 脚本', findings: [] })
      return
    }
    try {
      execFile(
        findNode(),
        [REPAIR_ENTRY, '--check'],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (err && !stdout) {
            resolve({ ok: false, error: err.message, findings: [] })
            return
          }
          try {
            const findings = JSON.parse(String(stdout || '[]').trim() || '[]')
            resolve({ ok: true, findings })
          } catch (e) {
            resolve({ ok: false, error: `解析诊断输出失败：${e.message}`, findings: [], raw: String(stdout).slice(0, 500) })
          }
        }
      )
    } catch (e) {
      resolve({ ok: false, error: e.message, findings: [] })
    }
  })
}

/** 触发一次真实修复（跑一轮 --once） */
function runRepair(timeoutMs = 60000) {
  return new Promise((resolve) => {
    if (!fs.existsSync(REPAIR_ENTRY)) {
      resolve({ ok: false, error: '找不到 auto-repair 脚本', output: '' })
      return
    }
    try {
      execFile(
        findNode(),
        [REPAIR_ENTRY, '--once'],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout, stderr) => {
          resolve({
            ok: !err,
            output: String(stdout || '') + String(stderr || ''),
            error: err ? err.message : ''
          })
        }
      )
    } catch (e) {
      resolve({ ok: false, error: e.message, output: '' })
    }
  })
}

/** 汇总状态 —— 面板首屏要的东西 */
async function collectStatus() {
  const d = daemonAlive()
  const diag = await runDiagnose()
  const findings = diag.findings || []
  const fatal = findings.filter((f) => f.severity === 'fatal')
  const warn = findings.filter((f) => f.severity === 'warn')
  const info = findings.filter((f) => f.severity === 'info')
  const policy = readPolicyFile()

  return {
    ok: true,
    at: Date.now(),
    daemon: {
      alive: d.alive,
      pid: d.pid,
      intervalMs: Number(process.env.AUTO_REPAIR_INTERVAL_MS || 30000),
      installed: fs.existsSync(REPAIR_ENTRY)
    },
    health: fatal.length ? 'fatal' : warn.length ? 'warn' : 'ok',
    counts: { fatal: fatal.length, warn: warn.length, info: info.length, total: findings.length },
    // 审批策略：逐条审批 / 全部自动 / 全拒绝
    policy,
    // 通知策略：notify = 照常推送；silent = 一条都不发（修照常修）
    notify: readNotifyPolicy(),
    // 重复故障提醒：on = 照旧提醒；off = 同一故障再次出现时不弹（修复与记录照常）
    repeatAlert: readRepeatAlert(),
    // findings 里每条都带了 fixable / needsHuman / rejected / handoff（由守护进程 enrich）
    findings,
    counters: counters(),
    history: recentHistory(30),
    log: recentLog(40),
    daemonError: diag.ok ? null : diag.error
  }
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function apply(ctx) {
  let webServer
  try {
    webServer = (typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined) || ctx?.webServer
  } catch {
    webServer = ctx?.webServer
  }
  if (!webServer || typeof webServer.register !== 'function') {
    try { ctx?.logger?.warn?.(`[${NS}] webServer 不可用，API 路由未注册`) } catch {}
    return
  }

  const disposers = []

  /** DSH 凭据服务（用于「Key 配了没」的只读描述，绝不读取值本身） */
  function credentialsOf() {
    try {
      return (typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined) || ctx?.credentials
    } catch {
      return undefined
    }
  }

  /** 描述一个凭据引用：{configured, source, writable}，读不到返回 null */
  async function describeCredential(ref) {
    const svc = credentialsOf()
    if (!svc || typeof svc.describe !== 'function') return null
    try {
      const info = await svc.describe(ref)
      return {
        configured: info?.configured === true,
        source: info?.source || null,
        writable: info?.writable !== false
      }
    } catch {
      return null
    }
  }

  /**
   * 这个模型此刻能不能用（用于面板上「自动投喂」的状态提示）。
   * 与守护进程 models.mjs 的判定口径一致：缺 Key / 路由未启用 / 模型不存在都算不可用。
   */
  function readinessFromProviders(providers, provider, model) {
    const group = (providers || []).find((p) => p.id === provider)
    if (!group) return { ok: false, code: 'UNKNOWN_PROVIDER', reason: `没有 ${provider} 这个提供方` }
    if (!(group.models || []).some((m) => m.id === model)) {
      return { ok: false, code: 'UNKNOWN_MODEL', reason: `${provider} 下没有 ${model} 这个模型` }
    }
    if (group.available === false) {
      return { ok: false, code: 'ROUTE_DOWN', reason: `${group.name || provider} 路由还没加载（多半是改了配置但没重启 DSH）` }
    }
    if (group.keyConfigured === false) {
      return { ok: false, code: 'NO_KEY', reason: `缺少 ${group.keyEnv}：在 DSH 设置里配置，或写进 .dsh/.credentials.yaml 的 refs，然后重启 DSH` }
    }
    return { ok: true, code: null, reason: '可用' }
  }

  /**
   * 模型目录 = 守护进程读到的 DSH 实时目录 + 内置兜底清单，
   * 再由宿主侧补上「Key 配了没」的状态与提示。
   */
  async function collectModels() {
    const r = await runCli(['--models'], 30000)
    const base = r.json
    const usesDoc = readModelUses()
    if (!base || base.ok === false) {
      return {
        ok: false,
        error: base?.error || r.error || r.stderr || '读不到模型列表',
        providers: [],
        current: readModelChoiceFile(),
        uses: usesDoc.uses,
        enabled: usesDoc.enabled,
        warnings: []
      }
    }

    const warnings = []
    for (const p of base.providers || []) {
      // 路由还没加载（多半是没重启 DSH）：先说明这个，不再叠加 Key 提示
      if (p.available === false) {
        warnings.push(`${p.name} 路由尚未加载：确认 DSH profile 已挂载 @deepseek-ai/dsh-llm-pi-ai，重启 DSH 后才会生效。`)
        continue
      }
      if (!p.keyEnv) continue
      const info = await describeCredential(p.keyEnv)
      p.key = info
      p.keyConfigured = info ? info.configured : null
      if (info && !info.configured) {
        warnings.push(`缺少 ${p.name} 的 API Key（${p.keyEnv}）：在 DSH 设置里配置，或写进 .dsh/.credentials.yaml 的 refs 下，然后重启 DSH。`)
      } else if (!info) {
        warnings.push(`读不到 ${p.keyEnv} 的配置状态（凭据服务不可用），请自行确认该 Key 已在 DSH 里配置。`)
      }
    }
    if (base.catalogError) {
      warnings.push(`DSH 模型目录读取失败：${base.catalogError}（下列模型来自内置兜底清单）`)
    }

    const cur = base.current || null
    const readiness = cur ? readinessFromProviders(base.providers || [], cur.provider, cur.model) : null

    return { ...base, warnings: [...new Set(warnings)], readiness, uses: usesDoc.uses, enabled: usesDoc.enabled }
  }

  /**
   * 扫本机装了哪些模型客户端（TRAE / MiniMax）。
   * 扫不到就如实返回空/未安装，不编路径；扫描失败也只降级成一条错误提示。
   */
  async function collectClients() {
    const r = await runCli(['--scan-clients'], 40000)
    const base = r.json
    if (!base || base.ok === false || !Array.isArray(base.clients)) {
      return { ok: false, error: base?.error || r.error || r.stderr || '扫描客户端失败', clients: [] }
    }
    return base
  }

  // ── 提供方接入信息（API 地址 / Key 状态） ────────────────────────────────
  //
  // Key 明文只在这一层进、这一层出：
  //   - 进：面板 POST 上来，直接交给 ctx.credentials.set(ref, value)，
  //         由 DSH 写进 ~/.dsh/.credentials.yaml（权限 600），**不落我们自己的文件**。
  //   - 出：只给 describe() 的结果 + 尾 4 位（尾 4 位存在 ~/.dsh-auto-repair/ 下）。
  //   任何返回值、日志里都不出现明文。
  const KEY_ENV = Object.freeze({
    zhipu: 'ZHIPU_API_KEY',
    minimax: 'MINIMAX_API_KEY',
    'minimax-cn': 'MINIMAX_CN_API_KEY'
  })
  const PROVIDER_NAME = Object.freeze({
    zhipu: '智谱开放平台（bigmodel.cn）',
    minimax: 'MiniMax（国际）',
    'minimax-cn': 'MiniMax（国内）'
  })

  async function collectProviders() {
    const r = await runCli(['--providers'], 20000)
    const base = r.json
    if (!base || base.ok === false || !base.providers) {
      return { ok: false, error: base?.error || r.error || r.stderr || '读取接入信息失败', providers: [] }
    }
    const defaults = base.defaults || {}
    const out = []
    for (const [id, ref] of Object.entries(KEY_ENV)) {
      const saved = base.providers[id] || {}
      const info = await describeCredential(ref)
      out.push({
        id,
        name: PROVIDER_NAME[id] || id,
        keyEnv: ref,
        baseUrl: saved.baseUrl || '',
        defaultBaseUrl: saved.defaultBaseUrl || defaults[id] || '',
        keyTail: saved.keyTail || '',
        keyAt: saved.keyAt || 0,
        managed: saved.managed === true,
        hasKey: info ? info.configured === true : null,
        keySource: info?.source || null,
        writable: info ? info.writable !== false : null
      })
    }
    return { ok: true, providers: out }
  }

  disposers.push(webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: async (req, res) => {
      try {
        sendJson(res, 200, await collectStatus())
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e?.message || String(e) })
      }
    }
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: DIAGNOSE_PATH,
    handler: async (req, res) => {
      const r = await runDiagnose()
      sendJson(res, r.ok ? 200 : 500, r)
    }
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: REPAIR_PATH,
    handler: async (req, res) => {
      const r = await runRepair()
      sendJson(res, r.ok ? 200 : 500, r)
    }
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: HISTORY_PATH,
    handler: async (req, res) => {
      sendJson(res, 200, { ok: true, history: recentHistory(200), counters: counters() })
    }
  }))

  // ── 审批策略 ──────────────────────────────────────────────────────────────
  // 同一个 path 只注册一次（webServer 按 path 建表，重复注册会互相覆盖）。
  disposers.push(webServer.register({
    kind: 'exact',
    path: POLICY_PATH,
    handler: async (req, res) => {
      const method = String(req.method || 'GET').toUpperCase()
      if (method === 'GET') {
        sendJson(res, 200, { ok: true, policy: readPolicyFile() })
        return
      }
      if (method === 'POST' || method === 'PUT') {
        const body = await readBody(req)
        const patch = {}
        if (body.mode !== undefined) patch.mode = String(body.mode)
        if (body.agentAssist !== undefined) patch.agentAssist = body.agentAssist === true
        if (body.autoFeed !== undefined) patch.autoFeed = body.autoFeed === true
        if (!Object.keys(patch).length) {
          sendJson(res, 400, { ok: false, error: '没有要改的字段' })
          return
        }
        const r = await writePolicy(patch)
        sendJson(res, r.ok ? 200 : 500, r.ok ? { ok: true, policy: r.policy } : { ok: false, error: r.error })
        return
      }
      sendJson(res, 405, { ok: false, error: '方法不允许' })
    }
  }))

  // ── 自动修复通知策略（一个总开关） ────────────────────────────────────────
  disposers.push(webServer.register({
    kind: 'exact',
    path: NOTIFY_PATH,
    handler: async (req, res) => {
      const method = String(req.method || 'GET').toUpperCase()
      if (method === 'GET') {
        sendJson(res, 200, { ok: true, notify: readNotifyPolicy() })
        return
      }
      if (method === 'POST' || method === 'PUT') {
        const body = await readBody(req)
        const mode = String(body.mode || '')
        if (mode !== 'notify' && mode !== 'silent') {
          sendJson(res, 400, { ok: false, error: 'mode 只能是 notify 或 silent' })
          return
        }
        const r = writeNotifyPolicy(mode)
        sendJson(res, r.ok ? 200 : 500, r.ok ? { ok: true, notify: { mode: r.mode, updatedAt: r.updatedAt } } : r)
        return
      }
      sendJson(res, 405, { ok: false, error: '方法不允许' })
    }
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: REPEAT_ALERT_PATH,
    handler: async (req, res) => {
      const method = String(req.method || 'GET').toUpperCase()
      if (method === 'GET') {
        sendJson(res, 200, { ok: true, repeatAlert: readRepeatAlert() })
        return
      }
      if (method === 'POST' || method === 'PUT') {
        const body = await readBody(req)
        const mode = String(body.mode || '')
        if (mode !== 'on' && mode !== 'off') {
          sendJson(res, 400, { ok: false, error: 'mode 只能是 on 或 off' })
          return
        }
        const r = writeRepeatAlert(mode)
        sendJson(res, r.ok ? 200 : 500, r.ok ? { ok: true, repeatAlert: { mode: r.mode, updatedAt: r.updatedAt } } : r)
        return
      }
      sendJson(res, 405, { ok: false, error: '方法不允许' })
    }
  }))

  // ── 本地用量（口径：本地统计，非厂商账单） ────────────────────────────────
  const USAGE_PATH = `${API_BASE}/usage`
  const USAGE_STORE = pathToFileURL('D:\\大肥鱼\\auto-repair\\usage.mjs').href
  const PRICE_MOD = pathToFileURL('D:\\大肥鱼\\qq-bridge\\src\\model-prices.js').href

  /** 北京时间自然日 key。 */
  const dayKeyOf = (t) => new Date(Number(t) + 8 * 3600 * 1000).toISOString().slice(0, 10)

  disposers.push(webServer.register({
    kind: 'exact',
    path: USAGE_PATH,
    handler: async (req, res) => {
      const method = String(req.method || 'GET').toUpperCase()
      const url = new URL(String(req.url || ''), 'http://127.0.0.1')
      try {
        const store = await import(USAGE_STORE)
        if (method === 'GET') {
          const days = Number(url.searchParams.get('days')) === 30 ? 30 : 7
          const source = String(url.searchParams.get('source') || 'all')
          const era = ['legacy', 'current'].includes(String(url.searchParams.get('era') || '')) ? String(url.searchParams.get('era')) : 'all'
          const includeTest = url.searchParams.get('test') === '1'
          // 从「days 天前的北京 0 点」开始，避免按滚动 24h 切割自然日。
          const todayStart = new Date(`${dayKeyOf(Date.now())}T00:00:00+08:00`).getTime()
          const sinceMs = todayStart - (days - 1) * 24 * 3600 * 1000
          const read = store.readUsageRecords({ sinceMs, includeTest })
          const usageStats = read.stats || { unknown: 0, recovered: 0 }
          let records = read.records || []
          if (source !== 'all') records = records.filter((r) => r.src === source)
          // 「历史」= 切换智谱前 / 桥接账本里留下的 DeepSeek 记录；「当前」= 之后用智谱等模型的记录。
          const eraOf = (r) => (/deepseek/i.test(r.p) || /deepseek/i.test(r.m) ? 'legacy' : 'current')
          const eraCount = { legacy: { count: 0, tokens: 0 }, current: { count: 0, tokens: 0 } }
          for (const r of records) {
            const e = eraCount[eraOf(r)]
            e.count += 1
            e.tokens += r.input + r.output
          }
          if (era !== 'all') records = records.filter((r) => eraOf(r) === era)

          let prices = null
          try {
            prices = await import(PRICE_MOD)
          } catch { /* 价目表读不到就全部标「未计价」，绝不编价格 */ }
          const table = (() => {
            try { return prices?.resolvePriceTable?.() ?? prices?.DEFAULT_PRICE_TABLE } catch { return prices?.DEFAULT_PRICE_TABLE }
          })()

          const totals = { count: 0, input: 0, output: 0, tokens: 0, cost: 0, unpriced: 0, missing: 0, failed: 0, ms: 0, msKnown: 0 }
          const byDay = new Map()
          const byProvider = new Map()
          const byModel = new Map()
          const bySource = new Map()
          const bump = (map, key, r, cost, priced) => {
            const cur = map.get(key) || { count: 0, input: 0, output: 0, tokens: 0, cost: 0, unpriced: 0 }
            cur.count += 1
            cur.input += r.input
            cur.output += r.output
            cur.tokens += r.input + r.output
            cur.cost += cost
            if (!priced) cur.unpriced += 1
            map.set(key, cur)
          }
          for (const r of records) {
            const buckets = r.b ?? { cacheMiss: r.input, cacheHit: 0, cacheWrite: 0, output: r.output }
            let cost = 0
            let priced = false
            if (prices && table) {
              try {
                const rates = prices.ratesAt(r.m, r.t, table)
                // 目录里没有这个模型时 ratesAt 会回落到兜底模型并置 estimated —— 那属于「编价格」，不采用。
                if (!rates?.estimated) {
                  cost = prices.costOfBuckets(buckets, rates).total
                  priced = true
                }
              } catch { priced = false }
            }
            totals.count += 1
            totals.input += r.input
            totals.output += r.output
            totals.tokens += r.input + r.output
            totals.cost += cost
            if (!priced) totals.unpriced += 1
            if (r.missing) totals.missing += 1
            if (!r.ok) totals.failed += 1
            if (r.ms > 0) { totals.ms += r.ms; totals.msKnown += 1 }
            bump(byDay, dayKeyOf(r.t), r, cost, priced)
            bump(byProvider, r.p || '未知厂商', r, cost, priced)
            bump(byModel, `${r.p || '未知厂商'}/${r.m || '未知模型'}`, r, cost, priced)
            bump(bySource, r.src, r, cost, priced)
          }
          const series = []
          for (let i = 0; i < days; i += 1) {
            const d = dayKeyOf(sinceMs + i * 24 * 3600 * 1000)
            const v = byDay.get(d) || { count: 0, input: 0, output: 0, tokens: 0, cost: 0, unpriced: 0 }
            series.push({ d, ...v })
          }
          const rows = (map, keyName) => [...map.entries()]
            .map(([k, v]) => ({ [keyName]: k, ...v, cost: Math.round(v.cost * 1e6) / 1e6 }))
            .sort((a, b) => b.tokens - a.tokens)
          sendJson(res, 200, {
            ok: true,
            meta: {
              local: true,
              note: '本地统计，非厂商账单',
              days,
              source,
              era,
              eraCount,
              unknown: usageStats.unknown,
              recovered: usageStats.recovered,
              pricedOk: Boolean(prices && table),
              currency: table?.currency || 'CNY',
              symbol: table?.symbol || '¥',
              priceVersion: table?.version || ''
            },
            totals: { ...totals, cost: Math.round(totals.cost * 1e6) / 1e6, avgMs: totals.msKnown ? Math.round(totals.ms / totals.msKnown) : 0 },
            series,
            byProvider: rows(byProvider, 'provider'),
            byModel: rows(byModel, 'model'),
            bySource: rows(bySource, 'source')
          })
          return
        }
        if (method === 'POST') {
          const body = await readBody(req)
          if (body?.action === 'purge-test') {
            const dropped = store.purgeTestRecords()
            sendJson(res, dropped < 0 ? 500 : 200, dropped < 0 ? { ok: false, error: '清理失败（可能有别的进程在写）' } : { ok: true, dropped })
            return
          }
          const list = Array.isArray(body?.records) ? body.records : (body?.record ? [body.record] : [])
          if (!list.length) { sendJson(res, 400, { ok: false, error: '需要 records 数组' }); return }
          let written = 0
          for (const r of list.slice(0, 500)) {
            if (store.appendUsage({ ...r, test: body?.test === true })) written += 1
          }
          sendJson(res, 200, { ok: true, written })
          return
        }
        sendJson(res, 405, { ok: false, error: '方法不允许' })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: `用量账本不可用：${e?.message || String(e)}` })
      }
    }
  }))

  // ── 手动修某一条（= 用户点了那一条的「修复」） ────────────────────────────
  disposers.push(webServer.register({
    kind: 'exact',
    path: REPAIR_ONE_PATH,
    handler: async (req, res) => {
      if (String(req.method || '').toUpperCase() !== 'POST') {
        sendJson(res, 405, { ok: false, error: '方法不允许' })
        return
      }
      const body = await readBody(req)
      const code = String(body.code || '').trim()
      if (!code) {
        sendJson(res, 400, { ok: false, error: '缺少 code' })
        return
      }
      const r = await runCli(['--repair', code], 120000)
      const json = r.json || { ok: false, error: r.error || r.stderr || '修复失败' }
      sendJson(res, json.ok ? 200 : 200, { ...json, output: r.stdout })
    }
  }))

  // ── 一次性把能修的全修了 ─────────────────────────────────────────────────
  disposers.push(webServer.register({
    kind: 'exact',
    path: REPAIR_ALL_PATH,
    handler: async (req, res) => {
      if (String(req.method || '').toUpperCase() !== 'POST') {
        sendJson(res, 405, { ok: false, error: '方法不允许' })
        return
      }
      const r = await runCli(['--repair-all'], 180000)
      const json = r.json || { ok: false, error: r.error || r.stderr || '批量修复失败' }
      sendJson(res, 200, { ...json, output: r.stdout })
    }
  }))

  // ── 把某一条交给 AI 会话去修 ─────────────────────────────────────────────
  disposers.push(webServer.register({
    kind: 'exact',
    path: AGENT_PATH,
    handler: async (req, res) => {
      if (String(req.method || '').toUpperCase() !== 'POST') {
        sendJson(res, 405, { ok: false, error: '方法不允许' })
        return
      }
      const body = await readBody(req)
      const code = String(body.code || '').trim()
      if (!code) {
        sendJson(res, 400, { ok: false, error: '缺少 code' })
        return
      }

      // 缺 Key 时先把话说清楚，别让 agent 会话建出来才发现发不出请求。
      const choice = readModelChoiceFile()
      const keyEnv = choice ? PROVIDER_KEY_ENV[choice.provider] : null
      if (keyEnv) {
        const info = await describeCredential(keyEnv)
        if (info && !info.configured) {
          sendJson(res, 200, {
            ok: false,
            error: `当前模型 ${choice.provider}/${choice.model} 需要 ${keyEnv}，但 DSH 里没有配置这个 Key。请补上后重启 DSH，或在面板里换成别的模型。`
          })
          return
        }
      }

      const r = await runCli(['--agent', code], 60000)
      const json = r.json || { ok: false, error: r.error || r.stderr || '拉起 AI 失败' }
      // route=model：这次走的是「升级给模型」这条路，面板据此打标记
      sendJson(res, 200, { ...json, route: json?.ok ? 'model' : null })
    }
  }))

  // ── AI 模型选择（「让 AI 修」用哪个提供方/模型） ───────────────────────────
  disposers.push(webServer.register({
    kind: 'exact',
    path: MODELS_PATH,
    handler: async (req, res) => {
      const method = String(req.method || 'GET').toUpperCase()
      if (method === 'GET') {
        try {
          sendJson(res, 200, await collectModels())
        } catch (e) {
          sendJson(res, 500, { ok: false, error: e?.message || String(e), providers: [], warnings: [] })
        }
        return
      }
      if (method === 'POST' || method === 'PUT') {
        const body = await readBody(req)
        const provider = String(body.provider || '').trim()
        const model = String(body.model || '').trim()
        const doc = readModelUses()

        // 启用 / 停用一个模型：一家供应商下可以同时启用多个。
        if (body.enabled !== undefined) {
          if (!provider || !model) {
            sendJson(res, 400, { ok: false, error: '缺少 provider 或 model' })
            return
          }
          const existed = await modelExists(provider, model)
          if (!existed) {
            sendJson(res, 400, { ok: false, error: `${provider} 下没有 ${model} 这个模型` })
            return
          }
          const on = body.enabled === true
          if (!on) {
            const usedBy = MODEL_USES.filter((k) => doc.uses[k] && pairKey(doc.uses[k]) === `${provider}::${model}`)
            if (usedBy.length) {
              sendJson(res, 200, {
                ok: false,
                error: `这个模型正被「${usedBy.map((k) => USE_LABEL[k]).join('」「')}」使用，先把用途改到别的模型再停用`
              })
              return
            }
          }
          const key = `${provider}::${model}`
          const enabled = on
            ? (doc.enabled.some((x) => pairKey(x) === key) ? doc.enabled : [...doc.enabled, { provider, model }])
            : doc.enabled.filter((x) => pairKey(x) !== key)
          const saved = writeModelUses({ ...doc, enabled })
          if (!saved) {
            sendJson(res, 200, { ok: false, error: '写入 model-uses.json 失败' })
            return
          }
          sendJson(res, 200, { ok: true, enabled: saved.enabled, uses: saved.uses })
          return
        }

        // 指定某个用途用哪个模型；use 省略时按老接口当「修复」处理（兼容旧界面）。
        const use = body.use === undefined ? 'repair' : String(body.use || '')
        if (!MODEL_USES.includes(use)) {
          sendJson(res, 400, { ok: false, error: `不认识的用途：${use || '(空)'}` })
          return
        }
        // 清空某个用途的指定（「修复」必须留一个模型，守护进程没有「不指定」状态）
        if (body.clearUse === true) {
          if (use === 'repair') {
            sendJson(res, 200, { ok: false, error: '「修复」用途必须指定一个模型，不能清空' })
            return
          }
          const uses = { ...doc.uses, [use]: null }
          const saved = writeModelUses({ ...doc, uses })
          if (!saved) {
            sendJson(res, 200, { ok: false, error: '写入 model-uses.json 失败' })
            return
          }
          sendJson(res, 200, { ok: true, use, uses: saved.uses, enabled: saved.enabled })
          return
        }
        if (!provider || !model) {
          sendJson(res, 400, { ok: false, error: '缺少 provider 或 model' })
          return
        }
        if (!(await modelExists(provider, model))) {
          sendJson(res, 400, { ok: false, error: `${provider} 下没有 ${model} 这个模型` })
          return
        }
        if (use === 'repair') {
          const w = await writeRepairChoice(provider, model)
          if (!w.ok) {
            sendJson(res, 200, { ok: false, error: w.error })
            return
          }
        }
        const uses = { ...doc.uses, [use]: { provider, model } }
        const key = `${provider}::${model}`
        const enabled = doc.enabled.some((x) => pairKey(x) === key) ? doc.enabled : [...doc.enabled, { provider, model }]
        const saved = writeModelUses({ ...doc, uses, enabled })
        if (!saved) {
          sendJson(res, 200, { ok: false, error: '写入 model-uses.json 失败' })
          return
        }
        sendJson(res, 200, {
          ok: true,
          use,
          uses: saved.uses,
          enabled: saved.enabled,
          current: use === 'repair' ? readModelChoiceFile() : undefined
        })
        return
      }
      sendJson(res, 405, { ok: false, error: '方法不允许' })
    }
  }))

  // ── 本机模型客户端：扫描 / 改路径 / 关联启动开关 ──────────────────────────
  disposers.push(webServer.register({
    kind: 'exact',
    path: CLIENTS_PATH,
    handler: async (req, res) => {
      const method = String(req.method || 'GET').toUpperCase()
      if (method === 'GET') {
        try {
          sendJson(res, 200, await collectClients())
        } catch (e) {
          sendJson(res, 500, { ok: false, error: e?.message || String(e), clients: [] })
        }
        return
      }
      if (method === 'POST' || method === 'PUT') {
        const body = await readBody(req)
        const id = String(body.id || '').trim()
        if (!id) {
          sendJson(res, 400, { ok: false, error: '缺少客户端 id' })
          return
        }
        const patch = { id }
        // path 传空字符串 = 清掉手动路径，回到自动扫描
        if (body.path !== undefined) patch.path = String(body.path || '')
        if (body.launch !== undefined) patch.launch = body.launch === true
        const r = await runCli(['--set-client', JSON.stringify(patch)], 30000)
        const json = r.json
        if (!json?.ok) {
          sendJson(res, 200, { ok: false, error: json?.error || r.error || r.stderr || '保存失败' })
          return
        }
        // 改完立刻回一份最新的扫描结果，前端不用再请求一次
        sendJson(res, 200, { ...json, ...(await collectClients()) })
        return
      }
      sendJson(res, 405, { ok: false, error: '方法不允许' })
    }
  }))

  // ── 提供方接入信息：API 地址 / API Key（Key 只写进 DSH 凭据存储） ─────────
  disposers.push(webServer.register({
    kind: 'exact',
    path: PROVIDERS_PATH,
    handler: async (req, res) => {
      const method = String(req.method || 'GET').toUpperCase()
      if (method === 'GET') {
        try {
          sendJson(res, 200, await collectProviders())
        } catch (e) {
          sendJson(res, 500, { ok: false, error: e?.message || String(e), providers: [] })
        }
        return
      }
      if (method !== 'POST' && method !== 'PUT') {
        sendJson(res, 405, { ok: false, error: '方法不允许' })
        return
      }

      const body = await readBody(req)
      const id = String(body.id || '').trim()
      const ref = KEY_ENV[id]
      if (!id || !ref) {
        sendJson(res, 400, { ok: false, error: `不认识的提供方：${id || '(空)'}，只支持 ${Object.keys(KEY_ENV).join(' / ')}` })
        return
      }

      // 1) 只做连通性探测
      if (body.probe === true) {
        const r = await runCli(['--probe-provider', JSON.stringify({
          id,
          ...(body.baseUrl !== undefined ? { baseUrl: String(body.baseUrl || '') } : {})
        })], 20000)
        const json = r.json
        if (!json) {
          sendJson(res, 200, { ok: false, error: r.error || r.stderr || '探测失败' })
          return
        }
        sendJson(res, 200, { ...json, ...(await collectProviders()) })
        return
      }

      // 2) 保存 API 地址（空串 = 清掉自定义地址，回到默认）
      if (body.baseUrl !== undefined) {
        const r = await runCli(['--set-provider', JSON.stringify({ id, baseUrl: String(body.baseUrl || '') })], 20000)
        if (!r.json?.ok) {
          sendJson(res, 200, { ok: false, error: r.json?.error || r.error || r.stderr || '地址保存失败' })
          return
        }
      }

      // 3) 保存 Key：明文只交给 DSH 凭据服务，这里不留任何副本
      if (body.apiKey !== undefined) {
        const key = String(body.apiKey || '').trim()
        if (!key) {
          sendJson(res, 200, { ok: false, error: '没有填 Key（要删除已保存的 Key 请点「清除」）' })
          return
        }
        if (/\s/.test(key)) {
          sendJson(res, 200, { ok: false, error: 'Key 里不能有空格或换行，可能粘贴时带进了多余字符' })
          return
        }
        if (key.length < 8) {
          sendJson(res, 200, { ok: false, error: `Key 太短（${key.length} 位），检查是不是复制漏了` })
          return
        }
        const svc = credentialsOf()
        if (!svc || typeof svc.set !== 'function') {
          sendJson(res, 200, {
            ok: false,
            error: '当前 DSH 的凭据服务不支持写入，无法从面板保存 Key；请改用 ~/.dsh/.credentials.yaml 的 refs 配置'
          })
          return
        }
        try {
          await svc.set(ref, key)
        } catch (e) {
          sendJson(res, 200, { ok: false, error: `写入 DSH 凭据失败：${e?.message || e}` })
          return
        }
        await runCli(['--set-provider', JSON.stringify({ id, keyTail: key.slice(-4), keyAt: Date.now() })], 20000)
      }

      // 4) 清除已保存的 Key（同时清掉尾号记录）
      if (body.clearKey === true) {
        const svc = credentialsOf()
        if (!svc || typeof svc.unset !== 'function') {
          sendJson(res, 200, { ok: false, error: '当前 DSH 的凭据服务不支持写入，无法从面板清除 Key' })
          return
        }
        try {
          await svc.unset(ref)
        } catch (e) {
          sendJson(res, 200, { ok: false, error: `清除 DSH 凭据失败：${e?.message || e}` })
          return
        }
        await runCli(['--set-provider', JSON.stringify({ id, clearKey: true })], 20000)
      }

      sendJson(res, 200, { ok: true, ...(await collectProviders()) })
    }
  }))

  // ── 智谱开放平台：地址 / Key / 任务队列 ───────────────────────────────────
  // 面板上独立一页「智谱」。队列串行调用 bigmodel.cn 的 OpenAI 兼容接口，
  // Key 只从 DSH 凭据存储（ZHIPU_API_KEY）里取，接口与日志都不回显明文。
  let zhipuPumpPromise = null

  // 上次进程在任务执行中途被关掉时，队列里会留下 running。启动时把它退回 pending，
  // 否则这条任务永远卡在「执行中」，也没法重试。
  try {
    const stale = readZhipuQueue()
    if (stale.tasks.some((t) => t.status === 'running')) {
      writeZhipuQueue(stale.tasks.map((t) => (t.status === 'running' ? { ...t, status: 'pending', startedAt: 0 } : t)))
    }
  } catch {}

  // ── 提供方元数据 / Key 状态 / 模型（面板与队列共用） ──────────────────────

  let vendorMetaCache = null
  let vendorMetaAt = 0

  /** 所有可在面板里配置的提供方（内置预设 + 自定义），30 秒缓存一次 */
  async function vendorMeta(force = false) {
    if (!force && vendorMetaCache && Date.now() - vendorMetaAt < 30000) return vendorMetaCache
    const r = await runCli(['--providers'], 20000)
    if (r.json && r.json.ok && Array.isArray(r.json.vendors)) {
      vendorMetaCache = r.json
      vendorMetaAt = Date.now()
    }
    return vendorMetaCache || { ok: true, vendors: [], providers: {}, defaults: {} }
  }

  /** 某个提供方实际使用的 Base URL（面板里改过就用改过的） */
  function providerBaseUrl(id, meta = vendorMetaCache) {
    const doc = readJsonFile(PROVIDER_ENDPOINTS_FILE, null)
    const saved = doc && ((doc.providers && doc.providers[id]) || doc[id])?.baseUrl
    const s = typeof saved === 'string' ? saved.trim() : ''
    if (s) return s
    const v = (meta?.vendors || []).find((x) => x.id === id)
    return v?.baseUrl || meta?.defaults?.[id] || ZHIPU_DEFAULT_BASE
  }

  /**
   * 「Key 配了没」必须和队列执行走同一条取用路径。
   *
   * 之前只看 describe()：凭据还在环境变量/尚未落盘时 describe() 会返回未配置，
   * 而队列的 resolve() 能拿到值并真的发出请求 —— 于是出现「页面说缺 Key、任务却
   * 打到智谱并返回 429」的矛盾。现在 describe() 为主（拿真实来源），resolve()
   * 兜底（拿值/尾号），两者任一成立就算已配置。返回值里永远不含明文。
   */
  async function vendorKeyStatus(ref, providerId = '') {
    const svc = credentialsOf()
    if (!svc) return { configured: false, keyTail: '', source: 'unsupported', writable: false }
    let info = null
    try {
      if (typeof svc.describe === 'function') info = await svc.describe(ref)
    } catch {}
    let value = ''
    if (typeof svc.resolve === 'function') {
      try {
        const r = await svc.resolve(ref)
        value = String(r?.value || '')
      } catch {}
    }
    const configured = info?.configured === true || Boolean(value)
    let keyTail = value ? value.slice(-4) : ''
    if (!keyTail && providerId) {
      const saved = readJsonFile(PROVIDER_ENDPOINTS_FILE, null)
      keyTail = String(saved?.providers?.[providerId]?.keyTail || '')
    }
    return {
      configured,
      keyTail,
      // describe() 的 source 才是真实来源（file=凭据文件，env=环境变量）；
      // 只有 resolve() 成功时标 resolve，不再一律写成 store。
      source: configured ? (info?.source || (value ? 'resolve' : 'store')) : 'none',
      writable: info ? info.writable !== false : true
    }
  }

  async function zhipuKeyStatus() {
    return vendorKeyStatus(KEY_ENV.zhipu, 'zhipu')
  }

  // 模型清单直接复用 /models（realtime 目录 + 内置兜底），30 秒缓存一次。
  let vendorModelsCache = null
  let vendorModelsAt = 0
  async function vendorModelsMap(force = false) {
    if (!force && vendorModelsCache && Date.now() - vendorModelsAt < 30000) return vendorModelsCache
    try {
      const all = await collectModels()
      const map = {}
      for (const p of all.providers || []) map[p.id] = p
      vendorModelsCache = map
    } catch {
      vendorModelsCache = vendorModelsCache || {}
    }
    vendorModelsAt = Date.now()
    return vendorModelsCache
  }

  async function zhipuModels() {
    const map = await vendorModelsMap()
    return Array.isArray(map.zhipu?.models) ? map.zhipu.models : []
  }

  /** 某个 model 是否已在供应商目录里（只做存在性校验，不改目录本身） */
  async function modelExists(provider, model) {
    const map = await vendorModelsMap()
    return Boolean((map[provider]?.models || []).some((m) => m.id === model))
  }

  /**
   * 手动「重新检测」：真发最小请求（max_tokens=1），按返回判断
   * 可用 / 缺 Key / 额度问题。
   *
   * ⚠️ 不能只测目录里第一个模型：那往往是最贵的旗舰款，账号没买它的资源包就会返回
   * 429「余额不足或无可用资源包」，把「这个模型没额度」误判成「整个厂商额度耗尽」
   * （智谱就是这样被误标红标的）。所以按「正在用的模型 → 已启用的 → 目录顺序」试几个，
   * 只要有一个真的返回成功，就说明额度可用。
   */
  async function recheckProvider(id) {
    const meta = await vendorMeta()
    const vendor = (meta.vendors || []).find((v) => v.id === id)
    const ref = vendor?.keyEnv || ''
    let key = ''
    if (ref) {
      try {
        const svc = credentialsOf()
        key = String((await svc.resolve(ref))?.value || '')
      } catch {}
    }
    if (!key) {
      writeQuotaOk(id)
      return { ok: false, kind: 'nokey', message: `缺 Key（${ref || '未配置'}），不是额度问题` }
    }
    const map = await vendorModelsMap()
    const catalog = (map[id]?.models || []).map((m) => m.id).filter(Boolean)
    if (!catalog.length) return { ok: false, kind: 'error', message: '目录里没有可用模型，无法检测' }

    const usesDoc = readModelUses()
    const ordered = []
    for (const k of MODEL_USES) {
      const one = usesDoc.uses[k]
      if (one && one.provider === id) ordered.push(one.model)
    }
    for (const e of usesDoc.enabled || []) {
      if (e && e.provider === id) ordered.push(e.model)
    }
    for (const m of catalog) ordered.push(m)
    const seen = new Set()
    const candidates = ordered
      .filter((m) => m && catalog.includes(m) && !seen.has(m) && (seen.add(m), true))
      .slice(0, 5)

    const base = providerBaseUrl(id, meta).replace(/\/+$/, '')
    const tried = []
    for (const model of candidates) {
      let res
      try {
        res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
            stream: false
          }),
          signal: AbortSignal.timeout(30000)
        })
      } catch (e) {
        return { ok: false, kind: 'network', message: `请求没发出去/超时（${model}）：${e?.message || e}` }
      }
      const raw = await res.text()
      if (res.ok) {
        // 有一次真实调用成功 → 立刻清掉旧的额度标记
        writeQuotaOk(id)
        return { ok: true, kind: 'ok', model, message: `可用（${model}，HTTP ${res.status}）` }
      }
      const msg = (raw || `HTTP ${res.status}`).slice(0, 300)
      if (!zhipuQuotaError(`${res.status} ${msg}`)) {
        // 不是额度问题的失败（Key 无效 / 参数错 / 服务端错）→ 不能继续挂「额度耗尽」
        writeQuotaOk(id)
        if (res.status === 401 || res.status === 403) {
          return { ok: false, kind: 'key', message: `Key 无效或没权限：HTTP ${res.status}（${model}）` }
        }
        return { ok: false, kind: 'error', message: `HTTP ${res.status}：${msg}（${model}）` }
      }
      tried.push({ model, status: res.status, msg })
    }

    // 试过的模型全都报额度不足 → 这次才算真·额度问题
    writeQuotaFor(id, {
      exhausted: true,
      at: Date.now(),
      message: `试了 ${tried.length} 个模型都报额度不足：${tried[tried.length - 1].msg}`
    })
    return {
      ok: false,
      kind: 'quota',
      message: `额度问题：${tried.map((t) => t.model).join(' / ')} 都返回 ${tried[tried.length - 1].status} ${tried[tried.length - 1].msg}`
    }
  }

  /**
   * 改「修复」用途时同步守护进程认的那份文件（state/model-choice.json）。
   * 守护进程只读 model-choice.json，所以这里必须走它自己的 CLI，
   * 保证「面板上看到的修复模型」=「真正去修的那个模型」。
   */
  async function writeRepairChoice(provider, model) {
    const r = await runCli(['--set-model', JSON.stringify({ provider, model })], 30000)
    if (r.json?.ok) return { ok: true }
    return { ok: false, error: r.json?.error || r.error || r.stderr || '写入修复模型失败' }
  }

  function pumpZhipu() {
    if (zhipuPumpPromise) return zhipuPumpPromise
    zhipuPumpPromise = (async () => {
      for (;;) {
        const doc = readZhipuQueue()
        const task = doc.tasks.find((t) => t.status === 'pending')
        if (!task) break
        task.status = 'running'
        task.startedAt = Date.now()
        task.attempts += 1
        task.error = ''
        writeZhipuQueue(doc.tasks)

        const provider = String(task.provider || 'zhipu')
        const meta = await vendorMeta()
        const vendor = (meta.vendors || []).find((v) => v.id === provider)
        const ref = vendor?.keyEnv || ''
        let key = ''
        if (ref) {
          try {
            const svc = credentialsOf()
            const r = await svc.resolve(ref)
            key = String(r?.value || '')
          } catch {}
        }
        if (!key) {
          task.status = 'failed'
          task.finishedAt = Date.now()
          task.error = `缺 Key：先在「模型供应商」页填入 ${vendor?.name || provider} 的 API Key（保存到 ${ref || '对应凭据'}）`
          writeZhipuQueue(doc.tasks)
          continue
        }

        const modelMap = await vendorModelsMap()
        const model = task.model || (modelMap[provider]?.models?.[0]?.id) || ''
        const base = providerBaseUrl(provider, meta).replace(/\/+$/, '')
        try {
          const res = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body: JSON.stringify({
              model: model || 'glm-4.7',
              messages: [{ role: 'user', content: task.prompt }],
              stream: false
            }),
            signal: AbortSignal.timeout(180000)
          })
          const raw = await res.text()
          let json = null
          try { json = JSON.parse(raw) } catch {}
          if (!res.ok) {
            const msg = (json && json.error && json.error.message) || raw || `HTTP ${res.status}`
            const errLine = `HTTP ${res.status}：${String(msg).slice(0, 600)}`
            task.status = 'failed'
            task.error = errLine
            // 额度类错误单独记一份，页面据此显示「额度耗尽/需充值」，
            // 而不是继续显示成「缺 Key」——两者原因和处理方式完全不同。
            if (zhipuQuotaError(errLine)) {
              writeQuotaFor(provider, { exhausted: true, at: Date.now(), message: errLine.slice(0, 300) })
            }
          } else {
            const content = json && json.choices && json.choices[0] && json.choices[0].message
              ? json.choices[0].message.content
              : ''
            task.status = 'done'
            task.result = typeof content === 'string' ? content.slice(0, 8000) : raw.slice(0, 2000)
            // 能成功调用说明额度可用，立刻清掉旧的欠费提示（无论之前是否有记录）。
            writeQuotaOk(provider)
          }
        } catch (e) {
          task.status = 'failed'
          task.error = e?.name === 'TimeoutError' ? '请求超时（180 秒）' : String(e?.message || e)
        }
        task.finishedAt = Date.now()
        writeZhipuQueue(doc.tasks)
      }
    })()
      .catch(() => {})
      .finally(() => { zhipuPumpPromise = null })
    return zhipuPumpPromise
  }

  disposers.push(webServer.register({
    kind: 'exact',
    path: ZHIPU_PATH,
    handler: async (req, res) => {
      const method = String(req.method || 'GET').toUpperCase()
      const snapshot = async () => ({
        ok: true,
        baseUrl: zhipuBaseUrl(),
        defaultBaseUrl: ZHIPU_DEFAULT_BASE,
        key: await zhipuKeyStatus(),
        quota: readZhipuQuota(),
        models: await zhipuModels(),
        queue: { running: Boolean(zhipuPumpPromise), tasks: readZhipuQueue().tasks }
      })

      if (method === 'GET') {
        sendJson(res, 200, await snapshot())
        return
      }
      if (method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '方法不允许' })
        return
      }

      const body = await readBody(req)

      // 保存 / 清除 Key
      if (body.apiKey !== undefined || body.clearKey === true) {
        const svc = credentialsOf()
        if (!svc || typeof svc.set !== 'function') {
          sendJson(res, 200, { ok: false, error: '当前 DSH 的凭据服务不支持写入' })
          return
        }
        if (body.clearKey === true) {
          try { await svc.unset(KEY_ENV.zhipu) } catch (e) {
            sendJson(res, 200, { ok: false, error: `清除凭据失败：${e?.message || e}` })
            return
          }
          await runCli(['--set-provider', JSON.stringify({ id: 'zhipu', clearKey: true })], 20000)
          sendJson(res, 200, { ...(await snapshot()), msg: '已清除 Key' })
          return
        }
        const key = String(body.apiKey || '').trim()
        if (key.length < 8) {
          sendJson(res, 200, { ok: false, error: 'Key 太短，没保存' })
          return
        }
        try { await svc.set(KEY_ENV.zhipu, key) } catch (e) {
          sendJson(res, 200, { ok: false, error: `写入 DSH 凭据失败：${e?.message || e}` })
          return
        }
        await runCli(['--set-provider', JSON.stringify({ id: 'zhipu', keyTail: key.slice(-4), keyAt: Date.now() })], 20000)
        sendJson(res, 200, { ...(await snapshot()), msg: 'Key 已保存（只显示尾 4 位）' })
        return
      }

      // 改地址
      if (body.baseUrl !== undefined) {
        const base = String(body.baseUrl || '').trim()
        if (!/^https?:\/\//i.test(base)) {
          sendJson(res, 200, { ok: false, error: '地址必须以 http:// 或 https:// 开头' })
          return
        }
        const r = await runCli(['--set-provider', JSON.stringify({ id: 'zhipu', baseUrl: base })], 20000)
        if (!r.ok || (r.json && r.json.ok === false)) {
          sendJson(res, 200, { ok: false, error: (r.json && r.json.error) || r.error || '保存地址失败' })
          return
        }
        sendJson(res, 200, { ...(await snapshot()), msg: '地址已保存' })
        return
      }

      // 连通性探测（不带 Key 也能看出地址是否真实可达）
      if (body.probe === true) {
        const r = await runCli(['--probe-provider', JSON.stringify({ id: 'zhipu' })], 40000)
        sendJson(res, 200, { ...(await snapshot()), probe: r.json || { ok: false, error: r.error || '探测失败' } })
        return
      }

      const action = String(body.action || '')

      if (action === 'add') {
        const prompt = String(body.prompt || '').trim()
        if (!prompt) {
          sendJson(res, 200, { ok: false, error: '任务内容不能为空' })
          return
        }
        if (prompt.length > 8000) {
          sendJson(res, 200, { ok: false, error: '任务内容太长（上限 8000 字）' })
          return
        }
        const doc = readZhipuQueue()
        const qDefault = (() => {
          const one = readModelUses().uses.queue
          return one && one.provider === String(body.provider || 'zhipu') ? one.model : ''
        })()
        doc.tasks.push({
          id: `zq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          provider: String(body.provider || 'zhipu'),
          prompt,
          model: String(body.model || '').trim() || qDefault || 'glm-4.7',
          status: 'pending',
          createdAt: Date.now(),
          startedAt: 0,
          finishedAt: 0,
          attempts: 0,
          result: '',
          error: ''
        })
        writeZhipuQueue(doc.tasks)
        pumpZhipu()
        sendJson(res, 200, { ...(await snapshot()), msg: '已加入队列' })
        return
      }

      if (action === 'retry' || action === 'retry-all') {
        const doc = readZhipuQueue()
        const id = String(body.id || '')
        let n = 0
        for (const t of doc.tasks) {
          if (t.status !== 'failed') continue
          if (action === 'retry' && t.id !== id) continue
          t.status = 'pending'
          t.error = ''
          t.result = ''
          t.finishedAt = 0
          n += 1
        }
        if (!n) {
          sendJson(res, 200, { ok: false, error: '没有可重试的失败任务' })
          return
        }
        writeZhipuQueue(doc.tasks)
        pumpZhipu()
        sendJson(res, 200, { ...(await snapshot()), msg: `已重新排队 ${n} 条` })
        return
      }

      if (action === 'remove') {
        const id = String(body.id || '')
        const doc = readZhipuQueue()
        const hit = doc.tasks.find((t) => t.id === id)
        if (!hit) {
          sendJson(res, 200, { ok: false, error: '找不到这条任务' })
          return
        }
        if (hit.status === 'running') {
          sendJson(res, 200, { ok: false, error: '执行中的任务不能删' })
          return
        }
        writeZhipuQueue(doc.tasks.filter((t) => t.id !== id))
        sendJson(res, 200, { ...(await snapshot()), msg: '已删除' })
        return
      }

      if (action === 'clear-finished') {
        const doc = readZhipuQueue()
        const kept = doc.tasks.filter((t) => t.status === 'pending' || t.status === 'running')
        writeZhipuQueue(kept)
        sendJson(res, 200, { ...(await snapshot()), msg: `已清理 ${doc.tasks.length - kept.length} 条` })
        return
      }

      sendJson(res, 200, { ok: false, error: `未知操作：${action || '(空)'}` })
    }
  }))

  // ── 模型供应商：主流厂商预设 / 自定义 / Key / 队列 ────────────────────────
  //
  // 数据源只有一份：auto-repair 的 provider-catalog.mjs（预设）+
  // ~/.dsh-auto-repair/provider-endpoints.json 的 custom 段（自定义）。
  // 本页不另存模型清单，模型统一从 /models（DSH 目录 + 兜底）来。

  function yamlStr(v) {
    return `'${String(v == null ? '' : v).replace(/'/g, "''")}'`
  }

  const ROUTE_HEADER = `- insert:
    - id: dsh-auto-repair-ui
      name: 'dsh-auto-repair-ui'

# ── 模型路由（bundle 层）────────────────────────────────────────────────────
# 由「模型供应商」页自动生成：预设厂商 + 用户自定义厂商都在这里注册。
# 用 DSH 自带的 @deepseek-ai/dsh-llm-pi-ai，不新增第三方依赖。
#
# ⚠ 写在 bundle 层：DSH 保存设置时会重写 profile 的 cordis.patch.yml，
#   并抹掉它不管理的行（见 auto-repair/README.md「QQ 桥接掉了」的根因）。
#   bundle 层只在启动时读取、永不被写回，所以注册放这里最稳。
#
# Key 不在本文件里：填在 DSH 设置里配置凭据，或写进
# ~/.dsh/.credentials.yaml 的 refs: 下，或使用同名环境变量。
# 新增/删除供应商后需要重启一次 DSH 才会加载新路由。
`

  function buildRouteYaml(vendors, modelsMap) {
    const lines = [ROUTE_HEADER.trimEnd()]
    lines.push("- insert:")
    lines.push("    - id: llm-pi-ai")
    lines.push("      name: '@deepseek-ai/dsh-llm-pi-ai'")
    lines.push("      config:")
    lines.push("        providers:")
    for (const v of vendors) {
      const models = Array.isArray(modelsMap[v.id]?.models) ? modelsMap[v.id].models : []
      if (!v.keyEnv || !models.length) continue
      const api = v.id === 'minimax' || v.id === 'minimax-cn' ? 'anthropic-messages' : 'openai-completions'
      lines.push(`          ${v.id}:`)
      lines.push(`            apiKeyEnv: ${v.keyEnv}`)
      lines.push(`            displayName: ${yamlStr(v.name)}`)
      lines.push(`            api: ${api}`)
      lines.push(`            baseURL: ${yamlStr(providerBaseUrl(v.id))}`)
      lines.push('            models:')
      for (const m of models) {
        if (!m || !m.id) continue
        const parts = [`id: ${yamlStr(m.id)}`, `name: ${yamlStr(m.name || m.id)}`]
        if (Number(m.contextWindow) > 0) parts.push(`contextWindow: ${Number(m.contextWindow)}`)
        if (m.vision) parts.push('input: [text, image]')
        lines.push(`              - { ${parts.join(', ')} }`)
      }
    }
    return lines.join('\n') + '\n'
  }

  async function ensureRouteConfig(force = false) {
    const meta = await vendorMeta(force)
    const map = await vendorModelsMap(force)
    const next = buildRouteYaml(meta.vendors || [], map)
    let cur = ''
    try { cur = fs.readFileSync(ROUTE_PATCH_FILE, 'utf8') } catch {}
    if (cur === next) return { ok: true, changed: false }
    try {
      const tmp = `${ROUTE_PATCH_FILE}.tmp`
      fs.writeFileSync(tmp, next, 'utf8')
      fs.renameSync(tmp, ROUTE_PATCH_FILE)
      return { ok: true, changed: true }
    } catch (e) {
      return { ok: false, changed: false, error: e?.message || String(e) }
    }
  }

  async function snapshotVendors() {
    const meta = await vendorMeta()
    const map = await vendorModelsMap()
    const vendors = await Promise.all((meta.vendors || []).map(async (v) => {
      const group = map[v.id]
      const key = v.keyEnv
        ? await vendorKeyStatus(v.keyEnv, v.id)
        : { configured: false, keyTail: '', source: 'none', writable: false }
      return {
        id: v.id,
        name: v.name,
        note: v.note || '',
        docs: v.docs || '',
        keyEnv: v.keyEnv || '',
        isCustom: v.isCustom === true,
        verified: v.verified !== false,
        baseUrl: providerBaseUrl(v.id, meta),
        defaultBaseUrl: v.baseUrl || meta.defaults?.[v.id] || '',
        models: Array.isArray(group?.models) ? group.models : [],
        available: group?.available === true,
        key,
        quota: readQuotaFor(v.id)
      }
    }))
    return {
      ok: true,
      vendors,
      uses: readModelUses().uses,
      enabled: readModelUses().enabled,
      queue: { running: Boolean(zhipuPumpPromise), tasks: readZhipuQueue().tasks },
      routeFile: ROUTE_PATCH_FILE,
      routeNeeded: vendors.some((v) => !v.available)
    }
  }

  disposers.push(webServer.register({
    kind: 'exact',
    path: VENDORS_PATH,
    handler: async (req, res) => {
      const method = String(req.method || 'GET').toUpperCase()

      if (method === 'GET') {
        sendJson(res, 200, await snapshotVendors())
        return
      }
      if (method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '方法不允许' })
        return
      }

      const body = await readBody(req)
      const id = String(body.id || '').trim()

      try {
        // 自定义供应商：新增 / 修改 / 删除
        const customAction = String(body.customAction || '').trim()
        if (customAction) {
          if (customAction === 'remove') {
            const meta = await vendorMeta()
            const v = (meta.vendors || []).find((x) => x.id === id)
            if (!v || !v.isCustom) throw new Error('只能删除自定义供应商')
            const svc = credentialsOf()
            if (svc && typeof svc.unset === 'function' && v.keyEnv) {
              try { await svc.unset(v.keyEnv) } catch {}
            }
            await runCli(['--set-provider', JSON.stringify({ id, clearKey: true })], 20000)
            const r = await runCli(['--custom-provider', JSON.stringify({ action: 'remove', id })], 20000)
            if (!r.ok || r.json?.ok === false) throw new Error(r.json?.error || r.error || '删除失败')
          } else {
            const payload = {
              action: customAction === 'add' ? 'add' : 'update',
              ...(customAction === 'add' ? {} : { id }),
              name: body.name,
              baseUrl: body.baseUrl,
              models: body.models,
            }
            const r = await runCli(['--custom-provider', JSON.stringify(payload)], 20000)
            if (!r.ok || r.json?.ok === false) throw new Error(r.json?.error || r.error || '保存失败')
            if (customAction === 'add' && body.apiKey !== undefined) {
              const key = String(body.apiKey || '').trim()
              const env = String(r.json?.keyEnv || '')
              const svc = credentialsOf()
              if (key && env && svc && typeof svc.set === 'function') {
                await svc.set(env, key)
                await runCli(['--set-provider', JSON.stringify({ id: r.json.id, keyTail: key.slice(-4), keyAt: Date.now() })], 20000)
              }
            }
          }
          vendorMetaCache = null
          vendorModelsCache = null
          await ensureRouteConfig(true)
          const snap = await snapshotVendors()
          sendJson(res, 200, { ...snap, msg: customAction === 'remove' ? '已删除自定义供应商' : '已保存自定义供应商（路由需重启 DSH 生效）' })
          return
        }

        const meta = await vendorMeta()
        const vendor = (meta.vendors || []).find((v) => v.id === id)
        if (!vendor) {
          sendJson(res, 200, { ok: false, error: '找不到这个供应商' })
          return
        }

        // 保存 / 清除 Key
        if (body.apiKey !== undefined || body.clearKey === true) {
          const svc = credentialsOf()
          if (!svc || typeof svc.set !== 'function') {
            sendJson(res, 200, { ok: false, error: '当前 DSH 的凭据服务不支持写入' })
            return
          }
          if (!vendor.keyEnv) {
            sendJson(res, 200, { ok: false, error: '这个供应商不需要 Key' })
            return
          }
          if (body.clearKey === true) {
            try { await svc.unset(vendor.keyEnv) } catch (e) {
              sendJson(res, 200, { ok: false, error: `清除凭据失败：${e?.message || e}` })
              return
            }
            await runCli(['--set-provider', JSON.stringify({ id, clearKey: true })], 20000)
            sendJson(res, 200, { ...(await snapshotVendors()), msg: '已清除 Key' })
            return
          }
          const key = String(body.apiKey || '').trim()
          if (key.length < 8) {
            sendJson(res, 200, { ok: false, error: 'Key 太短，没保存' })
            return
          }
          try { await svc.set(vendor.keyEnv, key) } catch (e) {
            sendJson(res, 200, { ok: false, error: `写入 DSH 凭据失败：${e?.message || e}` })
            return
          }
          await runCli(['--set-provider', JSON.stringify({ id, keyTail: key.slice(-4), keyAt: Date.now() })], 20000)
          sendJson(res, 200, { ...(await snapshotVendors()), msg: 'Key 已保存（只显示尾 4 位）' })
          return
        }

        // 改地址（写进路由配置，重启后生效；队列立刻用新地址）
        if (body.baseUrl !== undefined) {
          const base = String(body.baseUrl || '').trim()
          if (!/^https?:\/\//i.test(base)) {
            sendJson(res, 200, { ok: false, error: '地址必须以 http:// 或 https:// 开头' })
            return
          }
          const r = await runCli(['--set-provider', JSON.stringify({ id, baseUrl: base })], 20000)
          if (!r.ok || r.json?.ok === false) {
            sendJson(res, 200, { ok: false, error: r.json?.error || r.error || '保存地址失败' })
            return
          }
          vendorMetaCache = null
          await ensureRouteConfig(true)
          sendJson(res, 200, { ...(await snapshotVendors()), msg: '地址已保存（路由需重启 DSH 生效）' })
          return
        }

        // 连通性探测（不带 Key，避免把密钥发到填错的地址）
        if (body.probe === true) {
          const r = await runCli(['--probe-provider', JSON.stringify({ id })], 40000)
          sendJson(res, 200, { ...(await snapshotVendors()), probe: r.json || { ok: false, error: r.error || '探测失败' } })
          return
        }

        // 重新检测额度：真发一条最小请求（带 Key），按返回判断可用/缺 Key/额度问题
        if (body.recheck === true) {
          const recheck = await recheckProvider(id)
          sendJson(res, 200, { ...(await snapshotVendors()), recheck })
          return
        }

        const action = String(body.action || '')

        if (action === 'add') {
          const prompt = String(body.prompt || '').trim()
          if (!prompt) {
            sendJson(res, 200, { ok: false, error: '任务内容不能为空' })
            return
          }
          if (prompt.length > 8000) {
            sendJson(res, 200, { ok: false, error: '任务内容太长（上限 8000 字）' })
            return
          }
          const map = await vendorModelsMap()
          const models = map[id]?.models || []
          // 没显式指定时，优先用「任务队列默认」这个用途的模型（必须属于当前供应商）
          const qDefault = (() => {
            const one = readModelUses().uses.queue
            return one && one.provider === id ? one.model : ''
          })()
          const model = String(body.model || '').trim() || qDefault || models[0]?.id || ''
          if (!model) {
            sendJson(res, 200, { ok: false, error: '这个供应商还没有可用模型' })
            return
          }
          const doc = readZhipuQueue()
          doc.tasks.push({
            id: `zq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            provider: id,
            prompt,
            model,
            status: 'pending',
            createdAt: Date.now(),
            startedAt: 0,
            finishedAt: 0,
            attempts: 0,
            result: '',
            error: ''
          })
          writeZhipuQueue(doc.tasks)
          pumpZhipu()
          sendJson(res, 200, { ...(await snapshotVendors()), msg: '已加入队列' })
          return
        }

        if (action === 'retry' || action === 'retry-all') {
          const doc = readZhipuQueue()
          let n = 0
          for (const t of doc.tasks) {
            if (t.status !== 'failed') continue
            if (action === 'retry' && t.id !== String(body.taskId || '')) continue
            t.status = 'pending'
            t.error = ''
            t.result = ''
            t.finishedAt = 0
            n += 1
          }
          if (!n) {
            sendJson(res, 200, { ok: false, error: '没有可重试的失败任务' })
            return
          }
          writeZhipuQueue(doc.tasks)
          pumpZhipu()
          sendJson(res, 200, { ...(await snapshotVendors()), msg: `已重新排队 ${n} 条` })
          return
        }

        if (action === 'remove' || action === 'clear-finished') {
          const doc = readZhipuQueue()
          if (action === 'clear-finished') {
            const kept = doc.tasks.filter((t) => t.status === 'pending' || t.status === 'running')
            writeZhipuQueue(kept)
            sendJson(res, 200, { ...(await snapshotVendors()), msg: `已清理 ${doc.tasks.length - kept.length} 条` })
            return
          }
          const hit = doc.tasks.find((t) => t.id === String(body.taskId || ''))
          if (!hit) {
            sendJson(res, 200, { ok: false, error: '找不到这条任务' })
            return
          }
          if (hit.status === 'running') {
            sendJson(res, 200, { ok: false, error: '执行中的任务不能删' })
            return
          }
          writeZhipuQueue(doc.tasks.filter((t) => t.id !== hit.id))
          sendJson(res, 200, { ...(await snapshotVendors()), msg: '已删除' })
          return
        }

        sendJson(res, 200, { ok: false, error: `未知操作：${action || '(空)'}` })
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e?.message || String(e) })
      }
    }
  }))

  // ── 模型管理（总控）：切换 API + 接管范围清单 ─────────────────────────────
  disposers.push(webServer.register({
    kind: 'exact',
    path: MANAGE_PATH,
    handler: async (req, res) => {
      const method = String(req.method || 'GET').toUpperCase()

      const snap = async () => {
        const vendors = await snapshotVendors()
        const manage = readManageDoc()
        const repair = readModelChoiceFile()
        return {
          ok: true,
          vendors: (vendors.vendors || []).map((v) => ({
            id: v.id,
            name: v.name,
            keyEnv: v.keyEnv || '',
            verified: v.verified !== false,
            configured: Boolean(v.key?.configured),
            models: (v.models || []).map((m) => ({ id: m.id, name: m.name || m.id }))
          })),
          uses: vendors.uses,
          enabled: vendors.enabled,
          repair: repair ? { provider: repair.provider, model: repair.model } : null,
          agent: readAgentDefault(),
          bridge: readBridgeModel(),
          takeover: manage.takeover,
          pendingAgent: manage.pendingAgent
        }
      }

      if (method === 'GET') {
        sendJson(res, 200, await snap())
        return
      }
      if (method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '方法不允许' })
        return
      }

      try {
        const body = await readBody(req)
        const action = String(body.action || '').trim()

        // 接管范围开关
        if (action === 'saveTakeover') {
          const doc = readManageDoc()
          const src = body.takeover && typeof body.takeover === 'object' ? body.takeover : {}
          for (const k of MANAGE_SCOPES) {
            if (typeof src[k] === 'boolean') doc.takeover[k] = src[k]
          }
          writeManageDoc(doc)
          sendJson(res, 200, { ...(await snap()), message: '接管范围已保存' })
          return
        }

        // 切换：只作用于勾选接管的范围；DSH 本体只记待应用值，等用户点按钮
        if (action === 'switch') {
          const target = normalizeModelPair(body.provider, body.model)
          const scopes = Array.isArray(body.scopes) ? body.scopes.map((x) => String(x)) : []
          if (!target) {
            sendJson(res, 200, { ok: false, error: '先选厂商和模型' })
            return
          }
          const map = await vendorModelsMap()
          const hit = (map[target.provider]?.models || []).some((m) => m.id === target.model)
          if (!hit) {
            sendJson(res, 200, { ok: false, error: `目录里没有 ${target.provider}/${target.model}` })
            return
          }
          const meta = await vendorMeta()
          const vendor = (meta.vendors || []).find((v) => v.id === target.provider)
          if (vendor?.keyEnv) {
            const ks = await vendorKeyStatus(vendor.keyEnv, target.provider)
            if (!ks?.configured) {
              sendJson(res, 200, { ok: false, error: `${vendor.name || target.provider} 还没配 Key，切过去也用不了` })
              return
            }
          }

          const results = []
          const usesDoc = readModelUses()
          let usesChanged = false
          const enableOne = () => {
            if (!usesDoc.enabled.some((e) => pairKey(e) === pairKey(target))) {
              usesDoc.enabled.push({ provider: target.provider, model: target.model })
            }
          }

          if (scopes.includes('repair')) {
            const r = await writeRepairChoice(target.provider, target.model)
            if (r.ok) {
              usesDoc.uses.repair = { provider: target.provider, model: target.model }
              enableOne()
              usesChanged = true
              results.push({ scope: 'repair', ok: true, message: '已写入 model-choice.json，守护进程下次运行即用' })
            } else {
              results.push({ scope: 'repair', ok: false, message: r.error || '写入失败' })
            }
          }
          if (scopes.includes('queue')) {
            usesDoc.uses.queue = { provider: target.provider, model: target.model }
            enableOne()
            usesChanged = true
            results.push({ scope: 'queue', ok: true, message: '之后新加的任务默认用它（即时生效）' })
          }
          if (scopes.includes('reply')) {
            usesDoc.uses.reply = { provider: target.provider, model: target.model }
            enableOne()
            usesChanged = true
            results.push({ scope: 'reply', ok: true, message: '桥接每条消息热读，下一条消息起生效（无需重启）' })
          }
          if (usesChanged) writeModelUses(usesDoc)

          if (scopes.includes('bridge')) {
            const r = writeBridgeModel(target.provider, target.model)
            results.push({
              scope: 'bridge',
              ok: r.ok,
              needsRestart: r.ok,
              message: r.ok ? '兜底配置已写入，重启桥接后生效（全天回复本身已热读，不受影响）' : r.error
            })
          }
          if (scopes.includes('agent')) {
            const doc = readManageDoc()
            doc.pendingAgent = { provider: target.provider, model: target.model }
            writeManageDoc(doc)
            results.push({
              scope: 'agent',
              ok: true,
              needsRestart: true,
              message: '已记下目标值，点「写入 DSH 本体」后才落盘，且需重启 DSH 生效'
            })
          }

          const failed = results.filter((r) => !r.ok)
          sendJson(res, 200, {
            ...(await snap()),
            ok: failed.length === 0,
            results,
            error: failed.length ? failed.map((r) => r.message).join('；') : undefined,
            needsRestart: results.some((r) => r.needsRestart)
          })
          return
        }

        // 写入 DSH 本体（agent-default-model）：必须由用户点按钮触发
        if (action === 'applyAgent') {
          const manage = readManageDoc()
          const target = normalizeModelPair(body.provider, body.model) || manage.pendingAgent
          if (!target) {
            sendJson(res, 200, { ok: false, error: '没有待写入的目标模型，先在上面选一个' })
            return
          }
          const map = await vendorModelsMap()
          if (!(map[target.provider]?.models || []).some((m) => m.id === target.model)) {
            sendJson(res, 200, { ok: false, error: `目录里没有 ${target.provider}/${target.model}` })
            return
          }
          const r = writeAgentDefault(target.provider, target.model)
          if (!r.ok) {
            sendJson(res, 200, { ok: false, error: r.error })
            return
          }
          manage.pendingAgent = null
          writeManageDoc(manage)
          sendJson(res, 200, {
            ...(await snap()),
            ok: true,
            needsRestart: true,
            backup: r.backup,
            message: `已写入 agent-default-model = ${target.provider}/${target.model}，重启 DSH 后生效`
          })
          return
        }

        sendJson(res, 200, { ok: false, error: `未知操作：${action || '(空)'}` })
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e?.message || String(e) })
      }
    }
  }))

  // ── 忽略 / 取消忽略某一条 ─────────────────────────────────────────────────
  disposers.push(webServer.register({
    kind: 'exact',
    path: IGNORE_PATH,
    handler: async (req, res) => {
      if (String(req.method || '').toUpperCase() !== 'POST') {
        sendJson(res, 405, { ok: false, error: '方法不允许' })
        return
      }
      const body = await readBody(req)
      const code = String(body.code || '').trim()
      if (!code) {
        sendJson(res, 400, { ok: false, error: '缺少 code' })
        return
      }
      const ignored = body.ignored !== false
      const r = await writePolicy(ignored ? { addRejected: [code] } : { removeRejected: [code] })
      sendJson(res, r.ok ? 200 : 500, r.ok ? { ok: true, code, ignored, policy: r.policy } : { ok: false, error: r.error })
    }
  }))

  const dispose = () => {
    for (const d of disposers) {
      try { d?.dispose?.() } catch {}
    }
  }
  if (typeof ctx?.effect === 'function') ctx.effect(() => dispose, `${NS}: api routes`)
  try {
    ctx?.logger?.info?.(`[${NS}] API 路由就绪: ${STATUS_PATH}, ${DIAGNOSE_PATH}, ${REPAIR_PATH}, ${HISTORY_PATH}, ${POLICY_PATH}, ${MODELS_PATH}, ${CLIENTS_PATH}, ${PROVIDERS_PATH}, ${REPAIR_ONE_PATH}, ${REPAIR_ALL_PATH}, ${AGENT_PATH}, ${IGNORE_PATH}`)
  } catch {}
  return dispose
}

/**
 * cordis 依赖注入声明：这个宿主侧 bundle 需要哪些服务。
 * 注意与客户端的 `inject: ['slots']`（插槽）不是一回事 —— 这里是**宿主服务**。
 */
const inject = ['webServer']
const name = NS

export { apply, inject, name }
