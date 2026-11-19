// DSH 插件健康检查：一键跑完加载、路由、服务、工具调用四层验证。
// 用法：node check-plugins.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ASAR = 'D:\\大肥鱼\\resources\\app.asar';
const PROFILE = 'C:\\Users\\Administrator\\.dsh\\profiles\\desktop';
const USER_PLUGINS = 'C:\\Users\\Administrator\\.dsh\\plugins';
const BRIDGE_CFG = 'D:\\大肥鱼\\qq-bridge\\config.json';

const pass = [], fail = [], warn = [];
const ok = (m) => { pass.push(m); console.log('  ✅ ' + m); };
const bad = (m) => { fail.push(m); console.log('  ❌ ' + m); };
const mid = (m) => { warn.push(m); console.log('  ⚠️  ' + m); };

function get(port, p, headers = {}, timeoutMs = 4000) {
  return new Promise((res) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers, timeout: timeoutMs }, (r) => {
      let b = ''; r.on('data', (d) => (b += d));
      r.on('end', () => res({ code: r.statusCode, body: b }));
    });
    req.on('error', (e) => res({ code: 0, body: e.message }));
    req.on('timeout', () => { req.destroy(); res({ code: 0, body: 'TIMEOUT' }); });
  });
}
const j = (s) => { try { return JSON.parse(s); } catch { return null; } };

// ---------- 0. 定位当前 DSH 端口 ----------
console.log('\n[0] 环境定位');
let dshPort = 0;
try {
  const cfg = JSON.parse(fs.readFileSync(BRIDGE_CFG, 'utf8'));
  const m = String(cfg?.dsh?.baseUrl || cfg?.baseUrl || '').match(/:(\d+)/);
  if (m) dshPort = Number(m[1]);
} catch { /* 忽略 */ }
if (dshPort) ok(`DSH 端口 = ${dshPort}（取自 qq-bridge/config.json 的 dsh.baseUrl）`);
else bad('无法从 qq-bridge/config.json 定位 DSH 端口');

// DSH Web UI 需要会话 Cookie，铸一枚（复用 dsh-session.mjs）
let dshCookie = '';
try {
  const here = path.dirname(fileURLToPath(import.meta.url));
  dshCookie = execSync(
    `"${process.execPath}" "${path.join(here, 'dsh-session.mjs')}" --mint http://127.0.0.1:${dshPort}/`,
    { encoding: 'utf8', windowsHide: true }
  ).trim().split(/\r?\n/).pop();
  if (dshCookie) ok('已铸造 DSH 会话 Cookie');
  else mid('未能铸造会话 Cookie');
} catch (e) {
  mid('未能铸造会话 Cookie（' + String(e.message).split('\n')[0] + '）');
}

// ---------- 1. profile 完整性 ----------
console.log('\n[1] profile 完整性');
let pkg = null;
try {
  const buf = fs.readFileSync(path.join(PROFILE, 'package.json'));
  pkg = JSON.parse(buf.toString('utf8'));
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) bad('profile package.json 带 UTF-8 BOM（DSH 会启动即崩）');
  else ok('profile package.json 无 BOM');
  const bundles = pkg.dsh?.profile?.bundles || [];
  ok(`bundles ${bundles.length} 项：${bundles.map((b) => b.name || b).join(', ')}`);
} catch (e) {
  bad('profile package.json 读取/解析失败：' + e.message);
}

// ---------- 2. 用户插件落地 ----------
console.log('\n[2] 用户插件落地');
const expected = ['dsh-auto-repair-ui', 'dsh-box-ui', 'dsh-cyber-red-ui', 'dsh-startup-secret', 'qq-agent-presets', 'qq-mode-console'];
for (const n of expected) {
  const dir = path.join(USER_PLUGINS, n);
  const inNode = fs.existsSync(path.join(PROFILE, 'node_modules', n));
  const inBundle = pkg?.dsh?.profile?.bundles?.some((b) => (b.name || b) === n);
  if (fs.existsSync(dir) && inNode && inBundle) ok(`${n}：目录 ✓ node_modules ✓ bundles ✓`);
  else bad(`${n}：目录${fs.existsSync(dir) ? '✓' : '✗'} node_modules${inNode ? '✓' : '✗'} bundles${inBundle ? '✓' : '✗'}`);
}

// ---------- 3. DSH 路由与外部服务 ----------
console.log('\n[3] DSH 路由与外部服务');
if (dshPort) {
  const auth = dshCookie ? { cookie: dshCookie } : {};
  const root = await get(dshPort, '/', auth);
  root.code === 200 ? ok(`DSH 根页面 200（${root.body.length}B）`) : bad(`DSH 根页面 ${root.code}${dshCookie ? '' : '（无 Cookie）'}`);

  // 自愈面板的 /status 会现跑一轮诊断（本机 CIM 查询 ~3s），要给足超时
  const ar = await get(dshPort, '/dsh-auto-repair/status', auth, 20000);
  const arj = j(ar.body);
  if (ar.code === 200 && arj?.ok && arj.daemon?.alive) ok(`自愈面板路由 200，守护进程 alive pid=${arj.daemon.pid}，health=${arj.health}`);
  else bad(`自愈面板路由 ${ar.code} ${ar.body.slice(0, 80)}`);

  const bx = await get(dshPort, '/dsh-box/health', auth);
  const bxj = j(bx.body);
  if (bx.code === 200 && bxj?.ok) ok(`需求箱面板路由 200，服务 alive，端口 ${bxj.port}`);
  else bad(`需求箱面板路由 ${bx.code} ${bx.body.slice(0, 80)}`);

  const items = await get(dshPort, '/dsh-box/items', auth);
  const ij = j(items.body);
  if (items.code === 200 && ij?.ok) ok(`需求箱数据可读，${ij.items?.length ?? 0} 条留言`);
  else bad(`需求箱数据 ${items.code}`);
}

for (const [port, name, tokenFile, hdr] of [
  [3200, '需求箱服务', 'D:\\大肥鱼\\需求箱\\state\\box-token', 'x-box-token'],
  [3100, 'QQ 桥接', 'D:\\大肥鱼\\qq-bridge\\state\\console-token', 'x-console-token'],
]) {
  const path_ = name === '需求箱服务' ? '/api/box' : '/api/status';
  const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
  const r = await get(port, path_, token ? { [hdr]: token } : {});
  const rj = j(r.body);
  if (r.code === 200 && rj?.ok !== false) ok(`${name} :${port} 200`);
  else bad(`${name} :${port} ${r.code} ${r.body.slice(0, 80)}`);
}

// 桥接与 DSH 的连通
try {
  const ct = fs.readFileSync('D:\\大肥鱼\\qq-bridge\\state\\console-token', 'utf8').trim();
  const st = j((await get(3100, '/api/status', { 'x-console-token': ct })).body);
  st?.dshReady ? ok(`桥接已连上 DSH（dshReady=true）`) : bad('桥接 dshReady=false');
  st?.snowluma?.connected ? ok('SnowLuma MCP 已连接') : mid('SnowLuma connected=' + st?.snowluma?.connected);
} catch { /* 忽略 */ }

// ---------- 4. 历史会话里的真实工具调用 ----------
console.log('\n[4] 历史会话工具调用（最能说明“能不能用”）');
const SESS = 'C:\\Users\\Administrator\\.dsh\\sessions';
const stats = new Map();
let sessions = 0, events = 0;
function note(name, isErr) {
  if (!name) return;
  if (!stats.has(name)) stats.set(name, { c: 0, e: 0 });
  const s = stats.get(name); s.c++; if (isErr) s.e++;
}
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.zstd')) {
      let lines;
      try { lines = zlib.zstdDecompressSync(fs.readFileSync(p)).toString('utf8').split('\n').filter((x) => x.trim()); }
      catch { return; }
      sessions++;
      for (const l of lines) {
        events++;
        let ev; try { ev = JSON.parse(l); } catch { continue; }
        const t = ev.type, dta = ev.data || {};
        if (t === 'tool/call') note(dta.name || dta.toolName || dta.tool || (dta.input && dta.input.name), false);
        if (t === 'tool/result') {
          const m = dta.message || {};
          const nm = dta.name || dta.toolName || dta.tool || (m.source && m.source.name);
          note(nm, m.isError === true || !!dta.error);
        }
      }
    }
  }
})(SESS);

const totalCalls = [...stats.values()].reduce((n, s) => n + s.c, 0);
const totalErr = [...stats.values()].reduce((n, s) => n + s.e, 0);
const top = [...stats.entries()].sort((a, b) => b[1].c - a[1].c).slice(0, 8);
ok(`扫描 ${sessions} 个会话 / ${events} 条事件：${totalCalls} 次工具调用，${stats.size} 个工具，失败 ${totalErr} 次`);
for (const [n, s] of top) console.log(`       ${n.padEnd(42)} ${String(s.c).padStart(4)} 次  失败 ${s.e}`);

// ---------- 5. 崩溃日志（与本次运行对比） ----------
console.log('\n[5] 崩溃日志');
const crashDir = 'C:\\Users\\Administrator\\AppData\\Roaming\\@deepseek-ai\\dsh-desktop\\logs';
// 当前 DSH 主进程启动时间
let dshStart = 0;
try {
  const out = execSync(
    '(Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1).StartTime.ToUniversalTime().ToString("o")',
    { encoding: 'utf8', shell: 'powershell.exe', windowsHide: true }
  ).trim();
  if (out) dshStart = new Date(out).getTime();
} catch { /* 忽略 */ }
if (fs.existsSync(crashDir)) {
  const crashes = fs.readdirSync(crashDir).filter((f) => f.startsWith('crash-'))
    .map((f) => ({ f, t: fs.statSync(path.join(crashDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  const latest = crashes[0];
  if (!latest) ok('没有任何崩溃日志');
  else if (dshStart && latest.t < dshStart) {
    ok(`本次运行（${new Date(dshStart).toLocaleTimeString('zh-CN')} 启动）零崩溃；最近一次崩溃 ${latest.f} 早于本次启动，属历史遗留`);
  } else {
    bad(`本次运行期间有崩溃：${latest.f}`);
  }
} else ok('无崩溃日志目录');

// ---------- 汇总 ----------
console.log('\n' + '='.repeat(56));
console.log(`通过 ${pass.length} · 警告 ${warn.length} · 失败 ${fail.length}`);
if (fail.length) { console.log('\n失败项：'); fail.forEach((f) => console.log('  - ' + f)); }
process.exit(fail.length ? 1 : 0);
