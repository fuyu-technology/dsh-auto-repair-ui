// 从 DSH 的 MCP 客户端实现里找配置来源与 server 注册逻辑。
import fs from 'node:fs';

const f = 'D:\\大肥鱼\\auto-repair\\state\\mcp-client.raw.js';
const buf = fs.readFileSync(f);
// PowerShell `>` 重定向写的是 UTF-16LE，按实际编码解
const s = (buf[0] === 0xFF && buf[1] === 0xFE) ? buf.toString('utf16le').slice(1) : buf.toString('utf8');
console.log('长度', s.length, '| 前 60 字:', JSON.stringify(s.slice(0, 60)));

const lines = s.split(/\r?\n/);
const pat = /(mcpServers|servers\.json|\.mcp\.json|configPath|serversPath|readFileSync|\.dsh|workspace\.json|storage|snowluma|ws:\/\/|http:\/\/)/i;
lines.forEach((l, i) => {
  if (pat.test(l) && l.trim().length < 500) console.log((i + 1) + ': ' + l.trim().slice(0, 320));
});
