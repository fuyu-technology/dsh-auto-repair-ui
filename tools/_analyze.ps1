param(
  [string]$Dir = 'D:\caps',
  [int]$Step = 1
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function Get-Bytes($bmp) {
  $rect = New-Object System.Drawing.Rectangle(0, 0, $bmp.Width, $bmp.Height)
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageFormat]::Format32bppArgb, $bmp.PixelFormat)
  $len = [Math]::Abs($data.Stride) * $bmp.Height
  $bytes = New-Object byte[] $len
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $len)
  $bmp.UnlockBits($data)
  return , @($bytes, $data.Stride)
}

$folders = Get-ChildItem $Dir -Directory | Sort-Object Name
$dir = $folders[-1].FullName
$files = Get-ChildItem $dir -Filter 'f*.png' | Sort-Object Name
Write-Output ('dir=' + $dir + ' frames=' + $files.Count)

$base = $null
$baseStride = 0
$w = 0
$h = 0

foreach ($f in $files) {
  $bmp = [System.Drawing.Bitmap]::FromFile($f.FullName)
  $w = $bmp.Width
  $h = $bmp.Height
  $r = Get-Bytes $bmp
  $bytes = $r[0]
  $stride = $r[1]
  $bmp.Dispose()

  if ($base -eq $null) {
    $base = $bytes
    $baseStride = $stride
    Write-Output ('frame0 ' + $w + 'x' + $h)
    continue
  }

  $changed = 0
  $minX = 999999
  $maxX = -1
  $minY = 999999
  $maxY = -1
  $strideA = [Math]::Abs($stride)
  for ($y = 0; $y -lt $h; $y++) {
    $rowA = $y * $strideA
    for ($x = 0; $x -lt $w; $x++) {
      $i = $rowA + $x * 4
      $d = [Math]::Abs($bytes[$i] - $base[$i]) + [Math]::Abs($bytes[$i + 1] - $base[$i + 1]) + [Math]::Abs($bytes[$i + 2] - $base[$i + 2])
      if ($d -gt 24) {
        $changed++
        if ($x -lt $minX) { $minX = $x }
        if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }
        if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  Write-Output ($f.Name + ' changed=' + $changed + ' bbox=' + $minX + ',' + $minY + ' - ' + $maxX + ',' + $maxY)
}
