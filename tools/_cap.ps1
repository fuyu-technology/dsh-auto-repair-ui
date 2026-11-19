param(
  [string]$OutDir = 'D:\caps',
  [int]$X = 633,
  [int]$Y = 285,
  [int]$W = 1295,
  [int]$H = 829,
  [int]$IntervalMs = 200,
  [int]$Count = 60
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$stamp = Get-Date -Format 'HHmmss'
$OutDir = Join-Path $OutDir $stamp
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$sig = @'
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
}
'@
Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue

$proc = Get-Process | Where-Object { $_.MainWindowTitle -like '*DeepSeek Harness*' } | Select-Object -First 1
if ($proc -ne $null) {
  $hwnd = $proc.MainWindowHandle
  [W]::ShowWindow($hwnd, 9) | Out-Null
  [W]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 700
  Write-Output ("window title: " + $proc.MainWindowTitle)
} else {
  Write-Output 'DSH window not found'
}

for ($i = 0; $i -lt $Count; $i++) {
  $bmp = New-Object System.Drawing.Bitmap($W, $H)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size($W, $H)))
  $g.Dispose()
  $file = Join-Path $OutDir ('f' + ('{0:D4}' -f $i) + '.png')
  try { $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png) } catch { Write-Output ('save-fail ' + $file + ' :: ' + $_.Exception.Message) }
  $bmp.Dispose()
  Start-Sleep -Milliseconds $IntervalMs
}
Write-Output ('saved ' + $Count + ' frames to ' + $OutDir)
