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

  const dispose = () => {
    for (const d of disposers) {
      try { d?.dispose?.() } catch {}
    }
  }
  if (typeof ctx?.effect === 'function') ctx.effect(() => dispose, `${NS}: api routes`)
  try {
    ctx?.logger?.info?.(`[${NS}] API 路由就绪: ${STATUS_PATH}, ${DIAGNOSE_PATH}, ${REPAIR_PATH}, ${HISTORY_PATH}`)
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
