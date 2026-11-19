// QQ 桥接的 MCP client 注册 —— 单一权威来源。
//
// 为什么注册要放两层：
//   · bundle 层（plugins/qq-agent-presets/bridge.patch.yml）
//       DSH 只在启动时读 bundle 层，**永远不会重写它** → 这里是权威来源。
//   · profile 层（profiles/desktop/cordis.patch.yml）
//       DSH 保存设置时会重写 profile 层，且**只写它自己管理的行**
//       （ui-* / agent-default-model 等）。外部托管的行会被整段抹掉 ——
//       2026-11-02 07:22:40 的「QQ 桥接掉了」就是这么来的：
//       profile 从 2257B 缩到 1052B，MCP 注册整段消失，QQ 会话只剩
//       「提问」和「待办」两个工具。
//
// 活证据：qq-chat / qq-chat-v2 两个 preset 同在 bundle 层，
// profile 被重写之后 preset 依然生效 —— bundle 层免疫写回。

import fs from 'node:fs'
import path from 'node:path'

export const NODE_BIN = 'C:\\Users\\Administrator\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe'
export const SRC_DIR = 'D:\\大肥鱼\\qq-bridge\\src'

/** 由桥接托管的三个 MCP client（与 scripts/setup-dsh.mjs 的 MANAGED_MCP_IDS 一致） */
export const MCP_CLIENTS = [
  { id: 'mcp-snowluma', server: 'snowluma', script: 'mcp-snowluma-safe.js', timeout: 725000 },
  { id: 'mcp-snowluma-host', server: 'snowluma-host', script: 'mcp-host-server.js' },
  { id: 'mcp-web-search-safe', server: 'web-search-safe', script: 'mcp-web-search-safe.js' }
]

export const MCP_CLIENT_IDS = MCP_CLIENTS.map((c) => c.id)

const yq = (s) => `'${String(s).replace(/'/g, "''")}'`

/** bundle 层补丁的规范内容 */
export function bundlePatchText() {
  let out = '# qq-bridge 托管行（bundle 层）\n'
  out += '#\n'
  out += '# 本文件是 MCP 注册的权威来源。DSH 只在启动时读 bundle 层，永远不会重写它。\n'
  out += '# profile 层同名区块只是热备：DSH 保存设置时会重写 profile patch 并抹掉外部托管的行\n'
  out += '#（2026-11-02「QQ 桥接掉了」的根因）。两层都有时按 id 去重，只会跑一份。\n'
  out += '#\n'
  out += '# 由 scripts/setup-dsh.mjs 维护，请勿手工编辑内部条目。\n'
  for (const c of MCP_CLIENTS) {
    out += '- insert:\n'
    out += `    - id: ${c.id}\n`
    out += `      name: '@deepseek-ai/dsh-mcp-client'\n`
    out += `      config:\n`
    out += `        serverName: ${c.server}\n`
    out += `        transport: stdio\n`
    out += `        command: ${yq(NODE_BIN)}\n`
    out += `        args:\n`
    out += `          - ${yq(path.join(SRC_DIR, c.script))}\n`
    if (c.timeout) out += `        toolCallTimeoutMs: ${c.timeout}\n`
  }
  out += '\n'
  out += '# 预选哪个 agent preset。dsh-web-app 的 bundle 已声明 default: standard，\n'
  out += '# 这里只覆盖用户实际选中的那个（cordis）。volatile 字段，写回时容易被丢，故沉到 bundle 层。\n'
  out += '# ⚠ cordis 的 patch 是「整行替换 config」，不是合并 —— 只写 selectedDefault 会把\n'
  out += '#   web-app 设的 default 抹掉，agent-preset-registry 因缺必填字段校验失败，\n'
  out += '#   agentPresets 服务起不来、所有 preset 永远 pending（2026-11-03 实测）。\n'
  out += '#   所以 default 必须一起写上。\n'
  out += '- id: agent-preset-registry\n'
  out += "  name: '@deepseek-ai/dsh-agent-preset-registry'\n"
  out += '  config:\n'
  out += '    default: standard\n'
  out += '    selectedDefault: cordis\n'
  return out
}

/** 幂等地把 bundle 层补丁写成规范内容 */
export function ensureBundlePatch(file) {
  const want = bundlePatchText()
  let cur = null
  try { cur = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '') } catch {}
  if (cur === want) return { changed: false, reason: '已是规范状态' }

  // 关键内容（三个 MCP client + preset 预选）缺一不可；
  // 只在**缺内容**时覆盖，注释写得不一样不算故障，不动它。
  const missing = MCP_CLIENT_IDS.filter((id) => !String(cur ?? '').includes(id))
  // preset 行必须是**完整 config**（default + selectedDefault）——
  // 少 default 就会把 dsh-web-app 那一行的 default 整行覆盖掉，preset 服务起不来。
  const presetOk = /- id: agent-preset-registry[\s\S]*?config:\s*\n\s*default: standard[\s\S]*?selectedDefault: cordis/.test(String(cur ?? ''))
  if (!presetOk) missing.push('agent-preset-registry')
  if (!missing.length) {
    return { changed: false, reason: 'MCP 条目齐全（仅注释与规范不同，未覆盖）' }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, want, 'utf8')
  return { changed: true, reason: `已重写 bundle 层补丁（补回 ${missing.join(', ')}）`, missing }
}

/**
 * 幂等地把 MCP 注册补回 profile 层补丁。
 * 只做**文本插入**，不重新序列化 YAML —— 保留原注释与格式。
 */
export function ensureProfilePatch(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch (e) {
    return { changed: false, reason: `读不到 ${file}：${e.message}` }
  }
  const before = text
  const missing = MCP_CLIENT_IDS.filter((id) => !text.includes(id))
  if (!missing.length) return { changed: false, reason: 'MCP 条目齐全' }

  if (!text.endsWith('\n')) text += '\n'
  // ⚠️ 关键坑（2026-11-03）：DSH 写回 profile patch 时，文件内容是一个**空的根数组**
  // （文件最后一行是 `[]`）。若直接在其后追加 `- insert:` 区块，就会变成**一个 YAML 文件里
  // 两个文档**，host 启动即报 "YAMLException: end of the stream or a document separator
  // is expected" → DSH 起不来，桌面壳层只显示 "desktop welcome: Web authentication
  // failed"（误导性症状）。所以追加前必须先摘掉那个空的根数组行。
  text = text.replace(/^﻿?\[\][ \t]*$/gm, '')
  text += '# === qq-bridge MCP BEGIN ===\n'
  text += '# 由 scripts/setup-dsh.mjs 维护；这段区块会被整体替换，请勿手工编辑内部条目。\n'
  for (const c of MCP_CLIENTS) {
    text += '- insert:\n'
    text += `    - id: ${c.id}\n`
    text += `      name: '@deepseek-ai/dsh-mcp-client'\n`
    text += `      config:\n`
    text += `        serverName: ${c.server}\n`
    text += `        transport: stdio\n`
    text += `        command: ${yq(NODE_BIN)}\n`
    text += `        args:\n`
    text += `          - ${yq(path.join(SRC_DIR, c.script))}\n`
    if (c.timeout) text += `        toolCallTimeoutMs: ${c.timeout}\n`
  }
  text += '# === qq-bridge MCP END ===\n'

  if (text === before) return { changed: false, reason: '已是规范状态' }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  try { fs.copyFileSync(file, `${file}.bak-${stamp}`) } catch {}
  fs.writeFileSync(file, text, 'utf8')
  return { changed: true, reason: `已补回：${missing.join(', ')}`, missing }
}
