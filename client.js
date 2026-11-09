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
      const [models, setModels] = useState(null)
      const [modelBusy, setModelBusy] = useState(false)
      // 本机模型客户端（TRAE / MiniMax）：扫描结果 + 手动改路径时的草稿
      const [clients, setClients] = useState(null)
      const [clientsBusy, setClientsBusy] = useState(false)
      const [clientDraft, setClientDraft] = useState({})
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

      // 模型卡片用的数据（/models 拉不到时也要能把面板画出来）
      const modelProviders = Array.isArray(models?.providers) ? models.providers : []
      const modelWarnings = Array.isArray(models?.warnings) ? models.warnings : []
      const modelError = models && models.ok === false ? String(models.error || '读不到模型列表') : ''
      const curModel = models?.current || null
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

        // ── AI 模型（「让 AI 修」用哪个提供方/模型） ──────────────────────
        h('div', { className: 'ar-policy' },
          h('div', { className: 'ar-policy-head' },
            h('span', { className: 'ar-policy-title' }, 'AI 模型'),
            h('span', { className: 'ar-policy-hint' },
              '「让 AI 修」时用哪个提供方/模型。选项来自 DSH 实际可用的模型目录；缺 Key 或路由未启用会直接标出来。')
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
          '「AI 模型」卡片决定下一次「让 AI 修」用哪个模型；MiniMax 的 Key 由 DSH 凭据系统管理，',
          '面板本身不存密钥。',
          h('br'),
          '「本机模型客户端」卡片只做发现与可选关联启动：勾了「关联启动」才会在投喂前拉起对应客户端，',
          '默认全关；扫不到就显示「未检测到」，也可以手填 .exe 完整路径。',
          h('br'),
          '手动诊断：',
          h('code', null, 'node D:\\大肥鱼\\auto-repair\\auto-repair.mjs --check')
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
      }
    }
  }
})
