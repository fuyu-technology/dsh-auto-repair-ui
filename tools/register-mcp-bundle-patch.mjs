// 登记 bundle 层补丁文件（qq-agent-presets）。
// 用 Node 改写 package.json（绝不写 BOM：带 BOM 会让 DSH 启动即崩）。
import fs from 'node:fs';

const PKG = 'D:\\大肥鱼\\qq-bridge\\plugins\\qq-agent-presets\\package.json';
const ADD = './bridge.patch.yml';
const DROP = './mcp.patch.yml';

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8').replace(/^\uFEFF/, ''));

const bundle = (pkg.dsh ??= {}).bundle ??= {};
let list = typeof bundle.patch === 'string' ? [bundle.patch] : (Array.isArray(bundle.patch) ? bundle.patch : []);
list = list.filter((f) => f !== DROP);
if (!list.includes(ADD)) list.unshift(ADD);
bundle.patch = list;

fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log('dsh.bundle.patch =', JSON.stringify(bundle.patch));

const check = fs.readFileSync(PKG);
console.log('bom:', check[0] === 0xEF && check[1] === 0xBB && check[2] === 0xBF, '| bytes:', check.length);
JSON.parse(fs.readFileSync(PKG, 'utf8'));
console.log('json ok');
