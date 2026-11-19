// 通过 GitHub REST API 把两个 DSH 插件发布到 GitHub。
//
// 不用 git、不用浏览器登录。令牌从**文件**读，不走命令行参数、也不进对话。
//
// 用法：
//   node publish-github-api.mjs --token-file D:\大肥鱼\.github-token --dry-run
//   node publish-github-api.mjs --token-file D:\大肥鱼\.github-token --public
//   node publish-github-api.mjs --token-file D:\大肥鱼\.github-token --private
//
// 令牌怎么拿：
//   GitHub → Settings → Developer settings → Personal access tokens → Fine-grained
//   → Generate new token → 勾选 Repository access 里的那两个仓库（或 All repositories）
//   → Permissions → Repository permissions → Contents: Read and write
//   → 复制那串 token，存到 D:\大肥鱼\.github-token（纯文本，一行）
//
// ⚠️ 别把 token 存进插件目录里，那样会被传到 GitHub 上。

import fs from 'node:fs'
import path from 'node:path'

const PLUGINS = [
  {
    dir: 'D:\\大肥鱼\\auto-repair\\dsh-auto-repair-ui',
    name: 'dsh-auto-repair-ui',
    description: 'DeepSeek Harness 插件：自愈守护进程的可视化面板——实时诊断结论、修复历史，一键手动修复。',
    homepage: 'https://github.com/fuyu-technology/dsh-auto-repair-ui#readme',
    topics: ['deepseek-harness', 'dsh', 'dsh-plugin', 'cordis', 'self-healing', 'observability', 'dashboard', 'batwing-tech']
  },
  {
    dir: 'D:\\大肥鱼\\需求箱\\dsh-box-ui',
    name: 'dsh-box-ui',
    description: 'DeepSeek Harness 插件：设置页里的留言箱——查看条目、改回执、回复、删除与新建。',
    homepage: 'https://github.com/fuyu-technology/dsh-box-ui#readme',
    topics: ['deepseek-harness', 'dsh', 'dsh-plugin', 'cordis', 'inbox', 'triage', 'chatops', 'batwing-tech']
  }
]

const OWNER = 'fuyu-technology'
const API = 'https://api.github.com'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? String(args[i + 1] ?? '').trim() : fallback
}
const tokenFile = arg('--token-file', 'D:\\大肥鱼\\.github-token')
const dryRun = args.includes('--dry-run')
const isPrivate = args.includes('--private')
const visibility = isPrivate ? 'private' : 'public'

// ── 令牌 ────────────────────────────────────────────────────────────────────
let token = ''
try {
  token = fs.readFileSync(tokenFile, 'utf8').trim()
} catch (e) {
  console.error(`✗ 读不到令牌文件：${tokenFile}\n  ${e.message}`)
  console.error('  先在 GitHub 生成 PAT 并存进这个文件（一行纯文本）。')
  process.exit(1)
}
if (!token) {
  console.error(`✗ 令牌文件是空的：${tokenFile}`)
  process.exit(1)
}

const headers = {
  'Authorization': `Bearer ${token}`,
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'mavis-publish-dsh-plugins',
  'Content-Type': 'application/json'
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
  return { status: res.status, ok: res.ok, data }
}

// ── 收集要传的文件 ───────────────────────────────────────────────────────────
function collectFiles(dir) {
  const out = []
  const walk = (d, rel) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name)
      const r = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) { walk(abs, r); continue }
      if (!entry.isFile()) continue
      out.push({ path: r, abs })
    }
  }
  walk(dir, '')
  return out
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
console.log(`仓库归属：${OWNER}   可见性：${visibility}${dryRun ? '   [dry-run]' : ''}\n`)

for (const p of PLUGINS) {
  const files = collectFiles(p.dir)
  console.log(`=== ${p.name}  (${files.length} 个文件)`)

  if (dryRun) {
    for (const f of files) console.log(`    ${f.path}  ${fs.statSync(f.abs).size} B`)
    console.log('')
    continue
  }

  // 1) 建仓（已存在就复用）
  const repoUrl = `https://github.com/${OWNER}/${p.name}`
  let created = false
  let createRes = await api('POST', `${API}/user/repos`, {
    name: p.name,
    description: p.description,
    homepage: p.homepage,
    private: isPrivate,
    auto_init: true            // 先给一个初始 commit，否则 contents API 没有分支可写
  })
  if (createRes.status === 201) {
    created = true
    console.log(`    ✓ 已创建仓库 ${repoUrl}`)
  } else if (createRes.status === 422) {
    console.log(`    · 仓库已存在，复用`)
  } else {
    console.error(`    ✗ 建仓失败：${createRes.status} ${JSON.stringify(createRes.data).slice(0, 300)}`)
    console.error('      （令牌权限不够？或者名字被占了？）')
    continue
  }

  // 2) 传文件（contents API 支持带斜杠的路径，locale/ 子目录天然保留）
  let okCount = 0
  let failCount = 0
  for (const f of files) {
    const content = fs.readFileSync(f.abs).toString('base64')
    const body = { message: `feat: add ${f.path}`, content, branch: 'main' }
    let res = await api('PUT', `${API}/repos/${OWNER}/${p.name}/contents/${f.path}`, body)
    if (res.status === 422 && res.data?.errors) {
      // 已存在（可能是仓库自带的 README）：取 sha 再覆盖
      const get = await api('GET', `${API}/repos/${OWNER}/${p.name}/contents/${f.path}?ref=main`)
      if (get.ok && get.data?.sha) {
        res = await api('PUT', `${API}/repos/${OWNER}/${p.name}/contents/${f.path}`, { ...body, sha: get.data.sha })
      }
    }
    if (res.ok) { okCount++; console.log(`    ✓ ${f.path}`) }
    else { failCount++; console.error(`    ✗ ${f.path}  ${res.status} ${JSON.stringify(res.data).slice(0, 200)}`) }
  }
  console.log(`    → 成功 ${okCount}，失败 ${failCount}`)

  // 3) 简介 / 主页 / Topics
  const patch = await api('PATCH', `${API}/repos/${OWNER}/${p.name}`, {
    description: p.description,
    homepage: p.homepage,
    private: isPrivate
  })
  console.log(patch.ok ? '    ✓ 简介/主页已设置' : `    ! 简介设置失败：${patch.status}`)

  const topics = await api('PUT', `${API}/repos/${OWNER}/${p.name}/topics`, { names: p.topics })
  console.log(topics.ok ? `    ✓ Topics：${p.topics.join(' ')}` : `    ! Topics 设置失败：${topics.status} ${JSON.stringify(topics.data).slice(0, 160)}`)

  console.log(`    → ${repoUrl}${created ? ' （新建）' : '（已存在）'}\n`)
}

console.log(dryRun ? 'dry-run 结束，未做任何改动。' : '全部完成。')
