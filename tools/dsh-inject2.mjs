import fs from 'node:fs'
import http from 'node:http'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire('D:\\大肥鱼\\qq-bridge\\package.json')
const YAML = require('js-yaml')

const PORT = Number(process.argv[2] || 5198)
const TARGET = process.argv[3] || 'http://127.0.0.1:63311/'
const HOST = '127.0.0.1'

const doc = YAML.load(fs.readFileSync('C:\\Users\\Administrator\\.dsh\\.credentials.yaml', 'utf8'))
const secret = Buffer.from(doc.records['client-connection/browser-session'].payload.secret.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
const b64u = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

function mint(authority) {
  const now = Date.now()
  const body = b64u(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 3600 * 1000 }), 'utf8'))
  const sig = b64u(crypto.createHmac('sha256', secret).update(body).digest())
  return { name: 'dsh-auth-' + b64u(crypto.createHash('sha256').update(authority).digest()), value: `v1.${body}.${sig}` }
}

const authority = new URL(TARGET).host
const good = mint(authority)
const stale = mint('127.0.0.1:50873')

const html = `<!doctype html><meta charset="utf-8"><title>DSH 会话注入 v2</title>
<body style="font:14px system-ui;padding:24px;background:#111;color:#eee">正在写入会话 Cookie 并跳转…</body>
<script>
// 1) 先过期掉所有同名变体（host-only + Domain），避免服务端按名字取到第一个匹配时拿到旧值
for (const nm of ${JSON.stringify([good.name, stale.name])}) {
  document.cookie = nm + "=; path=/; max-age=0";
  document.cookie = nm + "=; path=/; max-age=0; Domain=127.0.0.1";
}
// 2) 写入当前 authority 的有效 cookie（两种形态都写，保证服务端无论取到哪个都有效）
document.cookie = ${JSON.stringify(good.name + '=' + good.value)} + "; path=/; max-age=3600; SameSite=Lax";
document.cookie = ${JSON.stringify(good.name + '=' + good.value)} + "; path=/; max-age=3600; SameSite=Lax; Domain=127.0.0.1";
location.replace(${JSON.stringify(TARGET)});
</script>`

http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, no-cache, must-revalidate' })
  res.end(html)
}).listen(PORT, '127.0.0.1', () => {
  console.log(`injector v2 on http://127.0.0.1:${PORT}/ -> ${TARGET}`)
  console.log(`cookie: ${good.name}=${good.value}`)
})
