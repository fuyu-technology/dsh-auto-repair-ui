// DSH 浏览器会话 Cookie 铸造 / 注入工具（临时排障用）。
//
// 背景：DSH 的 Web UI 需要 `dsh-auth-<base64url(sha256(authority))>` Cookie 才能访问，
// 而浏览器里没有这个 Cookie 就没有「设置页」。DSH 的进程启动 token 只存在内存，
// 不可推导；但 `~/.dsh/.credentials.yaml` 里有一份**持久化**的
// `client-connection/browser-session` 签名密钥（32 字节），可以用它离线 HMAC 铸造
// 合法 Cookie。算法与 DSH 服务端一致：
//   name   = 'dsh-auth-' + base64url(sha256(authority))
//   body   = base64url(JSON{version,authority,issuedAt,expiresAt})
//   value  = 'v1.' + body + '.' + base64url(HMAC-SHA256(secret, body))
//
// 用法：
//   node dsh-session.mjs --mint [baseUrl]        # 打印 Cookie 串（name=value）
//   node dsh-session.mjs --serve <port> <target> # 起一个小页面写 Cookie 后跳转 target
//
// --serve 的原理：Cookie 只按 host+path 匹配，**不含端口**。所以在
// http://127.0.0.1:<port> 写下的 cookie，浏览器访问 http://127.0.0.1:50873 时会自动带上。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash, createHmac } from 'node:crypto';

const require = createRequire('D:\\大肥鱼\\qq-bridge\\package.json');
const YAML = require('js-yaml');

const COOKIE_PREFIX = 'dsh-auth-';
const SECRET_BYTES = 32;
const LIFETIME_MS = 60 * 60 * 1000;

const base64url = (buf) => Buffer.from(buf).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

export function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function readBrowserSessionSecret() {
  try {
    const doc = YAML.load(fs.readFileSync(path.join(resolveDshHome(), '.credentials.yaml'), 'utf8'));
    const record = doc?.records?.['client-connection/browser-session'];
    if (record?.kind !== 'grant' || record?.payload?.version !== 1) return null;
    const secret = record.payload.secret;
    if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]+$/.test(secret)) return null;
    const decoded = Buffer.from(secret.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
    return decoded.byteLength === SECRET_BYTES ? decoded : null;
  } catch {
    return null;
  }
}

export function mintBrowserSessionCookie(baseUrl, secret, lifetimeMs = LIFETIME_MS) {
  const authority = new URL(String(baseUrl)).host;
  const issuedAt = Date.now();
  const expiresAt = issuedAt + lifetimeMs;
  const body = base64url(Buffer.from(JSON.stringify({
    version: 1, authority, issuedAt, expiresAt,
  }), 'utf8'));
  const signature = base64url(createHmac('sha256', secret).update(body).digest());
  const name = COOKIE_PREFIX + base64url(createHash('sha256').update(authority).digest());
  return { name, value: `v1.${body}.${signature}`, header: `${name}=v1.${body}.${signature}` };
}

function main() {
  const argv = process.argv.slice(2);
  const baseUrl = argv.find((a) => a.startsWith('http')) || 'http://127.0.0.1:50873';
  const secret = readBrowserSessionSecret();
  if (!secret) {
    console.error('无法读取 browser-session 密钥');
    process.exit(2);
  }
  const cookie = mintBrowserSessionCookie(baseUrl, secret);

  if (argv.includes('--serve')) {
    const port = Number(argv[argv.indexOf('--serve') + 1]) || 5199;
    const target = argv[argv.indexOf('--serve') + 2] || `${baseUrl}/`;
    // Cookie 名是 authority 的哈希，服务端按名字从 Cookie 头里取第一个匹配项。
    // 浏览器里若残留同名但带 Domain 属性的旧 cookie（host-only 与 Domain 是两条不同的
    // cookie），服务端可能取到旧的那条并判定签名不合法 → 401。这里把两种形态都覆盖掉。
    const serveCookie = mintBrowserSessionCookie(target, secret);
    const staleNames = [cookie.name, serveCookie.name]
      .filter((n, i, a) => a.indexOf(n) === i)
      .map((n) => JSON.stringify(n));
    const setBoth = [
      JSON.stringify(`${serveCookie.name}=${serveCookie.value}; path=/; max-age=3600; SameSite=Lax`),
      JSON.stringify(`${serveCookie.name}=${serveCookie.value}; path=/; max-age=3600; SameSite=Lax; Domain=127.0.0.1`)
    ];
    const html = `<!doctype html><meta charset="utf-8"><title>DSH 会话注入</title>
<body style="font:14px system-ui;padding:24px">正在写入会话 Cookie 并跳转…</body>
<script>
for (const nm of ${JSON.stringify(staleNames)}) {
  document.cookie = nm + "=; path=/; max-age=0";
  document.cookie = nm + "=; path=/; max-age=0; Domain=127.0.0.1";
}
document.cookie = ${setBoth[0]};
document.cookie = ${setBoth[1]};
location.replace(${JSON.stringify(target)});
</script>`;
    http.createServer((req, res) => {
      if (req.url.startsWith('/cookie')) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(serveCookie.header);
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store, no-cache, must-revalidate'
      });
      res.end(html);
    }).listen(port, '127.0.0.1', () => {
      console.log(`cookie-injector listening on http://127.0.0.1:${port}/ -> ${target}`);
    });
    return;
  }

  console.log(cookie.header);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
