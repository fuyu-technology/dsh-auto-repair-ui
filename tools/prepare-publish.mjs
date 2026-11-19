// 推 GitHub 前，把两个插件的 package.json 补上仓库元信息。
//
// 用法：
//   node prepare-publish.mjs --owner <你的 GitHub 用户名>
//   node prepare-publish.mjs --owner <用户名> --dry-run
//
// 幂等：重复跑不会重复插入。写文件一律用 Node（绝不写 BOM：带 BOM 会让 DSH 启动即崩）。
import fs from 'node:fs'
import path from 'node:path'

const PLUGINS = [
  {
    dir: 'D:\\大肥鱼\\auto-repair\\dsh-auto-repair-ui',
    name: 'dsh-auto-repair-ui',
    title: '自愈面板',
    descZh: 'DeepSeek Harness 插件：自愈守护进程的可视化面板——实时诊断结论、修复历史，一键手动修复。',
    descEn: 'DSH plugin: visual dashboard for a self-healing daemon — live diagnostics, repair history, one-click manual repair.'
  },
  {
    dir: 'D:\\大肥鱼\\需求箱\\dsh-box-ui',
    name: 'dsh-box-ui',
    title: '需求箱面板',
    descZh: 'DeepSeek Harness 插件：设置页里的留言箱——查看条目、改回执、回复、删除与新建。',
    descEn: 'DSH plugin: a triage inbox in the settings page — view, acknowledge, reply, remove and create items.'
  }
]

const args = process.argv.slice(2)
const ownerIdx = args.indexOf('--owner')
const owner = ownerIdx >= 0 ? String(args[ownerIdx + 1] || '').trim() : ''
const dryRun = args.includes('--dry-run')

if (!owner) {
  console.error('用法：node prepare-publish.mjs --owner <你的 GitHub 用户名>')
  process.exit(1)
}

for (const p of PLUGINS) {
  const file = path.join(p.dir, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  const repoUrl = `https://github.com/${owner}/${p.name}`

  pkg.description = `${p.descZh} | ${p.descEn}`
  pkg.repository = { type: 'git', url: `git+${repoUrl}.git` }
  pkg.homepage = `${repoUrl}#readme`
  pkg.bugs = { url: `${repoUrl}/issues` }
  pkg.keywords = [...new Set([...(pkg.keywords || []), 'batwing-tech'])]

  if (dryRun) {
    console.log(`--- ${p.name}（dry-run，未写入）`)
    console.log(JSON.stringify({
      name: pkg.name, version: pkg.version, description: pkg.description,
      repository: pkg.repository, homepage: pkg.homepage, bugs: pkg.bugs
    }, null, 2))
    continue
  }

  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n', 'utf8')

  // 自检：BOM / JSON 合法性 / 关键字段
  const buf = fs.readFileSync(file)
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  JSON.parse(buf.toString('utf8'))
  console.log(`✓ ${p.name}  bytes=${buf.length} bom=${bom}  repo=${repoUrl}`)
}

console.log(dryRun ? '\n（dry-run 结束）' : '\n完成。两个插件的 package.json 已更新。')
