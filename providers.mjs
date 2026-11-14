// auto-repair · 模型接入信息（API 地址 / Key 状态）
//
// 1.5.0 起，面板上可以给每个提供方填 API Base URL 和 API Key。
//
// 落盘原则（重要）：
//   - **Key 的明文永远不写进这个文件**。这里只留「尾 4 位 + 设置时间 + 是否由面板设置」，
//     用来做遮蔽显示（已配置 ·••••abcd）。
//   - API Key 的值交给 DSH 自己的凭据存储：~/.dsh/.credentials.yaml 的 refs 段
//     （由 ctx.credentials.set() 写入，文件权限由 DSH 强制 600）。
//   - 本文件放在用户主目录 ~/.dsh-auto-repair/ 下，**不在 git 仓库里**，
//     也不写进 README / 日志。目录 700、文件 600，Windows 额外用 icacls 收紧到当前用户。
//   - 终端/接口输出一律只出现尾 4 位，绝不回显明文。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { PROVIDER_PRESETS } from './provider-catalog.mjs'

const DIR = path.join(os.homedir(), '.dsh-auto-repair')
const FILE = path.join(DIR, 'provider-endpoints.json')

/** 内置提供方的展示信息（预设目录之外的三个老提供方） */
const BUILTIN_VENDORS = [
  {
    id: 'zhipu',
    name: '智谱 GLM',
    keyEnv: 'ZHIPU_API_KEY',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    docs: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction',
    note: '智谱开放平台，OpenAI 兼容接口。',
  },
  {
    id: 'minimax',
    name: 'MiniMax（国际站）',
    keyEnv: 'MINIMAX_API_KEY',
    baseUrl: 'https://api.minimax.io/anthropic',
    docs: 'https://platform.minimax.io/docs/guides/text-generation',
    note: '国际站使用 Anthropic 兼容接口 /anthropic，与国内站 Key 不通用。',
  },
  {
    id: 'minimax-cn',
    name: 'MiniMax（国内站）',
    keyEnv: 'MINIMAX_CN_API_KEY',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    docs: 'https://platform.minimaxi.com/docs/guides/text-generation',
    note: '国内站使用 Anthropic 兼容接口 /anthropic，与国外站 Key 不通用。',
  },
]

/** 各提供方在 DSH 里的默认地址（只用于占位提示与探测兜底，不是强制值） */
export const PROVIDER_DEFAULT_BASE = Object.freeze({
  ...Object.fromEntries(BUILTIN_VENDORS.map((v) => [v.id, v.baseUrl])),
  ...Object.fromEntries(PROVIDER_PRESETS.map((v) => [v.id, v.baseUrl])),
})

const BUILTIN_IDS = new Set(BUILTIN_VENDORS.map((v) => v.id))

/** 内置提供方 id（自定义提供方单独判断） */
export const KNOWN_PROVIDERS = Object.freeze(Object.keys(PROVIDER_DEFAULT_BASE))

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return fallback
  }
}

/** 收紧权限：目录 700 / 文件 600；Windows 上再用 icacls 去掉继承、只给当前用户 */
function harden(target, isDir) {
  try { fs.chmodSync(target, isDir ? 0o700 : 0o600) } catch {}
  if (process.platform !== 'win32') return
  const user = String(process.env.USERNAME || '').trim()
  if (!user) return
  try {
    execFile(
      'icacls',
      [target, '/inheritance:r', '/grant:r', `${user}:F`],
      { windowsHide: true, timeout: 8000 },
      () => {}
    )
  } catch {}
}

/** 读接入信息（永远不含 Key 明文） */
export function readEndpoints() {
  const doc = readJson(FILE, null)
  const src = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {}
  const providers = {}
  for (const [id, v] of Object.entries(src.providers || {})) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue
    providers[id] = {
      baseUrl: typeof v.baseUrl === 'string' ? v.baseUrl : '',
      keyTail: typeof v.keyTail === 'string' ? v.keyTail.slice(-4) : '',
      keyAt: Number(v.keyAt) || 0,
      managed: v.managed === true
    }
  }
  return { providers, updatedAt: Number(src.updatedAt) || 0 }
}

function readDoc() {
  const doc = readJson(FILE, null)
  return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {}
}

function normalizeModels(models) {
  const list = Array.isArray(models) ? models : []
  const out = []
  for (const m of list) {
    const id = String(typeof m === 'string' ? m : m?.id || '').trim()
    if (!id || out.some((x) => x.id === id)) continue
    out.push({
      id,
      name: String((typeof m === 'object' && m?.name) || id).trim().slice(0, 80),
      note: '自定义模型',
      tag: '自定义',
      verified: true,
      custom: true,
    })
    if (out.length >= 20) break
  }
  return out
}

/** 读自定义提供方（用户手动填的，存同一个文件的 custom 段） */
export function readCustomProviders() {
  const arr = readDoc().custom
  if (!Array.isArray(arr)) return []
  const out = []
  for (const v of arr) {
    if (!v || typeof v !== 'object') continue
    const id = String(v.id || '').trim()
    if (!/^custom-[a-z0-9-]+$/.test(id)) continue
    const keyEnv = String(v.keyEnv || '').trim()
    if (!/^[A-Z][A-Z0-9_]*$/.test(keyEnv)) continue
    const base = validateBaseUrl(v.baseUrl)
    if (!base.ok || !base.value) continue
    out.push({
      id,
      name: String(v.name || id).trim().slice(0, 40),
      keyEnv,
      baseUrl: base.value,
      docs: '',
      note: '自定义供应商',
      isCustom: true,
      models: normalizeModels(v.models),
    })
  }
  return out
}

/** 列给面板用：内置 + 自定义，带默认地址与 Key 环境变量名 */
export function listVendors() {
  const vendors = BUILTIN_VENDORS.map((v) => ({ ...v, isCustom: false, models: [] }))
  for (const p of PROVIDER_PRESETS) {
    vendors.push({
      id: p.id,
      name: p.name,
      keyEnv: p.keyEnv,
      baseUrl: p.baseUrl,
      docs: p.docs,
      note: p.note,
      verified: p.verified !== false,
      isCustom: false,
      models: [],
    })
  }
  return [...vendors, ...readCustomProviders()]
}

export function isKnownProvider(id) {
  return KNOWN_PROVIDERS.includes(id) || readCustomProviders().some((v) => v.id === id)
}

/** 新增自定义提供方：名称 + 地址 + 模型 ID（可多个） */
export function addCustomProvider({ name, baseUrl, models }) {
  const nm = String(name || '').trim().slice(0, 40)
  if (!nm) throw new Error('名称不能为空')
  const url = validateBaseUrl(baseUrl)
  if (!url.ok) throw new Error(url.error)
  if (!url.value) throw new Error('地址不能为空')
  const list = normalizeModels(models)
  if (!list.length) throw new Error('至少填一个模型 ID')
  const doc = readDoc()
  const custom = Array.isArray(doc.custom) ? doc.custom.slice() : []
  if (custom.length >= 20) throw new Error('自定义供应商最多 20 个')
  const id = `custom-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const keyEnv = `CUSTOM_${Math.random().toString(36).slice(2, 8).toUpperCase()}_API_KEY`
  custom.push({ id, name: nm, keyEnv, baseUrl: url.value, models: list })
  writeEndpoints({ ...doc, custom })
  return { id, keyEnv }
}

export function updateCustomProvider(id, patch) {
  const doc = readDoc()
  const custom = Array.isArray(doc.custom) ? doc.custom.slice() : []
  const i = custom.findIndex((v) => v && v.id === id)
  if (i < 0) throw new Error(`没有这个自定义供应商：${id}`)
  const cur = custom[i]
  const next = { ...cur }
  if (patch.name !== undefined) {
    const nm = String(patch.name || '').trim().slice(0, 40)
    if (!nm) throw new Error('名称不能为空')
    next.name = nm
  }
  if (patch.baseUrl !== undefined) {
    const url = validateBaseUrl(patch.baseUrl)
    if (!url.ok) throw new Error(url.error)
    if (!url.value) throw new Error('地址不能为空')
    next.baseUrl = url.value
  }
  if (patch.models !== undefined) {
    const list = normalizeModels(patch.models)
    if (!list.length) throw new Error('至少填一个模型 ID')
    next.models = list
  }
  custom[i] = next
  writeEndpoints({ ...doc, custom })
  return { id }
}

export function removeCustomProvider(id) {
  const doc = readDoc()
  const custom = Array.isArray(doc.custom) ? doc.custom.filter((v) => v && v.id !== id) : []
  writeEndpoints({ ...doc, custom })
  return { id }
}

function writeEndpoints(doc) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 })
  harden(DIR, true)
  const tmp = `${FILE}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify({ ...doc, updatedAt: Date.now() }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, FILE)
  harden(FILE, false)
  return readEndpoints()
}

/** 只改某一个提供方的字段（不传的字段保持原样） */
export function patchEndpoint(provider, patch) {
  const id = String(provider || '').trim()
  if (!id) throw new Error('provider 不能为空')
  if (!isKnownProvider(id)) {
    throw new Error(`不认识的提供方：${id}，只支持 ${KNOWN_PROVIDERS.join(' / ')} 或自定义供应商`)
  }
  const doc = readEndpoints()
  const cur = doc.providers[id] || { baseUrl: '', keyTail: '', keyAt: 0, managed: false }
  const next = {
    ...cur,
    ...(patch.baseUrl !== undefined ? { baseUrl: String(patch.baseUrl || '') } : {}),
    ...(patch.keyTail !== undefined ? { keyTail: String(patch.keyTail || '').slice(-4) } : {}),
    ...(patch.keyAt !== undefined ? { keyAt: Number(patch.keyAt) || 0 } : {}),
    ...(patch.managed !== undefined ? { managed: patch.managed === true } : {})
  }
  const providers = { ...doc.providers, [id]: next }
  if (!next.baseUrl && !next.keyTail && !next.managed) delete providers[id]
  return writeEndpoints({ ...readDoc(), providers })
}

/** 校验 API 地址：空串表示「清空/回落到默认」，其余必须是 http(s) URL */
export function validateBaseUrl(raw) {
  const v = String(raw || '').trim()
  if (!v) return { ok: true, value: '' }
  if (/\s/.test(v)) return { ok: false, error: '地址里不能有空格或换行' }
  let u
  try {
    u = new URL(v)
  } catch {
    return { ok: false, error: '不是合法 URL：要以 http:// 或 https:// 开头，例如 https://api.minimaxi.com/anthropic' }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: `只支持 http / https 协议，当前是 ${u.protocol}` }
  }
  if (!u.hostname) return { ok: false, error: '地址缺少主机名' }
  const out = u.pathname === '/' ? u.origin : u.toString().replace(/\/+$/, '')
  return { ok: true, value: out }
}

/**
 * 轻量连通性探测。
 *
 * 有意**不带 Authorization 头**：地址填错了也不该把 Key 发到别人机器上。
 * 只要能拿到任何 HTTP 状态码，就说明地址可达（401/403 也算通，只是缺有效 Key）。
 */
export async function probeEndpoint(baseUrl, { timeoutMs = 6000 } = {}) {
  const v = validateBaseUrl(baseUrl)
  if (!v.ok) return { ok: false, error: v.error }
  if (!v.value) return { ok: false, error: '还没填地址' }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(v.value, { method: 'GET', signal: ctrl.signal, redirect: 'manual' })
    const code = res.status
    const detail = (code === 401 || code === 403)
      ? `地址可达（HTTP ${code}，需要有效 Key）`
      : `地址可达（HTTP ${code}）`
    return { ok: true, status: code, detail, url: v.value }
  } catch (e) {
    const cause = e?.cause?.code || e?.cause?.message || ''
    const msg = e?.name === 'AbortError' ? `请求超时（${timeoutMs}ms）` : (cause || e?.message || String(e))
    return { ok: false, error: `连不上 ${v.value}：${msg}` }
  } finally {
    clearTimeout(timer)
  }
}

/** 面板展示用：只给尾 4 位，不给明文 */
export function publicEndpoints() {
  const doc = readEndpoints()
  const out = {}
  for (const [id, v] of Object.entries(doc.providers)) {
    out[id] = {
      baseUrl: v.baseUrl,
      defaultBaseUrl: PROVIDER_DEFAULT_BASE[id] || '',
      keyTail: v.keyTail,
      keyAt: v.keyAt,
      managed: v.managed && !!v.keyTail
    }
  }
  return out
}

/** 是否内置（用于面板区分来源） */
export function isBuiltinVendor(id) {
  return BUILTIN_IDS.has(id) || !!PROVIDER_DEFAULT_BASE[id]
}
