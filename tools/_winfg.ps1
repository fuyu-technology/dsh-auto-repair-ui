param([int]$Index = 0)
$ErrorActionPreference = 'Stop'
$sig = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue

$list = New-Object System.Collections.ArrayList
$cb = [Win+EnumWindowsProc]{
  param($h, $p)
  if ([Win]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 512
    [Win]::GetWindowText($h, $sb, 512) | Out-Null
    $t = $sb.ToString()
    if ($t -like '*DeepSeek Harness*') {
      $r = New-Object Win+RECT
      [Win]::GetWindowRect($h, [ref]$r) | Out-Null
      $pid2 = 0
      [Win]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
      $null = $list.Add([PSCustomObject]@{
        H = $h; Title = $t; Pid = $pid2
        X = $r.Left; Y = $r.Top; W = $r.Right - $r.Left; Hh = $r.Bottom - $r.Top
        Minimized = [Win]::IsIconic($h)
      })
    }
  }
  return $true
}
[Win]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$i = 0
foreach ($w in $list) {
  Write-Output ('[' + $i + '] pid=' + $w.Pid + ' rect=' + $w.X + ',' + $w.Y + ' ' + $w.W + 'x' + $w.Hh + ' min=' + $w.Minimized + ' title=' + $w.Title)
  $i++
}

if ($list.Count -gt $Index) {
  $t = $list[$Index]
  [Win]::ShowWindow($t.H, 9) | Out-Null
  Start-Sleep -Milliseconds 300
  $fg = [Win]::GetForegroundWindow()
  $t1 = [Win]::GetWindowThreadProcessId($fg, [ref]([uint32]0))
  $cur = [Win]::GetCurrentThreadId()
  [Win]::AttachThreadInput($cur, $t1, $true) | Out-Null
  [Win]::BringWindowToTop($t.H) | Out-Null
  [Win]::SetForegroundWindow($t.H) | Out-Null
  [Win]::ShowWindow($t.H, 5) | Out-Null
  [Win]::AttachThreadInput($cur, $t1, $false) | Out-Null
  Start-Sleep -Milliseconds 500
  $now = [Win]::GetForegroundWindow()
  Write-Output ('foreground now == target: ' + ($now -eq $t.H))
  $r2 = New-Object Win+RECT
  [Win]::GetWindowRect($t.H, [ref]$r2) | Out-Null
  Write-Output ('rect now=' + $r2.Left + ',' + $r2.Top + ' ' + ($r2.Right - $r2.Left) + 'x' + ($r2.Bottom - $r2.Top))
}
