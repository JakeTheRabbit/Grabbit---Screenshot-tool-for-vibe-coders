using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Linq;
using System.Runtime.InteropServices;
using Rect32 = System.Drawing.Rectangle;

namespace Grabbit;

/// <summary>Windows captured on their own (even when covered), and several composed as they sit on screen.</summary>
public static class WindowShot
{
    const uint PW_RENDERFULLCONTENT = 2;   // includes DirectComposition / GPU content (browsers, UWP)

    /// <summary>The window's visible frame via PrintWindow; null when the app renders nothing that way (some games, DRM).</summary>
    public static Bitmap? Capture(IntPtr hwnd, Rect32 frame)
    {
        if (!Native.GetWindowRect(hwnd, out var r)) return null;
        var full = Rect32.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
        if (full.Width <= 0 || full.Height <= 0) return null;
        using var bmp = new Bitmap(full.Width, full.Height, PixelFormat.Format32bppArgb);
        bool ok;
        using (var g = Graphics.FromImage(bmp))
        {
            var dc = g.GetHdc();
            ok = Native.PrintWindow(hwnd, dc, PW_RENDERFULLCONTENT);
            g.ReleaseHdc(dc);
        }
        if (!ok) return null;
        var crop = frame;
        crop.Offset(-full.X, -full.Y);   // drop the invisible resize border / shadow margin
        crop.Intersect(new Rect32(0, 0, full.Width, full.Height));
        if (crop.Width <= 0 || crop.Height <= 0) return null;
        var shot = bmp.Clone(crop, PixelFormat.Format32bppArgb);
        if (!MakeOpaque(shot)) { shot.Dispose(); return null; }
        return shot;
    }

    /// <summary>
    /// PrintWindow leaves alpha at 0 for GDI-drawn windows; force it opaque.
    /// Returns false if the picture is (almost) all black, i.e. the window didn't really render.
    /// </summary>
    static bool MakeOpaque(Bitmap bmp)
    {
        var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
        try
        {
            var px = new int[bmp.Width * bmp.Height];
            Marshal.Copy(data.Scan0, px, 0, px.Length);   // 32bpp: stride == width * 4
            long lit = 0;
            for (var i = 0; i < px.Length; i++)
            {
                if ((px[i] & 0x00FFFFFF) > 0x00101010) lit++;
                px[i] |= unchecked((int)0xFF000000);
            }
            Marshal.Copy(px, 0, data.Scan0, px.Length);
            return lit > px.Length / 200;
        }
        finally { bmp.UnlockBits(data); }
    }

    /// <summary>
    /// Compose windows (front-to-back order, as in <see cref="Frame.Windows"/>) on a transparent canvas the size of
    /// their union, each at its screen position. Falls back to the frozen frame for a window PrintWindow can't draw.
    /// </summary>
    public static Bitmap Compose(Frame frame, IReadOnlyList<(IntPtr Handle, Rect32 Bounds)> windows)
    {
        var union = windows.Select(w => w.Bounds).Aggregate(Rect32.Union);
        var canvas = new Bitmap(union.Width, union.Height, PixelFormat.Format32bppArgb);
        using var g = Graphics.FromImage(canvas);
        g.Clear(Color.Transparent);
        foreach (var (handle, bounds) in windows.Reverse())   // back first, so front windows land on top
        {
            using var shot = Capture(handle, bounds) ?? frame.Crop(bounds);
            g.DrawImageUnscaled(shot, bounds.X - union.X, bounds.Y - union.Y);
        }
        return canvas;
    }
}
