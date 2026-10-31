# Scroll-capture a long page in a throwaway Edge instance (own temp profile; the user's Edge is untouched).
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class W {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(P p, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint f);
  public struct RECT { public int L, T, R, B; }
  public static IntPtr Find(string title) { IntPtr hit = IntPtr.Zero; EnumWindows((h,l) => { var s = new StringBuilder(256); GetWindowText(h, s, 256); if (IsWindowVisible(h) && s.ToString().StartsWith(title)) { hit = h; return false; } return true; }, IntPtr.Zero); return hit; }
}
"@
[void][W]::SetProcessDpiAwarenessContext([IntPtr]-4)
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP "grabbit-edge-test"
$page = 'file:///C:/Github/apps/grabbit/spikes/p3-longpage.html'
$out = 'C:\Github\apps\grabbit\spikes\p3-edge-scroll.png'
$p = Start-Process $edge -ArgumentList "--user-data-dir=`"$profile`"", '--no-first-run', '--no-default-browser-check', "--app=$page", '--window-size=1000,800', '--window-position=200,150' -PassThru
$h = [IntPtr]::Zero
foreach ($i in 1..60) { $h = [W]::Find('Grabbit scroll test page'); if ($h -ne [IntPtr]::Zero) { break }; Start-Sleep -Milliseconds 250 }
if ($h -eq [IntPtr]::Zero) { 'edge window not found' } else {
  Start-Sleep 2
  # Pin the throwaway window on top so the capture (and UI Automation's point lookup) can only hit it.
  [void][W]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x3)
  Start-Sleep -Milliseconds 500
  $r = New-Object W+RECT; [void][W]::DwmGetWindowAttribute($h, 9, [ref]$r, 16)
  # The page viewport: below Edge's app title bar (skip the top 40 px of the frame).
  $area = "{0},{1},{2},{3}" -f ($r.L + 1), ($r.T + 40), ($r.R - $r.L - 2), ($r.B - $r.T - 41)
  "edge window $h frame $($r.L),$($r.T),$($r.R),$($r.B) -> area $area"
  $g = Start-Process 'C:\Github\apps\grabbit\src\Grabbit\bin\Debug\net10.0-windows\Grabbit.exe' -ArgumentList '--scroll-area', $area, "`"$out`"", 'fromtop' -PassThru
  if (-not $g.WaitForExit(180000)) { $g.Kill(); 'grabbit TIMEOUT' }
  "grabbit exit $($g.ExitCode): $(Get-Content "$out.txt" -ErrorAction SilentlyContinue)"
}
# Close only the throwaway instance (matched by its private profile folder).
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like "*grabbit-edge-test*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
"throwaway edge closed"
