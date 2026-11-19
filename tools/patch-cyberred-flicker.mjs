// cyber-red-ui client.js - flicker guard, round 2 (2026-11-03)
//
// Facts established by measurement:
//  * DSH ships a "TextShimmer" primitive: a masked diagonal light band that
//    sweeps across a row every 1.5s in 48 discrete steps, forever.
//      ._sweep_1rdzk_34, ._highlight_1rdzk_54 {
//        animation-duration: 1.5s; animation-delay: .3s;
//        animation-timing-function: steps(48, end);
//        animation-iteration-count: infinite; }
//    On a code chip that reads as a constant strobe.
//  * The plugin's chat-surface scope [data-cr-convo] is NEVER set by this
//    build, so every rule under it (including round 1's chip patch) was
//    inert. [data-phase] is the scope that actually exists.
//  * Measured chip fill in the desktop app: flat R41/G41/B41 -> the chip is
//    opaque, so "the wallpaper shows through" cannot be the mechanism.
//
// Fix: kill the infinite shimmer sweep, make every code element unanimated,
// and repaint chat code with a scope that actually matches.
import fs from 'node:fs';

const FILE = 'C:/Users/Administrator/.dsh/plugins/dsh-cyber-red-ui/client.js';
const src = fs.readFileSync(FILE, 'utf8');

const BLOCK_RE = /      \[data-cr-convo\] pre \{[\s\S]*?\n      \}\s*      \[data-cr-convo\] pre code \{[\s\S]*?\n      \}\s*      \[data-cr-convo\] :not\(pre\) > code \{[\s\S]*?\n      \}/;

if (!BLOCK_RE.test(src)) {
  console.error('anchor block not found - aborting (file may already be patched)');
  process.exit(2);
}

const NEW = `      [data-cr-convo] pre {
        border-color: #6d1219 !important;
        background-color: rgba(20, 6, 8, 0.97) !important;
        color: #ffe0e4 !important;
        box-shadow: none !important;
        animation: none !important;
        transition: none !important;
      }
      [data-cr-convo] pre code {
        border-color: transparent !important;
        background-color: transparent !important;
        color: #ffe0e4 !important;
        animation: none !important;
        transition: none !important;
      }
      [data-cr-convo] :not(pre) > code {
        border-color: #6d1219 !important;
        background-color: #1c0709 !important;
        color: #ffe0e4 !important;
        box-shadow: none !important;
        animation: none !important;
        transition: none !important;
        text-shadow: none !important;
      }
      /* ---- Flicker guard (2026-11-03) ---------------------------------
         DSH's TextShimmer paints a masked light band that sweeps a row
         every 1.5s in 48 discrete steps, forever. Over a code chip that
         reads as a constant strobe, so the sweep is switched off.
         The chat surfaces below use [data-phase], the scope that actually
         exists in this build - the original [data-cr-convo] scope was
         never set, so those rules never applied. */
      ._sweep_1rdzk_34,
      ._highlight_1rdzk_54 {
        animation: none !important;
      }
      code,
      pre {
        animation: none !important;
        transition: none !important;
      }
      [data-phase] :not(pre) > code {
        border-color: #6d1219 !important;
        background-color: #1c0709 !important;
        color: #ffe0e4 !important;
        box-shadow: none !important;
        animation: none !important;
        transition: none !important;
        text-shadow: none !important;
      }
      [data-phase] pre {
        border-color: #6d1219 !important;
        background-color: rgba(20, 6, 8, 0.97) !important;
        color: #ffe0e4 !important;
        animation: none !important;
        transition: none !important;
      }`;

const out = src.replace(BLOCK_RE, () => NEW);
if (out === src) { console.error('no change'); process.exit(3); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(FILE + '.bak-' + stamp, src, 'utf8');
fs.writeFileSync(FILE, out, 'utf8');
console.log('patched. backup =', FILE + '.bak-' + stamp);

const buf = fs.readFileSync(FILE);
console.log('BOM?', buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf);
console.log('bytes', buf.length);
for (const marker of ['_sweep_1rdzk_34', '[data-phase] :not(pre) > code', 'data-cr-convo']) {
  console.log('  contains', marker, '->', buf.toString('utf8').split(marker).length - 1);
}
