// auto-repair · AI 模型选择
//
// 面板上「让 AI 修」时用哪个模型/提供方，选择结果存在 state/model-choice.json。
//
// 两条原则：
//   1. 可选模型**只列真实存在的**：优先读 DSH 的 session/modelCatalog；
//      DSH 连不上时，回落到这里的内置清单（DeepSeek 来自 DSH 目录，
//      MiniMax 来自 DSH 内置的 pi-ai 提供方目录，不是编出来的名字）。
//   2. 这里**只存 provider/model**，不碰任何密钥。MiniMax 的 Key 由 DSH
//      凭据系统按名解析（MINIMAX_API_KEY / MINIMAX_CN_API_KEY）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ROOT } from './diagnose.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STATE = process.env.REPAIR_STATE_DIR
  ? path.resolve(process.env.REPAIR_STATE_DIR)
  : path.join(HERE, 'state')
const CHOICE_FILE = path.join(STATE, 'model-choice.json')
const BRIDGE_DIR = path.join(ROOT, 'qq-bridge')

// 内置兜底清单。
//   deepseek-account 的模型来自本机 DSH 的 session/modelCatalog 实测结果；
//   MiniMax 的模型来自 DSH 自带的 @earendil-works/pi-ai 提供方目录
//   （minimax / minimax-cn，Anthropic Messages 协议）。
// 它不是「另编一份可选列表」，只是 DSH 暂时连不上时仍能把界面画出来。
const FALLBACK_PROVIDERS = [
  {
    id: 'deepseek-account',
    name: 'DeepSeek Account',
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }
    ]
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    keyEnv: 'MINIMAX_API_KEY',
    models: [
      { id: 'MiniMax-M2.7', name: 'MiniMax-M2.7' },
      { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax-M2.7-highspeed' },
      { id: 'MiniMax-M3', name: 'MiniMax-M3' }
    ]
  },
  {
    id: 'minimax-cn',
    name: 'MiniMax 中国站',
    keyEnv: 'MINIMAX_CN_API_KEY',
    models: [
      { id: 'MiniMax-M2.7', name: 'MiniMax-M2.7' },
      { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax-M2.7-highspeed' },
      { id: 'MiniMax-M3', name: 'MiniMax-M3' }
    ]
  }
]

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return fallback
  }
}

function cloneProviders() {
  return FALLBACK_PROVIDERS.map((p) => ({
    id: p.id,
    name: p.name,
    keyEnv: p.keyEnv || null,
    models: p.models.map((m) => ({ ...m }))
  }))
}

function normalizeProviderId(provider) {
  return String(provider || '').trim()
}

/** 读用户的选择；没选过（或文件坏了）返回 null —— 表示沿用 DSH 自己的默认模型 */
export function readChoice() {
  const doc = readJson(CHOICE_FILE, null)
  const src = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {}
  const provider = normalizeProviderId(src.provider)
  const model = String(src.model || '').trim()
  if (!provider || !model) return null
  return { provider, model, updatedAt: Number(src.updatedAt) || 0 }
}

/** 落盘用户的选择（只认 provider/model 两个字段） */
export function writeChoice(patch) {
  const provider = normalizeProviderId(patch?.provider)
  const model = String(patch?.model || '').trim()
  if (!provider || !model) throw new Error('provider 和 model 都不能为空')
  const next = { provider, model, updatedAt: Date.now() }
  fs.mkdirSync(STATE, { recursive: true })
  fs.writeFileSync(CHOICE_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

/** 在结果列表里找某个 provider/model */
export function findModel(providers, provider, model) {
  const group = (providers || []).find((p) => p.id === normalizeProviderId(provider))
  if (!group) return null
  const hit = (group.models || []).find((m) => m.id === String(model || '').trim())
  return hit ? { provider: group.id, name: group.name, model: hit } : null
}

function withTimeout(promise, ms, label) {
  let timer = null
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms)
    })
  ]).finally(() => { if (timer) clearTimeout(timer) })
}

/** 读 DSH 的实时模型目录（会话 API，只读，不消费 token） */
async function readDshCatalog(timeoutMs) {
  const cfg = readJson(path.join(BRIDGE_DIR, 'config.json'), {})
  const baseUrl = String(cfg?.dsh?.baseUrl || '').trim()
  if (!baseUrl) throw new Error('拿不到 DSH 地址（qq-bridge/config.json 的 dsh.baseUrl）')

  const { NodeApiClient, unwrap } = await import(
    pathToFileURL(path.join(BRIDGE_DIR, 'src', 'dsh-client.js')).href
  )
  const api = new NodeApiClient(baseUrl, undefined, {
    token: String(cfg?.dsh?.authToken || ''),
    tokenExplicit: cfg?.dsh?.authTokenExplicit === true
  })
  const value = unwrap(
    await withTimeout(api.callUnary('session/modelCatalog', {}), timeoutMs, '读取 DSH 模型目录'),
    'session/modelCatalog'
  )
  if (!value || typeof value !== 'object') throw new Error('DSH 模型目录返回为空')
  return value
}

/** 把 DSH 目录的一行模型整成面板用的形状（去掉描述等噪音） */
function normalizeLiveModel(m) {
  const efforts = Array.isArray(m?.reasoning?.efforts)
    ? m.reasoning.efforts.map((e) => String(e.id)).filter(Boolean)
    : []
  return {
    id: String(m?.id || ''),
    name: String(m?.name || m?.id || ''),
    ...(efforts.length ? { reasoningEfforts: efforts } : {})
  }
}

/**
 * 列出可选的提供方/模型，并给出当前选择。
 *
 * @returns {Promise<{
 *   ok: boolean, current: {provider:string, model:string, explicit:boolean}|null,
 *   providers: Array, catalogError: string|null, failures: Array
 * }>}
 */
export async function listModels({ timeoutMs = 8000 } = {}) {
  const providers = cloneProviders()
  const liveById = new Map(providers.map((p) => [p.id, p]))
  let catalogError = null
  let failures = []
  let dshDefault = null

  try {
    const catalog = await readDshCatalog(timeoutMs)
    dshDefault = catalog.default && catalog.default.provider && catalog.default.model
      ? { provider: String(catalog.default.provider), model: String(catalog.default.model) }
      : null
    failures = Array.isArray(catalog.failures) ? catalog.failures : []

    const routable = new Set((catalog.routableProviders || []).map(String))
    for (const group of catalog.groups || []) {
      const id = String(group.id || '')
      if (!id) continue
      let target = liveById.get(id)
      if (!target) {
        target = { id, name: String(group.name || id), keyEnv: null, models: [] }
        providers.push(target)
        liveById.set(id, target)
      }
      target.name = String(group.name || target.name)
      target.available = true
      for (const model of group.models || []) {
        const normalized = normalizeLiveModel(model)
        if (!normalized.id) continue
        const idx = target.models.findIndex((m) => m.id === normalized.id)
        if (idx >= 0) target.models[idx] = { ...target.models[idx], ...normalized }
        else target.models.push(normalized)
      }
    }
    // 路由已注册但目录没返回（例如缺 Key 时 listModels 返回空）：
    // 仍标成可用，模型名用兜底清单，避免面板里整组消失。
    for (const id of routable) {
      let target = liveById.get(id)
      if (!target) {
        target = { id, name: id, keyEnv: null, models: [] }
        providers.push(target)
        liveById.set(id, target)
      }
      target.available = true
    }
    // 没在 DSH 目录里出现的提供方（多数是还没重启、路由未挂载）
    for (const p of providers) {
      if (p.available === undefined) p.available = p.id === 'deepseek-account'
    }
  } catch (e) {
    catalogError = e?.message || String(e)
    for (const p of providers) p.available = p.id === 'deepseek-account'
  }

  // 过滤掉没有任何模型的空组
  for (const p of providers) {
    if (!Array.isArray(p.models)) p.models = []
    p.models = p.models.filter((m) => m.id)
  }

  const explicit = readChoice()
  // current 永远给出「实际会用哪个」（explicit 优先，否则 DSH 默认），
  // 供 readiness / 守护进程判断；selected 只在用户真的选过时才有值，
  // 面板据此决定下拉框要不要停在「跟随 DSH 默认」上。
  const current = explicit || dshDefault || { provider: 'deepseek-account', model: 'deepseek-flash' }
  return {
    ok: true,
    current: { ...current, explicit: !!explicit },
    selected: explicit ? { provider: explicit.provider, model: explicit.model } : null,
    dshDefault: dshDefault || null,
    providers,
    catalogError,
    failures
  }
}

// ── 可用性判定（缺 Key / 路由未启用） ────────────────────────────────────────
//
// 为什么需要它：自动投喂报错之前必须先判断「这个模型现在能不能用」。
// 缺 Key、路由没加载这类**配置问题**不该把报错灌进会话 —— 灌了也只会再报一次，
// 白烧 token。这里只做**存在性判断**，绝不读取、打印、保存密钥值。

/** 各提供方需要的凭据名（只写名字，值永远不落这里） */
export const PROVIDER_KEY_ENV = Object.freeze({
  minimax: 'MINIMAX_API_KEY',
  'minimax-cn': 'MINIMAX_CN_API_KEY'
})

/** provider → 需要的环境变量/凭据名 */
export function providerKeyEnv(provider) {
  return PROVIDER_KEY_ENV[normalizeProviderId(provider)] || null
}

function fileMentionsKey(file, name) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    // 只看「这个名字有没有被定义」，不读它的值。
    return new RegExp(`(^|[\\s{,])${name}\\s*[:=]`).test(text)
  } catch {
    return false
  }
}

/**
 * 这个凭据名配了没？只看有没有，不看值。
 * 解析顺序与 DSH 一致：进程环境 → ~/.dsh/.credentials.yaml → ~/.dsh/.env。
 */
export function keyConfigured(envName) {
  const name = String(envName || '').trim()
  if (!name) return { configured: false, source: null }
  if (String(process.env[name] || '').trim()) return { configured: true, source: 'env' }
  const dshHome = path.join(os.homedir(), '.dsh')
  const candidates = [
    { file: path.join(dshHome, '.credentials.yaml'), source: 'credentials' },
    { file: path.join(dshHome, '.env'), source: 'dotenv' },
    { file: path.join(dshHome, 'project-env'), source: 'dotenv' }
  ]
  for (const c of candidates) {
    if (fileMentionsKey(c.file, name)) return { configured: true, source: c.source }
  }
  return { configured: false, source: null }
}

/**
 * 判断某个 provider/model 现在能不能真的用。
 *
 * @returns {{ok:boolean, code:string|null, reason:string, keyEnv:string|null, keySource:string|null}}
 *   code: null（可用）/ 'UNKNOWN_PROVIDER' / 'UNKNOWN_MODEL' / 'ROUTE_DOWN' / 'NO_KEY'
 */
export function readinessOf(providers, provider, model) {
  const pid = normalizeProviderId(provider)
  const mid = String(model || '').trim()
  const keyEnv = providerKeyEnv(pid)
  const group = (providers || []).find((p) => p.id === pid)
  if (!group) {
    return { ok: false, code: 'UNKNOWN_PROVIDER', reason: `没有 ${pid} 这个提供方`, keyEnv, keySource: null }
  }
  if (!(group.models || []).some((m) => m.id === mid)) {
    return { ok: false, code: 'UNKNOWN_MODEL', reason: `${pid} 下没有 ${mid} 这个模型`, keyEnv, keySource: null }
  }
  if (group.available === false) {
    return {
      ok: false,
      code: 'ROUTE_DOWN',
      reason: `${group.name || pid} 路由还没加载（多半是改了配置但没重启 DSH）`,
      keyEnv,
      keySource: null
    }
  }
  if (keyEnv) {
    const k = keyConfigured(keyEnv)
    if (!k.configured) {
      return {
        ok: false,
        code: 'NO_KEY',
        reason: `缺少 ${keyEnv}。在 DSH 设置里配置，或写进 ~/.dsh/.credentials.yaml 的 refs，然后重启 DSH`,
        keyEnv,
        keySource: null
      }
    }
    return { ok: true, code: null, reason: '可用', keyEnv, keySource: k.source }
  }
  return { ok: true, code: null, reason: '可用', keyEnv, keySource: null }
}

/**
 * 便捷版：自己拉一次模型目录再判断。
 * 读不到目录时**放行**（只记原因）—— 那是临时连不上，不是配置错误。
 */
export async function readiness({ provider, model, timeoutMs = 8000 } = {}) {
  try {
    const catalog = await listModels({ timeoutMs })
    return readinessOf(catalog.providers, provider, model)
  } catch (e) {
    return {
      ok: true,
      code: null,
      reason: `模型目录读不到（${e?.message || e}），按放行处理`,
      keyEnv: providerKeyEnv(provider),
      keySource: null
    }
  }
}
