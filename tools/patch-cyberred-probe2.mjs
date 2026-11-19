// v3: quiet the probe logs, add a self-test line for the reduced-motion override.
import fs from 'node:fs';

const FILE = 'C:\\Users\\Administrator\\.dsh\\plugins\\dsh-cyber-red-ui\\client.js';
const src = fs.readFileSync(FILE, 'utf8');
if (src.charCodeAt(0) === 0xfeff) { console.error('BOM detected - aborting'); process.exit(2); }
const EOL = src.includes('\r\n') ? '\r\n' : '\n';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(FILE + '.bak-' + stamp, src);
console.log('backup:', FILE + '.bak-' + stamp);

let out = src;

/* quiet the per-query log: keep the first 3, then stay silent */
const a1 = `              console.log('[cyber-red] reduced-motion query -> forced true:', query);`;
const b1 = `              if (reducedMotionLogCount < 3) {
                reducedMotionLogCount += 1;
                console.log('[cyber-red] reduced-motion query -> forced true:', query);
              }`;
if (!out.includes(a1)) throw new Error('log anchor not found');
out = out.replace(a1, b1);

/* declare the counter next to the matcher */
const a2 = `          const REDUCED = /prefers-reduced-motion/i;`;
const b2 = `          const REDUCED = /prefers-reduced-motion/i;
          let reducedMotionLogCount = 0;`;
if (!out.includes(a2)) throw new Error('counter anchor not found');
out = out.replace(a2, b2);

/* self-test line at install */
const a3 = `          console.log('[cyber-red] toBottom guard installed (reduced-motion forced for JS queries)');`;
const b3 = `          console.log('[cyber-red] toBottom guard installed; reduced-motion override native=' +
            nativeMatchMedia.call(window, '(prefers-reduced-motion: reduce)').matches +
            ' patched=true; scrollTo spy active');`;
if (!out.includes(a3)) throw new Error('install-log anchor not found');
out = out.replace(a3, b3);

fs.writeFileSync(FILE, out, 'utf8');
console.log('written bytes:', Buffer.byteLength(out, 'utf8'));
console.log('BOM check:', out.charCodeAt(0) === 0xfeff ? 'BAD' : 'clean');
console.log('EOL:', EOL === '\r\n' ? 'CRLF' : 'LF');
