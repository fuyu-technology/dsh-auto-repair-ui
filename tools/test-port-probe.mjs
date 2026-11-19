// 复现 supervisor.currentDshPort() 的判定，看它为什么给出旧端口
import { execSync } from 'node:child_process'
import { listeningPortsSync } from './net-listeners.mjs'

const PS = (s) => execSync('powershell.exe -NoLogo -NoProfile -NonInteractive -Command ' + JSON.stringify(s), {
  encoding: 'utf8', windowsHide: true, timeout: 25000
})

const ids = PS('(tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /FO CSV | ' +
  'Select-String "DeepSeek Harness.exe" | ' +
  'ForEach-Object { ($_ -split ",")[1].Trim("`"") }) -join ","').trim().split(',').filter(Boolean).map(Number)
console.log('DSH 进程 pid 集合:', ids)

const skip = new Set([3000, 3001, 3100, 3200, 5099, 5100, 5101, 5199])
console.log('\nlisteningPortsSync() 里由 DSH pid 持有的端口:')
for (const [port, pid] of listeningPortsSync()) {
  if (ids.includes(Number(pid))) {
    console.log(`  port=${port} pid=${pid} ${skip.has(port) ? '(在 skip 列表里)' : ''}`)
  }
}
console.log('\n所有监听端口数:', listeningPortsSync().size)
console.log('57594 在监听表里吗:', listeningPortsSync([57594]).has(57594))
console.log('57581 在监听表里吗:', listeningPortsSync([57581]).has(57581))
