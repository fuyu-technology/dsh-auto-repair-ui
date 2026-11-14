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

// dsh-auto-repair-ui · 客户端
//
// 在 DSH 设置页里加一个「自愈」页面，展示 auto-repair 守护进程的状态。
//
// 挂载方式（DSH 官方插槽契约）：
//   ctx.slots.inject('settings.section', () =>
//     ctx.slots.register({ name:'settings.section', id:'auto-repair', order:50, label:'自愈' }, Component)
//   )
//
// 设计约束（DSH 插件规范）：
//   - 只用主题令牌（CSS 变量），不硬编码颜色 → 亮/暗色都正确
//   - 不 import 任何 Harness Client 包（@deepseek-ai/dsh-client-ui-*）
//   - 不崩：所有取数都要有兜底，面板不能把设置页搞挂

window.__ModuleLoader__.load({
  id: 'dsh-auto-repair-ui',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const API = '/dsh-auto-repair'
    const MAKER = '蝠羽科技'

    // ── 样式：只用主题令牌，亮/暗都跟着系统走 ───────────────────────────
    const STYLE = `
.ar-root {
  --ar-ok: var(--dsw-alias-state-success-primary, #39d98a);
  --ar-warn: var(--dsw-alias-state-warn-primary, #e0a44a);
  --ar-fatal: var(--dsw-alias-state-error-primary, #e05a5a);
  --ar-idle: var(--dsw-alias-label-secondary, #8a8a8a);
  padding: 4px 2px 24px;
  font-size: 13px;
  line-height: 1.6;
}
.ar-head {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px; margin-bottom: 12px;
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, #ffffff08);
}
.ar-dot {
  width: 10px; height: 10px; border-radius: 50%;
  flex: 0 0 auto;
}
.ar-dot.ok { background: var(--ar-ok); box-shadow: 0 0 8px var(--ar-ok); }
.ar-dot.warn { background: var(--ar-warn); box-shadow: 0 0 8px var(--ar-warn); }
.ar-dot.fatal { background: var(--ar-fatal); box-shadow: 0 0 8px var(--ar-fatal); animation: ar-pulse 1.2s ease-in-out infinite; }
@keyframes ar-pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
.ar-title { font-weight: 600; font-size: 14px; }
.ar-sub { color: var(--dsw-alias-label-secondary, #8a8a8a); font-size: 12px; }
/* 标题块允许收缩换行，徽章与按钮保持单行不被挤扁 */
.ar-head-main { flex: 1 1 auto; min-width: 0; }
.ar-head-right { margin-left: auto; flex: 0 0 auto; display: flex; align-items: center; gap: 8px; white-space: nowrap; }
.ar-maker {
  font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8a8a);
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
  border-radius: 999px; padding: 1px 8px;
  flex: 0 0 auto; white-space: nowrap;
}

.ar-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 14px; }
.ar-card {
  border: 1px solid var(--dsw-alias-border-l1, #ffffff12);
  border-radius: 9px; padding: 10px 12px;
  background: var(--dsw-alias-bg-layer-1, #ffffff06);
}
.ar-card-label { color: var(--dsw-alias-label-secondary, #8a8a8a); font-size: 11px; margin-bottom: 3px; }
.ar-card-value { font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; }
.ar-card-value.ok { color: var(--ar-ok); }
.ar-card-value.warn { color: var(--ar-warn); }
.ar-card-value.fatal { color: var(--ar-fatal); }

.ar-btn {
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
  background: var(--dsw-alias-bg-layer-2, #ffffff0d);
  color: var(--dsw-alias-label-primary, inherit);
  border-radius: 7px; padding: 5px 12px; font-size: 12px;
  cursor: pointer; font-family: inherit; white-space: nowrap;
}
.ar-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary, #5b8cff); }
.ar-btn:disabled { opacity: .45; cursor: not-allowed; }
.ar-btn.primary {
  /* 成对使用 DSH 的 primary fill / foreground 令牌，
     这样在任意主题（亮/暗/赛博红）下前景与背景都自带对比度，
     不会出现「白底白字」按钮看不见的情况。 */
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #5b8cff));
  border-color: transparent;
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.ar-btn.primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-button-primary-fill, #5b8cff));
}

.ar-section-title {
  font-size: 12px; font-weight: 600; margin: 16px 0 8px;
  color: var(--dsw-alias-label-secondary, #8a8a8a);
  text-transform: uppercase; letter-spacing: .06em;
}

.ar-finding {
  border: 1px solid var(--dsw-alias-border-l1, #ffffff12);
  border-left-width: 3px; border-radius: 7px;
  padding: 9px 12px; margin-bottom: 7px;
  background: var(--dsw-alias-bg-layer-1, #ffffff06);
}
.ar-finding.fatal { border-left-color: var(--ar-fatal); }
.ar-finding.warn { border-left-color: var(--ar-warn); }
.ar-finding.info { border-left-color: var(--ar-idle); }
.ar-finding-title { font-weight: 600; margin-bottom: 2px; }
.ar-finding-detail { color: var(--dsw-alias-label-secondary, #8a8a8a); font-size: 12px; word-break: break-word; }
.ar-badge {
  display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2, #ffffff12); margin-right: 7px;
  color: var(--dsw-alias-label-secondary, #8a8a8a);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.ar-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.ar-table th {
  text-align: left; padding: 5px 8px; font-weight: 600;
  color: var(--dsw-alias-label-secondary, #8a8a8a);
  border-bottom: 1px solid var(--dsw-alias-border-l1, #ffffff12);
}
.ar-table td { padding: 5px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1, #ffffff0a); vertical-align: top; }
.ar-table tr:last-child td { border-bottom: none; }
.ar-time { color: var(--dsw-alias-label-secondary, #8a8a8a); white-space: nowrap; font-variant-numeric: tabular-nums; }
.ar-ok-mark { color: var(--ar-ok); }
.ar-fail-mark { color: var(--ar-fatal); }

.ar-log {
  max-height: 220px; overflow-y: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; line-height: 1.55;
  border: 1px solid var(--dsw-alias-border-l1, #ffffff12);
  border-radius: 8px; padding: 9px 11px;
  background: var(--dsw-alias-bg-layer-1, #ffffff06);
  white-space: pre-wrap; word-break: break-word;
}
.ar-empty { color: var(--dsw-alias-label-secondary, #8a8a8a); font-size: 12px; padding: 14px 0; }
.ar-note {
  margin-top: 14px; padding: 9px 11px; border-radius: 7px; font-size: 12px;
  border: 1px solid var(--dsw-alias-border-l1, #ffffff12);
  color: var(--dsw-alias-label-secondary, #8a8a8a);
  background: var(--dsw-alias-bg-layer-1, #ffffff06);
}
.ar-note code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; background: var(--dsw-alias-bg-layer-2, #ffffff12);
  padding: 1px 5px; border-radius: 4px;
}
.ar-toast {
  margin-top: 10px; padding: 8px 11px; border-radius: 7px; font-size: 12px;
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
}
.ar-toast.ok { border-left: 3px solid var(--ar-ok); }
.ar-toast.err { border-left: 3px solid var(--ar-fatal); }

/* ── 审批策略 ─────────────────────────────────────────────────────────── */
.ar-policy {
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
  border-radius: 10px; padding: 12px 14px; margin-bottom: 14px;
  background: var(--dsw-alias-bg-layer-1, #ffffff08);
}
.ar-policy-head { display: flex; align-items: center; gap: 10px; margin-bottom: 9px; flex-wrap: wrap; }
.ar-policy-title { font-weight: 600; font-size: 13px; }
.ar-policy-hint { color: var(--dsw-alias-label-secondary, #8a8a8a); font-size: 12px; flex: 1 1 240px; min-width: 0; }
.ar-seg { display: inline-flex; border: 1px solid var(--dsw-alias-border-l2, #ffffff1f); border-radius: 8px; overflow: hidden; }
.ar-seg-btn {
  border: none; background: transparent; color: var(--dsw-alias-label-secondary, #8a8a8a);
  padding: 5px 12px; font-size: 12px; cursor: pointer; font-family: inherit; white-space: nowrap;
}
.ar-seg-btn + .ar-seg-btn { border-left: 1px solid var(--dsw-alias-border-l2, #ffffff1f); }
.ar-seg-btn.on {
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #5b8cff));
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.ar-seg-btn:disabled { opacity: .5; cursor: not-allowed; }
.ar-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; color: var(--dsw-alias-label-primary, inherit); }
.ar-check input { margin: 0; cursor: pointer; }
.ar-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ar-select {
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
  background: var(--dsw-alias-bg-layer-2, #ffffff0d);
  color: var(--dsw-alias-label-primary, inherit);
  border-radius: 8px; padding: 5px 8px; font-size: 12px; font-family: inherit;
  min-width: 200px; max-width: 100%;
}
.ar-select:disabled { opacity: .5; }
/* 客户端路径输入：与下拉框同款令牌，不引入新控件风格 */
.ar-input {
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
  background: var(--dsw-alias-bg-layer-2, #ffffff0d);
  color: var(--dsw-alias-label-primary, inherit);
  border-radius: 8px; padding: 5px 8px; font-size: 12px; font-family: inherit;
  flex: 1 1 320px; min-width: 200px; max-width: 100%;
}
.ar-input:disabled { opacity: .5; }
.ar-client-list { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
.ar-client-row {
  padding: 9px 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
  background: var(--dsw-alias-bg-layer-1, #ffffff06);
  display: flex; flex-direction: column; gap: 6px;
}
.ar-client-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ar-client-name { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }
.ar-client-path {
  font-size: 11px; font-family: ui-monospace, Consolas, monospace;
  color: var(--dsw-alias-label-secondary, #ffffffa6);
  word-break: break-all; line-height: 1.5;
}
.ar-warnbox {
  margin-top: 9px; padding: 8px 10px; border-radius: 7px; font-size: 12px;
  border: 1px solid var(--ar-warn); color: var(--ar-warn);
  background: var(--dsw-alias-bg-layer-1, #ffffff06);
  white-space: pre-wrap; word-break: break-word; line-height: 1.6;
}

/* ── 每条错误的操作按钮 ───────────────────────────────────────────────── */
.ar-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 7px; }
.ar-actions .ar-btn { padding: 3px 10px; font-size: 11px; }
.ar-flag {
  font-size: 10px; padding: 1px 6px; border-radius: 4px; margin-left: 7px;
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
  color: var(--dsw-alias-label-secondary, #8a8a8a);
}
.ar-flag.rejected { color: var(--ar-warn); border-color: var(--ar-warn); }
.ar-flag.agent { color: var(--ar-ok); border-color: var(--ar-ok); }
.ar-reply {
  margin-top: 6px; padding: 7px 9px; border-radius: 6px; font-size: 11px;
  border: 1px solid var(--dsw-alias-border-l1, #ffffff12);
  background: var(--dsw-alias-bg-layer-2, #ffffff0d);
  white-space: pre-wrap; word-break: break-word;
  color: var(--dsw-alias-label-secondary, #8a8a8a);
  max-height: 160px; overflow-y: auto;
}
/* 智谱页：任务队列 */
.zq-task {
  margin-top: 8px; padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1, #ffffff12);
  background: var(--dsw-alias-bg-layer-2, #ffffff0d);
}
.zq-task-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.zq-idx { color: var(--dsw-alias-label-secondary, #8a8a8a); font-size: 11px; }
.zq-chip {
  font-size: 10px; padding: 1px 7px; border-radius: 999px;
  border: 1px solid currentColor;
}
.zq-chip.pending { color: var(--ar-idle); }
.zq-chip.running { color: var(--ar-warn); }
.zq-chip.done { color: var(--ar-ok); }
.zq-chip.failed { color: var(--ar-fatal); }
.zq-prompt { margin-top: 4px; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
.zq-out {
  margin-top: 5px; padding-left: 8px; font-size: 11px;
  color: var(--dsw-alias-label-secondary, #8a8a8a);
  border-left: 2px solid var(--dsw-alias-border-l2, #ffffff1f);
  white-space: pre-wrap; word-break: break-word;
  max-height: 150px; overflow-y: auto;
}
.zq-out.err { color: var(--ar-fatal); border-left-color: var(--ar-fatal); }
.zq-row-actions { display: flex; gap: 6px; margin-top: 6px; }
.zq-row-actions .ar-btn { padding: 2px 9px; font-size: 11px; }
`

    function fmtTime(ts) {
      try {
        return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
      } catch {
        return '--:--:--'
      }
    }
    function fmtDateTime(ts) {
      try {
        return new Date(ts).toLocaleString('zh-CN', { hour12: false })
      } catch {
        return '-'
      }
    }

    async function fetchJson(pathname, options) {
      try {
        const res = await fetch(API + pathname, options || {})
        if (!res.ok && res.status !== 200) {
          const t = await res.text().catch(() => '')
          throw new Error(`HTTP ${res.status} ${t.slice(0, 120)}`)
        }
        return await res.json()
      } catch (e) {
        throw new Error(e?.message || String(e))
      }
    }

    function AutoRepairPanel() {
      const [data, setData] = useState(null)
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState(false)
      const [toast, setToast] = useState(null)
      const [err, setErr] = useState('')
      const [busyCode, setBusyCode] = useState('')
      const [policyBusy, setPolicyBusy] = useState(false)
      // 自动修复通知策略（总开关）：notify = 照常推送；silent = 只修不推
      const [notifyBusy, setNotifyBusy] = useState(false)
      const [models, setModels] = useState(null)
      const [modelBusy, setModelBusy] = useState(false)
      // 本机模型客户端（TRAE / MiniMax）：扫描结果 + 手动改路径时的草稿
      const [clients, setClients] = useState(null)
      const [clientsBusy, setClientsBusy] = useState(false)
      const [clientDraft, setClientDraft] = useState({})
      // 各提供方的 API 地址 / Key 状态（Key 只拿尾 4 位，不拿明文）
      const [providers, setProviders] = useState(null)
      const [providersBusy, setProvidersBusy] = useState(false)
      const [baseDraft, setBaseDraft] = useState({})
      const [keyDraft, setKeyDraft] = useState({})
      // 智谱模型预设的临时选择（providerId → modelId），点「选为『让 AI 修』模型」才落盘
      const [presetPick, setPresetPick] = useState({})
      const timerRef = useRef(null)

      const load = useCallback(async (silent) => {
        try {
          const s = await fetchJson('/status')
          setData(s)
          setErr('')
        } catch (e) {
          setErr(e?.message || String(e))
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => {
        load()
        // 面板开着的时候定时刷新，能看到状态实时变化
        timerRef.current = setInterval(() => load(true), 10000)
        return () => { if (timerRef.current) clearInterval(timerRef.current) }
      }, [load])

      /** 读「让 AI 修」可用的模型/提供方（DSH 实时目录 + 内置兜底） */
      const loadModels = useCallback(async () => {
        try {
          const r = await fetchJson('/models', { cache: 'no-store' })
          setModels(r)
        } catch (e) {
          setModels({ ok: false, error: e?.message || String(e), providers: [], warnings: [] })
        }
      }, [])

      useEffect(() => { loadModels() }, [loadModels])

      /** 扫本机装了哪些模型客户端（扫不到就如实是「未检测到」） */
      const loadClients = useCallback(async (silent) => {
        if (!silent) setClientsBusy(true)
        try {
          const r = await fetchJson('/clients', { cache: 'no-store' })
          setClients(r)
          setClientDraft({})
        } catch (e) {
          setClients({ ok: false, error: e?.message || String(e), clients: [] })
        } finally {
          if (!silent) setClientsBusy(false)
        }
      }, [])

      useEffect(() => { loadClients() }, [loadClients])

      /** 读各提供方的 API 地址 / Key 状态（永远不含 Key 明文） */
      const loadProviders = useCallback(async () => {
        try {
          const r = await fetchJson('/providers', { cache: 'no-store' })
          setProviders(r)
        } catch (e) {
          setProviders({ ok: false, error: e?.message || String(e), providers: [] })
        }
      }, [])

      useEffect(() => { loadProviders() }, [loadProviders])

      /** 保存 API 地址 / Key，或清除 Key（apiKey 明文只在这一次请求里出现） */
      const saveProvider = useCallback(async (id, patch, okText) => {
        setProvidersBusy(true)
        setToast(null)
        try {
          const r = await postJson('/providers', { id, ...patch })
          if (r?.ok === false) {
            setToast({ ok: false, text: String(r.error || '保存失败') })
          } else {
            setProviders({ ok: true, providers: r?.providers || [] })
            setKeyDraft((d) => ({ ...d, [id]: '' }))
            setBaseDraft((d) => ({ ...d, [id]: undefined }))
            setToast({ ok: true, text: okText || '已保存' })
          }
        } catch (e) {
          setToast({ ok: false, text: e?.message || String(e) })
        } finally {
          setProvidersBusy(false)
        }
      }, [])

      /** 轻量连通性探测（不带 Key，避免把密钥发到填错的地址） */
      const probeProvider = useCallback(async (id) => {
        setProvidersBusy(true)
        setToast(null)
        try {
          const draft = baseDraft[id]
          const r = await postJson('/providers', {
            id,
            probe: true,
            ...(draft !== undefined ? { baseUrl: draft } : {})
          })
          if (r?.providers) setProviders({ ok: true, providers: r.providers })
          setToast({ ok: r?.ok === true, text: r?.ok ? String(r.detail || '地址可达') : String(r?.error || '连不上') })
        } catch (e) {
          setToast({ ok: false, text: e?.message || String(e) })
        } finally {
          setProvidersBusy(false)
        }
      }, [baseDraft])

      /** 改客户端路径 / 关联启动开关（改完用返回的新扫描结果直接覆盖，省一次请求） */
      const updateClient = useCallback(async (id, patch) => {
        setClientsBusy(true)
        try {
          const r = await postJson('/clients', { id, ...patch })
          if (r?.ok === false) {
            setToast({ ok: false, text: String(r.error || '保存失败') })
          } else {
            setClients(r)
            setClientDraft({})
            const name = (r?.clients || []).find((c) => c.id === id)?.name || id
            setToast({ ok: true, text: patch.launch !== undefined
              ? `${name}：关联启动已${patch.launch ? '打开' : '关闭'}`
              : `${name}：路径已更新` })
          }
        } catch (e) {
          setToast({ ok: false, text: e?.message || String(e) })
        } finally {
          setClientsBusy(false)
        }
      }, [])

      const doRepair = useCallback(async () => {
        setBusy(true)
        setToast(null)
        try {
          const r = await fetchJson('/repair', { method: 'POST' })
          const out = String(r.output || '').trim()
          setToast({ ok: r.ok !== false, text: out ? out.slice(-600) : (r.ok ? '已完成' : '失败') })
          await load(true)
        } catch (e) {
          setToast({ ok: false, text: e?.message || String(e) })
        } finally {
          setBusy(false)
        }
      }, [load])

      // ── 审批相关的动作 ──────────────────────────────────────────────────

      const postJson = useCallback(async (pathname, body) => {
        return await fetchJson(pathname, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {})
        })
      }, [])

      /** 改审批策略（逐条审批 / 全部自动 / 全拒绝，以及「交给 AI」开关） */
      const setPolicy = useCallback(async (patch) => {
        setPolicyBusy(true)
        setToast(null)
        try {
          const r = await postJson('/policy', patch)
          if (r && r.ok) {
            setToast({ ok: true, text: '策略已更新，下一轮巡检（30 秒内）就按新策略走' })
          } else {
            setToast({ ok: false, text: r?.error || '改策略失败' })
          }
          await load(true)
        } catch (e) {
          setToast({ ok: false, text: e?.message || String(e) })
        } finally {
          setPolicyBusy(false)
        }
      }, [postJson, load])

      /** 改「自动修复通知策略」总开关（发通知 / 完全不发） */
      const setNotifyMode = useCallback(async (mode) => {
        setNotifyBusy(true)
        setToast(null)
        try {
          const r = await postJson('/notify-policy', { mode })
          if (r && r.ok) {
            setToast({ ok: true, text: mode === 'silent'
              ? '已切换为「完全不发」：自动修复照常执行，但不再推送任何对外消息'
              : '已切换为「发通知」：自动修复的消息会照常推送' })
          } else {
            setToast({ ok: false, text: r?.error || '改通知策略失败' })
          }
          await load(true)
        } catch (e) {
          setToast({ ok: false, text: e?.message || String(e) })
        } finally {
          setNotifyBusy(false)
        }
      }, [postJson, load])

      /** 选「让 AI 修」用哪个模型/提供方（只存 provider/model，不碰任何 Key） */
      const setModel = useCallback(async (provider, model) => {
        setModelBusy(true)
        setToast(null)
        try {
          const r = await postJson('/models', { provider, model })
          if (r && r.ok) {
            setToast({ ok: true, text: `已切换到 ${provider} / ${model}，下一次「让 AI 修」就用它` })
          } else {
            setToast({ ok: false, text: r?.error || '切换模型失败' })
          }
          await loadModels()
        } catch (e) {
          setToast({ ok: false, text: e?.message || String(e) })
        } finally {
          setModelBusy(false)
        }
      }, [postJson, loadModels])

      /** 修某一条（= 审批通过这一条） */
      const repairOne = useCallback(async (code) => {
        setBusyCode(code)
        setToast(null)
        try {
          const r = await postJson('/repair-one', { code })
          const lines = Array.isArray(r?.results) && r.results.length
            ? r.results.map((x) => `${x.code}：${x.ok ? '✅' : '⚠️'} ${x.action || ''}`).join('\n')
            : String(r?.error || '（无输出）')
          setToast({ ok: r?.ok !== false, text: lines })
          await load(true)
        } catch (e) {
          setToast({ ok: false, text: e?.message || String(e) })
        } finally {
          setBusyCode('')
        }
      }, [postJson, load])

      /** 把能修的一次全修了 */
      const repairAll = useCallback(async () => {
        setBusy(true)
        setToast(null)
        try {
          const r = await postJson('/repair-all', {})
          const lines = Array.isArray(r?.results) && r.results.length
            ? r.results.map((x) => `${x.code}：${x.ok ? '✅' : '⚠️'} ${x.action || ''}`).join('\n')
            : String(r?.error || '（无输出）')
          setToast({ ok: r?.ok !== false, text: lines })
          await load(true)
        } catch (e) {
          setToast({ ok: false, text: e?.message || String(e) })
        } finally {
          setBusy(false)
        }
      }, [postJson, load])

      /** 把某一条交给 AI 会话去修 */
      const askAgent = useCallback(async (code) => {
        setBusyCode(code)
        setToast(null)
        try {
          const cur = models?.current
          const label = cur ? `${cur.provider} / ${cur.model}` : ''
          const r = await postJson('/agent-assist', { code })
          setToast({
            ok: r?.ok !== false,
            text: r?.ok
              ? `已拉起 AI 协助处理 ${code}${label ? `（模型 ${label}）` : ''}（它在后台跑，完成后这里会显示它的总结）`
              : String(r?.error || '拉起 AI 失败')
          })
          await load(true)
        } catch (e) {
          setToast({ ok: false, text: e?.message || String(e) })
        } finally {
          setBusyCode('')
        }
      }, [postJson, load, models])

      /** 忽略 / 取消忽略某一条 */
      const toggleIgnore = useCallback(async (code, ignored) => {
        setBusyCode(code)
        setToast(null)
        try {
          const r = await postJson('/ignore', { code, ignored })
          setToast({
            ok: r?.ok !== false,
            text: r?.ok ? (ignored ? `已忽略 ${code}，以后不再自动处理` : `已取消忽略 ${code}`) : String(r?.error || '操作失败')
          })
          await load(true)
        } catch (e) {
          setToast({ ok: false, text: e?.message || String(e) })
        } finally {
          setBusyCode('')
        }
      }, [postJson, load])

      if (loading) {
        return h('div', { className: 'ar-root' },
          h('div', { className: 'ar-empty' }, '正在读取自愈状态…')
        )
      }

      if (err && !data) {
        return h('div', { className: 'ar-root' },
          h('div', { className: 'ar-finding fatal' },
            h('div', { className: 'ar-finding-title' }, '读不到自愈守护进程'),
            h('div', { className: 'ar-finding-detail' }, err)
          )
        )
      }

      const d = data || {}
      const health = d.health || 'ok'
      const counts = d.counts || { fatal: 0, warn: 0, info: 0, total: 0 }
      const daemon = d.daemon || {}
      const policy = d.policy || { mode: 'manual', agentAssist: true, autoFeed: true, rejectedCodes: [] }
      const rejectAll = policy.mode === 'reject-all'
      const healthText = health === 'fatal' ? '发现严重故障' : health === 'warn' ? '有可修复项' : '一切正常'
      const healthClass = health === 'fatal' ? 'fatal' : health === 'warn' ? 'warn' : 'ok'
      const policyHint = rejectAll
        ? '全拒绝：守护进程不会自动修任何东西，面板上的「修复」也点不动。改回别的模式即可恢复。'
        : policy.mode === 'approve-all'
          ? '全部自动：守护进程发现能修的直接修，不用等你点。'
          : '逐条审批：守护进程只报告不改，等你点某一条的「修复」才动手。'

      // 通知策略：默认 notify（维持现状），只有明确存了 silent 才是「完全不发」
      const notifyMode = d.notify && d.notify.mode === 'silent' ? 'silent' : 'notify'
      const notifyHint = notifyMode === 'silent'
        ? '当前「完全不发」：自动修复照常执行，但需求箱、QQ 私聊、Windows 气泡一条都不推（含全天回复自己发的提示，比如余额不足自动关闭）；修复历史和日志照常记录。'
        : '当前「发通知」：自动修复的消息和全天回复自己发的提示都照常推送（需求箱 / QQ 私聊 / Windows 气泡），文案与现在一致。'

      // 模型卡片用的数据（/models 拉不到时也要能把面板画出来）
      const modelProviders = Array.isArray(models?.providers) ? models.providers : []
      const modelWarnings = Array.isArray(models?.warnings) ? models.warnings : []
      const modelError = models && models.ok === false ? String(models.error || '读不到模型列表') : ''
      // API 地址 / Key 卡片用的数据（智谱有自己的独立页，不塞在这里）
      const providerList = (Array.isArray(providers?.providers) ? providers.providers : []).filter((p) => p.id !== 'zhipu')
      const providerError = providers && providers.ok === false ? String(providers.error || '读不到接入信息') : ''
      const curModel = models?.current || null
      // 智谱预设：模型清单来自 /models 的 zhipu 组（含中文名 / 标签 / 一句说明）
      const zhipuGroup = modelProviders.find((g) => g.id === 'zhipu') || null
      const zhipuModels = Array.isArray(zhipuGroup?.models) ? zhipuGroup.models : []
      const zhipuRoutable = zhipuGroup?.available === true
      // selected 只在用户真的选过时才有值：没选过就停在「跟随 DSH 默认」，
      // 不再默认把 deepseek 那一项顶上去。
      const selected = models?.selected || null
      const curValue = selected ? `${selected.provider}::${selected.model}` : ''
      const curInList = !!selected && modelProviders.some(
        (g) => g.id === selected.provider && (g.models || []).some((m) => m.id === selected.model)
      )
      const modelHint = selected
        ? `已指定：${selected.provider} / ${selected.model}`
        : curModel
          ? `未指定，跟随 DSH 默认：${curModel.provider} / ${curModel.model}`
          : '还没有选择，下一次「让 AI 修」会用 DSH 的默认模型'

      return h('div', { className: 'ar-root' },
        h('style', null, STYLE),

        // 顶部状态条
        h('div', { className: 'ar-head' },
          h('span', { className: `ar-dot ${healthClass}` }),
          h('div', { className: 'ar-head-main' },
            h('div', { className: 'ar-title' }, healthText),
            h('div', { className: 'ar-sub' },
              daemon.alive
                ? `守护进程运行中 (pid ${daemon.pid}) · 每 ${Math.round((daemon.intervalMs || 30000) / 1000)} 秒巡检`
                : '⚠️ 守护进程未运行 —— supervisor 会在一分钟内补回'
            )
          ),
          h('span', { className: 'ar-maker' }, `制作方：${MAKER}`),
          h('div', { className: 'ar-head-right' },
            h('button', {
              className: 'ar-btn', disabled: busy,
              onClick: () => load()
            }, '刷新'),
            h('button', {
              className: 'ar-btn primary', disabled: busy,
              onClick: doRepair
            }, busy ? '巡检中…' : '巡检一轮')
          )
        ),

        // 概览卡片
        h('div', { className: 'ar-grid' },
          h('div', { className: 'ar-card' },
            h('div', { className: 'ar-card-label' }, '严重故障'),
            h('div', { className: `ar-card-value ${counts.fatal ? 'fatal' : 'ok'}` }, counts.fatal || 0)
          ),
          h('div', { className: 'ar-card' },
            h('div', { className: 'ar-card-label' }, '可修复项'),
            h('div', { className: `ar-card-value ${counts.warn ? 'warn' : 'ok'}` }, counts.warn || 0)
          ),
          h('div', { className: 'ar-card' },
            h('div', { className: 'ar-card-label' }, '待人工'),
            h('div', { className: `ar-card-value ${counts.info ? 'warn' : 'ok'}` }, counts.info || 0)
          ),
          h('div', { className: 'ar-card' },
            h('div', { className: 'ar-card-label' }, '累计修复'),
            h('div', { className: 'ar-card-value' },
              (d.history || []).filter((x) => x.ok).length
            )
          )
        ),

        toast ? h('div', { className: `ar-toast ${toast.ok ? 'ok' : 'err'}` }, toast.text) : null,

        // ── 审批策略 ────────────────────────────────────────────────────
        h('div', { className: 'ar-policy' },
          h('div', { className: 'ar-policy-head' },
            h('span', { className: 'ar-policy-title' }, '审批策略'),
            h('span', { className: 'ar-policy-hint' }, policyHint)
          ),
          h('div', { className: 'ar-row' },
            h('div', { className: 'ar-seg' },
              h('button', {
                className: `ar-seg-btn ${policy.mode === 'manual' ? 'on' : ''}`,
                disabled: policyBusy,
                onClick: () => setPolicy({ mode: 'manual' })
              }, '逐条审批'),
              h('button', {
                className: `ar-seg-btn ${policy.mode === 'approve-all' ? 'on' : ''}`,
                disabled: policyBusy,
                onClick: () => setPolicy({ mode: 'approve-all' })
              }, '全部自动'),
              h('button', {
                className: `ar-seg-btn ${rejectAll ? 'on' : ''}`,
                disabled: policyBusy,
                onClick: () => setPolicy({ mode: 'reject-all' })
              }, '全拒绝')
            ),
            h('label', { className: 'ar-check' },
              h('input', {
                type: 'checkbox',
                checked: policy.agentAssist !== false,
                disabled: policyBusy || rejectAll,
                onChange: (e) => setPolicy({ agentAssist: !!e.target.checked })
              }),
              '修不了的时候让 AI 接手'
            ),
            h('label', { className: 'ar-check', title: '开启后，插件修不动的报错会自动送进模型会话；同一报错 30 分钟内只送一次' },
              h('input', {
                type: 'checkbox',
                checked: policy.autoFeed !== false,
                disabled: policyBusy || rejectAll || policy.agentAssist === false,
                onChange: (e) => setPolicy({ autoFeed: !!e.target.checked })
              }),
              '出错自动投喂给 AI'
            ),
            h('button', {
              className: 'ar-btn', disabled: busy || rejectAll,
              onClick: repairAll
            }, busy ? '修复中…' : '全部修复')
          )
        ),

        // ── 自动修复通知策略（一个总开关，管所有对外推送） ────────────────
        h('div', { className: 'ar-policy' },
          h('div', { className: 'ar-policy-head' },
            h('span', { className: 'ar-policy-title' }, '通知策略'),
            h('span', { className: 'ar-policy-hint' }, notifyHint)
          ),
          h('div', { className: 'ar-row' },
            h('div', { className: 'ar-seg' },
              h('button', {
                className: `ar-seg-btn ${notifyMode === 'notify' ? 'on' : ''}`,
                disabled: notifyBusy,
                onClick: () => setNotifyMode('notify')
              }, '发通知'),
              h('button', {
                className: `ar-seg-btn ${notifyMode === 'silent' ? 'on' : ''}`,
                disabled: notifyBusy,
                onClick: () => setNotifyMode('silent')
              }, '完全不发')
            )
          ),
          h('div', { className: 'ar-policy-hint', style: { marginTop: '8px' } },
            '这一个总开关同时管自动修复的全部对外消息：待你审批、自动修复成功、自动修复未成功、需要你处理；渠道包括需求箱、QQ 私聊和 Windows 气泡。选「完全不发」时这些一律不推，但修复照常执行，面板的修复历史和 auto-repair.log 仍照常记录。全天回复自己发的提示（例如余额不足自动关闭全天回复）也受这个开关控制：选「完全不发」时同样不推，只在 bridge.log 和面板活动里记录。')
        ),

        // ── AI 模型（「让 AI 修」用哪个提供方/模型） ──────────────────────
        h('div', { className: 'ar-policy' },
          h('div', { className: 'ar-policy-head' },
            h('span', { className: 'ar-policy-title' }, '修复使用的模型'),
            h('span', { className: 'ar-policy-hint' },
              '「让 AI 修」时用哪个提供方/模型（只影响修复用途，不会改队列默认和全天回复）。选项来自 DSH 实际可用的模型目录；缺 Key 或路由未启用会直接标出来。')
          ),
          h('div', { className: 'ar-row' },
            h('select', {
              className: 'ar-select',
              disabled: modelBusy,
              value: curValue,
              onChange: (e) => {
                const v = String(e.target.value || '')
                const i = v.indexOf('::')
                if (i < 0) return
                setModel(v.slice(0, i), v.slice(i + 2))
              }
            },
              curValue ? null : h('option', { value: '' }, modelError ? '（读不到模型列表）' : '（跟随 DSH 默认）'),
              curModel && !curInList
                ? h('option', { value: curValue }, `${curModel.provider} / ${curModel.model}（当前，但目录里没看到）`)
                : null,
              modelProviders.map((g) => h('optgroup', { key: g.id, label: g.name || g.id },
                (g.models || []).map((m) => h('option', {
                  key: `${g.id}::${m.id}`,
                  value: `${g.id}::${m.id}`
                },
                  `${m.name || m.id}${g.keyEnv
                    ? (g.keyConfigured === false ? '（缺 Key）' : g.keyConfigured === true ? '（Key 已配）' : '')
                    : ''}${g.available === false ? '（未启用）' : ''}`
                ))
              ))
            ),
            h('button', {
              className: 'ar-btn', disabled: modelBusy,
              onClick: () => loadModels()
            }, modelBusy ? '处理中…' : '刷新模型')
          ),
          h('div', { className: 'ar-policy-hint', style: { marginTop: '8px' } }, modelHint),
          models?.readiness && models.readiness.ok === false
            ? h('div', { className: 'ar-warnbox' }, `当前模型暂不可用：${models.readiness.reason}`)
            : null,
          modelError ? h('div', { className: 'ar-warnbox' }, modelError) : null,
          modelWarnings.length ? h('div', { className: 'ar-warnbox' }, modelWarnings.join('\n')) : null
        ),

        // ── API 地址与 Key（MiniMax 等需要 Key 的提供方） ────────────────────
        h('div', { className: 'ar-policy' },
          h('div', { className: 'ar-policy-head' },
            h('span', { className: 'ar-policy-title' }, 'API 地址与 Key'),
            h('span', { className: 'ar-policy-hint' },
              '智谱的接口地址和模型预设已内置，只需填 Key。填了就用面板里填的；留空则沿用 DSH 自己的凭据（.credentials.yaml 的 refs 或环境变量）。Key 只写进 DSH 凭据存储，面板只显示尾 4 位。')
          ),
          providerError ? h('div', { className: 'ar-warnbox' }, providerError) : null,
          h('div', { className: 'ar-client-list' },
            providerList.map((p) => {
              const isZhipu = p.id === 'zhipu'
              // 智谱的地址是内置预设：没保存过也直接显示出来，不用用户自己记
              const baseVal = baseDraft[p.id] !== undefined
                ? baseDraft[p.id]
                : (p.baseUrl || (isZhipu ? (p.defaultBaseUrl || '') : ''))
              const keyVal = keyDraft[p.id] || ''
              const keyState = isZhipu
                ? p.hasKey === true
                  ? (zhipuRoutable
                      ? `Key 已配置${p.keyTail ? ` · 尾号 ${p.keyTail}` : ''}`
                      : 'Key 已配置 · DSH 路由未挂载')
                  : p.hasKey === false
                    ? '缺 Key'
                    : '缺 Key（读不到凭据状态）'
                : p.hasKey === true
                  ? (p.keyTail ? `已配置 · 尾号 ${p.keyTail}` : '已配置（来自 DSH 凭据 / 环境变量）')
                  : p.hasKey === false
                    ? '未配置'
                    : '读不到状态'
              const presetId = presetPick[p.id] !== undefined
                ? presetPick[p.id]
                : (selected?.provider === 'zhipu' ? selected.model : '')
              const pickId = presetId || (zhipuModels[0]?.id || '')
              const pickModel = zhipuModels.find((m) => m.id === pickId) || null
              return h('div', { className: 'ar-client-row', key: p.id },
                h('div', { className: 'ar-client-head' },
                  h('span', { className: 'ar-client-name' }, p.name),
                  h('span', { className: `ar-flag${p.hasKey === true ? ' agent' : ''}` }, keyState)
                ),
                h('div', { className: 'ar-client-path' }, `凭据名：${p.keyEnv}${p.defaultBaseUrl ? ` · 默认地址：${p.defaultBaseUrl}` : ''}`),
                h('div', { className: 'ar-row', style: { marginTop: '6px' } },
                  h('input', {
                    className: 'ar-input',
                    type: 'text',
                    value: baseVal,
                    placeholder: p.defaultBaseUrl || 'https://…',
                    disabled: providersBusy,
                    spellCheck: false,
                    onChange: (e) => setBaseDraft((d) => ({ ...d, [p.id]: e.target.value }))
                  }),
                  h('button', {
                    className: 'ar-btn',
                    disabled: providersBusy,
                    onClick: () => saveProvider(p.id, { baseUrl: baseVal }, `${p.name}：API 地址已保存`)
                  }, '保存地址'),
                  h('button', {
                    className: 'ar-btn',
                    disabled: providersBusy,
                    onClick: () => probeProvider(p.id)
                  }, '测试连通')
                ),
                h('div', { className: 'ar-row', style: { marginTop: '6px' } },
                  h('input', {
                    className: 'ar-input',
                    type: 'password',
                    value: keyVal,
                    placeholder: p.hasKey === true ? '留空则不修改（已配置）' : '粘贴 API Key',
                    autoComplete: 'new-password',
                    disabled: providersBusy,
                    onChange: (e) => setKeyDraft((d) => ({ ...d, [p.id]: e.target.value }))
                  }),
                  h('button', {
                    className: 'ar-btn',
                    disabled: providersBusy || !keyVal,
                    onClick: () => saveProvider(p.id, { apiKey: keyVal }, `${p.name}：Key 已保存`)
                  }, '保存 Key'),
                  h('button', {
                    className: 'ar-btn',
                    disabled: providersBusy || p.hasKey !== true,
                    onClick: () => saveProvider(p.id, { clearKey: true }, `${p.name}：Key 已清除`)
                  }, '清除')
                ),
                isZhipu
                  ? h('div', { className: 'ar-preset' },
                      h('div', { className: 'ar-policy-hint', style: { marginTop: '10px' } },
                        `模型预设：地址已预填 ${p.defaultBaseUrl || 'https://open.bigmodel.cn/api/paas/v4'}，共 ${zhipuModels.length} 个模型（文本 / 视觉），选一个直接用于「让 AI 修」。`),
                      p.hasKey !== true
                        ? h('div', { className: 'ar-warnbox' }, '缺 Key：把 bigmodel.cn 控制台的 API Key 粘到上面点「保存 Key」；填 Key 之前这里不会显示成可用。')
                        : (zhipuRoutable
                            ? null
                            : h('div', { className: 'ar-warnbox' }, 'Key 已配置，但 DSH 里还没挂载智谱 provider（需要改 profile 并重启 DSH 一次）。')),
                      zhipuModels.length
                        ? h('div', { className: 'ar-row', style: { marginTop: '6px' } },
                            h('select', {
                              className: 'ar-select',
                              disabled: providersBusy || modelBusy,
                              value: pickId,
                              onChange: (e) => setPresetPick((d) => ({ ...d, [p.id]: e.target.value }))
                            },
                              zhipuModels.map((m) => h('option', { key: m.id, value: m.id },
                                `${m.name || m.id}（${m.id}）${m.tag ? ` · ${m.tag}` : ''}`
                              ))
                            ),
                            h('button', {
                              className: 'ar-btn',
                              disabled: providersBusy || modelBusy || !pickId,
                              onClick: () => setModel(p.id, pickId)
                            }, '选为「让 AI 修」模型')
                          )
                        : h('div', { className: 'ar-warnbox' }, '读不到智谱模型预设（/models 接口没返回 zhipu 组）'),
                      pickModel?.note
                        ? h('div', { className: 'ar-policy-hint', style: { marginTop: '6px' } }, `适用：${pickModel.note}`)
                        : null
                    )
                  : null
              )
            })
          ),
          providerList.length === 0 && providers
            ? h('div', { className: 'ar-policy-hint' }, '当前没有需要填 Key 的提供方。')
            : null
        ),

        // ── 本机模型客户端（扫描 + 可选关联启动） ──────────────────────────
        h('div', { className: 'ar-policy' },
          h('div', { className: 'ar-policy-head' },
            h('span', { className: 'ar-policy-title' }, '本机模型客户端'),
            h('span', { className: 'ar-policy-hint' },
              '自动扫描本机装了的模型客户端（注册表 / 开始菜单 / 常见安装目录）。勾上「关联启动」后，用该模型投喂报错时会先把客户端拉起来。')
          ),
          clients?.ok === false
            ? h('div', { className: 'ar-warnbox' }, `扫描失败：${clients.error || '未知原因'}`)
            : null,
          h('div', { className: 'ar-client-list' },
            (clients?.clients || []).map((c) => {
              const draft = clientDraft[c.id]
              const shown = draft !== undefined ? draft : (c.manualPath || c.path || '')
              return h('div', { key: c.id, className: 'ar-client-row' },
                h('div', { className: 'ar-client-head' },
                  h('span', { className: 'ar-client-name' }, c.name),
                  h('span', { className: `ar-flag${c.installed ? ' agent' : ''}` }, c.installed ? '已安装' : '未检测到'),
                  c.source === 'manual' ? h('span', { className: 'ar-flag' }, '手动指定') : null,
                  h('span', { className: 'ar-policy-hint' }, c.hint || '')
                ),
                h('div', { className: 'ar-client-path' }, c.path || '未检测到可执行文件'),
                h('div', { className: 'ar-row' },
                  h('input', {
                    className: 'ar-input',
                    type: 'text',
                    placeholder: '扫描不到时，把 .exe 完整路径贴这里',
                    value: shown,
                    spellCheck: false,
                    onChange: (e) => setClientDraft((prev) => ({ ...prev, [c.id]: e.target.value }))
                  }),
                  h('button', {
                    className: 'ar-btn',
                    disabled: clientsBusy || shown === (c.path || ''),
                    onClick: () => updateClient(c.id, { path: shown.trim() })
                  }, '保存路径'),
                  c.manualPath
                    ? h('button', {
                        className: 'ar-btn', disabled: clientsBusy,
                        onClick: () => updateClient(c.id, { path: '' })
                      }, '恢复自动')
                    : null,
                  h('label', { className: 'ar-check' },
                    h('input', {
                      type: 'checkbox',
                      checked: c.launch === true,
                      disabled: clientsBusy || !c.installed,
                      onChange: (e) => updateClient(c.id, { launch: !!e.target.checked })
                    }),
                    '关联启动'
                  )
                ),
                c.installed && !c.launch
                  ? h('div', { className: 'ar-policy-hint' }, '未勾选「关联启动」：投喂时不会拉起它，保持原有行为。')
                  : null
              )
            })
          ),
          h('div', { className: 'ar-row', style: { marginTop: '8px' } },
            h('button', {
              className: 'ar-btn', disabled: clientsBusy,
              onClick: () => loadClients()
            }, clientsBusy ? '扫描中…' : '重新扫描')
          ),
          clients && (clients.clients || []).length === 0
            ? h('div', { className: 'ar-policy-hint' }, '没有检测到任何模型客户端；这不影响自愈功能，只是投喂时不会额外拉起客户端。')
            : null
        ),

        // 当前诊断结论
        h('div', { className: 'ar-section-title' }, '当前诊断'),
        (d.findings || []).length
          ? h('div', null, (d.findings || []).map((f, i) => {
              const itemBusy = busyCode === f.code
              const canRepair = f.fixable !== false && !rejectAll && !f.rejected
              const handoff = f.handoff || null
              return h('div', { key: i, className: `ar-finding ${f.severity}` },
                h('div', { className: 'ar-finding-title' },
                  h('span', { className: 'ar-badge' }, f.code),
                  f.title,
                  f.rejected ? h('span', { className: 'ar-flag rejected' }, '已忽略') : null,
                  f.fixable ? null : h('span', { className: 'ar-flag' }, '不能自动修'),
                  handoff && handoff.status === 'queued' ? h('span', { className: 'ar-flag agent' }, 'AI 处理中') : null,
                  // 这一次走的是哪条路：插件修好的 / 升级给模型的
                  f.route === 'plugin' ? h('span', { className: 'ar-flag', title: f.routeDetail || '' }, '插件已修复') : null,
                  f.route === 'model'
                    ? h('span', { className: 'ar-flag agent', title: f.routeDetail || '' },
                        `已升级给模型${handoff?.model ? `（${handoff.model}）` : ''}`)
                    : null
                ),
                h('div', { className: 'ar-finding-detail' }, f.detail || ''),
                h('div', { className: 'ar-actions' },
                  h('button', {
                    className: 'ar-btn primary',
                    disabled: itemBusy || !canRepair,
                    onClick: () => repairOne(f.code)
                  }, itemBusy ? '处理中…' : '修复'),
                  h('button', {
                    className: 'ar-btn',
                    disabled: itemBusy || rejectAll,
                    onClick: () => askAgent(f.code)
                  }, '让 AI 修'),
                  h('button', {
                    className: 'ar-btn',
                    disabled: itemBusy,
                    onClick: () => toggleIgnore(f.code, !f.rejected)
                  }, f.rejected ? '取消忽略' : '忽略')
                ),
                handoff && handoff.reply
                  ? h('div', { className: 'ar-reply' }, handoff.reply)
                  : null
              )
            }))
          : h('div', { className: 'ar-empty' }, '没有发现任何问题 —— 大肥鱼很健康 🐟'),

        // 修复历史
        h('div', { className: 'ar-section-title' }, '修复历史'),
        (d.history || []).length
          ? h('table', { className: 'ar-table' },
              h('thead', null, h('tr', null,
                h('th', null, '时间'), h('th', null, '代码'),
                h('th', null, '结果'), h('th', null, '说明')
              )),
              h('tbody', null, (d.history || []).slice(0, 25).map((x, i) =>
                h('tr', { key: i },
                  h('td', { className: 'ar-time' }, fmtTime(x.at)),
                  h('td', null, h('span', { className: 'ar-badge' }, x.code)),
                  h('td', null, x.ok
                    ? h('span', { className: 'ar-ok-mark' }, '✓ 成功')
                    : h('span', { className: 'ar-fail-mark' }, '✗ ' + (x.attempted ? '失败' : '未处理'))
                  ),
                  h('td', null, x.action || '')
                )
              ))
            )
          : h('div', { className: 'ar-empty' }, '还没有修复记录'),

        // 巡检日志
        h('div', { className: 'ar-section-title' }, '巡检日志'),
        (d.log || []).length
          ? h('div', { className: 'ar-log' }, (d.log || []).slice(0, 40).join('\n'))
          : h('div', { className: 'ar-empty' }, '暂无日志'),

        h('div', { className: 'ar-note' },
          '这个面板只是「看」和「手动戳一下」。真正的自动修复由独立守护进程执行——',
          '因为 DSH 自己崩溃的时候，面板也跟着没了。',
          h('br'),
          '逐条审批模式下，守护进程只诊断不修；「让 AI 修」会拉起一个带本地工具的 DSH 会话，',
          '由它自己复核问题、动手改、然后把总结写回这里。',
          h('br'),
          '阶梯是「先插件、后模型」：能用内置修复器修的直接修（标「插件已修复」），修不动才升级给模型，',
          '并把报错自动投喂进那个会话的输入框（标「已升级给模型」）。同一报错 30 分钟内只投喂一次；',
          '缺 Key、路由未启用这类配置问题只提示、不投喂。',
          h('br'),
          '「AI 模型」卡片决定下一次「让 AI 修」用哪个模型；「API 地址与 Key」卡片可以把 Key 直接填在这里，',
          '值只写进 DSH 凭据存储（.credentials.yaml，权限 600），面板与日志只保留尾 4 位。留空则沿用原有配置。',
          h('br'),
          '「本机模型客户端」卡片只做发现与可选关联启动：勾了「关联启动」才会在投喂前拉起对应客户端，',
          '默认全关；扫不到就显示「未检测到」，也可以手填 .exe 完整路径。',
          h('br'),
          '手动诊断：',
          h('code', null, 'node D:\\大肥鱼\\auto-repair\\auto-repair.mjs --check')
        )
      )
    }

    // ── 智谱开放平台（bigmodel.cn）：独立设置页 ──────────────────────────────
    // 和「自愈」分开：自己的位置、自己的标题，地址 / Key / 任务队列都在这里。
    const ZQ_STATUS = {
      pending: ['pending', '排队中'],
      running: ['running', '执行中'],
      done: ['done', '完成'],
      failed: ['failed', '失败']
    }

    const VN_STATUS = {
      ready: ['agent', '已配置'],
      nokey: ['rejected', '缺 Key'],
      quota: ['rejected', '额度耗尽'],
      pending: ['pending', '路由待重启']
    }

    // 模型列表展开状态：默认收起；放组件外，设置页被重挂载时本次会话内也能记住
    const VN_OPEN = {}

    // 三种用途各自独立指定：修复（自愈里「让 AI 修」）/ 任务队列默认 / 全天回复
    const MODEL_USE_LABELS = [
      ['repair', '修复', '「让 AI 修」用它'],
      ['queue', '队列默认', '加任务时默认用它'],
      ['reply', '全天回复', '自动回复用的模型']
    ]

    // 「重新检测」真发一次最小请求后的判定文案
    const RECHECK_LABEL = {
      ok: '可用：刚才那次真实调用返回成功',
      quota: '额度/余额问题：供应商明确返回欠费或额度不足',
      nokey: '缺 Key：没读到可用凭据',
      key: 'Key 无效或无权限（401/403）',
      error: '调用失败（不是额度问题）',
      network: '网络不通或超时'
    }

    function vendorStatus(v) {
      if (v.quota && v.quota.exhausted) return 'quota'
      if (!(v.key && v.key.configured)) return 'nokey'
      if (!v.available) return 'pending'
      return 'ready'
    }

    function VendorsSection() {
      const [state, setState] = useState(null)
      const [err, setErr] = useState('')
      const [note, setNote] = useState('')
      const [busy, setBusy] = useState('')
      const [filter, setFilter] = useState('all')
      const [keyDraft, setKeyDraft] = useState({})
      const [baseDraft, setBaseDraft] = useState({})
      const [probe, setProbe] = useState(null)
      // 「重新检测」的结果（真发一次最小请求）
      const [recheck, setRecheck] = useState(null)
      const [qProvider, setQProvider] = useState('')
      const [qModel, setQModel] = useState('')
      const [prompt, setPrompt] = useState('')
      const [showCustom, setShowCustom] = useState(false)
      const [cName, setCName] = useState('')
      const [cBase, setCBase] = useState('')
      const [cModels, setCModels] = useState('')
      const [cKey, setCKey] = useState('')
      // 三用途的指定请求各自独立忙态，互不影响
      const [busyUse, setBusyUse] = useState('')
      // 每个厂商卡片的模型列表是否展开（默认全收起，状态在本次会话内保持）
      const [openModels, setOpenModels] = useState(() => ({ ...VN_OPEN }))

      const load = useCallback(async () => {
        try {
          const r = await fetchJson('/vendors', { cache: 'no-store' })
          setState(r)
          setErr('')
        } catch (e) {
          setErr(e?.message || String(e))
        }
      }, [])

      useEffect(() => { load() }, [load])
      useEffect(() => {
        const t = setInterval(() => { load() }, 8000)
        return () => clearInterval(t)
      }, [load])

      async function post(body, tag) {
        setBusy(tag || 'x')
        setNote('')
        try {
          const r = await fetchJson('/vendors', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          })
          if (r && r.ok === false) setErr(String(r.error || '操作失败'))
          else {
            setErr('')
            setNote(String(r.msg || '已更新'))
            if (r && Array.isArray(r.vendors)) setState(r)
          }
          return r
        } catch (e) {
          setErr(e?.message || String(e))
        } finally {
          setBusy('')
        }
      }

      function setKey(id, v) { setKeyDraft((d) => ({ ...d, [id]: v })) }
      function setBase(id, v) { setBaseDraft((d) => ({ ...d, [id]: v })) }

      /** 展开/收起某个厂商的模型列表（默认收起） */
      function toggleModels(id) {
        setOpenModels((prev) => {
          const next = { ...prev, [id]: !prev[id] }
          if (next[id]) VN_OPEN[id] = true
          else delete VN_OPEN[id]
          return next
        })
      }

      /** 启用 / 停用一个模型（同一供应商下可以同时启用多个） */
      async function toggleEnabled(provider, model, on) {
        const tag = 'en-' + provider + '::' + model
        setBusy(tag)
        setNote('')
        try {
          const r = await fetchJson('/models', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ provider, model, enabled: on })
          })
          if (r && r.ok === false) setErr(String(r.error || '操作失败'))
          else {
            setErr('')
            setNote(on ? `已启用 ${model}` : `已停用 ${model}`)
            await load()
          }
        } catch (e) {
          setErr(e?.message || String(e))
        } finally {
          setBusy('')
        }
      }

      /** 指定某个用途用哪个模型；value 为空 = 清空这个用途（修复不允许清空） */
      async function assignUse(use, value) {
        if (!value && use === 'repair') {
          setErr('「修复」用途必须指定一个模型')
          return
        }
        setBusyUse(use)
        setNote('')
        try {
          const i = value.indexOf('::')
          const body = value
            ? { use, provider: value.slice(0, i), model: value.slice(i + 2) }
            : { use, clearUse: true }
          const r = await fetchJson('/models', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          })
          if (r && r.ok === false) setErr(String(r.error || '指定失败'))
          else {
            setErr('')
            const label = (MODEL_USE_LABELS.find((x) => x[0] === use) || ['', use])[1]
            setNote(value ? `已把「${label}」指定为 ${value.replace('::', ' / ')}` : `已清空「${label}」的指定`)
            await load()
          }
        } catch (e) {
          setErr(e?.message || String(e))
        } finally {
          setBusyUse('')
        }
      }

      const vendorUses = (state && state.uses) || {}
      const enabledList = Array.isArray(state && state.enabled) ? state.enabled : []
      const enabledKeys = new Set(enabledList.map((x) => `${x.provider}::${x.model}`))
      const vendorsAll = Array.isArray(state && state.vendors) ? state.vendors : []
      const enabledOptions = []
      for (const v of vendorsAll) {
        for (const m of v.models || []) {
          const k = `${v.id}::${m.id}`
          if (enabledKeys.has(k)) enabledOptions.push({ key: k, label: `${v.name} / ${m.name || m.id}` })
        }
      }

      const vendors = Array.isArray(state && state.vendors) ? state.vendors : []
      const models = vendors.reduce((n, v) => n + (v.models ? v.models.length : 0), 0)
      const counts = { ready: 0, nokey: 0, quota: 0, pending: 0 }
      for (const v of vendors) counts[vendorStatus(v)] += 1
      const shown = vendors.filter((v) => {
        const st = vendorStatus(v)
        if (filter === 'all') return true
        if (filter === 'custom') return v.isCustom
        return st === filter
      })

      const q = (state && state.queue) || { running: false, tasks: [] }
      const tasks = Array.isArray(q.tasks) ? q.tasks : []
      // 「队列默认」这个用途优先作为初始供应商/模型，用户手动改了就按手动的来
      const qDefaultPair = vendorUses.queue
      const qProviderValue = qProvider
        || (qDefaultPair && vendors.some((v) => v.id === qDefaultPair.provider) ? qDefaultPair.provider : '')
      const qVendor = vendors.find((v) => v.id === qProviderValue) || vendors.find((v) => v.id === 'zhipu') || vendors[0]
      const qModels = (qVendor && qVendor.models) || []
      const qDefaultModel = qDefaultPair && qVendor && qDefaultPair.provider === qVendor.id ? qDefaultPair.model : ''
      const qModelValue = qModels.some((m) => m.id === qModel)
        ? qModel
        : (qModels.some((m) => m.id === qDefaultModel) ? qDefaultModel : (qModels[0]?.id || ''))

      const sourceLabel = (s) => ({
        file: 'DSH 凭据文件',
        env: '环境变量',
        store: 'DSH 凭据存储',
        resolve: 'DSH 凭据（运行时）'
      }[s] || 'DSH 凭据')

      return h('div', { className: 'ar-root' },
        h('style', null, STYLE),
        h('style', null, `
          .vn-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0 4px}
          .vn-tab{border:1px solid rgba(127,127,127,.25);background:transparent;color:inherit;border-radius:999px;padding:4px 12px;font-size:12px;cursor:pointer}
          .vn-tab.on{background:rgba(64,132,255,.14);border-color:rgba(64,132,255,.5)}
          .vn-grid{display:flex;flex-direction:column;gap:10px;margin-top:8px}
          .vn-card{border:1px solid rgba(127,127,127,.18);border-radius:10px;padding:12px}
          .vn-card.route-down{opacity:.86}
          .vn-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
          .vn-name{font-weight:600;font-size:14px}
          .vn-badge{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid rgba(127,127,127,.3);opacity:.85}
          .vn-note{font-size:12px;opacity:.72;margin-top:4px;line-height:1.55}
          .vn-models{margin-top:6px;display:flex;flex-direction:column;gap:4px}
          .vn-models-toggle{margin-top:8px}
          .vn-toggle-btn{border:1px solid rgba(127,127,127,.25);background:transparent;color:inherit;border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer;opacity:.85}
          .vn-toggle-btn:hover{opacity:1;border-color:rgba(64,132,255,.5)}
          .vn-setrepair{font-size:11px;padding:1px 8px;border-radius:999px}
          .vn-model{display:flex;align-items:center;gap:8px;font-size:12px;flex-wrap:wrap}
          .vn-mname{font-weight:550}
          .vn-mid{opacity:.5;font-family:ui-monospace,Consolas,monospace;font-size:11px}
          .vn-mnote{opacity:.7}
          .vn-price{opacity:.62;font-size:11px}
          .vn-keyrow{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:10px}
          .vn-keyrow .ar-input{flex:1;min-width:180px}
          .vn-keyline{margin-top:6px}
          .vn-addrline{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:8px}
          .vn-addrline .ar-input{flex:1;min-width:200px}
          .vn-model.off{opacity:.55}
          .vn-check{display:inline-flex;align-items:center;gap:4px;font-size:11px;opacity:.9;cursor:pointer}
          .vn-use{font-size:10px;padding:0 5px;border-radius:999px;border:1px solid rgba(127,127,127,.3);opacity:.75}
          .vn-use.on{border-color:rgba(64,132,255,.55);opacity:1;background:rgba(64,132,255,.12)}
          .vn-use-none{font-size:10px;opacity:.5}
          .vn-addr{margin-top:8px}
          .vn-addr summary{cursor:pointer;font-size:12px;opacity:.65}
          .vn-addr .ar-row{margin-top:8px}
          .vn-empty{padding:18px;text-align:center;opacity:.6;font-size:13px}
        `),

        h('div', { className: 'ar-head' },
          h('span', { className: 'ar-dot ' + (counts.ready ? 'ok' : 'warn') }),
          h('div', { className: 'ar-head-main' },
            h('div', { className: 'ar-title' }, '模型供应商'),
            h('div', { className: 'ar-sub' }, '主流厂商预设 + 自定义入口 · Key / 额度 / 路由状态都照实显示')
          ),
          h('div', { className: 'ar-head-right' }, h('span', { className: 'ar-maker' }, MAKER))
        ),

        h('div', { className: 'ar-policy' },
          h('div', { className: 'ar-policy-head' },
            h('div', { className: 'ar-policy-title' }, '总览'),
            h('span', { className: 'ar-flag agent' }, `已配置 ${counts.ready}`),
            h('span', { className: 'ar-flag rejected' }, `缺 Key ${counts.nokey}`),
            counts.quota ? h('span', { className: 'ar-flag rejected' }, `额度耗尽 ${counts.quota}`) : null,
            counts.pending ? h('span', { className: 'ar-flag pending' }, `待重启 ${counts.pending}`) : null,
            h('span', { className: 'ar-flag' }, `${vendors.length} 家 / ${models} 个模型`)
          ),
          h('div', { className: 'ar-policy-hint' },
            '「已配置」= Key 已读到，且路由已经在当前 DSH 进程里加载。',
            '填了新 Key 不需要重启；新增厂商、改地址需要重启一次 DSH 才会进模型列表。'
          ),
          state && state.routeNeeded
            ? h('div', { className: 'ar-warnbox' },
              '有供应商的路由还没在当前进程生效。把所有 Key 填好后重启一次 DSH 即可批量生效，不用一家一家重启。')
            : null,
          h('div', { className: 'vn-tabs' },
            [['all', '全部'], ['ready', '已配置'], ['nokey', '缺 Key'], ['quota', '额度耗尽'], ['custom', '自定义']]
              .map(([k, label]) => h('button', {
                key: k,
                className: 'vn-tab' + (filter === k ? ' on' : ''),
                onClick: () => setFilter(k)
              }, label))
          )
        ),

        // ── 三种用途各自独立指定（修复 / 队列默认 / 全天回复） ────────────────
        h('div', { className: 'ar-policy' },
          h('div', { className: 'ar-policy-head' },
            h('div', { className: 'ar-policy-title' }, '模型用途'),
            h('span', { className: 'ar-flag' }, `已启用 ${enabledOptions.length} 个模型`)
          ),
          h('div', { className: 'ar-policy-hint' },
            '三处指定互相独立，改一个不会覆盖另外两个。',
            '先在下面各厂商卡片里勾选「启用」（一家可以同时启用多个），再在这里分别指定用途；同一个模型可以被多处共用。'
          ),
          enabledOptions.length === 0
            ? h('div', { className: 'ar-warnbox' }, '还没有启用任何模型：在下面卡片里勾选模型左侧的「启用」后，这里就能选了。')
            : MODEL_USE_LABELS.map(([k, label, desc]) => {
              const cur = vendorUses[k]
              const curVal = cur ? `${cur.provider}::${cur.model}` : ''
              const curInList = curVal && enabledOptions.some((o) => o.key === curVal)
              return h('div', { className: 'ar-row', key: k },
                h('span', { className: 'ar-sub' }, label),
                h('select', {
                  className: 'ar-select',
                  value: curVal,
                  disabled: busyUse === k,
                  onChange: (e) => assignUse(k, String(e.target.value || ''))
                },
                  k !== 'repair' ? h('option', { value: '' }, cur ? '（未指定，清空）' : '（未指定）') : null,
                  !cur && k === 'repair' ? h('option', { value: '' }, '（未指定，请选一个）') : null,
                  curVal && !curInList ? h('option', { value: curVal }, `${cur.provider} / ${cur.model}（当前，不在已启用列表）`) : null,
                  enabledOptions.map((o) => h('option', { key: o.key, value: o.key }, o.label))
                ),
                h('span', { className: 'ar-sub' }, desc)
              )
            })
        ),

        h('div', { className: 'vn-grid' },
          shown.length === 0
            ? h('div', { className: 'vn-empty' }, '这个筛选下没有供应商。')
            : shown.map((v) => {
              const st = vendorStatus(v)
              const pair = VN_STATUS[st]
              const kd = keyDraft[v.id] || ''
              const bd = baseDraft[v.id] !== undefined ? baseDraft[v.id] : (v.baseUrl || '')
              return h('div', { className: 'vn-card' + (v.available ? '' : ' route-down'), key: v.id },
                h('div', { className: 'vn-top' },
                  h('span', { className: 'vn-name' }, v.name),
                  h('span', { className: 'ar-flag ' + pair[0] }, pair[1]),
                  v.isCustom ? h('span', { className: 'vn-badge' }, '自定义') : null,
                  v.verified === false ? h('span', { className: 'vn-badge' }, '待确认') : null,
                  v.docs ? h('a', { className: 'ar-sub', href: v.docs, target: '_blank', rel: 'noreferrer' }, '官方文档') : null,
                  h('span', { className: 'ar-sub' }, v.keyEnv || '')
                ),
                // Key 状态 + 输入行紧跟标题：打开卡片就能直接填
                v.key && v.key.configured
                  ? h('div', { className: 'ar-sub vn-keyline' }, `Key 已配置 · 尾号 ${v.key.keyTail || '----'} · 来源：${sourceLabel(v.key.source)}`)
                  : h('div', { className: 'ar-sub vn-keyline' }, `缺 Key${v.keyEnv ? `（${v.keyEnv}）` : ''}`),
                h('div', { className: 'vn-keyrow' },
                  h('input', {
                    className: 'ar-input',
                    type: 'password',
                    spellCheck: false,
                    value: kd,
                    placeholder: v.key && v.key.configured ? `已配置（尾号 ${v.key.keyTail || '----'}），留空不改` : `粘贴 ${v.keyEnv || 'API Key'}`,
                    onChange: (e) => setKey(v.id, e.target.value)
                  }),
                  h('button', {
                    className: 'ar-btn primary',
                    disabled: busy === 'key-' + v.id || !kd.trim(),
                    onClick: async () => {
                      const r = await post({ id: v.id, apiKey: kd }, 'key-' + v.id)
                      if (r && r.ok !== false) setKey(v.id, '')
                    }
                  }, busy === 'key-' + v.id ? '保存中…' : '保存 Key'),
                  h('button', {
                    className: 'ar-btn',
                    disabled: busy === 'clear-' + v.id || !(v.key && v.key.configured),
                    onClick: async () => { await post({ id: v.id, clearKey: true }, 'clear-' + v.id) }
                  }, '清除')
                ),
                // 地址与连通性探测也放在最上面，不用先点开折叠
                h('div', { className: 'vn-addrline' },
                  h('span', { className: 'ar-sub' }, '地址'),
                  h('input', {
                    className: 'ar-input',
                    value: bd,
                    spellCheck: false,
                    onChange: (e) => setBase(v.id, e.target.value)
                  }),
                  h('button', {
                    className: 'ar-btn',
                    disabled: busy === 'base-' + v.id,
                    onClick: async () => {
                      const r = await post({ id: v.id, baseUrl: bd }, 'base-' + v.id)
                      if (r && r.ok !== false) setBase(v.id, undefined)
                    }
                  }, busy === 'base-' + v.id ? '保存中…' : '保存地址'),
                  h('button', {
                    className: 'ar-btn',
                    disabled: busy === 'probe-' + v.id,
                    onClick: async () => {
                      const r = await post({ id: v.id, probe: true }, 'probe-' + v.id)
                      if (r && r.probe) setProbe({ id: v.id, text: JSON.stringify(r.probe).slice(0, 260) })
                    }
                  }, busy === 'probe-' + v.id ? '探测中…' : '测试连通'),
                  h('button', {
                    className: 'ar-btn',
                    title: '真发一次最小请求，判断 Key / 额度到底能不能用',
                    disabled: busy === 'recheck-' + v.id,
                    onClick: async () => {
                      const r = await post({ id: v.id, recheck: true }, 'recheck-' + v.id)
                      if (r && r.recheck) {
                        setRecheck({
                          id: v.id,
                          kind: r.recheck.kind || '',
                          text: r.recheck.message || RECHECK_LABEL[r.recheck.kind] || ''
                        })
                      }
                    }
                  }, busy === 'recheck-' + v.id ? '检测中…' : '重新检测'),
                  v.isCustom ? h('button', {
                    className: 'ar-btn',
                    disabled: busy === 'rm-' + v.id,
                    onClick: async () => {
                      if (!window.confirm(`删除自定义供应商「${v.name}」？`)) return
                      await post({ id: v.id, customAction: 'remove' }, 'rm-' + v.id)
                    }
                  }, '删除') : null
                ),
                probe && probe.id === v.id ? h('div', { className: 'ar-note' }, '探测结果：' + probe.text) : null,
                recheck && recheck.id === v.id
                  ? h('div', { className: 'ar-note' }, '重新检测：' + recheck.text)
                  : null,
                // 只有「明确失败、且之后没有成功证据」才挂这个提示；成功一次就自动消失
                v.quota && v.quota.exhausted
                  ? h('div', { className: 'ar-warnbox' },
                    `上次调用报额度问题：${v.quota.message || '供应商返回余额不足'}（${fmtDateTime(v.quota.at)}）。之后只要有一次真实调用成功就会自动清掉；也可以点「重新检测」马上重试一次。`)
                  : null,
                v.note ? h('div', { className: 'vn-note' }, v.note) : null,
                // 模型列表默认收起：卡片只留一行「N 个模型」，点开才看到勾选/用途徽标/设为修复模型
                (v.models || []).length
                  ? h('div', { className: 'vn-models-toggle' },
                    h('button', {
                      className: 'vn-toggle-btn',
                      onClick: () => toggleModels(v.id),
                      title: openModels[v.id] ? '收起模型列表' : '展开模型列表'
                    },
                      openModels[v.id] ? '▾' : '▸',
                      ` ${(v.models || []).length} 个模型`,
                      openModels[v.id] ? '（收起）' : '（展开）'
                    )
                  )
                  : null,
                openModels[v.id]
                  ? h('div', { className: 'vn-models' },
                    (v.models || []).map((m) => {
                      const mk = `${v.id}::${m.id}`
                      const isOn = enabledKeys.has(mk)
                      const isRepair = Boolean(vendorUses.repair && `${vendorUses.repair.provider}::${vendorUses.repair.model}` === mk)
                      const usedLabels = MODEL_USE_LABELS
                        .filter(([k]) => vendorUses[k] && `${vendorUses[k].provider}::${vendorUses[k].model}` === mk)
                        .map(([, label]) => label)
                      return h('div', { className: 'vn-model' + (isOn ? '' : ' off'), key: m.id },
                        h('label', { className: 'vn-check', title: '启用后可用于「修复 / 队列默认 / 全天回复」' },
                          h('input', {
                            type: 'checkbox',
                            checked: isOn,
                            disabled: busy === 'en-' + mk,
                            onChange: (e) => toggleEnabled(v.id, m.id, e.target.checked)
                          }),
                          '启用'
                        ),
                        h('span', { className: 'vn-mname' }, m.name || m.id),
                        h('span', { className: 'vn-mid' }, m.id),
                        usedLabels.length
                          ? usedLabels.map((label) => h('span', { className: 'vn-use on', key: label }, label))
                          : (isOn ? h('span', { className: 'vn-use-none' }, '已启用 · 未分配') : null),
                        m.note ? h('span', { className: 'vn-mnote' }, m.note) : null,
                        m.price ? h('span', { className: 'vn-price' }, m.price) : null,
                        m.verified === false ? h('span', { className: 'vn-badge' }, '待确认') : null,
                        h('button', {
                          className: 'ar-btn vn-setrepair',
                          disabled: busyUse === 'repair',
                          title: '把这个模型指定为「让 AI 修」使用的模型',
                          onClick: () => assignUse('repair', mk)
                        }, isRepair ? '当前修复模型' : '设为修复模型')
                      )
                    })
                  )
                  : null
              )
            })
        ),

        h('div', { className: 'ar-policy' },
          h('div', { className: 'ar-policy-head' },
            h('div', { className: 'ar-policy-title' }, '自定义供应商'),
            h('span', { className: 'ar-flag' }, '名称 / 地址 / 模型 ID / Key')
          ),
          h('div', { className: 'ar-policy-hint' },
            '任何 OpenAI 兼容服务都能接：填完会进同一个模型列表、同一个队列，路由随下一次重启生效。',
            '模型 ID 可以填多个，用逗号或换行分隔。'
          ),
          h('div', { className: 'ar-actions' },
            h('button', { className: 'ar-btn', onClick: () => setShowCustom((x) => !x) }, showCustom ? '收起' : '新增自定义供应商')
          ),
          showCustom
            ? h('div', null,
              h('div', { className: 'ar-row' },
                h('span', { className: 'ar-sub' }, '名称'),
                h('input', { className: 'ar-input', value: cName, placeholder: '例如：公司内网网关', onChange: (e) => setCName(e.target.value) })
              ),
              h('div', { className: 'ar-row' },
                h('span', { className: 'ar-sub' }, '地址'),
                h('input', { className: 'ar-input', value: cBase, spellCheck: false, placeholder: 'https://example.com/v1', onChange: (e) => setCBase(e.target.value) })
              ),
              h('div', { className: 'ar-row' },
                h('span', { className: 'ar-sub' }, '模型 ID'),
                h('input', { className: 'ar-input', value: cModels, spellCheck: false, placeholder: 'model-a, model-b', onChange: (e) => setCModels(e.target.value) })
              ),
              h('div', { className: 'ar-row' },
                h('span', { className: 'ar-sub' }, 'Key'),
                h('input', { className: 'ar-input', type: 'password', value: cKey, spellCheck: false, placeholder: '可留空，稍后再填', onChange: (e) => setCKey(e.target.value) })
              ),
              h('div', { className: 'ar-actions' },
                h('button', {
                  className: 'ar-btn primary',
                  disabled: busy === 'custom-add' || !cName.trim() || !cBase.trim() || !cModels.trim(),
                  onClick: async () => {
                    const list = cModels.split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean)
                    const r = await post({ customAction: 'add', name: cName, baseUrl: cBase, models: list, apiKey: cKey }, 'custom-add')
                    if (r && r.ok !== false) {
                      setCName(''); setCBase(''); setCModels(''); setCKey(''); setShowCustom(false)
                    }
                  }
                }, busy === 'custom-add' ? '保存中…' : '保存自定义供应商')
              )
            )
            : null
        ),

        h('div', { className: 'ar-policy' },
          h('div', { className: 'ar-policy-head' },
            h('div', { className: 'ar-policy-title' }, '任务队列（共用）'),
            h('span', { className: 'ar-flag' }, q.running ? '执行中' : '空闲'),
            h('span', { className: 'ar-flag' }, `共 ${tasks.length} 条`)
          ),
          h('div', { className: 'ar-policy-hint' },
            '队列不分厂商：选哪家就用哪家的地址和 Key，串行执行、可重试，状态写在 auto-repair/state/zhipu-queue.json。'
          ),
          h('div', { className: 'ar-row' },
            h('span', { className: 'ar-sub' }, '供应商'),
            h('select', {
              className: 'ar-select',
              value: qVendor ? qVendor.id : '',
              onChange: (e) => { setQProvider(e.target.value); setQModel('') }
            },
              vendors.map((v) => h('option', { key: v.id, value: v.id }, `${v.name}${v.key && v.key.configured ? '' : '（缺 Key）'}`))
            )
          ),
          h('div', { className: 'ar-row' },
            h('span', { className: 'ar-sub' }, '模型'),
            h('select', {
              className: 'ar-select',
              value: qModelValue,
              onChange: (e) => setQModel(e.target.value)
            },
              qModels.length
                ? qModels.map((m) => h('option', { key: m.id, value: m.id }, `${m.name || m.id}（${m.id}）`))
                : h('option', { value: '' }, '暂无模型')
            )
          ),
          h('textarea', {
            className: 'ar-input',
            rows: 3,
            value: prompt,
            placeholder: '要交给这个供应商做的事，例如：把这段日志总结成三条结论…',
            onChange: (e) => setPrompt(e.target.value)
          }),
          h('div', { className: 'ar-actions' },
            h('button', {
              className: 'ar-btn primary',
              disabled: busy === 'q-add' || !prompt.trim() || !qVendor || !qModelValue,
              onClick: async () => {
                const r = await post({ id: qVendor.id, action: 'add', prompt, model: qModelValue }, 'q-add')
                if (r && r.ok !== false) setPrompt('')
              }
            }, '加入队列'),
            h('button', {
              className: 'ar-btn',
              disabled: busy === 'retryall',
              onClick: () => post({ id: qVendor ? qVendor.id : '', action: 'retry-all' }, 'retryall')
            }, '重试全部失败'),
            h('button', {
              className: 'ar-btn',
              disabled: busy === 'clearq',
              onClick: () => post({ id: qVendor ? qVendor.id : '', action: 'clear-finished' }, 'clearq')
            }, '清理已完成')
          ),
          tasks.length === 0
            ? h('div', { className: 'ar-empty' }, '队列是空的。加一条任务，它会自动开始执行。')
            : h('div', null, tasks.map((t, i) => {
              const pair = ZQ_STATUS[t.status] || ['pending', t.status || '未知']
              const pv = vendors.find((v) => v.id === (t.provider || 'zhipu'))
              return h('div', { className: 'zq-task', key: t.id },
                h('div', { className: 'zq-task-top' },
                  h('span', { className: 'zq-idx' }, `#${i + 1}`),
                  h('span', { className: 'zq-chip ' + pair[0] }, pair[1]),
                  h('span', { className: 'ar-sub' }, pv ? pv.name : (t.provider || 'zhipu')),
                  h('span', { className: 'ar-sub' }, t.model || '(默认模型)'),
                  t.attempts > 1 ? h('span', { className: 'ar-sub' }, `第 ${t.attempts} 次`) : null,
                  h('span', { className: 'ar-time' },
                    t.finishedAt ? fmtDateTime(t.finishedAt)
                      : t.startedAt ? '开始 ' + fmtTime(t.startedAt)
                        : fmtTime(t.createdAt))
                ),
                h('div', { className: 'zq-prompt' }, t.prompt),
                t.result ? h('div', { className: 'zq-out' }, t.result) : null,
                t.error ? h('div', { className: 'zq-out err' }, t.error) : null,
                h('div', { className: 'zq-row-actions' },
                  t.status === 'failed'
                    ? h('button', {
                      className: 'ar-btn',
                      disabled: busy === 'retry-' + t.id,
                      onClick: () => post({ id: t.provider || 'zhipu', action: 'retry', taskId: t.id }, 'retry-' + t.id)
                    }, '重试')
                    : null,
                  (t.status === 'done' || t.status === 'failed')
                    ? h('button', {
                      className: 'ar-btn',
                      disabled: busy === 'rm-' + t.id,
                      onClick: () => post({ id: t.provider || 'zhipu', action: 'remove', taskId: t.id }, 'rm-' + t.id)
                    }, '删除')
                    : null
                )
              )
            }))
        ),

        err ? h('div', { className: 'ar-warnbox' }, err) : null,
        note ? h('div', { className: 'ar-note' }, note) : null
      )
    }

    // ── 模型管理（总控）：一处切换 API + 接管范围清单 ─────────────────────────
    const MANAGE_SCOPE_ROWS = [
      { key: 'agent', label: 'DSH 本体会话', hint: 'agent-default-model（profiles/desktop/cordis.patch.yml）', effect: '需重启 DSH', effectNote: '' },
      { key: 'repair', label: '自愈「让 AI 修」', hint: 'model-choice.json', effect: '即时', effectNote: '守护进程每次运行读文件' },
      { key: 'queue', label: '任务队列默认模型', hint: 'uses.queue', effect: '即时', effectNote: '只影响新任务' },
      { key: 'reply', label: '全天回复 / QQ 桥接', hint: 'uses.reply', effect: '即时', effectNote: '每条消息热读，无需重启' },
      { key: 'bridge', label: '桥接兜底配置', hint: 'qq-bridge/config.json 的 dsh.provider/model', effect: '需重启桥接', effectNote: 'reply 为空时才用到' }
    ]

    function ManageSection() {
      const [state, setState] = useState(null)
      const [err, setErr] = useState('')
      const [note, setNote] = useState('')
      const [busy, setBusy] = useState('')
      const [pv, setPv] = useState('')
      const [mv, setMv] = useState('')
      const [results, setResults] = useState(null)
      // 用量（本地账本，非厂商账单）
      const [usageDays, setUsageDays] = useState(7)
      const [usageSrc, setUsageSrc] = useState('all')
      const [usage, setUsage] = useState(null)
      const [usageErr, setUsageErr] = useState('')

      const loadUsage = useCallback(async (days, src) => {
        try {
          const r = await fetchJson(`/usage?days=${days}&source=${encodeURIComponent(src)}`, { cache: 'no-store' })
          if (r && r.ok === false) throw new Error(r.error || '读取用量失败')
          setUsage(r)
          setUsageErr('')
        } catch (e) {
          setUsageErr(e?.message || String(e))
        }
      }, [])
      useEffect(() => { loadUsage(usageDays, usageSrc) }, [loadUsage, usageDays, usageSrc])

      const load = useCallback(async () => {
        try {
          const r = await fetchJson('/manage', { cache: 'no-store' })
          setState(r)
          setErr('')
        } catch (e) {
          setErr(e?.message || String(e))
        }
      }, [])
      useEffect(() => { load() }, [load])
      useEffect(() => {
        const t = setInterval(() => { load() }, 8000)
        return () => clearInterval(t)
      }, [load])

      async function send(body, tag) {
        setBusy(tag || 'x')
        setNote('')
        setErr('')
        try {
          const r = await fetchJson('/manage', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          })
          if (r) {
            if (r.ok === false) setErr(String(r.error || '操作失败'))
            if (Array.isArray(r.results)) setResults(r.results)
            if (r.message) setNote(String(r.message))
            if (Array.isArray(r.vendors)) setState(r)
          }
          return r
        } catch (e) {
          setErr(e?.message || String(e))
        } finally {
          setBusy('')
        }
      }

      const vendors = (state && state.vendors) || []
      const takeover = (state && state.takeover) || {}
      const defProvider =
        (state && (state.uses?.reply?.provider || state.uses?.queue?.provider)) ||
        (vendors.find((v) => v.configured) || {}).id ||
        ''
      const defModel = (state && (state.uses?.reply?.model || state.uses?.queue?.model)) || ''
      const selProvider = pv || defProvider
      const selVendor = vendors.find((v) => v.id === selProvider) || null
      const selModels = (selVendor && selVendor.models) || []
      const selModel = (mv && selModels.some((m) => m.id === mv) ? mv : '') ||
        (selModels.some((m) => m.id === defModel) ? defModel : '') ||
        (selModels[0] && selModels[0].id) || ''

      const valueOf = (key) => {
        if (!state) return '—'
        if (key === 'agent') {
          const a = state.agent || {}
          return a.exists ? `${a.provider || '?'} / ${a.model || '?'}` : '读不到（profile 缺失）'
        }
        if (key === 'repair') return state.repair ? `${state.repair.provider} / ${state.repair.model}` : '（未指定）'
        if (key === 'bridge') return `${state.bridge?.provider || '?'} / ${state.bridge?.model || '?'}`
        const u = (state.uses && state.uses[key]) || null
        return u ? `${u.provider} / ${u.model}` : '（未指定）'
      }

      function toggleScope(key, on) {
        const next = { ...takeover, [key]: on }
        setState((s) => (s ? { ...s, takeover: next } : s))
        send({ action: 'saveTakeover', takeover: next }, 'tk-' + key)
      }

      // ── 用量卡片的小工具 ──
      const US_SOURCES = [
        { id: 'all', label: '全部' },
        { id: 'repair', label: '修复' },
        { id: 'queue', label: '队列' },
        { id: 'reply', label: '全天回复' },
        { id: 'bridge', label: '桥接兜底' }
      ]
      const fmtTok = (n) => {
        const v = Number(n) || 0
        if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`
        if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`
        return String(v)
      }
      const fmtCost = (n, sym) => `${sym || '¥'}${(Number(n) || 0).toFixed(4)}`
      const usSeries = (usage && usage.series) || []
      const usMax = Math.max(1, ...usSeries.map((s) => Number(s.tokens) || 0))
      const usSym = usage?.meta?.symbol || '¥'

      function doSwitch() {
        if (!selProvider || !selModel) return
        const scopes = MANAGE_SCOPE_ROWS.filter((r) => takeover[r.key]).map((r) => r.key)
        if (!scopes.length) {
          setErr('下面没有任何一项被接管，先把要跟着变的那几项打开')
          return
        }
        setResults(null)
        send({ action: 'switch', provider: selProvider, model: selModel, scopes }, 'switch')
      }

      function applyAgent() {
        if (!selProvider || !selModel) return
        send({ action: 'applyAgent', provider: selProvider, model: selModel }, 'agent')
      }

      const restartList = (results || []).filter((r) => r.needsRestart)
      const pending = state && state.pendingAgent

      return h('div', { className: 'ar-root' },
        h('style', null, STYLE + `
          .mg-sec{margin-top:14px}
          .mg-tag{font-size:11px;opacity:.8}
          .mg-chk{display:flex;align-items:center;gap:5px;font-size:11.5px;opacity:.92;white-space:nowrap}
          .mg-res{margin-top:8px;font-size:12px;line-height:1.6}
          .mg-scopes{display:flex;flex-direction:column;gap:10px;margin-top:4px}
          .mg-scope{display:flex;flex-direction:column;gap:6px;min-width:0;padding:10px 12px;border:1px solid rgba(127,127,127,.18);border-radius:10px;background:rgba(127,127,127,.04)}
          .mg-scope-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;min-width:0}
          .mg-scope-name{font-weight:600;font-size:12.5px;min-width:0;overflow-wrap:anywhere}
          .mg-scope-key{font-family:ui-monospace,Consolas,monospace;font-size:11px;opacity:.62;overflow-wrap:anywhere;word-break:break-all}
          .mg-scope-val{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;font-size:11.5px;min-width:0}
          .mg-now,.mg-next{font-family:ui-monospace,Consolas,monospace;white-space:nowrap;max-width:100%}
          .mg-now{opacity:.9}
          .mg-nextgroup{display:inline-flex;align-items:baseline;gap:6px;white-space:nowrap;max-width:100%}
          .mg-arrow{opacity:.5}
          .mg-next{opacity:.95}
          .mg-next.off{opacity:.5}
          .mg-scope-foot{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;min-width:0}
          .mg-badge{font-size:11px;line-height:1.5;padding:1px 8px;border-radius:999px;border:1px solid rgba(127,127,127,.3);background:rgba(127,127,127,.1);white-space:normal;overflow-wrap:anywhere}
          .mg-badge.restart{border-color:rgba(214,158,46,.55);background:rgba(214,158,46,.14)}
          .mg-badge-note{font-size:11px;opacity:.62;white-space:normal;overflow-wrap:anywhere}
          .us-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
          .us-local{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid rgba(214,158,46,.5);background:rgba(214,158,46,.12);white-space:nowrap}
          .us-grid{display:flex;gap:10px;flex-wrap:wrap;margin:10px 0 4px}
          .us-kpi{flex:1 1 120px;min-width:110px;padding:8px 10px;border:1px solid rgba(127,127,127,.18);border-radius:10px;background:rgba(127,127,127,.05)}
          .us-kpi b{display:block;font-size:16px;line-height:1.4;font-variant-numeric:tabular-nums}
          .us-kpi span{font-size:11px;opacity:.7}
          .us-seg{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
          .us-seg-btn{font-size:11.5px;padding:3px 10px;border-radius:999px;border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;cursor:pointer;white-space:nowrap}
          .us-seg-btn.on{background:rgba(127,127,127,.18);border-color:rgba(127,127,127,.5);font-weight:600}
          .us-chart{width:100%;height:96px;display:block;margin:6px 0 2px;overflow:visible}
          .us-axis{display:flex;justify-content:space-between;font-size:10.5px;opacity:.6;gap:8px}
          .us-table{width:100%;border-collapse:collapse;font-size:11.5px;margin-top:6px}
          .us-table th{text-align:left;font-weight:600;opacity:.7;padding:3px 6px;border-bottom:1px solid rgba(127,127,127,.2);white-space:nowrap}
          .us-table td{padding:3px 6px;border-bottom:1px solid rgba(127,127,127,.1);vertical-align:top}
          .us-table td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
          .us-table td.name{overflow-wrap:anywhere}
          .us-cap{font-size:11px;opacity:.65;margin-top:10px}
          .us-err{font-size:11.5px;color:#c0392b;margin-top:6px;overflow-wrap:anywhere}
        `),
        h('div', { className: 'ar-section-title' }, '模型管理'),
        h('div', { className: 'ar-note' }, '一处切换当前生效的厂商/模型；下面每一项单独决定「跟不跟着变」，并标明是即时生效还是必须重启。'),

        err ? h('div', { className: 'ar-warnbox' }, err) : null,
        note ? h('div', { className: 'ar-note' }, note) : null,
        restartList.length
          ? h('div', { className: 'ar-warnbox' }, '其中 ' + restartList.map((r) => (MANAGE_SCOPE_ROWS.find((x) => x.key === r.scope) || {}).label || r.scope).join('、') + ' 需重启才生效。')
          : null,

        // ① 切换 API
        h('div', { className: 'ar-card mg-sec' },
          h('div', { className: 'ar-section-title' }, '切换 API'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
            h('select', {
              value: selProvider,
              onChange: (e) => { setPv(e.target.value); setMv('') },
              style: { minWidth: 190 }
            },
              !vendors.length ? h('option', { value: '' }, '（加载中）') : null,
              vendors.map((v) => h('option', { key: v.id, value: v.id },
                `${v.name || v.id}${v.configured ? '' : '（缺 Key）'}`))
            ),
            h('select', {
              value: selModel,
              onChange: (e) => setMv(e.target.value),
              style: { minWidth: 220 }
            },
              selModels.map((m) => h('option', { key: m.id, value: m.id }, `${m.name || m.id}（${m.id}）`))
            ),
            h('span', { className: 'mg-tag' },
              selVendor
                ? (selVendor.configured ? 'Key 已配置' : (selVendor.keyEnv ? '缺 Key，先用「模型供应商」填上' : '免 Key'))
                : ''
            ),
            h('button', {
              className: 'ar-btn',
              disabled: busy === 'switch' || !selProvider || !selModel,
              onClick: doSwitch
            }, busy === 'switch' ? '切换中…' : '切换')
          ),
          h('div', { className: 'ar-note' }, '只作用于下面勾了「接管」的项；没勾的不会被动。'),
          pending
            ? h('div', { className: 'ar-note' }, `DSH 本体待应用：${pending.provider} / ${pending.model}（点下方「写入 DSH 本体」并重启）`)
            : null,
          results && results.length
            ? h('div', { className: 'mg-res' },
              results.map((r) => {
                const row = MANAGE_SCOPE_ROWS.find((x) => x.key === r.scope) || {}
                return h('div', { key: r.scope },
                  `${r.ok ? '✓' : '✗'} ${row.label || r.scope}：${r.message || (r.ok ? '成功' : '失败')}${r.needsRestart ? '（需重启）' : ''}`)
              })
            )
            : null
        ),

        // ② 接管范围（堆叠卡片：一项一块，窄容器下纵向排列，不横向挤出）
        h('div', { className: 'ar-card mg-sec' },
          h('div', { className: 'ar-section-title' }, '接管范围'),
          h('div', { className: 'mg-scopes' },
            MANAGE_SCOPE_ROWS.map((row) =>
              h('div', { className: 'mg-scope', key: row.key },
                h('div', { className: 'mg-scope-head' },
                  h('div', { className: 'mg-scope-name' }, row.label),
                  h('label', { className: 'mg-chk' },
                    h('input', {
                      type: 'checkbox',
                      checked: Boolean(takeover[row.key]),
                      disabled: busy === 'tk-' + row.key,
                      onChange: (e) => toggleScope(row.key, e.target.checked)
                    }),
                    '接管'
                  )
                ),
                h('div', { className: 'mg-scope-key' }, row.hint),
                h('div', { className: 'mg-scope-val' },
                  h('span', { className: 'mg-now' }, valueOf(row.key)),
                  h('span', { className: 'mg-nextgroup' },
                    h('span', { className: 'mg-arrow' }, '→'),
                    h('span', { className: takeover[row.key] ? 'mg-next' : 'mg-next off' },
                      takeover[row.key] ? `${selProvider} / ${selModel}` : '保持不动')
                  )
                ),
                h('div', { className: 'mg-scope-foot' },
                  h('span', { className: row.effect === '即时' ? 'mg-badge' : 'mg-badge restart' }, row.effect),
                  row.effectNote ? h('span', { className: 'mg-badge-note' }, row.effectNote) : null,
                  row.key === 'agent'
                    ? h('button', {
                      className: 'ar-btn',
                      disabled: busy === 'agent' || !selProvider || !selModel,
                      title: '写入 profiles/desktop/cordis.patch.yml 的 agent-default-model（改前自动备份）',
                      onClick: applyAgent
                    }, busy === 'agent' ? '写入中…' : '写入 DSH 本体')
                    : null
                )
              )
            )
          ),
          h('div', { className: 'ar-note' }, '已排在队列里的任务各自带着模型，不会跟着切换；只有之后新加的任务用「任务队列默认」。')
        ),

        // ③ 用量（本地统计，非厂商账单）
        h('div', { className: 'ar-card mg-sec' },
          h('div', { className: 'us-head' },
            h('div', { className: 'ar-section-title' }, '用量'),
            h('span', { className: 'us-local' }, '本地统计，非厂商账单')
          ),
          h('div', { className: 'ar-note' }, '统计本机观察到的调用，费用按厂商目录价折算成估算值；厂商侧真实账单/额度以官方为准。'),
          usageErr ? h('div', { className: 'us-err' }, usageErr) : null,
          h('div', { className: 'us-grid' },
            h('div', { className: 'us-kpi' },
              h('b', null, usage ? String(usage.totals.count) : '—'),
              h('span', null, '请求次数')),
            h('div', { className: 'us-kpi' },
              h('b', null, usage ? fmtTok(usage.totals.tokens) : '—'),
              h('span', null, usage ? `Tokens（入 ${fmtTok(usage.totals.input)} / 出 ${fmtTok(usage.totals.output)}）` : 'Tokens')),
            h('div', { className: 'us-kpi' },
              h('b', null, usage ? fmtCost(usage.totals.cost, usSym) : '—'),
              h('span', null, usage && usage.totals.unpriced ? `估算花费 · ${usage.totals.unpriced} 条未计价` : '估算花费'))
          ),
          h('div', { className: 'us-seg' },
            [7, 30].map((d) => h('button', {
              key: d,
              className: `us-seg-btn ${usageDays === d ? 'on' : ''}`,
              onClick: () => setUsageDays(d)
            }, `近 ${d} 天`))
          ),
          h('div', { className: 'us-seg' },
            US_SOURCES.map((s) => h('button', {
              key: s.id,
              className: `us-seg-btn ${usageSrc === s.id ? 'on' : ''}`,
              onClick: () => setUsageSrc(s.id)
            }, s.label))
          ),
          h('svg', { className: 'us-chart', viewBox: '0 0 700 90', preserveAspectRatio: 'none', role: 'img', 'aria-label': `近 ${usageDays} 天按天 tokens 柱状图` },
            h('line', { x1: 0, y1: 89, x2: 700, y2: 89, stroke: 'rgba(127,127,127,.35)', strokeWidth: 1 }),
            usSeries.map((s, i) => {
              const bw = 700 / Math.max(1, usSeries.length)
              const w = Math.max(2, bw * 0.62)
              const x = i * bw + (bw - w) / 2
              const hgt = Math.max(0, Math.round(((Number(s.tokens) || 0) / usMax) * 80))
              return h('rect', {
                key: s.d,
                x, y: 88 - hgt, width: w, height: hgt,
                rx: 2,
                fill: s.tokens ? 'rgba(90,150,240,.75)' : 'rgba(127,127,127,.18)'
              }, h('title', null, `${s.d}：${fmtTok(s.tokens)} tokens / ${s.count} 次 / ${fmtCost(s.cost, usSym)}`))
            })
          ),
          h('div', { className: 'us-axis' },
            h('span', null, usSeries[0]?.d || '—'),
            h('span', null, usSeries[usSeries.length - 1]?.d || '—')
          ),
          h('table', { className: 'us-table' },
            h('thead', null,
              h('tr', null,
                h('th', null, '厂商'),
                h('th', { className: 'num' }, '次数'),
                h('th', { className: 'num' }, 'Tokens'),
                h('th', { className: 'num' }, '估算花费')
              )
            ),
            h('tbody', null,
              ((usage && usage.byProvider) || []).slice(0, 6).map((r) =>
                h('tr', { key: r.provider },
                  h('td', { className: 'name' }, r.provider),
                  h('td', { className: 'num' }, String(r.count)),
                  h('td', { className: 'num' }, fmtTok(r.tokens)),
                  h('td', { className: 'num' }, r.unpriced && !r.cost ? '未计价' : fmtCost(r.cost, usSym))
                )
              ),
              !(usage && usage.byProvider && usage.byProvider.length)
                ? h('tr', null, h('td', { colSpan: 4, className: 'name' }, '这个范围内还没有记录'))
                : null
            )
          ),
          h('table', { className: 'us-table' },
            h('thead', null,
              h('tr', null,
                h('th', null, '模型'),
                h('th', { className: 'num' }, '次数'),
                h('th', { className: 'num' }, 'Tokens'),
                h('th', { className: 'num' }, '估算花费')
              )
            ),
            h('tbody', null,
              ((usage && usage.byModel) || []).slice(0, 8).map((r) =>
                h('tr', { key: r.model },
                  h('td', { className: 'name' }, r.model),
                  h('td', { className: 'num' }, String(r.count)),
                  h('td', { className: 'num' }, fmtTok(r.tokens)),
                  h('td', { className: 'num' }, r.unpriced && !r.cost ? '未计价' : fmtCost(r.cost, usSym))
                )
              )
            )
          ),
          h('div', { className: 'us-cap' },
            '来源：全天回复读桥接的逐次 token 账本；修复由「让 AI 修」在每轮结束时按 step 写入；队列由 DSH 内部执行、桥接兜底目前未触发，两者暂无采集点（显示 0 属正常）。账本保留 90 天，超期自动清理。价目表里没有的厂商/模型显示「未计价」，不按兜底价编造。')
        )
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'auto-repair', order: 50, label: '自愈' },
            AutoRepairPanel
          )
        )
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'vendors', order: 45, label: '模型供应商' },
            VendorsSection
          )
        )
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'model-manage', order: 43, label: '模型管理' },
            ManageSection
          )
        )
      }
    }
  }
})
