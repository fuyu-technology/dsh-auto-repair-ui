// 生成 DSH 全部插件清单（markdown）。
// 数据源：app.asar 内各 bundle 的 cordis.patch.yml + 各插件包的 locale/zh.json，
//          加上 profile 自身的 cordis.patch.yml 与 ~/.dsh/plugins 下的用户插件。
// 用法：node list-plugins.mjs [输出文件]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readAsar } from './asar-read.mjs';

const ASAR = 'D:\\大肥鱼\\resources\\app.asar';
const PROFILE = 'C:\\Users\\Administrator\\.dsh\\profiles\\desktop';
const USER_PLUGINS = 'C:\\Users\\Administrator\\.dsh\\plugins';
const OUT = process.argv[2] || 'D:\\大肥鱼\\auto-repair\\state\\plugins-list.md';

const asar = readAsar(ASAR);
const asarFiles = asar.files.map((f) => f.path);
const readAsarText = (p) => {
  try { return asar.read(p).toString('utf8'); } catch { return null; }
};

// ---------- 1. 收集每个插件包的中文元信息 ----------
const zhMeta = new Map(); // pkgName -> {title, description}
for (const p of asarFiles) {
  const m = p.match(/^dsh\/node_modules\/(@deepseek-ai\/[^/]+|[^/]+)\/locale\/zh\.json$/);
  if (!m) continue;
  try {
    const j = JSON.parse(readAsarText(p));
    zhMeta.set(m[1], { title: j.meta?.title || '', description: j.meta?.description || '' });
  } catch { /* 忽略解析失败 */ }
}
for (const dir of fs.existsSync(USER_PLUGINS) ? fs.readdirSync(USER_PLUGINS) : []) {
  const f = path.join(USER_PLUGINS, dir, 'locale', 'zh.json');
  if (!fs.existsSync(f)) continue;
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    zhMeta.set(dir, { title: j.meta?.title || '', description: j.meta?.description || '' });
  } catch { /* 忽略 */ }
}

// ---------- 2. 解析 cordis.patch.yml ----------
// 行格式：`- id:` 开一条目，其后同条目层级（缩进 +2）的 `name:` / `disabled:` 归属它。
function parsePatch(yaml, layer, onRow) {
  const lines = yaml.split(/\r?\n/);
  let cur = null, curIndent = 0;
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const idm = raw.match(/^(\s*)-\s+id:\s*(\S+)\s*$/);
    if (idm) {
      if (cur) onRow(cur, layer);
      cur = { id: idm[2], indent: idm[1].length, name: '', disabled: null, layer };
      continue;
    }
    if (!cur) continue;
    const indent = raw.match(/^(\s*)/)[1].length;
    if (indent !== cur.indent + 2) continue;
    const nm = raw.match(/^\s*name:\s*['"]?([^'"\n]+?)['"]?\s*$/);
    if (nm && !cur.name) { cur.name = nm[1].trim(); continue; }
    const dm = raw.match(/^\s*disabled:\s*(.+?)\s*$/);
    if (dm) {
      const v = dm[1];
      cur.disabled = v === 'true' ? true : v === 'false' ? false : 'cond';
    }
  }
  if (cur) onRow(cur, layer);
}

const rows = new Map(); // id -> row
function addRow(row) {
  if (!rows.has(row.id)) { row.layers = [row.layer]; rows.set(row.id, row); }
  else {
    const prev = rows.get(row.id);
    if (!prev.name && row.name) prev.name = row.name;
    if (prev.disabled == null) prev.disabled = row.disabled;
    prev.layers.push(row.layer);
  }
}

// 全局层：base + web-app
for (const p of [
  'dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml',
  'dsh/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml',
]) {
  const t = readAsarText(p);
  if (t) parsePatch(t, path.basename(path.dirname(path.dirname(p))), addRow);
}
// profile 覆盖层
const profPatch = path.join(PROFILE, 'cordis.patch.yml');
if (fs.existsSync(profPatch)) parsePatch(fs.readFileSync(profPatch, 'utf8'), 'profile', addRow);
// 用户插件层
for (const dir of fs.existsSync(USER_PLUGINS) ? fs.readdirSync(USER_PLUGINS) : []) {
  const f = path.join(USER_PLUGINS, dir, 'cordis.patch.yml');
  if (!fs.existsSync(f)) continue;
  parsePatch(fs.readFileSync(f, 'utf8'), `user:${dir}`, addRow);
}

// ---------- 3. Agent 预设 ----------
// 预设声明在 dsh-web-app/presets/*.patch.yml，每个文件一个预设。
// 结构：`- id: preset-<x>` → `config.plugins:` → 一串 `- id: <plugin>`
const presets = [];
for (const p of asarFiles.filter((f) => /^dsh\/node_modules\/@deepseek-ai\/dsh-web-app\/presets\/.*\.patch\.yml$/.test(f))) {
  const yaml = readAsarText(p);
  if (!yaml) continue;
  const lines = yaml.split(/\r?\n/);
  let inPreset = null, plugins = [], inPlugins = false, pluginsIndent = 0;
  for (const raw of lines) {
    const pid = raw.match(/^(\s*)-\s+id:\s*(preset-[a-z0-9-]+)\s*$/);
    if (pid) {
      if (inPreset) presets.push({ id: inPreset, plugins, file: path.basename(p) });
      inPreset = pid[2]; plugins = []; inPlugins = false;
      continue;
    }
    if (!inPreset) continue;
    const pm = raw.match(/^(\s*)plugins:\s*$/);
    if (pm) { inPlugins = true; pluginsIndent = pm[1].length; continue; }
    if (!inPlugins) continue;
    const indent = raw.match(/^\s*/)[0].length;
    if (indent <= pluginsIndent && raw.trim() && !/^\s*-\s/.test(raw)) { inPlugins = false; continue; }
    const m = raw.match(/^\s*-\s+id:\s*(\S+)\s*$/);
    if (m && indent > pluginsIndent) plugins.push(m[1]);
  }
  if (inPreset) presets.push({ id: inPreset, plugins, file: path.basename(p) });
}

// ---------- 4. 汇总输出 ----------
const pkgOf = (name) => {
  if (!name) return '';
  if (name.startsWith('@deepseek-ai/')) return name.split('/').slice(0, 2).join('/');
  return name.split('/')[0];
};
const metaOf = (name) => zhMeta.get(pkgOf(name)) || { title: '', description: '' };

const globalRows = [...rows.values()].filter((r) => !r.id.startsWith('preset-'));
const presetRows = [...rows.values()].filter((r) => r.id.startsWith('preset-'));

const L = [];
L.push('# DSH 插件全量清单', '');
L.push(`> 生成时间：${new Date().toLocaleString('zh-CN')}　|　DSH profile：desktop`, '');
L.push(`**总计：全局插件 ${globalRows.length} 个 · Agent 预设 ${presets.length} 个 · 预设条目合计 ${presets.reduce((n, p) => n + p.plugins.length, 0)} 个**`, '');

L.push('## 一、用户自装 / 二次创作插件', '');
L.push('| 插件 ID | 名称 | 来源 | 制作方 | 说明 |', '|---|---|---|---|---|');
const userLayers = new Set(['user:dsh-auto-repair-ui', 'user:dsh-box-ui', 'user:dsh-cyber-red-ui', 'user:dsh-startup-secret', 'user:qq-agent-presets', 'user:qq-mode-console']);
const seenUser = new Set();
for (const r of globalRows.filter((r) => r.layers.some((l) => userLayers.has(l)))) {
  const m = metaOf(r.name);
  const dir = path.join(USER_PLUGINS, r.name);
  let author = '-';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    author = typeof pkg.author === 'string' ? pkg.author : (pkg.author?.name || '-');
  } catch { /* 忽略 */ }
  const src = r.layers.filter((l) => l.startsWith('user:')).map((l) => l.slice(5)).join(', ');
  seenUser.add(src);
  L.push(`| \`${r.id}\` | ${m.title || r.name} | ${src} | ${author} | ${m.description || '-'} |`);
}
// 没有 patch 行、通过 lib/index.js 动态注册的插件
for (const dir of fs.existsSync(USER_PLUGINS) ? fs.readdirSync(USER_PLUGINS) : []) {
  if (seenUser.has(dir)) continue;
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(USER_PLUGINS, dir, 'package.json'), 'utf8')); } catch { /* 忽略 */ }
  if (!pkg) continue;
  const m = metaOf(dir);
  const author = typeof pkg.author === 'string' ? pkg.author : (pkg.author?.name || '-');
  L.push(`| \`${pkg.name || dir}\` | ${m.title || pkg.name || dir} | ${dir} | ${author} | ${m.description || pkg.description || '-'} |`);
}
L.push('');

L.push('## 二、全局插件（DSH 自带 + 用户插件）', '');
L.push('| 插件 ID | 中文名 | 包 | 状态 |');
L.push('|---|---|---|---|');
for (const r of globalRows.sort((a, b) => a.id.localeCompare(b.id))) {
  const m = metaOf(r.name);
  const state = r.disabled === true ? '❌ 已停用' : r.disabled === 'cond' ? '⚙️ 条件启用' : '✅ 启用';
  L.push(`| \`${r.id}\` | ${m.title || '-'} | \`${r.name || '-'}\` | ${state} |`);
}
L.push('');

L.push('## 三、Agent 预设', '');
for (const p of presets) {
  L.push(`### \`${p.id}\`（${p.plugins.length} 个插件）`, '');
  L.push(p.plugins.map((x) => `- \`${x}\``).join('\n'), '');
}

fs.writeFileSync(OUT, L.join('\n'), 'utf8');
console.log(`全局插件 ${globalRows.length} 个 / 预设 ${presetRows.length} 个 / 预设插件合计 ${presets.reduce((n, p) => n + p.plugins.length, 0)} 个`);
console.log('已写出:', OUT);
asar.close();
