# Phase 1 end-to-end: tray app running -> capture command (as a hotkey would) -> real mouse drag / click in the
# picker -> check the log, the saved PNG and the clipboard. Kills Grabbit if a step doesn't deliver, so no picker is left up.
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class H {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, IntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public struct POINT { public int X, Y; }
}
"@
[void][H]::SetProcessDpiAwarenessContext([IntPtr]-4)   # physical pixels, same as Grabbit
$exe = 'C:\Github\apps\grabbit\src\Grabbit\bin\Debug\net10.0-windows\Grabbit.exe'
$log = Join-Path $env:APPDATA 'Grabbit\log.txt'
if (-not (Get-Process Grabbit -ErrorAction SilentlyContinue)) { Start-Process $exe -ArgumentList '--background'; Start-Sleep 3 }

function Step([string]$name, [scriptblock]$trigger, [scriptblock]$act) {
  "--- $name"
  $n = (Get-Content $log).Count
  & $trigger
  foreach ($i in 1..50) { if ((Get-Content $log | Select-Object -Skip $n) -match 'picker window') { break }; Start-Sleep -Milliseconds 100 }
  Start-Sleep -Milliseconds 500
  & $act
  Start-Sleep -Milliseconds 1500
  $new = @(Get-Content $log | Select-Object -Skip $n)
  $new | Where-Object { $_ -match 'under|foreground|mouse down|picked|delivered|failed' }
  if (-not ($new -match 'delivered')) { Get-Process Grabbit | Stop-Process -Force; "FAIL: no delivery (Grabbit stopped)"; return }
  Add-Type -AssemblyName System.Windows.Forms
  "  clipboard: " + ([System.Windows.Forms.Clipboard]::GetDataObject().GetFormats() -join ', ')
  $files = [System.Windows.Forms.Clipboard]::GetFileDropList()
  if ($files.Count) { $img = [System.Drawing.Image]::FromFile($files[0]); "  file drop: $($files[0]) $($img.Width)x$($img.Height)"; $img.Dispose() }
}

function Under([int]$x, [int]$y) {
  $p = New-Object H+POINT; $p.X = $x; $p.Y = $y
  $owner = 0; [void][H]::GetWindowThreadProcessId([H]::GetAncestor([H]::WindowFromPoint($p), 2), [ref]$owner)
  Add-Content $log "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff') [e2e] under ($x,$y): $((Get-Process -Id $owner).Name)"
}

$relay = { Start-Process $exe -ArgumentList '--capture' }                                     # second launch relays to the tray app
# Ctrl+Alt+G = Grabbit's own hotkey (PrtScn is held by Greenshot while it runs, so never send PrtScn here).
$ctrlAltG = {
  foreach ($vk in 0x11, 0x12) { [H]::keybd_event($vk, 0, 0, [IntPtr]::Zero) }
  [H]::keybd_event(0x47, 0, 0, [IntPtr]::Zero); [H]::keybd_event(0x47, 0, 2, [IntPtr]::Zero)
  foreach ($vk in 0x12, 0x11) { [H]::keybd_event($vk, 0, 2, [IntPtr]::Zero) }
}
$drag = {
  [void][H]::SetCursorPos(1000, 500); Under 1000 500; Start-Sleep -Milliseconds 100
  [H]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero)
  foreach ($i in 1..10) { [void][H]::SetCursorPos(1000 + 80 * $i, 500 + 50 * $i); Start-Sleep -Milliseconds 30 }
  [H]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)
}
$bigDragShift = {   # 2401x1301 with Shift held at release -> reduced copy (long edge 1920)
  [void][H]::SetCursorPos(200, 200); Start-Sleep -Milliseconds 100
  [H]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero)
  foreach ($i in 1..10) { [void][H]::SetCursorPos(200 + 240 * $i, 200 + 130 * $i); Start-Sleep -Milliseconds 30 }
  [H]::keybd_event(0x10, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 50
  [H]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 50
  [H]::keybd_event(0x10, 0, 2, [IntPtr]::Zero)
}
$click = {
  [void][H]::SetCursorPos(2000, 1000); Under 2000 1000; Start-Sleep -Milliseconds 100
  [H]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 60
  [H]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)
}

Step 'relay launch + drag 1000,500 -> 1800,1000 (expect 801x501, full PNG)' $relay $drag

