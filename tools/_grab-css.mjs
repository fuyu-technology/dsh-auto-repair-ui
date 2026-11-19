// Fetch the CSS assets DSH serves and print the rules that mention toBottom / shimmer.
import fs from 'node:fs';
import { mintBrowserSessionCookie, readBrowserSessionSecret } from './dsh-session.mjs';

const base = process.argv[2] || 'http://127.0.0.1:58579';
const secret = readBrowserSessionSecret();
const cookie = mintBrowserSessionCookie(base, secret);
const headers = { cookie: cookie.header, 'user-agent': 'Mozilla/5.0' };

const html = await (await fetch(base + '/', { headers: { ...headers, accept: 'text/html' } })).text();
const refs = [...html.matchAll(/(?:src|href)="([^"]+\.css[^"]*)"/g)].map((m) => m[1]);
console.log('css refs:', refs);

for (const ref of refs) {
  const url = ref.replace(/&amp;/g, '&').replace(/^\.\//, '/');
  const full = /^https?:/i.test(url) ? url : base + (url.charAt(0) === '/' ? url : '/' + url);
  const body = await (await fetch(full, { headers })).text();
  fs.writeFileSync('D:\\大肥鱼\\auto-repair\\tmp-core\\css-' + ref.split('/').pop().split('?')[0], body);
  console.log('saved', ref, body.length);
  for (const kw of ['toBottom', 'turnSpacer', 'chat-following-tail']) {
    const re = new RegExp('[^}]*' + kw.replace(/[-]/g, '\\-') + '[^}]*\\}', 'g');
    const hits = body.match(re) || [];
    console.log('--- ' + kw + ' (' + hits.length + ') ---');
    for (const h of hits.slice(0, 12)) console.log(h.trim());
  }
}
