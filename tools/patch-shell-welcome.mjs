// 给 DSH 桌面壳打一个「原地、同长度」的补丁，修复 welcome 认证失败。
//
// 背景（2026-11-04 实测闭环）：
//   桌面壳用两套不同的 HTTP 客户端打同一个 Host launch URL：
//     1) authenticateWebHost()  —— Node/undici 的全局 fetch，redirect:"manual"
//        → 拿到 303 + Set-Cookie（dsh-auth-<base64url>=签名值，绑定 authority，
//          带 issuedAt/expiresAt，无法预置），返回 "name=value" 存进 hostCookie。
//     2) connectDesktopWelcome() —— 用传进来的 send()，而调用处传的是
//        (input, init) => net.fetch(input, init)，也就是 Electron 的 net.fetch。
//        Electron 文档：net.fetch 默认**不发** session cookie（useSessionCookies
//        默认 false；一旦指定 credentials，该选项失效）。
//        → 303 跟随后访问 / 不带 cookie → Host 返回 401
//        → "desktop welcome: Web authentication failed" → 整个桌面壳退出。
//
//   也就是说：cookie 在第 1 步拿到了，却没有任何机制交给第 2 步。
//   本补丁让 send() 把 hostCookie 显式放进请求头，并改用全局 fetch（undici）——
//   实测 undici 手动带 cookie 头跟随后返回 200；Chromium 的 cookie jar 不会
//   干扰这��请求。
//
// 做法：在 app.asar 内定位 lib/main.js，把那段箭头函数换成会带上 hostCookie 的版本。
//   ★ 必须保持**文件长度完全不变** —— asar 内部靠偏移量寻址，改长度就必须整包重打，
//     风险太高。长度差用「修剪一段注释」补平。
//
// 用法:
//   node patch-shell-welcome.mjs <app.asar> [--dry]
//   node patch-shell-welcome.mjs <app.asar> --restore <备份文件>
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const asarPath = argv.find((a) => !a.startsWith('--') && a.endsWith('.asar'))
const dry = argv.includes('--dry')
const restoreIdx = argv.indexOf('--restore')
const restoreFile = restoreIdx >= 0 ? argv[restoreIdx + 1] : undefined
if (!asarPath) { console.error('用法: node patch-shell-welcome.mjs <app.asar> [--dry] [--restore <备份>]'); process.exit(2) }

// ── 读 asar 头 ────────────────────────────────────────────────────────────────
const fd = fs.openSync(asarPath, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(4)
const strLen = head.readUInt32LE(12)
const headerBuf = Buffer.alloc(strLen)
fs.readSync(fd, headerBuf, 0, strLen, 16)
const header = JSON.parse(headerBuf.toString('utf8'))
const base = 8 + headerSize

let node = header
for (const seg of 'lib/main.js'.split('/')) node = node.files[seg]
const offset = base + Number(node.offset)
const size = Number(node.size)

const readFile = () => {
  const buf = Buffer.alloc(size)
  fs.readSync(fd, buf, 0, size, offset)
  return buf
}

// ── 还原模式 ──────────────────────────────────────────────────────────────────
if (restoreFile) {
  const original = fs.readFileSync(restoreFile)
  if (original.length !== size) { console.error(`备份长度 ${original.length} != 期望 ${size}`); process.exit(3) }
  fs.writeSync(fd, original, 0, original.length, offset)
  fs.closeSync(fd)
  console.log(`✅ 已从备份还原 lib/main.js（偏移 ${offset}，长度 ${size}）`)
  process.exit(0)
}

// ── 读 lib/main.js ───────────────────────────────────────────────────────────
const buf = readFile()
fs.closeSync(fd)
const src = buf.toString('utf8')

const OLD = '(input, init) => net.fetch(input, init)'
const NEW = '(i,n)=>fetch(i,{...n,headers:{cookie:hostCookie,...n?.headers}})'

const hits = src.split(OLD).length - 1
if (hits !== 1) { console.error(`锚点出现 ${hits} 次（期望 1 次），中止`); process.exit(4) }

// 长度差：NEW 比 OLD 长多少，就要从注释里省出多少字节
const delta = Buffer.byteLength(NEW, 'utf8') - Buffer.byteLength(OLD, 'utf8')
console.log(`锚点唯一 ✅  补丁净增 ${delta} 字节，需要从注释里省出同等长度`)

// 被改写的注释行：这一行本来就在描述 send()，改完正好更准确
const OLD_DOC = '* @param send - Electron session fetch, retaining the Web authentication cookie.'
if (src.split(OLD_DOC).length - 1 !== 1) { console.error('注释锚点不唯一，中止'); process.exit(5) }

const DOC_KEEP = '* @param send - fetch carrying the Host authentication cookie.'
const targetLen = OLD_DOC.length - delta

let newDoc = DOC_KEEP
if (newDoc.length > targetLen) {
  // 截到词边界
  const cut = newDoc.slice(0, targetLen)
  const sp = cut.lastIndexOf(' ')
  newDoc = (sp > 0 ? cut.slice(0, sp) : cut).padEnd(targetLen, ' ')
} else {
  newDoc = newDoc.padEnd(targetLen, ' ')
}
if (Buffer.byteLength(newDoc, 'utf8') !== targetLen) { console.error('注释长度计算错误'); process.exit(6) }

const patched = src.replace(OLD, NEW).replace(OLD_DOC, newDoc)
const out = Buffer.from(patched, 'utf8')
if (out.length !== size) { console.error(`长度校验失败：${out.length} != ${size}（补丁会破坏 asar 偏移寻址）`); process.exit(7) }

// 确认只有这两处变化
const changed = (() => {
  let n = 0
  for (let i = 0; i < size; i++) if (out[i] !== buf[i]) n++
  return n
})()
console.log(`替换后长度一致 ✅  实际变动 ${changed} 字节`)

// ── 语法自检 ──────────────────────────────────────────────────────────────────
const tmp = path.join(path.dirname(asarPath), '.tmp-patched-main.mjs')
fs.writeFileSync(tmp, out)
console.log(`语法自检文件: ${tmp}`)

if (dry) { console.log('[dry-run] 未写回 app.asar'); process.exit(0) }

// ── 备份原件（回滚用） ───────────────────────────────────────────────────────
const backupDir = 'D:\\大肥鱼\\backups\\app-asar'
fs.mkdirSync(backupDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupFile = path.join(backupDir, `lib-main.js.${stamp}.orig`)
fs.writeFileSync(backupFile, buf)
console.log(`✅ 已备份原始 lib/main.js -> ${backupFile}`)

// ── 原地写回（同偏移、同长度，不动 asar 结构） ───────────────────────────────
const wfd = fs.openSync(asarPath, 'r+')
fs.writeSync(wfd, out, 0, out.length, offset)
fs.closeSync(wfd)
console.log(`✅ 已写回 app.asar（lib/main.js，偏移 ${offset}，长度 ${size} 不变）`)
console.log(`   还原命令: node patch-shell-welcome.mjs "${asarPath}" --restore "${backupFile}"`)
