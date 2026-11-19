Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$ErrorActionPreference = 'Continue'

$sig = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
Add-Type -TypeDefinition $sig -Language CSharp

$found = New-Object System.Collections.ArrayList
$cb = [Win+EnumWindowsProc]{
  param($h, $l)
  if ([Win]::IsWindowVisible($h)) {
    $len = [Win]::GetWindowTextLength($h)
    if ($len -gt 0) {
      $sb = New-Object System.Text.StringBuilder ($len + 2)
      [void][Win]::GetWindowText($h, $sb, $sb.Capacity)
      $t = $sb.ToString()
      $pid2 = 0
      [void][Win]::GetWindowThreadProcessId($h, [ref]$pid2)
      $r = New-Object Win+RECT
      [void][Win]::GetWindowRect($h, [ref]$r)
      [void]$found.Add([pscustomobject]@{ Handle = $h; Title = $t; ProcId = $pid2; L = $r.Left; T = $r.Top; W = ($r.Right - $r.Left); H = ($r.Bottom - $r.Top) })
    }
  }
  return $true
}
[void][Win]::EnumWindows($cb, [IntPtr]::Zero)

Write-Output '=== visible windows ==='
$found | ForEach-Object { "pid={0,-6} {1}x{2} @({3},{4})  {5}" -f $_.ProcId, $_.W, $_.H, $_.L, $_.T, $_.Title }

$target = $found | Where-Object { $_.Title -like '*DeepSeek*' -or $_.Title -like '*Harness*' } | Sort-Object { $_.W * $_.H } -Descending | Select-Object -First 1
if (-not $target) { Write-Output 'NO DSH WINDOW FOUND'; exit 1 }
Write-Output ("=== target: {0} ({1}x{2}) ===" -f $target.Title, $target.W, $target.H)

function Capture($handle, $path) {
  $bmp = New-Object System.Drawing.Bitmap $target.W, $target.H
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  [void][Win]::PrintWindow($handle, $hdc, 2)
  $g.ReleaseHdc($hdc)
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

$shots = $args
if (-not $shots -or $shots.Count -eq 0) {
  Capture $target.Handle 'D:\_dshwin.png'
  Write-Output 'saved D:\_dshwin.png'
  exit 0
}

$i = 0
foreach ($p in $shots) {
  Capture $target.Handle $p
  $i++
  Start-Sleep -Milliseconds 250
}
Write-Output "captured $i frames"
