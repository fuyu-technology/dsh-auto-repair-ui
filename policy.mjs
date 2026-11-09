// auto-repair · 审批策略
//
// 谁来决定「要不要修」？三种全局模式：
//
//   manual       逐条审批（**默认**）
//                守护进程只诊断、只报告，**不自动动手**。
//                用户在设置页点某条错误的「修复」才真的修。
//   approve-all  全部自动
//                守护进程发现能修的直接修，不需要人点（等于本文件引入前的行为）。
//   reject-all   全拒绝
//                一律不自动修，面板上的修复按钮也禁用，只做报告。
//
// 另有两条独立开关：
//
//   agentAssist    无法自动修复时，是否允许把问题**交给 DSH agent** 去修（默认开）。
//                  这条独立于上面三种模式：manual 模式下依然可以让 agent 接手。
//   autoFeed       自动把报错原文**投喂进模型会话的输入框**（默认开）。
//                  只影响「守护进程自动升级」这一条路；面板上手动点「让 AI 修」
//                  属于用户明确拍板，不受它限制。关掉后仍然会拉起会话，只是不投喂。
//   rejectedCodes  逐条「忽略」过的 code。这些 code 不再自动修，也不再弹到面板顶上，
//                  但仍会写进诊断记录（要查到随时能查）。
//
// 策略文件放在 state/repair-policy.json。**守护进程每轮都重读**，
// 所以面板改完策略下一轮（默认 30 秒）就生效，不用重启任何进程。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// 状态目录。可以用 REPAIR_STATE_DIR 覆盖 —— 测试时用它指到临时目录，
// 免得测试把真实策略文件改了。
const STATE = process.env.REPAIR_STATE_DIR
  ? path.resolve(process.env.REPAIR_STATE_DIR)
  : path.join(HERE, 'state')
const POLICY_FILE = path.join(STATE, 'repair-policy.json')

export const MODES = Object.freeze(['manual', 'approve-all', 'reject-all'])

/** 默认策略：逐条审批 + 允许 agent 接手 + 自动投喂报错 */
export const DEFAULT_POLICY = Object.freeze({
  mode: 'manual',
  agentAssist: true,
  autoFeed: true,
  rejectedCodes: [],
  updatedAt: 0
})

function normalizePolicy(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const mode = MODES.includes(String(src.mode)) ? String(src.mode) : DEFAULT_POLICY.mode
  const rejected = Array.isArray(src.rejectedCodes)
    ? [...new Set(src.rejectedCodes.map((c) => String(c).trim()).filter(Boolean))]
    : []
  return {
    mode,
    agentAssist: src.agentAssist !== false,
    autoFeed: src.autoFeed !== false,
    rejectedCodes: rejected,
    updatedAt: Number(src.updatedAt) || 0
  }
}

/** 读策略（文件不存在或坏了都回落到默认值，绝不抛错） */
export function readPolicy() {
  try {
    return normalizePolicy(JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8').replace(/^\uFEFF/, '')))
  } catch {
    return { ...DEFAULT_POLICY, rejectedCodes: [] }
  }
}

/**
 * 写策略。只接受白名单字段，未知字段丢弃。
 *
 * 除了「整份替换」式的 rejectedCodes，还支持两种增量写法：
 *   addRejected:    ['CODE', ...]    追加到忽略列表
 *   removeRejected: ['CODE', ...]    从忽略列表移除
 * 增量写法让面板的「忽略 / 取消忽略」不必先读全量再回写。
 *
 * @returns {object} 落盘后的完整策略
 */
export function writePolicy(patch) {
  const cur = readPolicy()
  const src = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}

  let rejected = Array.isArray(src.rejectedCodes)
    ? [...src.rejectedCodes]
    : [...cur.rejectedCodes]
  if (Array.isArray(src.addRejected)) rejected.push(...src.addRejected)
  if (Array.isArray(src.removeRejected)) {
    const drop = new Set(src.removeRejected.map((c) => String(c).trim()))
    rejected = rejected.filter((c) => !drop.has(String(c)))
  }

  const next = normalizePolicy({
    mode: src.mode !== undefined ? src.mode : cur.mode,
    agentAssist: src.agentAssist !== undefined ? src.agentAssist : cur.agentAssist,
    autoFeed: src.autoFeed !== undefined ? src.autoFeed : cur.autoFeed,
    rejectedCodes: rejected,
    updatedAt: Date.now()
  })
  fs.mkdirSync(STATE, { recursive: true })
  fs.writeFileSync(POLICY_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

/** 这个 code 是否被用户明确拒绝过 */
export function isRejected(code, policy = readPolicy()) {
  return policy.rejectedCodes.includes(String(code))
}

/**
 * 允许自动修吗？
 *
 * - reject-all      → 一律不许
 * - 手工拒绝过的 code → 不许
 * - manual          → 不许（要人点）
 * - approve-all     → 允许
 */
export function canAutoRepair(code, policy = readPolicy()) {
  if (policy.mode === 'reject-all') return false
  if (isRejected(code, policy)) return false
  return policy.mode === 'approve-all'
}

/** 面板上的「修复」按钮此刻允许点吗？（与守护进程的自动修是两条路） */
export function canManualRepair(code, policy = readPolicy()) {
  if (policy.mode === 'reject-all') return false
  if (isRejected(code, policy)) return false
  return true
}
