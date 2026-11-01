using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Linq;
using Rect32 = System.Drawing.Rectangle;
using Screen = System.Windows.Forms.Screen;

namespace Grabbit;

/// <summary>A frozen copy of the whole desktop plus the windows that were on it, captured at the hotkey press.</summary>
public sealed class Frame : IDisposable
{
    public Bitmap Image { get; }
    /// <summary>Virtual-desktop origin of <see cref="Image"/> (physical px; can be negative on left/top monitors).</summary>
    public Rect32 Bounds { get; }
    public IReadOnlyList<Rect32> Monitors { get; }
    /// <summary>Top-level windows, front to back, with their visible frame (no invisible resize border).</summary>
    public IReadOnlyList<(IntPtr Handle, string Title, Rect32 Bounds)> Windows { get; }

    Frame(Bitmap image, Rect32 bounds, IReadOnlyList<Rect32> monitors, IReadOnlyList<(IntPtr, string, Rect32)> windows)
    {
        Image = image; Bounds = bounds; Monitors = monitors; Windows = windows;
    }

    /// <summary>A frame from a picture, with no windows (README shots of the picker).</summary>
    internal static Frame FromImage(Bitmap image) => new(image, new Rect32(0, 0, image.Width, image.Height), [new Rect32(0, 0, image.Width, image.Height)], []);

    public static Frame Grab()
    {
        var monitors = Screen.AllScreens.Select(s => s.Bounds).ToList();
        var bounds = monitors.Aggregate(Rect32.Union);
        var windows = TopLevelWindows();   // before the picker opens, so it never lists itself
        var bmp = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
            g.CopyFromScreen(bounds.X, bounds.Y, 0, 0, bounds.Size, CopyPixelOperation.SourceCopy);   // DWM composes layered windows in; CaptureBlt is rejected by this API
        return new Frame(bmp, bounds, monitors, windows);
    }

    /// <summary>Copy of part of the frame. <paramref name="area"/> is in desktop coordinates and is clipped to the frame.</summary>
    public Bitmap Crop(Rect32 area)
    {
        var r = Rect32.Intersect(area, Bounds);
        r.Offset(-Bounds.X, -Bounds.Y);
        return Image.Clone(r, PixelFormat.Format32bppArgb);
    }

    public Rect32 MonitorAt(int x, int y) => Monitors.FirstOrDefault(m => m.Contains(x, y), Monitors[0]);

    /// <summary>Front-most window under a desktop point; the desktop itself counts as no window.</summary>
    public (IntPtr Handle, string Title, Rect32 Bounds)? WindowAt(int x, int y)
    {
        foreach (var w in Windows)
            if (w.Bounds.Contains(x, y)) return w;
        return null;
    }

    static List<(IntPtr, string, Rect32)> TopLevelWindows()
    {
        var own = (uint)Environment.ProcessId;
        var list = new List<(IntPtr, string, Rect32)>();
        Native.EnumWindows((h, _) =>   // EnumWindows walks z-order, front to back
        {
            if (!Native.IsWindowVisible(h) || Native.IsIconic(h)) return true;
            Native.GetWindowThreadProcessId(h, out var pid);
            if (pid == own || Native.IsGhost(h)) return true;
            if (Native.DwmGetWindowAttribute(h, Native.DWMWA_CLOAKED, out int cloaked, sizeof(int)) == 0 && cloaked != 0) return true;   // other virtual desktops, suspended UWP
            var cls = Native.ClassName(h);
            if (cls is "Progman" or "WorkerW") return true;   // the desktop: falls through to "whole screen"
            if (Native.DwmGetWindowAttribute(h, Native.DWMWA_EXTENDED_FRAME_BOUNDS, out Native.RECT r, 16) != 0 && !Native.GetWindowRect(h, out r)) return true;
            var rect = Rect32.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
            if (rect.Width < 8 || rect.Height < 8) return true;
            list.Add((h, Native.WindowTitle(h), rect));
            return true;
        }, IntPtr.Zero);
        return list;
    }

    public void Dispose() => Image.Dispose();
}
