// auto-repair · AI 模型选择
//
// 面板上「让 AI 修」时用哪个模型/提供方，选择结果存在 state/model-choice.json。
//
// 两条原则：
//   1. 可选模型**只列真实存在的**：优先读 DSH 的 session/modelCatalog；
//      DSH 连不上时，回落到这里的内置清单（DeepSeek 来自 DSH 目录，
//      MiniMax 来自 DSH 内置的 pi-ai 提供方目录，不是编出来的名字）。
//   2. 模型选择文件（state/model-choice.json）**只存 provider/model**。
//      1.5.0 起面板可以填 API Key：Key 的明文交给 DSH 凭据存储
//      （~/.dsh/.credentials.yaml 的 refs，经 ctx.credentials.set 写入），
//      本目录只留尾 4 位与设置时间（~/.dsh-auto-repair/provider-endpoints.json）。
//      这里以及任何日志都不读取、不打印、不保存密钥值。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ROOT } from './diagnose.mjs'
import { PROVIDER_PRESETS } from './provider-catalog.mjs'
import { readCustomProviders } from './providers.mjs'

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
const BASE_PROVIDERS = [
  {
    // 智谱开放平台（bigmodel.cn），OpenAI 兼容 /chat/completions。
    // 模型 ID 按官方文档核实：docs.bigmodel.cn/cn/guide/start/model-overview + 各模型页调用示例。
    id: 'zhipu',
    name: '智谱开放平台（bigmodel.cn）',
    keyEnv: 'ZHIPU_API_KEY',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: [
      // ── 文本 / 通用对话 ──
      { id: 'glm-5.3', name: 'GLM-5.3', tag: '旗舰', note: '最新旗舰：复杂软件工程与长程 Agent 最强，日常对话也稳；按量计费最贵（8/28 元每百万 tokens）。' },
      { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', tag: '多模态 · 便宜', note: '原生多模态，能看图片/视频；价格低（0.8/2.8），适合日常对话和看截图。' },
      { id: 'glm-5.3-flashx', name: 'GLM-5.3-FlashX', tag: '高速', note: 'GLM-5.3-Flash 的高速版，约 200 tokens/s，适合高并发、低延迟场景。' },
      { id: 'glm-5.2', name: 'GLM-5.2', tag: 'Coding 工程', note: '长程任务执行稳定，Coding 从代码生成走向工程交付；支持 thinking 推理模式。' },
      { id: 'glm-5.1', name: 'GLM-5.1', tag: 'Coding', note: 'Coding 能力对齐 Claude Opus 4.6，200K 上下文，可长时间自主工作。' },
      { id: 'glm-5', name: 'GLM-5', tag: 'Agent', note: '擅长 Agentic 长程规划与执行，编程能力对齐 Claude Opus 4.5。' },
      { id: 'glm-5-turbo', name: 'GLM-5-Turbo', tag: '长任务', note: '面向复杂长任务专项优化，执行连续性好，比 GLM-5 便宜。' },
      { id: 'glm-4.7', name: 'GLM-4.7', tag: '日常对话 · 性价比', note: '通用对话与推理的主力，便宜（2/8 元每百万 tokens），支持思考模式，适合天天用。' },
      { id: 'glm-4.7-flashx', name: 'GLM-4.7-FlashX', tag: '轻量高速', note: '小尺寸强能力，便宜且快（0.5/3），适合简单任务和高频调用。' },
      { id: 'glm-4.6', name: 'GLM-4.6', tag: '编码 · 工具调用', note: '擅长高级编码、复杂推理与工具调用，是上一代主力。' },
      { id: 'glm-4.5-air', name: 'GLM-4.5-Air', tag: '轻量 · 便宜', note: '轻量模型，推理/编码/智能体表现稳定，价格低（0.8/2）。' },
      { id: 'glm-4.5-airx', name: 'GLM-4.5-AirX', tag: '极速', note: 'GLM-4.5-Air 的极速版，适合低延迟、高响应要求的业务。' },
      { id: 'glm-4-long', name: 'GLM-4-Long', tag: '1M 长文本', note: '1M 上下文，专为超长文本和记忆型任务设计。' },
      { id: 'glm-4.7-flash', name: 'GLM-4.7-Flash', tag: '免费', note: '免费文本模型，30B 级，延续 GLM-4.7 基座的通用能力，适合零成本试用。' },
      { id: 'glm-4.5-flash', name: 'GLM-4.5-Flash', tag: '免费 · 已下线', note: '免费文本模型（128K 上下文）。官方公告 2026-01-30 下线，请求会自动转到 GLM-4.7-Flash，新接入建议直接选 GLM-4.7-Flash。' },
      { id: 'glm-4-flash-250414', name: 'GLM-4-Flash-250414', tag: '免费', note: '免费文本模型，适合轻量任务与连通性测试。' },
      // ── 视觉理解 / 视觉推理 ──
      { id: 'glm-5v-turbo', name: 'GLM-5V-Turbo', tag: '视觉 · Coding', note: '多模态 Coding 基座，能看图片/视频并写代码，适配 Agent 工作流。' },
      { id: 'glm-4.6v', name: 'GLM-4.6V', tag: '视觉 · 工具调用', note: '视觉推理模型，原生支持工具调用，适合看图操作和前端复刻。' },
      { id: 'glm-4.6v-flash', name: 'GLM-4.6V-Flash', tag: '免费 · 视觉', note: '免费的视觉推理模型，适合零成本看图。' },
      { id: 'glm-4.1v-thinking-flashx', name: 'GLM-4.1V-Thinking-FlashX', tag: '视觉推理 · 高速', note: '复杂场景理解与多步视觉推理的高速版，适合高并发视觉任务。' },
      { id: 'glm-4v-flash', name: 'GLM-4V-Flash', tag: '免费 · 图像理解', note: '免费的图像理解模型，适合简单看图问答。' }
    ]
  },
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
      { id: 'MiniMax-M3.1-Flash', name: 'MiniMax-M3.1-Flash' },
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

// 智谱模型的上下文与视觉能力（按官方文档补齐；路由配置与面板都靠这份数据）
const ZHIPU_META = {
  'glm-5.3': [200000, 0], 'glm-5.3-flash': [200000, 1], 'glm-5.3-flashx': [200000, 0],
  'glm-5.2': [200000, 0], 'glm-5.1': [200000, 0], 'glm-5': [200000, 0], 'glm-5-turbo': [200000, 0],
  'glm-4.7': [200000, 0], 'glm-4.7-flashx': [200000, 0], 'glm-4.6': [200000, 0],
  'glm-4.5-air': [128000, 0], 'glm-4.5-airx': [128000, 0], 'glm-4-long': [1000000, 0],
  'glm-4.7-flash': [200000, 0], 'glm-4.5-flash': [128000, 0], 'glm-4-flash-250414': [128000, 0],
  'glm-5v-turbo': [200000, 1], 'glm-4.6v': [128000, 1], 'glm-4.6v-flash': [128000, 1],
  'glm-4.1v-thinking-flashx': [128000, 1], 'glm-4v-flash': [128000, 1],
}
for (const m of BASE_PROVIDERS[0].models) {
  const meta = ZHIPU_META[m.id]
  if (!meta) continue
  m.contextWindow = meta[0]
  if (meta[1]) m.vision = true
}

// 主流厂商预设（provider-catalog.mjs）：每家带默认地址、Key 名与模型说明。
const PRESET_FALLBACKS = PROVIDER_PRESETS.map((p) => ({
  id: p.id,
  name: p.name,
  keyEnv: p.keyEnv,
  baseUrl: p.baseUrl,
  docs: p.docs,
  note: p.note,
  verified: p.verified,
  models: p.models.map((m) => ({ ...m })),
}))

/** 兜底清单 = 老的三个提供方 + 预设目录 + 用户自定义（每次重读，新增自定义不用重启） */
function fallbackProviders() {
  return [
    ...BASE_PROVIDERS,
    ...PRESET_FALLBACKS.map((p) => ({ ...p, models: p.models.map((m) => ({ ...m })) })),
    ...readCustomProviders().map((p) => ({
      ...p,
      models: p.models.map((m) => ({ ...m })),
    })),
  ]
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return fallback
  }
}

function cloneProviders() {
  return fallbackProviders().map((p) => ({
    id: p.id,
    name: p.name,
    keyEnv: p.keyEnv || null,
    ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
    ...(p.docs ? { docs: p.docs } : {}),
    ...(p.note ? { note: p.note } : {}),
    ...(p.isCustom ? { isCustom: true } : {}),
    ...(p.verified === false ? { verified: false } : {}),
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
  zhipu: 'ZHIPU_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  'minimax-cn': 'MINIMAX_CN_API_KEY',
  ...Object.fromEntries(PROVIDER_PRESETS.map((p) => [p.id, p.keyEnv])),
})

/** provider → 需要的环境变量/凭据名（自定义提供方的名字存在本地配置里） */
export function providerKeyEnv(provider) {
  const id = normalizeProviderId(provider)
  const custom = readCustomProviders().find((v) => v.id === id)
  return PROVIDER_KEY_ENV[id] || custom?.keyEnv || null
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
