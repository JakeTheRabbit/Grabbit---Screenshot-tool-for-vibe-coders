# Which window is under (1000,500) while the picker is open, and does a click reach it?
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class H {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public struct POINT { public int X, Y; }
}
"@
[void][H]::SetProcessDpiAwarenessContext([IntPtr]-4)
$exe = 'C:\Github\apps\grabbit\src\Grabbit\bin\Debug\net10.0-windows\Grabbit.exe'
$log = Join-Path $env:APPDATA 'Grabbit\log.txt'
if (-not (Get-Process Grabbit -ErrorAction SilentlyContinue)) { Start-Process $exe -ArgumentList '--background'; Start-Sleep 3 }
$n = (Get-Content $log).Count
Start-Process $exe -ArgumentList '--capture'
foreach ($i in 1..50) { if ((Get-Content $log | Select-Object -Skip $n) -match 'picker window') { break }; Start-Sleep -Milliseconds 100 }
Start-Sleep -Milliseconds 400
[void][H]::SetCursorPos(1000, 500)
$p = New-Object H+POINT; $p.X = 1000; $p.Y = 500
$h = [H]::GetAncestor([H]::WindowFromPoint($p), 2)
$pid2 = 0; [void][H]::GetWindowThreadProcessId($h, [ref]$pid2)
$sb = New-Object Text.StringBuilder 256; [void][H]::GetClassName($h, $sb, 256)
"under cursor: $h class=$sb process=$((Get-Process -Id $pid2).Name)"
[H]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 80; [H]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 1200
Get-Content $log | Select-Object -Skip $n
if (-not ((Get-Content $log -Tail 3) -match 'delivered')) { Get-Process Grabbit | Stop-Process -Force; 'stopped Grabbit (no delivery)' }
