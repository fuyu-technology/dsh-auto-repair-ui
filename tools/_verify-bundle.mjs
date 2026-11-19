import { mintBrowserSessionCookie, readBrowserSessionSecret } from './dsh-session.mjs';

const base = process.argv[2] || 'http://127.0.0.1:54023';
const secret = readBrowserSessionSecret();
const cookie = mintBrowserSessionCookie(base, secret);
const headers = { cookie: cookie.header, 'user-agent': 'Mozilla/5.0' };

const html = await (await fetch(base + '/', { headers: { ...headers, accept: 'text/html' } })).text();
const refs = [...html.matchAll(/(?:src|href)="([^"]+\.js[^"]*)"/g)].map((m) => m[1]);
const toUrl = (u) => {
  const c = u.replace(/&amp;/g, '&').replace(/^\.\//, '/');
  return /^https?:/i.test(c) ? c : base + (c.charAt(0) === '/' ? c : '/' + c);
};

const marks = {
  'toBottom guard installed': 0,
  'makeToBottomGuard': 0,
  'overflow-anchor: none !important': 0,
  '_sweep_1rdzk_34': 0,
  'data-phase': 0
};

for (const ref of refs) {
  const url = toUrl(ref);
  const body = await (await fetch(url, { headers })).text();
  const hits = {};
  for (const k of Object.keys(marks)) {
    const n = (body.match(new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    if (n > 0) hits[k] = n;
  }
  if (Object.keys(hits).length) {
    console.log(ref.split('?')[0], JSON.stringify(hits));
    for (const k of Object.keys(marks)) marks[k] += hits[k] || 0;
  }
}
console.log('TOTAL', JSON.stringify(marks));
