// auto-repair · 通知模块
//
// 修复动作是「偷偷」发生的，你不知道就等于没修 —— 所以每次修复都要播报。
//
// 三个通道，逐级降级（前面的不通就用后面的）：
//   1. 需求箱（3200）—— 本地留言箱，UI 上能看到，最可靠
//   2. QQ 私聊 ownerQQ —— 通过 OneBot HTTP API 直接发消息
//   3. Windows 通知气泡 —— toast，兜底
//   4. 日志 —— 永远有，任何通道失败都会留痕
//
// 设计：通知**不能阻塞**也不能**抛错**。通知失败绝不能影响修复主流程。

import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { ROOT } from './diagnose.mjs'

const BOX_PORT = 3200
const ONEBOT_HTTP = 'http://127.0.0.1:3000'
const STATE_DIR = path.join(ROOT, 'auto-repair', 'state')
const POLICY_FILE = path.join(STATE_DIR, 'notify-policy.json')
const LOG_FILE = path.join(STATE_DIR, 'auto-repair.log')

/**
 * 通知策略：notify（默认，照常推送）| silent（完全不发）。
 * 读不到文件或内容不合法时按 notify 处理，保证老行为不变。
 */
export function readNotifyPolicy() {
  try {
    const doc = JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8').replace(/^\uFEFF/, ''))
    return doc?.mode === 'silent' ? 'silent' : 'notify'
  } catch {
    return 'notify'
  }
}

/** 被拦下的推送要留痕：写到守护进程同一份日志里，方便事后查。 */
function logBlocked(title) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] [notify] 策略=完全不发，已拦下对外推送：${title}`
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8')
  } catch {}
}

function boxToken() {
  try {
    return fs.readFileSync(path.join(ROOT, '需求箱', 'state', 'box-token'), 'utf8').trim()
  } catch {
    return ''
  }
}

function bridgeConfig() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'qq-bridge', 'config.json'), 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function postJson(url, body, headers = {}, timeoutMs = 5000) {
  return new Promise((resolve) => {
    try {
      const data = JSON.stringify(body)
      const u = new URL(url)
      const req = execFile(
        process.execPath,
        ['-e', `
const https=require('https'),http=require('http');
const u=new URL(process.argv[1]);
const body=process.argv[2];
const headers=JSON.parse(process.argv[3]);
const mod=u.protocol==='https:'?https:http;
const r=mod.request(u,{method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body),...headers}},res=>{
  let d='';res.on('data',c=>d+=c);res.on('end',()=>{process.stdout.write(String(res.statusCode));});
});
r.on('error',e=>{process.stdout.write('ERR:'+e.message);});
r.setTimeout(${timeoutMs},()=>{r.destroy();process.stdout.write('TIMEOUT');});
r.write(body);r.end();
`, url, data, JSON.stringify(headers)],
        { timeout: timeoutMs + 2000, windowsHide: true, maxBuffer: 1024 * 1024 }
      )
      req.on('close', (code) => resolve(String(code || '')))
      req.on('error', () => resolve('ERR'))
    } catch {
      resolve('ERR')
    }
  })
}

/** 通道 1：需求箱留言 */
async function notifyBox(title, detail, kind = 'l1') {
  const token = boxToken()
  if (!token) return false
  const res = await postJson(
    `http://127.0.0.1:${BOX_PORT}/api/box`,
    { kind, title, detail },
    { 'x-box-token': token }
  )
  return res === '200'
}

/** 通道 2：QQ 私聊管理员 */
async function notifyQQ(title, detail) {
  const cfg = bridgeConfig()
  if (!cfg) return false
  const owner = Number(cfg.ownerQQ)
  if (!owner) return false
  const token = cfg?.snowluma?.accessToken || ''
  const text = `【自动修复】${title}\n${detail}`.slice(0, 900)
  const res = await postJson(
    `${ONEBOT_HTTP}/send_private_msg`,
    { user_id: owner, message: text },
    { authorization: `Bearer ${token}` }
  )
  return res === '200'
}

/** 通道 3：Windows 通知气泡 */
function notifyToast(title, detail) {
  return new Promise((resolve) => {
    try {
      const script = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(1)
$n = $t.GetElementsByTagName("text")
$n.Item(0).AppendChild($t.CreateTextNode($args[0])) | Out-Null
$n.Item(1).AppendChild($t.CreateTextNode($args[1])) | Out-Null
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("大肥鱼").Show([Windows.UI.Notifications.ToastNotification]::new($t))
`
      const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script, title, detail], {
        windowsHide: true,
        stdio: 'ignore'
      })
      p.on('error', () => resolve(false))
      p.on('close', () => resolve(true))
    } catch {
      resolve(false)
    }
  })
}

/**
 * 发一条通知。逐级降级，任一通道成功即返回。
 * 永远不抛错。
 */
export async function notify(title, detail, kind = 'l1') {
  // 总开关：选了「完全不发」就直接返回，不碰任何对外通道（修复流程照常）。
  if (readNotifyPolicy() === 'silent') {
    logBlocked(title)
    return [['policy', false, 'silent']]
  }
  const results = []
  try {
    results.push(['box', await notifyBox(title, detail, kind)])
  } catch {}
  if (!results.some(([, ok]) => ok)) {
    try {
      results.push(['qq', await notifyQQ(title, detail)])
    } catch {}
  }
  if (!results.some(([, ok]) => ok)) {
    try {
      results.push(['toast', await notifyToast(title, detail)])
    } catch {}
  }
  return results
}
