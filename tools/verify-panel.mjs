// 自愈面板一键验收：DSH 端口 → 会话 Cookie → 插件 API → 客户端 bundle → 桥接状态。
// 用法：node verify-panel.mjs [dshPort]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const NODE = 'D:\\大肥鱼\\SnowLuma\\node.exe';
const PORT = Number(process.argv[2]) || 50873;
const BASE = `http://127.0.0.1:${PORT}/`;

const cookie = execFileSync(NODE, ['D:\\大肥鱼\\auto-repair\\tools\\dsh-session.mjs', '--mint', BASE], { encoding: 'utf8' }).trim();

async function get(u) {
  // 注意：DSH 的插件 bundle URL 形如 `plugins/??a/client.js,b/client.js&rev=xxx`，
  // 里面的 `?` 会被 URL 解析成 query 起始符。用字符串拼接原样请求，
  // 才和浏览器实际发起的请求一致（new URL() 会重新编码，导致 404）。
  const url = u.startsWith('http')
    ? u
    : u.startsWith('plugins/')
      ? BASE.replace(/\/$/, '') + '/' + u
      : new URL(u, BASE).href;
  const res = await fetch(url, { headers: { Cookie: cookie } });
  return { status: res.status, text: await res.text() };
}

const line = (s) => console.log(s);

// 1. 根页面可达？
const root = await get('/');
line(`[1] 根页面            ${root.status}  ${root.text.length}B`);

// 2. 插件宿主 API
for (const p of ['/dsh-auto-repair/status', '/dsh-auto-repair/diagnose', '/dsh-auto-repair/history']) {
  const r = await get(p);
  let note = '';
  if (r.status === 200) {
    try {
      const j = JSON.parse(r.text);
      note = Object.keys(j).slice(0, 6).join(',');
      if (j.daemon) note += ` | daemon.alive=${j.daemon.alive} pid=${j.daemon.pid}`;
      if (j.health) note += ` | health=${j.health}`;
    } catch { note = '(非 JSON)'; }
  }
  line(`[2] ${p.padEnd(30)} ${r.status}  ${note}`);
}

// 3. 已部署的插件 client 文件是否包含预期标记
// （DSH 把插件 client 打包成带 rev 的内存 bundle，直接抓 URL 不可靠；
//   校验「磁盘上的部署件 + DSH 已重启」更稳定，视觉渲染另行人工/浏览器确认。）
try {
  const p = 'C:\\Users\\Administrator\\.dsh\\plugins\\dsh-auto-repair-ui\\client.js';
  const buf = readFileSync(p);
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const s = buf.toString('utf8');
  const marks = {
    '主按钮令牌': s.includes('button-primary-fill'),
    '面板文案': s.includes('立即诊断并修复'),
    '无BOM': !bom,
  };
  line(`[3] 已部署 client.js   ${buf.length}B  ${Object.entries(marks).map(([k, v]) => `${k}=${v ? '✓' : '✗'}`).join(' ')}`);
} catch (e) {
  line(`[3] 读取已部署 client.js 失败: ${e.message}`);
}

// 4. 桥接状态
try {
  const token = execFileSync('cmd', ['/c', 'type', 'D:\\大肥鱼\\qq-bridge\\state\\console-token'], { encoding: 'utf8' }).trim();
  const r = await fetch('http://127.0.0.1:3100/api/status', { headers: { 'x-console-token': token } });
  const j = await r.json();
  line(`[4] 桥接               ${r.status}  dshReady=${j.dshReady} snowluma=${j.snowluma?.connected} degraded=${j.degraded}`);
} catch (e) {
  line(`[4] 桥接检查失败: ${e.message}`);
}

// 5. auto-repair 守护进程
try {
  const r = await get('/dsh-auto-repair/status');
  const j = JSON.parse(r.text);
  line(`[5] 面板 status 摘要   health=${j.health} fatal=${j.counts?.fatal} warn=${j.counts?.warn} info=${j.counts?.info} history=${j.history?.length} log=${j.log?.length}`);
} catch (e) {
  line(`[5] ${e.message}`);
}
