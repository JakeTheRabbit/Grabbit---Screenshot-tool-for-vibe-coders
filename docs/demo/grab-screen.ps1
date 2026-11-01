# Screen grab of a physical-pixel rectangle (for README shots of overlays the picker can't show).
param([int]$X, [int]$Y, [int]$W, [int]$H, [string]$Out)
Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public static class Dpi { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr v); }
"@
[Dpi]::SetProcessDpiAwarenessContext([System.IntPtr]::new(-4)) | Out-Null
Add-Type -AssemblyName System.Drawing
$b = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($b)
$g.CopyFromScreen($X, $Y, 0, 0, $b.Size)
$b.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $b.Dispose()
