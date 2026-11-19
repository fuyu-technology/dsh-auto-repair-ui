// 解压 DSH 会话事件流，统计真实工具调用（哪个工具、成功还是失败）。
// 数据源：~/.dsh/sessions/<workspace>/session-*/session.v4.jsonl.zstd
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = 'C:\\Users\\Administrator\\.dsh\\sessions';
const stats = new Map(); // tool -> {calls, ok, err, sampleErr, lastSession}
let sessions = 0, events = 0;

function listSessionFiles(dir) {
  const out = [];
  for (const ws of fs.readdirSync(dir)) {
    const wsDir = path.join(dir, ws);
    if (!fs.statSync(wsDir).isDirectory()) continue;
    for (const s of fs.readdirSync(wsDir)) {
      const f = path.join(wsDir, s, 'session.v4.jsonl.zstd');
      if (fs.existsSync(f)) out.push(f);
    }
  }
  return out;
}

function note(name, ok, errText, when, sessionName) {
  if (!name) return;
  if (!stats.has(name)) stats.set(name, { calls: 0, ok: 0, err: 0, sampleErr: null, last: null, session: null });
  const s = stats.get(name);
  s.calls++;
  if (ok) s.ok++;
  else { s.err++; if (!s.sampleErr && errText) s.sampleErr = String(errText).slice(0, 200); }
  if (when && (!s.last || when > s.last)) { s.last = when; s.session = sessionName; }
}

for (const f of listSessionFiles(ROOT)) {
  let text;
  try {
    text = zlib.zstdDecompressSync(fs.readFileSync(f)).toString('utf8');
  } catch (e) {
    console.log('解压失败', path.basename(f), e.message);
    continue;
  }
  sessions++;
  const sessionName = path.basename(path.dirname(f));
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    events++;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const kind = ev.kind || ev.type || ev.event;
    // 工具调用事件（DSH v4 用 "tool/call" / "tool/result"）
    if (kind === 'tool/call' || kind === 'tool_call' || kind === 'tool-call' || kind === 'tool-use') {
      const d = ev.data || {};
      const name = d.name || d.toolName || d.tool || ev.name || ev.toolName || ev.tool
        || (d.input && d.input.name) || (d.arguments && d.arguments.name);
      note(name, true, '', ev.time || ev.at || ev.timestamp || 0, sessionName);
    }
    if (kind === 'tool/result' || kind === 'tool_result' || kind === 'tool-result') {
      const d = ev.data || {};
      const name = d.name || d.toolName || d.tool || ev.name || ev.toolName || ev.tool || d.toolCallId;
      const raw = d.result ?? d.output ?? d.content ?? '';
      const txt = typeof raw === 'string' ? raw : JSON.stringify(raw);
      // 只认结构化错误标记，避免把正常返回内容里的 error/未找到 等词误判为失败
      const bad = d.isError === true || d.is_error === true || !!d.error
        || (d.status && /^(error|failed)$/i.test(String(d.status)));
      note(name, !bad, bad ? txt : '', ev.time || ev.at || ev.timestamp || 0, sessionName);
    }
    // 也兼容 message 流里内嵌的 tool_calls
    const msg = ev.message || ev;
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && part.type === 'tool_use') note(part.name, true, '', ev.at || 0, sessionName);
        if (part && part.type === 'tool_result') {
          const txt = typeof part.content === 'string' ? part.content : JSON.stringify(part.content || '');
          const bad = part.is_error === true || /error|失败/i.test(String(txt).slice(0, 300));
          note(part.name || part.tool_use_id, !bad, bad ? txt : '', ev.at || 0, sessionName);
        }
      }
    }
  }
}

const rows = [...stats.entries()].sort((a, b) => b[1].calls - a[1].calls);
const totalCalls = rows.reduce((n, [, s]) => n + s.calls, 0);
const totalErr = rows.reduce((n, [, s]) => n + s.err, 0);
console.log(`会话 ${sessions} 个，事件 ${events} 条，工具调用 ${totalCalls} 次，涉及工具 ${rows.length} 个，失败 ${totalErr} 次\n`);
console.log('工具'.padEnd(44) + '调用'.padEnd(9) + '成功'.padEnd(9) + '失败');
for (const [name, s] of rows) {
  console.log(name.padEnd(46) + String(s.calls).padEnd(9) + String(s.ok).padEnd(9) + String(s.err)
    + (s.sampleErr ? '  ← ' + s.sampleErr.replace(/\s+/g, ' ') : ''));
}
