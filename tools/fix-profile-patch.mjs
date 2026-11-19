// 修复 DSH 的 MCP 注册（两层都补）：
//   1) bundle 层（权威）：plugins/qq-agent-presets/bridge.patch.yml
//   2) profile 层（热备）：profiles/desktop/cordis.patch.yml
// 全部用文本插入，不重新序列化 YAML —— 保留原注释与格式。
// 幂等：重复跑不会重复插入。写入无 BOM，写前自动备份。
import path from 'node:path'
import { ensureBundlePatch, ensureProfilePatch } from './mcp-registration.mjs'

const BUNDLE = 'D:\\大肥鱼\\qq-bridge\\plugins\\qq-agent-presets\\bridge.patch.yml'
const PROFILE = path.join(
  process.env.USERPROFILE || 'C:\\Users\\Administrator',
  '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'
)

let touched = false

const b = ensureBundlePatch(BUNDLE)
console.log(`bundle 层：${b.reason}`)
if (b.changed) touched = true

const p = ensureProfilePatch(PROFILE)
console.log(`profile 层：${p.reason}`)
if (p.changed) touched = true

if (!touched) {
  console.log('MCP 注册已是规范状态，无需改动。')
  process.exit(0)
}
console.log('提醒：bundle 层在 DSH 下次启动时生效；profile 层若支持热重载则立即生效。')
