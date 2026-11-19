// 插件安装/同步脚本：从源目录复制到 DSH 插件目录，**绝不写 BOM**。
// 教训（2026-11-02）：DSH profile 的 package.json 带 UTF-8 BOM 会让 DSH 启动即崩，
// 所以这里一律用 Node 的 Buffer 读写，并显式校验首 3 字节。
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'D:\\大肥鱼\\auto-repair\\dsh-auto-repair-ui';
const DST = 'C:\\Users\\Administrator\\.dsh\\plugins\\dsh-auto-repair-ui';

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
      if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        throw new Error(`源文件带 BOM，拒绝写入：${s}`);
      }
      fs.writeFileSync(d, buf);
      written.push(path.relative(DST, d));
    }
  }
  return written;
}

const written = copyTree(SRC, DST);
console.log('已同步：', written.join(', '));

// 反向校验：装好的文件必须无 BOM
let bad = [];
for (const rel of written) {
  const buf = fs.readFileSync(path.join(DST, rel));
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) bad.push(rel);
}
console.log(bad.length ? `❌ 仍有 BOM: ${bad.join(', ')}` : '✅ 全部文件无 BOM');

// JSON 合法性校验
for (const rel of written.filter((f) => f.endsWith('.json'))) {
  JSON.parse(fs.readFileSync(path.join(DST, rel), 'utf8'));
}
console.log('✅ JSON 全部可解析');

// node_modules junction 指向检查
const link = 'C:\\Users\\Administrator\\.dsh\\profiles\\desktop\\node_modules\\dsh-auto-repair-ui';
try {
  const real = fs.realpathSync(link);
  console.log(real === fs.realpathSync(DST)
    ? '✅ node_modules junction 指向插件目录'
    : `⚠️ junction 指向别处：${real}`);
} catch (e) {
  console.log('⚠️ junction 检查失败：', e.message);
}
