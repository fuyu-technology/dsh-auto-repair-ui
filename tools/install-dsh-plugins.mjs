// DSH 插件安装/同步器（幂等）。
//
// 用法：node install-dsh-plugins.mjs
//   自动处理 ~/.dsh/plugins/ 下的两个插件：
//     dsh-auto-repair-ui  ← D:\大肥鱼\auto-repair\dsh-auto-repair-ui
//     dsh-box-ui          ← D:\大肥鱼\需求箱\dsh-box-ui
//
// 三件套必须齐备，缺一个 DSH 就会报 "cannot resolve profile bundle"：
//   1. profile package.json 的 dependencies（link:）+ dsh.profile.bundles
//   2. pnpm-lock.yaml importers 里的 link 条目
//   3. profile node_modules/<name> 的 junction
//
// ⚠️ 铁律：profile package.json 带 UTF-8 BOM 会让 DSH 启动即崩。
// 本脚本一律用 Node 的 Buffer 读写，并显式校验首 3 字节。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PLUGINS_DIR = 'C:\\Users\\Administrator\\.dsh\\plugins';
const PROFILE_DIR = 'C:\\Users\\Administrator\\.dsh\\profiles\\desktop';
const PKG = path.join(PROFILE_DIR, 'package.json');
const LOCK = path.join(PROFILE_DIR, 'pnpm-lock.yaml');

const PLUGINS = [
  { name: 'dsh-auto-repair-ui', src: 'D:\\大肥鱼\\auto-repair\\dsh-auto-repair-ui' },
  { name: 'dsh-box-ui', src: 'D:\\大肥鱼\\需求箱\\dsh-box-ui' },
];

/**
 * profile 应该有的完整 bundle 列表（规范值）。
 *
 * 为什么要写死：2026-11-02 观察到一个坑——DSH 在**启动崩溃**的那次 boot 里，
 * 会把 profile package.json 的 `dsh.profile.bundles` 写回一份**残缺的**列表
 * （只剩核心 2 个 + 本次新增的），其余插件的 bundle 条目被悄悄抹掉，
 * 但 dependencies 还在。下次启动这些插件就不加载了，而且没有任何报错提示。
 *
 * 所以这里用规范值做「幂等恢复」：每次安装都把 bundles 重置成完整列表，
 * 顺序也固定，避免 DSH 崩溃时被截断的残留一直带下去。
 */
const CANONICAL_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  'qq-mode-console',
  'qq-agent-presets',
  'dsh-whale-widget',
  'dsh-startup-secret',
  'dsh-cyber-red-ui',
  'dsh-auto-repair-ui',
  'dsh-box-ui',
];

function hasBom(buf) {
  return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}
function stripBom(buf) {
  return hasBom(buf) ? buf.subarray(3) : buf;
}
function readTextNoBom(file) {
  return stripBom(fs.readFileSync(file)).toString('utf8');
}
function writeTextNoBom(file, text) {
  fs.writeFileSync(file, Buffer.from(text, 'utf8')); // 不带 BOM
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  const written = [];
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) {
      written.push(...copyTree(s, d));
    } else {
      const buf = fs.readFileSync(s);
      if (hasBom(buf)) throw new Error(`源文件带 BOM，拒绝写入：${s}`);
      fs.writeFileSync(d, buf);
      written.push(path.relative(to, d));
    }
  }
  return written;
}

function ensureJunction(linkPath, targetPath) {
  try {
    const st = fs.lstatSync(linkPath);
    if (st.isSymbolicLink()) {
      const real = fs.realpathSync(linkPath);
      if (real === fs.realpathSync(targetPath)) return '已存在且指向正确';
      fs.unlinkSync(linkPath);
    } else {
      return '已存在（非 junction，跳过）';
    }
  } catch { /* 不存在，下面创建 */ }
  execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, targetPath], { stdio: 'ignore', windowsHide: true });
  return '已创建';
}

// ── 1. 同步插件文件 ────────────────────────────────────────────────
for (const p of PLUGINS) {
  const dst = path.join(PLUGINS_DIR, p.name);
  const written = copyTree(p.src, dst);
  console.log(`[文件] ${p.name}: ${written.join(', ')}`);
}

// ── 2. profile package.json：dependencies + bundles ───────────────
const pkgRaw = readTextNoBom(PKG);
if (hasBom(fs.readFileSync(PKG))) console.log('[警告] 原 package.json 带 BOM，已剥离');
const pkg = JSON.parse(pkgRaw);
pkg.dependencies = pkg.dependencies || {};
pkg.dsh = pkg.dsh || {};
pkg.dsh.profile = pkg.dsh.profile || {};
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || [];

for (const p of PLUGINS) {
  const spec = `link:C:/Users/Administrator/.dsh/plugins/${p.name}`;
  pkg.dependencies[p.name] = spec;
}
const before = (pkg.dsh.profile.bundles || []).join(', ');
pkg.dsh.profile.bundles = CANONICAL_BUNDLES.slice();
writeTextNoBom(PKG, JSON.stringify(pkg, null, 2) + '\n');
if (before !== pkg.dsh.profile.bundles.join(', ')) {
  console.log(`[profile] bundles 已重置为规范值\n  原: ${before}\n  新: ${pkg.dsh.profile.bundles.join(', ')}`);
} else {
  console.log('[profile] bundles 已是规范值');
}
console.log('[profile] package.json 已更新（无 BOM）');

// ── 3. pnpm-lock.yaml：重建 importers 的 dependencies 块 ───────────
// 说明：原来用正则增量打补丁，结果同一插件被插入了多份重复 key。
// 这里改成**整块重建**，幂等且不会留重复条目。
let lock = readTextNoBom(LOCK);
const depsStart = lock.indexOf('    dependencies:\n');
const depsEnd = lock.indexOf('\npackages:', depsStart);
if (depsStart === -1 || depsEnd === -1) {
  console.error('[lock] 找不到 importers.dependencies 块，放弃修改');
  process.exit(1);
}

// 规范依赖列表：名字 → { specifier, version }
const LINK_DEPS = {
  'qq-agent-presets': 'link:../../plugins/qq-agent-presets',
  'qq-mode-console': 'link:../../plugins/qq-mode-console',
  'dsh-startup-secret': 'link:../../plugins/dsh-startup-secret',
  'dsh-cyber-red-ui': 'link:../../plugins/dsh-cyber-red-ui',
  'dsh-auto-repair-ui': 'link:../../plugins/dsh-auto-repair-ui',
  'dsh-box-ui': 'link:../../plugins/dsh-box-ui',
};
const block = ['    dependencies:\n'];
for (const name of Object.keys(LINK_DEPS)) {
  block.push(`      ${name}:\n`);
  block.push(`        specifier: link:C:/Users/Administrator/.dsh/plugins/${name}\n`);
  block.push(`        version: ${LINK_DEPS[name]}\n`);
}
block.push('      dsh-whale-widget:\n');
block.push('        specifier: 0.4.2\n');
block.push('        version: 0.4.2\n');

lock = lock.slice(0, depsStart) + block.join('') + lock.slice(depsEnd + 1);
writeTextNoBom(LOCK, lock);
console.log('[lock] importers.dependencies 已重建（无重复条目）');

// ── 4. node_modules junction ───────────────────────────────────────
for (const p of PLUGINS) {
  const link = path.join(PROFILE_DIR, 'node_modules', p.name);
  const target = path.join(PLUGINS_DIR, p.name);
  console.log(`[link] ${p.name}: ${ensureJunction(link, target)}`);
}

// ── 5. 反向校验 ────────────────────────────────────────────────────
let problems = [];
for (const p of PLUGINS) {
  const dst = path.join(PLUGINS_DIR, p.name);
  for (const rel of ['package.json', 'index.js', 'client.js', 'locale/zh.json', 'locale/en.json']) {
    const f = path.join(dst, rel);
    if (!fs.existsSync(f)) { problems.push(`缺文件 ${p.name}/${rel}`); continue; }
    const buf = fs.readFileSync(f);
    if (hasBom(buf)) problems.push(`带 BOM ${p.name}/${rel}`);
  }
  try {
    JSON.parse(readTextNoBom(path.join(dst, 'package.json')));
  } catch (e) {
    problems.push(`package.json 解析失败 ${p.name}: ${e.message}`);
  }
  try {
    const real = fs.realpathSync(path.join(PROFILE_DIR, 'node_modules', p.name));
    if (real !== fs.realpathSync(dst)) problems.push(`junction 指向不对 ${p.name}`);
  } catch {
    problems.push(`junction 缺失 ${p.name}`);
  }
}
const finalPkg = JSON.parse(readTextNoBom(PKG));
for (const p of PLUGINS) {
  if (!finalPkg.dsh.profile.bundles.includes(p.name)) problems.push(`bundles 缺 ${p.name}`);
  if (!finalPkg.dependencies[p.name]) problems.push(`dependencies 缺 ${p.name}`);
}
if (hasBom(fs.readFileSync(PKG))) problems.push('profile package.json 带 BOM！');

console.log(problems.length ? `\n❌ 问题:\n  ${problems.join('\n  ')}` : '\n✅ 全部校验通过');
process.exit(problems.length ? 1 : 0);
