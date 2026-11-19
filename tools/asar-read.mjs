// 读取 Electron asar 包内部文件（无需 asar 工具，纯解析 header）。
// asar 格式：前 4 字节 uint32 = pickle 大小；接着 4 字节 = header 大小；
// 再 4 字节 = JSON 长度；之后是文件树 JSON。文件数据从 8 + headerSize 开始。
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function readAsar(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  const pre = Buffer.alloc(16);
  fs.readSync(fd, pre, 0, 16, 0);
  const headerSize = pre.readUInt32LE(4);
  const jsonSize = pre.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonSize);
  fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
  const tree = JSON.parse(jsonBuf.toString('utf8'));
  const dataStart = 8 + headerSize;

  function walk(node, prefix = '') {
    const out = [];
    for (const [name, child] of Object.entries(node.files || {})) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (child.files) out.push(...walk(child, p));
      else out.push({ path: p, size: child.size, offset: child.offset });
    }
    return out;
  }

  return {
    files: walk(tree),
    read(relPath) {
      const entry = this.files.find((f) => f.path === relPath);
      if (!entry) throw new Error(`asar 内没有: ${relPath}`);
      const buf = Buffer.alloc(entry.size);
      fs.readSync(fd, buf, 0, entry.size, dataStart + Number(entry.offset));
      return buf;
    },
    close() { fs.closeSync(fd); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const asar = readAsar('D:\\大肥鱼\\resources\\app.asar');
  const mode = process.argv[2] || 'list';
  if (mode === 'list') {
    const pat = process.argv[3] ? new RegExp(process.argv[3], 'i') : null;
    for (const f of asar.files) {
      if (!pat || pat.test(f.path)) console.log(String(f.size).padStart(10), f.path);
    }
  } else if (mode === 'cat') {
    const buf = asar.read(process.argv[3]);
    process.stdout.write(buf);
  }
  asar.close();
}
