// Patch dsh-cyber-red-ui/client.js:
//  1. CSS: keep browser scroll anchoring off for the conversation scroller.
//  2. JS : force the reduced-motion branch so DSH's tail follow is an instant
//          jump instead of a native smooth scroll (that animation is what
//          publishes followingTail=false mid-flight and blinks the
//          "jump to latest" FAB).
//  3. JS : console diagnostic that reports every FAB mount/unmount.
import fs from 'node:fs';

const FILE = 'C:\\Users\\Administrator\\.dsh\\plugins\\dsh-cyber-red-ui\\client.js';
const src = fs.readFileSync(FILE, 'utf8');
if (src.charCodeAt(0) === 0xfeff) {
  console.error('BOM detected - aborting');
  process.exit(2);
}
const EOL = src.includes('\r\n') ? '\r\n' : '\n';
const NL = (s) => s.split('\n').join(EOL);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(FILE + '.bak-' + stamp, src);
console.log('backup:', FILE + '.bak-' + stamp);

let out = src;

/* ---- 1. CSS ---------------------------------------------------------- */
const cssAnchor = '      [data-cr-convo] a { color: #ec2626 !important; }';
if (!out.includes(cssAnchor)) throw new Error('css anchor not found');
const cssBlock = NL(`      /* ---- Jump-to-latest FAB stability (2026-11-03) -----------------
         DSH turns the browser's scroll anchoring on whenever it is NOT
         following the tail. Anchoring then shifts scrollTop whenever the
         column grows, which DSH reads as reader movement and flips
         followingTail, so the FAB appears and disappears on its own. DSH
         restores positions itself through its own anchor keys, so anchoring
         stays off for good. */
      [data-conversation-scroll],
      [data-conversation-scroll] div[class*="scroll"] {
        overflow-anchor: none !important;
      }
`);
out = out.replace(cssAnchor, cssBlock + cssAnchor);

/* ---- 2 + 3. runtime factory ----------------------------------------- */
const fnAnchor = '        const makeShellStylesheet = function () {';
if (!out.includes(fnAnchor)) throw new Error('fn anchor not found');
const fnBlock = NL(`        /* ---- Jump-to-latest FAB stability (2026-11-03) --------------------
           DSH follows the tail with a native smooth scroll. Chromium fires
           "scrollend" for the superseded animation whenever the tail is
           retargeted mid-flight; DSH reads that as "the reader moved away"
           and publishes followingTail=false, which mounts the jump-to-latest
           button. The next settled sample flips it back, so the button blinks
           in and out on every retarget.

           Forcing the reduced-motion branch turns that smooth scroll into an
           instant jump, so no animation is ever outstanding and the button
           keeps a stable presence. Only reduced-motion queries are
           intercepted; every other media query still reaches the platform. */
        const makeToBottomGuard = function () {
          const nativeMatchMedia = window.matchMedia;
          const REDUCED = /prefers-reduced-motion/i;
          const patched = function (query) {
            if (typeof query === 'string' && REDUCED.test(query)) {
              const mql = nativeMatchMedia.call(window, query);
              const listeners = new Set();
              return {
                media: mql.media,
                matches: true,
                onchange: null,
                addEventListener: function (type, fn) { listeners.add(fn); },
                removeEventListener: function (type, fn) { listeners.delete(fn); },
                addListener: function (fn) { listeners.add(fn); },
                removeListener: function (fn) { listeners.delete(fn); },
                dispatchEvent: function () { return false; }
              };
            }
            return nativeMatchMedia.call(window, query);
          };
          window.matchMedia = patched;

          /* Diagnostic: report every mount/unmount of the jump-to-latest FAB
             so the flicker can be confirmed from the console without a
             screenshot diff. */
          let last = null;
          let queued = false;
          const report = function () {
            queued = false;
            const fab = document.querySelector('[class*="_toBottom"]');
            const present = fab !== null;
            if (present === last) return;
            last = present;
            const scroller = document.querySelector('[data-conversation-scroll]');
            const metrics = scroller
              ? { top: scroller.scrollTop, height: scroller.scrollHeight, client: scroller.clientHeight }
              : null;
            console.log('[cyber-red] FAB ' + (present ? 'mounted' : 'unmounted'),
              JSON.stringify(metrics),
              'tail=' + String(document.querySelector('[data-chat-following-tail]') !== null));
          };
          const schedule = function () {
            if (queued) return;
            queued = true;
            if (typeof requestAnimationFrame === 'function') requestAnimationFrame(report);
            else setTimeout(report, 16);
          };
          const observer = new MutationObserver(schedule);
          observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['data-chat-following-tail']
          });
          report();
          console.log('[cyber-red] toBottom guard installed (reduced-motion forced for JS queries)');

          return function () {
            observer.disconnect();
            if (window.matchMedia === patched) window.matchMedia = nativeMatchMedia;
          };
        };

`);
out = out.replace(fnAnchor, fnBlock + fnAnchor);

/* ---- wire it into the runtime --------------------------------------- */
const arrAnchor = '            makeMarkingPass(),';
if (!out.includes(arrAnchor)) throw new Error('array anchor not found');
out = out.replace(arrAnchor, arrAnchor + EOL + '            makeToBottomGuard(),');

fs.writeFileSync(FILE, out, 'utf8');
console.log('written bytes:', Buffer.byteLength(out, 'utf8'));
console.log('BOM check:', out.charCodeAt(0) === 0xfeff ? 'BAD' : 'clean');
