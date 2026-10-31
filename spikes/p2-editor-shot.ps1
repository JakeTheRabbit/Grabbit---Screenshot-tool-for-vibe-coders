# Open an image in Grabbit's editor and save a screenshot of the editor window (no input injected).
param([string]$Image = 'C:\Github\apps\grabbit\spikes\p2-selftest\Full.png', [string]$Out = 'C:\Github\apps\grabbit\spikes\p2-editor-window.png')
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class E {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(P p, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  public struct RECT { public int L, T, R, B; }
  public static IntPtr Find(uint pid, string prefix) { IntPtr hit = IntPtr.Zero; EnumWindows((h,l) => { uint p; GetWindowThreadProcessId(h, out p); var s = new StringBuilder(256); GetWindowText(h, s, 256); if (p == pid && IsWindowVisible(h) && s.ToString().StartsWith(prefix)) { hit = h; return false; } return true; }, IntPtr.Zero); return hit; }
}
"@
[void][E]::SetProcessDpiAwarenessContext([IntPtr]-4)
Add-Type -AssemblyName System.Drawing
$exe = 'C:\Github\apps\grabbit\src\Grabbit\bin\Debug\net10.0-windows\Grabbit.exe'
if (-not (Get-Process Grabbit -ErrorAction SilentlyContinue)) { Start-Process $exe -ArgumentList '--background'; Start-Sleep 3 }
$gid = [uint32](Get-Process Grabbit | Sort-Object StartTime | Select-Object -First 1).Id   # the tray instance, not a relaying one
if (-not [E]::Find($gid, 'Grabbit —').ToInt64()) { Start-Process $exe -ArgumentList '--open', "`"$Image`"" }
$h = [IntPtr]::Zero
foreach ($i in 1..40) { $h = [E]::Find($gid, 'Grabbit —');if ($h -ne [IntPtr]::Zero) { break }; Start-Sleep -Milliseconds 150 }
if ($h -eq [IntPtr]::Zero) { 'editor window not found'; Get-Content "$env:APPDATA\Grabbit\log.txt" -Tail 6; exit 1 }
Start-Sleep -Milliseconds 1200
$r = New-Object E+RECT; [void][E]::DwmGetWindowAttribute($h, 9, [ref]$r, 16)
$w = $r.R - $r.L; $hh = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc(); [void][E]::PrintWindow($h, $dc, 2); $g.ReleaseHdc($dc); $g.Dispose()
$bmp.Save($Out); $bmp.Dispose()
"editor window $h at $($r.L),$($r.T) size ${w}x$hh -> $Out"
