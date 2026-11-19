// Trace what toggles scroll.followingTail -> the "jump to latest" FAB appearing/disappearing.
const base = process.argv[2] || 'http://127.0.0.1:58579';
const cookie = process.argv[3] || '';
const H = { cookie, accept: 'text/html', 'user-agent': 'Mozilla/5.0' };

const html = await (await fetch(base + '/', { headers: H })).text();
const srcs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((s) => s.indexOf('client.js') > -1);
const toUrl = (u) => {
  const c = u.replace(/&amp;/g, '&').replace(/^\.\//, '/');
  return /^https?:/i.test(c) ? c : base + (c.charAt(0) === '/' ? c : '/' + c);
};

for (const s of srcs) {
  let js = '';
  try { js = await (await fetch(toUrl(s), { headers: { cookie } })).text(); } catch { continue; }
  if (js.length < 100000) continue;
  console.log('### bundle bytes', js.length);

  const hits = [];
  let i = -1;
  while ((i = js.indexOf('followingTail', i + 1)) !== -1) hits.push(i);
  console.log('followingTail hits:', hits.length);
  for (const k of hits) {
    console.log('--- @' + k + ' ---');
    console.log(js.slice(Math.max(0, k - 380), k + 380).replace(/\s+/g, ' '));
  }

  console.log('\n=== composer height var ===');
  const hits2 = [];
  let j = -1;
  while ((j = js.indexOf('--dsh-composer-height', j + 1)) !== -1) hits2.push(j);
  console.log('hits', hits2.length);
  for (const k of hits2.slice(0, 6)) {
    console.log('--- @' + k + ' ---');
    console.log(js.slice(Math.max(0, k - 300), k + 300).replace(/\s+/g, ' '));
  }
  break;
}
