using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Interop;
using Rect32 = System.Drawing.Rectangle;

namespace Grabbit;

/// <summary>
/// Scroll-and-stitch capture of an area of the live screen.
/// Scrolls the content itself, never with fake mouse input: UI Automation <see cref="ScrollPattern"/> first,
/// then posted WM_MOUSEWHEEL, and if the app moves for neither, the user scrolls and we stitch what appears.
/// Frames are matched by row signatures; rows that don't move (sticky headers, footers, scroll bars) are kept once.
/// </summary>
public sealed class ScrollCapture
{
    public enum Method { Automation, Wheel, Manual }

    public Method Used { get; private set; }
    public int Steps { get; private set; }
    public string Ending { get; private set; } = "";

    const int MaxHeight = 50_000, MaxSteps = 400;
    readonly Rect32 area;
    readonly bool fromTop;
    readonly bool allowAutomation, allowWheel;
    readonly Native.POINT center;
    ScrollPattern? scroller;
    volatile bool stop, cancel;

    public ScrollCapture(Rect32 area, bool fromTop, bool allowAutomation = true, bool allowWheel = true)
    {
        this.area = area;
        this.fromTop = fromTop;
        this.allowAutomation = allowAutomation;
        this.allowWheel = allowWheel;
        center = new Native.POINT { X = area.X + area.Width / 2, Y = area.Y + area.Height / 2 };
    }

    /// <summary>Finish with what's been stitched so far.</summary>
    public void Done() => stop = true;
    public void Cancel() { cancel = true; stop = true; }

    /// <summary>Returns the stitched picture, or null if cancelled.</summary>
    public async Task<Bitmap?> RunAsync(Action<string>? status = null)
    {
        if (allowAutomation) scroller = await Task.Run(FindScroller);   // UIA off the UI thread: our own windows would deadlock it
        Used = scroller != null ? Method.Automation : allowWheel ? Method.Wheel : Method.Manual;
        Log.Write($"scroll capture {area} fromTop={fromTop} method={Used}");

        if (fromTop && Used != Method.Manual)
        {
            status?.Invoke("Going to the top…");
            await ToTop();
        }

        var (first, firstRows) = await GrabSettled();
        var steps = new List<(Bitmap Frame, int Dy, int Bottom)>();
        Bitmap prev = first;
        var prevRows = firstRows;
        int total = first.Height, unit = 0, k = 1, still = 0;
        var owned = new List<Bitmap> { first };

        while (!stop)
        {
            if (Used == Method.Manual)
            {
                status?.Invoke("Scroll the window yourself (slowly) · Done when finished · Esc cancels");
                await Task.Delay(120);
            }
            else
            {
                status?.Invoke(Used == Method.Wheel
                    ? $"Scrolling… {total} px · don't move the mouse · Esc stops"   // wheel follows the real cursor
                    : $"Scrolling… {total} px · Esc stops");
                await Step(k);
            }

            var (next, rows) = Used == Method.Manual ? Grab() : await GrabSettled();
            var (top, bottom, dy) = Match(prevRows, rows);

            if (dy == 0)   // nothing moved
            {
                next.Dispose();
                if (Used == Method.Manual) continue;
                if (Steps == 0 && Used == Method.Automation && allowWheel) { Used = Method.Wheel; Log.Write("scroll: automation didn't move, trying wheel"); continue; }
                if (Steps == 0) { Used = Method.Manual; Log.Write("scroll: wheel didn't move, manual"); continue; }
                if (++still >= 2) { Ending = "reached the end"; break; }
                continue;
            }
            if (dy < 0)   // moved, but too far to find the overlap
            {
                Log.Write($"scroll: no match: {LastMatch}");
                if (Environment.GetEnvironmentVariable("GRABBIT_SCROLL_DEBUG") is { Length: > 0 } dbg)
                {
                    System.IO.Directory.CreateDirectory(dbg);
                    prev.Save(System.IO.Path.Combine(dbg, $"miss{Steps}-a.png"));
                    next.Save(System.IO.Path.Combine(dbg, $"miss{Steps}-b.png"));
                }
                next.Dispose();
                if (Steps == 0 && k > 1) { k = 1; continue; }
                if (Used == Method.Automation && percentStep > 0.2)   // back up and take smaller bites
                {
                    var sp = scroller!;
                    var back = percentStep;
                    await Task.Run(() => sp.SetScrollPercent(ScrollPattern.NoScroll, Math.Max(0, sp.Current.VerticalScrollPercent - back)));
                    percentStep /= 2;
                    Log.Write($"scroll: overlap lost, step now {percentStep:F2}%");
                    await GrabSettled();
                    continue;
                }
                Ending = "lost track of the overlap (scrolled too far in one step)";
                break;
            }

            still = 0;
            owned.Add(next);
            steps.Add((next, dy, bottom));
            var z1 = next.Height - bottom;
            total += dy;
            Steps++;
            if (unit == 0) { unit = Math.Max(1, dy / k); k = Math.Clamp((int)(0.5 * (z1 - top) / unit), 1, 20); }   // half a view per step keeps a safe overlap
            prev = next;
            prevRows = rows;
            if (total >= MaxHeight || Steps >= MaxSteps) { Ending = "hit the size limit"; break; }
        }
        RestoreCursor();
        if (stop && Ending == "") Ending = cancel ? "cancelled" : "stopped";
        Log.Write($"scroll capture ended: {Ending}, method={Used}, steps={Steps}, height={total}");

        try
        {
            if (cancel) return null;
            if (steps.Count == 0) return new Bitmap(first);
            // One footer height for the whole capture: the smallest "unchanged at the bottom" band any step saw.
            // A real sticky footer is there every step; a stretch that only looked unchanged once (plain colour) isn't.
            var footerH = steps.Min(s => s.Bottom);
            var slices = new List<(Bitmap Src, int Y0, int Y1)> { (first, 0, first.Height - footerH) };
            foreach (var (frameBmp, dy, _) in steps)
            {
                var z1 = frameBmp.Height - footerH;
                slices.Add((frameBmp, z1 - dy, z1));
            }
            slices.Add((prev, prev.Height - footerH, prev.Height));
            var height = slices.Sum(s => s.Y1 - s.Y0);
            var result = new Bitmap(area.Width, height, PixelFormat.Format32bppArgb);
            using var g = Graphics.FromImage(result);
            var y = 0;
            foreach (var (src, y0, y1) in slices)
            {
                if (y1 <= y0) continue;
                g.DrawImage(src, new Rectangle(0, y, src.Width, y1 - y0), new Rectangle(0, y0, src.Width, y1 - y0), GraphicsUnit.Pixel);
                y += y1 - y0;
            }
            return result;
        }
        finally { foreach (var b in owned) b.Dispose(); }
    }

    // ---------- scrolling ----------

    double percentStep;   // > 0: step by scroll percentage (exact, app-independent); else by "small increment"

    ScrollPattern? FindScroller()
    {
        try
        {
            var el = AutomationElement.FromPoint(new System.Windows.Point(center.X, center.Y));
            for (var depth = 0; el != null && depth < 30; depth++)
            {
                if (el.TryGetCurrentPattern(ScrollPattern.Pattern, out var p) && p is ScrollPattern sp && sp.Current.VerticallyScrollable)
                {
                    // Half of what our area shows per step. VerticalViewSize = % of the content the scroller shows;
                    // our area may be only part of the scroller, so scale by the area's share of its height.
                    var view = sp.Current.VerticalViewSize;
                    var height = el.Current.BoundingRectangle.Height;
                    if (view is > 0 and < 100 && height > 0)
                        percentStep = view * 0.5 * Math.Min(1, area.Height / height);
                    Log.Write($"scroll: UIA scroller '{el.Current.ClassName}' view={view:F1}% at={sp.Current.VerticalScrollPercent:F1}% height={height} step={percentStep:F2}%");
                    return sp;
                }
                el = TreeWalker.ControlViewWalker.GetParent(el);
            }
        }
        catch (Exception ex) { Log.Write("scroll: UIA lookup failed: " + ex.Message); }
        return null;
    }

    async Task Step(int notches)
    {
        if (Used == Method.Automation && scroller != null)
        {
            var sp = scroller;
            var step = percentStep;
            await Task.Run(() =>
            {
                if (step > 0)
                {
                    var at = sp.Current.VerticalScrollPercent;
                    if (at >= 0) { sp.SetScrollPercent(ScrollPattern.NoScroll, Math.Min(100, at + step)); return; }
                }
                for (var i = 0; i < notches; i++) sp.ScrollVertical(ScrollAmount.SmallIncrement);
            });
        }
        else Wheel(-120 * notches);
    }

    Native.POINT? restoreCursor;

    /// <summary>
    /// Posted wheel at the right edge of the area. Most apps (WPF, Chromium) send wheel to whatever is under the real
    /// cursor, so the cursor is parked there too: over the scroll bar column, which the row signatures ignore.
    /// </summary>
    void Wheel(int delta)
    {
        var park = new Native.POINT { X = area.Right - 8, Y = center.Y };
        if (restoreCursor == null && Native.GetCursorPos(out var was)) { restoreCursor = was; Native.SetCursorPos(park.X, park.Y); }
        var target = Native.WindowFromPoint(park);
        var wParam = (IntPtr)((delta & 0xFFFF) << 16);
        var lParam = (IntPtr)(((park.Y & 0xFFFF) << 16) | (park.X & 0xFFFF));
        Native.PostMessage(target, Native.WM_MOUSEWHEEL, wParam, lParam);
    }

    void RestoreCursor()
    {
        if (restoreCursor is { } p) Native.SetCursorPos(p.X, p.Y);
        restoreCursor = null;
    }

    async Task ToTop()
    {
        if (Used == Method.Automation && scroller != null)
        {
            var sp = scroller;
            try { await Task.Run(() => sp.SetScrollPercent(ScrollPattern.NoScroll, 0)); }
            catch (Exception ex) { Log.Write("scroll: SetScrollPercent failed: " + ex.Message); }
            return;
        }
        var last = Grab().Rows;
        for (var round = 0; round < 40 && !stop; round++)   // wheel up until the picture stops changing
        {
            for (var i = 0; i < 10; i++) Wheel(120);
            var (b, rows) = await GrabSettled();
            b.Dispose();
            if (Same(rows, last)) break;
            last = rows;
        }
    }

    // ---------- frames ----------

    const int Bins = 48;

    (Bitmap Image, float[][] Rows) Grab()
    {
        var b = new Bitmap(area.Width, area.Height, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(b)) g.CopyFromScreen(area.X, area.Y, 0, 0, area.Size, CopyPixelOperation.SourceCopy);
        return (b, RowFeatures(b));
    }

    /// <summary>Grab until two frames in a row agree (smooth scrolling and lazy loading settle), max ~0.8 s.</summary>
    async Task<(Bitmap, float[][])> GrabSettled()
    {
        await Task.Delay(90);
        var (b, rows) = Grab();
        for (var i = 0; i < 10; i++)
        {
            await Task.Delay(70);
            var (b2, rows2) = Grab();
            if (Same(rows2, rows)) { b2.Dispose(); break; }
            b.Dispose();
            (b, rows) = (b2, rows2);
        }
        return (b, rows);
    }

    public static bool Same(float[][] a, float[][] b)
    {
        if (a.Length != b.Length) return false;
        for (var i = 0; i < a.Length; i++) if (Dist(a[i], b[i]) > 0.5f) return false;
        return true;
    }

    /// <summary>
    /// Each row as 48 bins of mean brightness, ignoring the right-hand strip where scroll bars live.
    /// Coarse on purpose: at fractional DPI scroll offsets text is re-antialiased, so exact pixels never repeat.
    /// </summary>
    public static float[][] RowFeatures(Bitmap b)
    {
        var data = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            var w = Math.Max(Bins, b.Width - Math.Min(24, b.Width / 10));
            var row = new int[b.Width];
            var rows = new float[b.Height][];
            var counts = new int[Bins];
            for (var y = 0; y < b.Height; y++)
            {
                Marshal.Copy(data.Scan0 + y * data.Stride, row, 0, b.Width);
                var f = new float[Bins];
                Array.Clear(counts);
                for (var x = 0; x < w && x < b.Width; x++)
                {
                    var px = row[x];
                    var lum = (((px >> 16) & 0xFF) * 299 + ((px >> 8) & 0xFF) * 587 + (px & 0xFF) * 114) / 1000f;
                    var bin = x * Bins / w;
                    f[bin] += lum;
                    counts[bin]++;
                }
                for (var k = 0; k < Bins; k++) f[k] /= Math.Max(1, counts[k]);
                rows[y] = f;
            }
            return rows;
        }
        finally { b.UnlockBits(data); }
    }

    static float Dist(float[] a, float[] b)
    {
        float s = 0;
        for (var k = 0; k < a.Length; k++) s += Math.Abs(a[k] - b[k]);
        return s / a.Length;
    }

    /// <summary>
    /// How far content moved up between two frames. top/bottom = rows unchanged at the same place (sticky bands).
    /// dy = 0: nothing moved; dy &lt; 0: moved but no trustworthy overlap.
    /// Only "informative" rows (different from the row above: text, edges) vote, so flat stretches can't fake a
    /// match, and the winning shift must be far better than a typical one.
    /// </summary>
    public static string LastMatch = "";

    public static (int Top, int Bottom, int Dy) Match(float[][] a, float[][] b)
    {
        const float SameRow = 1.0f;
        var h = Math.Min(a.Length, b.Length);
        var top = 0;
        while (top < h && Dist(a[top], b[top]) < SameRow) top++;
        if (top == h) return (0, 0, 0);
        var bottom = 0;
        while (bottom < h - top && Dist(a[h - 1 - bottom], b[h - 1 - bottom]) < SameRow) bottom++;
        int z0 = top, z1 = h - bottom, len = z1 - z0;

        var informative = new List<int>();
        for (var i = z0 + 1; i < z1; i++) if (Dist(b[i], b[i - 1]) > 2f) informative.Add(i);
        if (informative.Count < 4) { LastMatch = $"too few informative rows ({informative.Count})"; return (top, bottom, -1); }

        float best = float.MaxValue;
        var bestDy = -1;
        var costs = new List<float>();
        for (var dy = 1; dy < len - 4; dy++)
        {
            float sum = 0;
            var n = 0;
            foreach (var i in informative)
            {
                if (i + dy >= z1) break;
                sum += Dist(a[i + dy], b[i]);
                n++;
            }
            if (n < Math.Max(4, informative.Count / 8)) break;   // too little overlap left to judge
            var cost = sum / n;
            costs.Add(cost);
            if (cost < best) { best = cost; bestDy = dy; }
        }
        if (bestDy < 0) { LastMatch = $"no candidate (informative={informative.Count}, zone={z0}..{z1})"; return (top, bottom, -1); }
        costs.Sort();
        var median = costs[costs.Count / 2];
        LastMatch = $"best dy={bestDy} cost={best:F2} median={median:F2} informative={informative.Count} zone={z0}..{z1}";
        return best < 6f && best < median * 0.35f ? (top, bottom, bestDy) : (top, bottom, -1);
    }
}

/// <summary>Small floating status for a scrolling capture: what's happening, Done, Cancel (Esc). Never captured itself.</summary>
public sealed class ScrollStatusWindow : Window
{
    readonly TextBlock text = new() { Margin = new Thickness(4, 0, 12, 0), VerticalAlignment = VerticalAlignment.Center, MinWidth = 260 };
    readonly ScrollCapture capture;
    HwndSource? source;

    public ScrollStatusWindow(ScrollCapture capture, Rect32 area)
    {
        this.capture = capture;
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.NoResize;
        SizeToContent = SizeToContent.WidthAndHeight;
        Topmost = true;
        ShowInTaskbar = false;
        ShowActivated = false;
        var done = new Button { Content = "Done", Padding = new Thickness(12, 4, 12, 4), Margin = new Thickness(4) };
        var cancel = new Button { Content = "Cancel", Padding = new Thickness(12, 4, 12, 4), Margin = new Thickness(4) };
        done.Click += (_, _) => capture.Done();
        cancel.Click += (_, _) => capture.Cancel();
        Content = new Border
        {
            Padding = new Thickness(8), BorderThickness = new Thickness(1), BorderBrush = System.Windows.Media.Brushes.Gray,
            Child = new StackPanel { Orientation = Orientation.Horizontal, Children = { text, done, cancel } },
        };
        SourceInitialized += (_, _) =>
        {
            var h = new WindowInteropHelper(this).Handle;
            Native.ExcludeFromCapture(h);
            source = HwndSource.FromHwnd(h);
            source.AddHook(Hook);
            Native.RegisterHotKey(h, 0x5C01, 0, 0x1B);   // Esc anywhere cancels while scrolling
        };
        Loaded += (_, _) =>
        {
            // Under the area if there's room on that screen, else just inside its bottom edge.
            var screen = System.Windows.Forms.Screen.FromRectangle(area).WorkingArea;
            var dpi = System.Windows.Media.VisualTreeHelper.GetDpi(this).DpiScaleX;
            var w = (int)(ActualWidth * dpi);
            var hgt = (int)(ActualHeight * dpi);
            var x = Math.Clamp(area.X + (area.Width - w) / 2, screen.X, screen.Right - w);
            var y = area.Bottom + 12 + hgt <= screen.Bottom ? area.Bottom + 12 : Math.Max(screen.Y, area.Bottom - hgt - 12);
            Native.SetWindowPos(new WindowInteropHelper(this).Handle, Native.HWND_TOPMOST, x, y, 0, 0, Native.SWP_NOACTIVATE | 0x1 /* NOSIZE */);
        };
        Closed += (_, _) => Native.UnregisterHotKey(new WindowInteropHelper(this).Handle, 0x5C01);
    }

    public void Status(string s) => Dispatcher.Invoke(() => text.Text = s);

    IntPtr Hook(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg == Native.WM_HOTKEY && wParam.ToInt32() == 0x5C01) { capture.Cancel(); handled = true; }
        return IntPtr.Zero;
    }
}
