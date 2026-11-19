// Dump every JS asset DSH serves (core app bundle + plugin bundles) to local disk
// so the real scroll / followingTail logic can be analyzed offline.
import fs from 'node:fs';
import path from 'node:path';
import { mintBrowserSessionCookie, readBrowserSessionSecret } from './dsh-session.mjs';

const base = process.argv[2] || 'http://127.0.0.1:58579';
const secret = readBrowserSessionSecret();
if (!secret) {
  console.error('no browser-session secret');
  process.exit(2);
}
const cookie = mintBrowserSessionCookie(base, secret);
const headers = { cookie: cookie.header, 'user-agent': 'Mozilla/5.0' };

const outDir = 'D:\\大肥鱼\\auto-repair\\tmp-core';
fs.mkdirSync(outDir, { recursive: true });

const pageRes = await fetch(base + '/', { headers: { ...headers, accept: 'text/html' } });
const pageHtml = await pageRes.text();
const refs = [...pageHtml.matchAll(/(?:src|href)="([^"]+\.js[^"]*)"/g)].map((m) => m[1]);
console.log('js refs:', refs.length);

function toUrl(u) {
  const c = u.replace(/&amp;/g, '&').replace(/^\.\//, '/');
  return /^https?:/i.test(c) ? c : base + (c.charAt(0) === '/' ? c : '/' + c);
}

const manifest = [];
for (let i = 0; i < refs.length; i++) {
  const url = toUrl(refs[i]);
  const rawName = refs[i].split('/').pop().split('?')[0];
  const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const file = path.join(outDir, i + '-' + safeName);
  try {
    const res = await fetch(url, { headers });
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(file, buf);
    const body = buf.toString('utf8');
    const tail = (body.match(/followingTail/g) || []).length;
    manifest.push({ i, rawName, bytes: buf.length, tail, file });
  } catch (err) {
    manifest.push({ i, rawName, bytes: -1, tail: -1, file, error: String(err) });
  }
}
for (const m of manifest) console.log(JSON.stringify(m));
