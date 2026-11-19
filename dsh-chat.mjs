// auto-repair · 通过 DSH 会话执行一次普通模型任务（队列的 DSH 通道）。
//
// 目的：任务队列的 API 通道直连供应商 HTTP（需要 Key），而 DSH（DeepSeek）
// 走的是 DSH 账号，没有可直连的 API Key。这里用 DSH 会话代替直连，
// 让队列在「运行通道 = DSH」时也能真正跑模型任务。
//
// 输出（stdout）：只有一行 JSON：{ ok, result, error, provider, model }

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ROOT } from './diagnose.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE_DIR = path.join(ROOT, 'qq-bridge')
const WORKSPACE_DIR = process.env.AGENT_REPAIR_WORKSPACE ? path.resolve(process.env.AGENT_REPAIR_WORKSPACE) : ROOT

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return fallback }
}

export async function runChat({ provider, model, prompt, waitMs = 180000 } = {}) {
  const providerId = String(provider || '').trim()
  const modelId = String(model || '').trim()
  const text = String(prompt || '')
  if (!providerId || !modelId || !text.trim()) {
    return { ok: false, error: '需要 provider / model / prompt', provider: providerId, model: modelId }
  }
  const cfg = readJson(path.join(BRIDGE_DIR, 'config.json'), {})
  const baseUrl = String(cfg?.dsh?.baseUrl || '').trim()
  if (!baseUrl) return { ok: false, error: '拿不到 DSH 地址（qq-bridge/config.json 的 dsh.baseUrl）', provider: providerId, model: modelId }

  const clientMod = await import(pathToFileURL(path.join(BRIDGE_DIR, 'src', 'dsh-client.js')).href)
  const { NodeApiClient, unwrap, createTurnCollector } = clientMod
  const api = new NodeApiClient(baseUrl, undefined, {
    token: String(cfg?.dsh?.authToken || ''),
    tokenExplicit: cfg?.dsh?.authTokenExplicit === true
  })

  fs.mkdirSync(WORKSPACE_DIR, { recursive: true })
  const ws = unwrap(await api.workspace.create({ path: WORKSPACE_DIR }), 'workspace.create')
  const workspaceId = ws?.workspace?.workspaceId
  if (!workspaceId) throw new Error('创建 workspace 失败：拿不到 workspaceId')

  const created = unwrap(await api.sessions.create({ workspaceId, agentPreset: 'standard' }), 'sessions.create')
  const sessionId = String(created?.sessionId || '')
  if (!sessionId) throw new Error('创建 DSH 会话失败：拿不到 sessionId')

  api.events.follow(sessionId)
  unwrap(await api.sessions.selectModel({ sessionId, provider: providerId, model: modelId }), 'session.selectModel')

  const collector = createTurnCollector()
  const ac = new AbortController()
  const buffered = []
  let waiter = null
  const wake = () => { if (waiter) { const w = waiter; waiter = null; w() } }
  let markOpen = () => {}
  const opened = new Promise((resolve) => { markOpen = resolve })
  const pump = (async () => {
    try {
      for await (const envelope of api.events.mux({}, ac.signal, () => markOpen())) {
        buffered.push(envelope)
        wake()
      }
    } catch { /* 流断了就按已收到的事件判定 */ }
  })()
  await Promise.race([opened, new Promise((resolve) => setTimeout(resolve, 5000))])

  const accepted = await api.sessions.prompt({
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }]
  })
  if (!accepted?.result?.ok) {
    ac.abort()
    await pump.catch(() => {})
    return {
      ok: false,
      error: `DSH 拒绝了这次投递：${accepted?.result?.error?.code ?? '未知'} ${accepted?.result?.error?.message ?? ''}`,
      provider: providerId,
      model: modelId
    }
  }

  const deadline = Date.now() + Math.max(10000, Number(waitMs) || 180000)
  let done = null
  while (!done) {
    while (buffered.length && !done) {
      const frame = buffered.shift()?.payload
      if (!frame || frame.type !== 'session/event') continue
      if (String(frame.sessionId) !== sessionId) continue
      done = collector.push(frame.event)
    }
    if (done) break
    if (Date.now() > deadline) break
    await Promise.race([
      new Promise((resolve) => { waiter = resolve }),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ])
  }
  ac.abort()
  await pump.catch(() => {})

  if (!done) return { ok: false, error: '等待 DSH 回合结束超时', provider: providerId, model: modelId }
  const reply = typeof done === 'string' ? done : String(done?.text ?? '')
  const reason = typeof done === 'string' ? null : done?.reason
  if (reason?.kind === 'error') {
    return {
      ok: false,
      error: `${reason.error?.code || 'error'}: ${reason.error?.message || 'DSH 回合失败'}`.slice(0, 600),
      provider: providerId,
      model: modelId
    }
  }
  return { ok: true, result: reply.slice(0, 8000), error: '', provider: providerId, model: modelId }
}
