// 探测 DSH host 的 Web 鉴权握手行为，用于定位桌面壳 welcome 失败。
// 用法: node probe-host-auth.mjs
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const exe = "D:\\大肥鱼\\DeepSeek Harness.exe";
const hostEntry = "D:\\大肥鱼\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js";
const args = [
  hostEntry,
  "D:\\大肥鱼\\resources\\app.asar\\dsh",
  "C:\\Users\\Administrator\\.dsh\\profiles\\desktop",
  "D:\\大肥鱼\\resources\\runtime\\primary-runtime",
  "D:\\大肥鱼\\resources\\runtime\\primary-runtime\\dependencies\\pnpm\\bin\\pnpm.mjs",
  "D:\\大肥鱼\\resources\\runtime\\bin",
];

const child = spawn(exe, args, {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", (d) => { out += d.toString(); });
child.stderr.on("data", (d) => { out += d.toString(); });

const deadline = Date.now() + 90_000;
let launch = null;
while (Date.now() < deadline && !launch) {
  const m = out.match(/dsh web:\s*(http:\/\/\S+)/);
  if (m) launch = m[1];
  else await delay(400);
}
if (!launch) {
  console.log("!! 未捕获到 launch url，host 输出尾部：\n" + out.slice(-3000));
  child.kill();
  process.exit(1);
}

const u = new URL(launch);
console.log("launch url   :", launch);
console.log("origin       :", u.origin);
console.log("token query  :", u.searchParams.get("token") ? "(present, len=" + u.searchParams.get("token").length + ")" : "(absent)");

const r1 = await fetch(launch, { redirect: "manual" });
const setCookie = r1.headers.get("set-cookie");
console.log("\n[A] GET launch (redirect:manual)");
console.log("    status     :", r1.status);
console.log("    location   :", r1.headers.get("location"));
console.log("    set-cookie :", setCookie);
await r1.body?.cancel();

const cookie = (setCookie ?? "").split(";")[0];
const cookieName = cookie.split("=")[0];
const cookieValue = cookie.split("=").slice(1).join("=");
console.log("    cookie name:", cookieName);
console.log("    cookie val :", cookieValue, `(len=${cookieValue.length})`);
console.log("    value === token ?", cookieValue === u.searchParams.get("token"));

const r2 = await fetch(u.origin + "/", { redirect: "manual" });
console.log("\n[B] GET / 无 cookie        ->", r2.status);
await r2.body?.cancel();

const r3 = await fetch(u.origin + "/", { headers: { cookie }, redirect: "manual" });
console.log("[C] GET / 带 cookie        ->", r3.status);
await r3.body?.cancel();

const r4 = await fetch(launch, { redirect: "follow" });
console.log("[D] GET launch 自动跟随(无 cookie) ->", r4.status, "最终 url:", r4.url);
await r4.body?.cancel();

const r5 = await fetch(launch, { headers: { cookie }, redirect: "follow" });
console.log("[E] GET launch 自动跟随(带 cookie) ->", r5.status, "最终 url:", r5.url);
await r5.body?.cancel();

const r6 = await fetch(u.origin + "/api/ping", { headers: { cookie }, redirect: "manual" });
console.log("[F] GET /api/ping 带 cookie ->", r6.status);
await r6.body?.cancel();

const r7 = await fetch(u.origin + "/?token=" + encodeURIComponent(u.searchParams.get("token") ?? ""), { redirect: "manual" });
console.log("[G] GET /?token=... 无 cookie ->", r7.status, "location:", r7.headers.get("location"));
await r7.body?.cancel();

console.log("\nhost 输出尾部:\n" + out.slice(-1500));
child.kill();
process.exit(0);
