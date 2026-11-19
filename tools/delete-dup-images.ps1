<#
  全盘重复图片删除器（安全版）
  - 仅删除「用户内容目录」下的重复副本
  - 绝不删除程序资源 / 系统文件 / 依赖库
#>
param(
  [string]$Csv = 'D:\大肥鱼\tmp\fulldup_F.csv',
  [string]$OutList = 'D:\大肥鱼\tmp\todelete_full.csv',
  [switch]$Apply
)

$ErrorActionPreference = 'Continue'

# ---------- 1. 受保护目录：命中即整组跳过，绝不删除 ----------
$protectPatterns = @(
  '\\resources\\app\\',
  '\\resources\\',
  '\\node_modules\\',
  '\\site-packages\\',
  '\\AppData\\',
  '\\Program Files',
  '\\Program Files (x86)',
  '\\Windows\\',
  '\\System32\\',
  '\\System Volume Information\\',
  '\.git\\',
  '\\vendor\\',
  '\\packages\\',
  '\\dist\\',
  '\\build\\',
  '\\assets\\',
  '\\icons\\',
  '\\fonts\\',
  '\\themes\\',
  '\\skins\\',
  '\\plugins\\',
  '\\locales\\',
  '\\switches\\',
  '\\static\\',
  '\\templates\\',
  '\\locale\\',
  '\\i18n\\',
  '\\.min\\',
  '\\Python',
  '\\Python3',
  '\\conda',
  '\\Anaconda',
  '\\Miniconda',
  '\\.venv\\',
  '\\venv\\',
  '\\site-packages'
)
# 目录名精确命中（整段目录名）
$protectDirNames = @(
  'node_modules','.git','resources','app','assets','fonts','themes','skins',
  'plugins','locales','locale','i18n','vendor','packages','dist','build',
  'static','templates','bin','lib','lib64','site-packages','conda-meta',
  'Library','Python312','Python311','Python313','Python310','Anaconda3','Miniconda3',
  'Microsoft','Windows','Program Files','Program Files (x86)','System32'
)
$protectExts = @('.svg','.ico','.ttf','.otf','.woff','.woff2','.eot')

function Test-Protected($p) {
  $lp = $p.ToLower()
  foreach ($pat in $protectPatterns) { if ($lp -like "*$pat*") { return $true } }
  $segs = $lp -split '\\'
  for ($i = 1; $i -lt $segs.Count - 1; $i++) {
    if ($protectDirNames -contains $segs[$i]) { return $true }
  }
  $ext = [IO.Path]::GetExtension($lp)
  if ($protectExts -contains $ext) { return $true }
  return $false
}

# ---------- 2. 保留优先级：越靠前越优先保留 ----------
function KeepScore($p) {
  $lp = $p.ToLower()
  if ($lp -match '\\dcim\\camera\\')        { return 0 }   # 手机原图
  if ($lp -match '\\dcim\\')                { return 1 }
  if ($lp -match '\\camera\\')              { return 2 }
  if ($lp -match '\\pictures\\')            { return 3 }
  if ($lp -match '\\screenshots?\\')        { return 4 }
  if ($lp -match '\\photo(graph)?s?\\')     { return 5 }
  if ($lp -match '\\image(s)?\\')           { return 6 }
  if ($lp -match '\\album\\')               { return 6 }
  if ($lp -match '\\photo(s)?\\')            { return 6 }
  if ($lp -match '\\save(d)?\\')            { return 7 }
  return 8   # 根目录 / 其他
}

$rows = Import-Csv -LiteralPath $Csv
Write-Output "载入记录: $($rows.Count)"

$groups = $rows | Group-Object Hash | Where-Object { $_.Count -gt 1 }
Write-Output "重复组: $($groups.Count)"

$keepList = New-Object System.Collections.Generic.List[string]
$delList  = New-Object System.Collections.Generic.List[string]
$skippedGroups = 0
$skippedFiles  = 0

foreach ($g in $groups) {
  $members = $g.Group
  # 组内只要有一个成员受保护 -> 整组不删
  $prot = @($members | Where-Object { Test-Protected $_.Path })
  if ($prot.Count -gt 0) {
    $skippedGroups++
    $skippedFiles += ($members.Count - 1)
    foreach ($mp in $members) { $keepList.Add([string]$mp.Path) }
    continue
  }
  $sorted = $members | Sort-Object @{Expression={ KeepScore $_.Path }}, @{Expression={ [int64]$_.Size }}
  $keepList.Add($sorted[0].Path)
  for ($i = 1; $i -lt $sorted.Count; $i++) { $delList.Add($sorted[$i].Path) }
}

$bytes = 0
foreach ($p in $delList) {
  $f = Get-Item -LiteralPath $p -ErrorAction SilentlyContinue
  if ($f) { $bytes += $f.Length }
}

Write-Output "整组跳过(受保护): $skippedGroups 组, 涉及 $(($groups | Where-Object { $_.Count -gt 1 }).Count) "
Write-Output "待删副本: $($delList.Count)  预计释放: $([math]::Round($bytes/1GB,3)) GB"

$delList | Set-Content -LiteralPath $OutList -Encoding UTF8
Write-Output "待删列表 -> $OutList"

if ($Apply) {
  Add-Type -AssemblyName Microsoft.VisualBasic
  $ok = 0; $fail = 0; $fails = @()
  $sw = [Diagnostics.Stopwatch]::StartNew()
  foreach ($p in $delList) {
    if (Test-Path -LiteralPath $p) {
      try {
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin')
        $ok++
      } catch { $fail++; $fails += "$p :: $($_.Exception.Message)" }
    }
  }
  $sw.Stop()
  Write-Output "删除完成: ok=$ok fail=$fail 用时=$([math]::Round($sw.Elapsed.TotalSeconds,1))s"
  if ($fails.Count) { $fails | Select-Object -First 15 | ForEach-Object { Write-Output "  $_" } }
} else {
  Write-Output "（未加 -Apply，仅生成清单）"
  $delList | Select-Object -First 25 | ForEach-Object { Write-Output "  DEL $_" }
}
