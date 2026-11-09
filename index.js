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
import { fileURLToPath } from 'node:url'

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

const HERE = path.dirname(fileURLToPath(import.meta.url))
// auto-repair 守护进程的实际位置。
// 注意：本插件装在 ~/.dsh/plugins/ 下，而守护进程在 D:\大肥鱼\auto-repair\
// —— 两者**不在同一棵目录树**里，不能用相对路径推算，必须写死绝对路径。
// （用相对路径 ../.. 会算出 ~/.dsh/ 下面去，找不到脚本。）
// 绝对路径可用 REPAIR_DIR 覆盖，方便把插件搬到别的机器上。
const REPAIR_DIR = process.env.REPAIR_DIR || 'D:\\大肥鱼\\auto-repair'
const REPAIR_STATE = path.join(REPAIR_DIR, 'state')
const REPAIR_ENTRY = path.join(REPAIR_DIR, 'auto-repair.mjs')

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
    if (!base || base.ok === false) {
      return {
        ok: false,
        error: base?.error || r.error || r.stderr || '读不到模型列表',
        providers: [],
        current: readModelChoiceFile(),
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

    return { ...base, warnings: [...new Set(warnings)], readiness }
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
        if (!provider || !model) {
          sendJson(res, 400, { ok: false, error: '缺少 provider 或 model' })
          return
        }
        const r = await runCli(['--set-model', JSON.stringify({ provider, model })], 30000)
        const json = r.json
        if (!json?.ok) {
          sendJson(res, 200, { ok: false, error: json?.error || r.error || r.stderr || '切换模型失败' })
          return
        }
        sendJson(res, 200, { ok: true, current: json.current })
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
    ctx?.logger?.info?.(`[${NS}] API 路由就绪: ${STATUS_PATH}, ${DIAGNOSE_PATH}, ${REPAIR_PATH}, ${HISTORY_PATH}, ${POLICY_PATH}, ${MODELS_PATH}, ${CLIENTS_PATH}, ${REPAIR_ONE_PATH}, ${REPAIR_ALL_PATH}, ${AGENT_PATH}, ${IGNORE_PATH}`)
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
