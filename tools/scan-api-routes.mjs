// 扫描 app.asar 内的 web 路由，提取对外 HTTP 路径前缀。
import { readAsar } from './asar-read.mjs';

const asar = readAsar('D:\\大肥鱼\\resources\\app.asar');
const re = /["'`]([^"'`]*\/api\/[^"'`\\s]*)["'`]/g;
const found = new Set();
const targets = asar.files.filter(
  (f) => /dsh-web|dsh-web-app|dsh-api-|dsh-client-connection/.test(f.path) && /\.(js|mjs|cjs)$/.test(f.path)
);
for (const f of targets) {
  if (f.size > 3_000_000) continue;
  let txt;
  try { txt = asar.read(f.path).toString('utf8'); } catch { continue; }
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(txt))) found.add(m[1]);
}
const sorted = [...found].sort();
console.log('扫描文件数:', targets.length, '| 唯一 API 路径:', sorted.length);
console.log(sorted.join('\n'));
asar.close();
