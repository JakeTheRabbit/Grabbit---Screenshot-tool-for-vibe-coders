Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class X {
 public delegate bool P(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(P p, IntPtr l);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern bool GetLayeredWindowAttributes(IntPtr h, out uint key, out byte alpha, out uint flags);
}
"@
$global:o=@()
[X]::EnumWindows({ param($h,$l) if ([X]::IsWindowVisible($h)) { $s=New-Object Text.StringBuilder 256; [void][X]::GetClassName($h,$s,256); $c=$s.ToString()
 if ($c -match 'CEF-OSC|LogiOverlay|Cua\.|Chrome_WidgetWin_1|CabinetWClass|Shell_TrayWnd|TeamScreen|Outlook') { $ex=[X]::GetWindowLongPtr($h,-20).ToInt64(); $st=[X]::GetWindowLongPtr($h,-16).ToInt64(); $k=0;$a=0;$f=0; $lay=[X]::GetLayeredWindowAttributes($h,[ref]$k,[ref]$a,[ref]$f)
  $global:o += "{0,-40} ex=0x{1:X8} style=0x{2:X8} layeredAttr={3} alpha={4} flags={5}" -f $c.Substring(0,[Math]::Min(40,$c.Length)),$ex,$st,$lay,$a,$f } }; $true }, [IntPtr]::Zero) | Out-Null
$global:o
