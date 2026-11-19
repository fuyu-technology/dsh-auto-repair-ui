<#
  全盘重复图片扫描器（支持断点续扫）
  - 按扩展名筛选图片
  - 先用 (大小) 分组预筛，只对可能重复的组算 SHA256（大幅提速）
  - 每 2000 个算一个增量落盘，中断后可从断点继续
#>
param(
  [string[]]$Roots = @('F:\'),
  [string]$Out = 'D:\大肥鱼\tmp\fulldup_F.csv',
  [int]$Checkpoint = 2000
)

$ErrorActionPreference = 'Continue'
$exts = @('.jpg','.jpeg','.png','.heic','.heif','.gif','.bmp','.webp','.tif','.tiff','.raw','.dng','.nef','.cr2','.arw','.svg')

New-Item -ItemType Directory -Force -Path (Split-Path $Out) | Out-Null

# ---- 断点文件：记录已算过的 (path,hash) ----
$ckPath = "$Out.ckpt"
$done = @{}
if (Test-Path -LiteralPath $ckPath) {
  Import-Csv -LiteralPath $ckPath | ForEach-Object { $done[$_.Path] = $_.Hash }
  Write-Output "断点载入: $($done.Count) 条"
}

$files = New-Object System.Collections.Generic.List[object]
foreach ($r in $Roots) {
  if (-not (Test-Path -LiteralPath $r)) { continue }
  Write-Output "扫描 $r ..."
  Get-ChildItem -LiteralPath $r -Recurse -File -Force -ErrorAction SilentlyContinue |
    Where-Object { $exts -contains $_.Extension.ToLower() } |
    ForEach-Object { $files.Add($_) }
}
Write-Output "图片文件总数: $($files.Count)"

$bySize = $files | Group-Object Length | Where-Object { $_.Count -gt 1 }
$candidates = @($bySize | ForEach-Object { $_.Group })
Write-Output "大小重复候选: $($candidates.Count)"

# 过滤掉断点里已经算过的
$todo = @($candidates | Where-Object { -not $done.ContainsKey($_.FullName) })
Write-Output "本次需计算: $($todo.Count)"

$sha = [System.Security.Cryptography.SHA256]::Create()
$new = New-Object System.Collections.Generic.List[object]
$i = 0
foreach ($f in $todo) {
  try {
    $fs = [System.IO.File]::OpenRead($f.FullName)
    try { $h = [BitConverter]::ToString($sha.ComputeHash($fs)).Replace('-','') }
    finally { $fs.Dispose() }
    $done[$f.FullName] = $h
    $new.Add([pscustomobject]@{ Hash=$h; Size=$f.Length; Path=$f.FullName })
  } catch {}
  $i++
  if ($i % $Checkpoint -eq 0) {
    $new | Export-Csv -LiteralPath $ckPath -NoTypeInformation -Encoding UTF8 -Append
    Write-Output "  hashed $i / $($todo.Count)  (累计 $($done.Count))"
    $new = New-Object System.Collections.Generic.List[object]
  }
}
$sha.Dispose()
if ($new.Count -gt 0) { $new | Export-Csv -LiteralPath $ckPath -NoTypeInformation -Encoding UTF8 -Append }

# 汇总输出
$rows = $done.GetEnumerator() | ForEach-Object { [pscustomobject]@{ Hash=$_.Value; Path=$_.Key } }
$rows | Export-Csv -LiteralPath $Out -NoTypeInformation -Encoding UTF8
Write-Output "完成: $($rows.Count) 条记录 -> $Out"
