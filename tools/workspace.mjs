// 工作区解析 —— 单一来源（守护进程侧）
//
// 优先级：
//   1. 环境变量 AUTO_REPAIR_ROOT（最高，方便脚本/临时覆盖）
//   2. state/workspace.json（面板里「首次使用 / 重新选择」保存的结果）
//   3. 仓库自身目录（兜底，保证未配置时也能跑起来、不会崩）
//
// 注意：这里只负责「定位」，不负责「校验」。
// 校验（是否有 DeepSeek Harness.exe、qq-bridge 目录）在面板侧 index.js 完成，
// 避免同一套规则在两边各写一遍而产生偏差。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 仓库自身目录（本文件在 <repo>/tools/ 下） */
export const REPO_DIR = path.resolve(HERE, '..')

/** 保存面板所选工作区的配置文件 */
export const WORKSPACE_FILE = path.join(REPO_DIR, 'state', 'workspace.json')

/** 读已保存的工作区；没有/损坏都返回空字符串 */
export function readSavedWorkspace() {
  try {
    const raw = fs.readFileSync(WORKSPACE_FILE, 'utf8').replace(/^\uFEFF/, '')
    const doc = JSON.parse(raw)
    const v = typeof doc?.workspace === 'string' ? doc.workspace.trim() : ''
    return v ? path.resolve(v) : ''
  } catch {
    return ''
  }
}

/** 写工作区配置（原子写，先写 .tmp 再 rename） */
export function writeSavedWorkspace(dir) {
  const target = path.resolve(String(dir || ''))
  fs.mkdirSync(path.dirname(WORKSPACE_FILE), { recursive: true })
  const tmp = `${WORKSPACE_FILE}.tmp`
  const doc = { version: 1, workspace: target, updatedAt: Date.now() }
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8')
  fs.renameSync(tmp, WORKSPACE_FILE)
  return doc
}

/** 当前生效的工作区根目录 */
export function resolveWorkspaceRoot() {
  const env = String(process.env.AUTO_REPAIR_ROOT || '').trim()
  if (env) return path.resolve(env)
  const saved = readSavedWorkspace()
  if (saved) return saved
  return REPO_DIR
}

/** 给状态接口用：当前值 + 来源 + 是否还没配置 */
export function workspaceStatus() {
  const env = String(process.env.AUTO_REPAIR_ROOT || '').trim()
  const saved = readSavedWorkspace()
  const root = env ? path.resolve(env) : saved || ''
  return {
    root: root || '',
    resolved: resolveWorkspaceRoot(),
    source: env ? 'env' : saved ? 'config' : 'default',
    envRoot: env ? path.resolve(env) : '',
    saved,
    configFile: WORKSPACE_FILE,
    needsSetup: !env && !saved
  }
}
