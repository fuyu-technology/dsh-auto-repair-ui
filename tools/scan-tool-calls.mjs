// 统计 DSH 历史会话里的真实工具调用记录：用了哪些工具、成功还是失败。
// 数据源：~/.dsh/storages/session_projcache/sessions/*.json（未压缩）
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'C:\\Users\\Administrator\\.dsh\\storages\\session_projcache\\sessions';
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));

const toolStats = new Map(); // toolName -> {calls, ok, err, last, sampleErr}
let sessions = 0;

function note(name, ok, errText, at) {
  if (!name) return;
  if (!toolStats.has(name)) toolStats.set(name, { calls: 0, ok: 0, err: 0, last: at, sampleErr: null });
  const s = toolStats.get(name);
  s.calls++;
  if (ok) s.ok++;
  else { s.err++; if (!s.sampleErr && errText) s.sampleErr = String(errText).slice(0, 160); }
  if (at && (!s.last || at > s.last)) s.last = at;
}

function walk(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return;
  if (Array.isArray(node)) { for (const x of node) walk(x, depth + 1); return; }
  const role = node.role || node.type || node.kind;
  // 工具调用
  const name = node.name || node.toolName || node.tool || (node.function && node.function.name);
  const isTool = role === 'tool' || node.toolCallId || node.tool_use_id || node.toolUseId
    || node.kind === 'tool-call' || node.kind === 'tool_use' || node.type === 'tool-call';
  if (isTool && name) {
    const isErr = node.isError === true || node.status === 'error' || node.error
      || (typeof node.result === 'string' && /error|失败|Error:/i.test(node.result.slice(0, 200)));
    const txt = node.error || node.result || node.content || node.text || '';
    note(name, !isErr, isErr ? txt : '', node.at || node.timestamp || node.createdAt || 0);
  }
  for (const k of Object.keys(node)) walk(node[k], depth + 1);
}

for (const f of files) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    sessions++;
    walk(j);
  } catch { /* 跳过坏文件 */ }
}

const rows = [...toolStats.entries()].sort((a, b) => b[1].calls - a[1].calls);
console.log(`扫描会话 ${sessions} 个，工具调用记录 ${rows.reduce((n, [, s]) => n + s.calls, 0)} 条，涉及工具 ${rows.length} 个\n`);
console.log('工具'.padEnd(28) + '调用'.padEnd(7) + '成功'.padEnd(7) + '失败');
for (const [name, s] of rows) {
  console.log(name.padEnd(30) + String(s.calls).padEnd(7) + String(s.ok).padEnd(7) + String(s.err)
    + (s.sampleErr ? '  ← ' + s.sampleErr.replace(/\s+/g, ' ') : ''));
}
