// Add runtime probes to the existing toBottom guard:
//   1. log every reduced-motion query DSH makes (proves the override is in DSH's path)
//   2. log every smooth scrollTo request (proves no native animation is ever started)
import fs from 'node:fs';

const FILE = 'C:\\Users\\Administrator\\.dsh\\plugins\\dsh-cyber-red-ui\\client.js';
const src = fs.readFileSync(FILE, 'utf8');
if (src.charCodeAt(0) === 0xfeff) { console.error('BOM detected - aborting'); process.exit(2); }
const EOL = src.includes('\r\n') ? '\r\n' : '\n';
const NL = (s) => s.split('\n').join(EOL);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(FILE + '.bak-' + stamp, src);
console.log('backup:', FILE + '.bak-' + stamp);

let out = src;

/* ---- probe 1: reduced-motion query log ------------------------------ */
const a1 = `            if (typeof query === 'string' && REDUCED.test(query)) {
              const mql = nativeMatchMedia.call(window, query);`;
const b1 = `            if (typeof query === 'string' && REDUCED.test(query)) {
              const mql = nativeMatchMedia.call(window, query);
              console.log('[cyber-red] reduced-motion query -> forced true:', query);`;
if (!out.includes(a1)) throw new Error('probe1 anchor not found');
out = out.replace(a1, b1);

/* ---- probe 2: smooth scrollTo spy ----------------------------------- */
const a2 = `          window.matchMedia = patched;
`;
const b2 = `          window.matchMedia = patched;

          /* Probe: DSH starts a native smooth scroll only through
             element.scrollTo({behavior:'smooth'}). If the reduced-motion
             override works, that call never happens for the chat tail and
             therefore no mid-flight scrollend can flip followingTail. */
          const nativeScrollTo = Element.prototype.scrollTo;
          Element.prototype.scrollTo = function (options) {
            try {
              const behavior = options && typeof options === 'object' ? options.behavior : undefined;
              if (behavior === 'smooth') {
                const cls = this.className ? String(this.className).slice(0, 48) : '';
                console.log('[cyber-red] smooth scrollTo requested:', this.tagName, cls);
              }
            } catch (e) { /* probing must never break scrolling */ }
            return nativeScrollTo.apply(this, arguments);
          };
`;
if (!out.includes(a2)) throw new Error('probe2 anchor not found');
out = out.replace(a2, b2);

fs.writeFileSync(FILE, out, 'utf8');
console.log('written bytes:', Buffer.byteLength(out, 'utf8'));
console.log('BOM check:', out.charCodeAt(0) === 0xfeff ? 'BAD' : 'clean');
