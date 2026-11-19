// Harden the remaining transparent chat surfaces in dsh-cyber-red-ui/client.js
//   1. fenced code block container ([data-cr-convo] pre) -> opaque, so the moving
//      wallpaper video behind it can no longer modulate its pixels
//   2. bubble / card -> 0.93 -> 0.97 alpha (kills the light-pillar pulse)
// Idempotent: re-running is a no-op.
import fs from 'node:fs';

const FILE = 'C:/Users/Administrator/.dsh/plugins/dsh-cyber-red-ui/client.js';
const src = fs.readFileSync(FILE, 'utf8');

const PRE_RE = /(\s*)\[data-cr-convo\] pre,\s*\[data-cr-convo\] pre code\s*\{\s*border-color:\s*transparent\s*!important;\s*background-color:\s*transparent\s*!important;\s*color:\s*#ffe0e4\s*!important;\s*\}/;
const BUBBLE_RE = /\[data-cr-convo\] \[data-cr-bubble\],\s*\[data-cr-convo\] \[data-cr-card\]\s*\{[^}]*background-color:\s*rgba\(24,\s*6,\s*8,\s*0\.93\)\s*!important;/;

const preMatch = src.match(PRE_RE);
const bubbleMatch = src.match(BUBBLE_RE);
console.log('pre rule found    :', !!preMatch);
console.log('bubble rule found:', !!bubbleMatch);
if (!preMatch) { console.error('pre rule not matched - abort'); process.exit(2); }

let out = src;

// 1) fenced code block container becomes opaque
const indent = preMatch[1];
const preReplacement = `${indent}[data-cr-convo] pre {
${indent}  border-color: #6d1219 !important;
${indent}  background-color: rgba(20, 6, 8, 0.97) !important;
${indent}  color: #ffe0e4 !important;
${indent}  box-shadow: none !important;
${indent}  animation: none !important;
${indent}  transition: none !important;
${indent}}
${indent}[data-cr-convo] pre code {
${indent}  border-color: transparent !important;
${indent}  background-color: transparent !important;
${indent}  color: #ffe0e4 !important;
${indent}  animation: none !important;
${indent}  transition: none !important;
${indent}}`;
out = out.replace(PRE_RE, () => preReplacement);
console.log('pre rule patched  :', out !== src);

// 2) bubble / card alpha 0.93 -> 0.97
if (bubbleMatch) {
  const before = out;
  out = out.replace(BUBBLE_RE, (m) => m.replace('rgba(24, 6, 8, 0.93)', 'rgba(24, 6, 8, 0.97)'));
  console.log('bubble patched    :', out !== before);
} else {
  console.log('bubble already at 0.97 or pattern changed - skipped');
}

if (out === src) {
  console.log('nothing to do (already patched)');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(FILE + '.bak-' + stamp, src, 'utf8');
fs.writeFileSync(FILE, out, 'utf8');
console.log('written, backup =', FILE + '.bak-' + stamp);

// sanity: JSON-free JS, make sure the file did not gain a BOM and size is sane
const buf = fs.readFileSync(FILE);
console.log('BOM?', buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf);
console.log('bytes', buf.length);
