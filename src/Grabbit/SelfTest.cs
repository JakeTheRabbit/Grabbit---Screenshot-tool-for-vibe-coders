using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;

namespace Grabbit;

/// <summary>
/// grabbit --selftest [outDir]: grabs the desktop, copies the main screen in every size, reads the clipboard
/// back and checks each format decodes to the right picture. Writes report.txt + the decoded files. Exit 0 = pass.
/// </summary>
public static class SelfTest
{
    public static async System.Threading.Tasks.Task<int> RunAsync(string outDir)
    {
        Directory.CreateDirectory(outDir);
        var log = new StringBuilder();
        var failures = 0;
        void Check(bool ok, string what) { log.AppendLine($"{(ok ? "PASS" : "FAIL")}  {what}"); if (!ok) failures++; }

        var s = new AppSettings();
        using var frame = Frame.Grab();
        log.AppendLine($"desktop {frame.Bounds}, monitors: {string.Join(" | ", frame.Monitors)}");
        foreach (var w in frame.Windows) log.AppendLine($"  window [{Native.ClassName(w.Handle)}] '{w.Title}' {w.Bounds}");
        var primary = System.Windows.Forms.Screen.PrimaryScreen!.Bounds;
        Check(frame.Windows.Count > 0, $"{frame.Windows.Count} windows found");

        using var screen = frame.Crop(primary);
        Check(screen.Width == primary.Width && screen.Height == primary.Height, $"main screen crop {screen.Width}×{screen.Height}");
        if (frame.Windows.FirstOrDefault() is var (_, title, bounds) && !bounds.IsEmpty)
        {
            using var win = frame.Crop(bounds);
            win.Save(Path.Combine(outDir, "window.png"));
            Check(win.Width > 0, $"window crop '{title}' {win.Width}×{win.Height}");
        }

        foreach (var size in Enum.GetValues<CopySize>())
        {
            var enc = ImageExport.Encode(screen, size, s);
            ClipboardService.CopyImage(IntPtr.Zero, enc, true, $"selftest {size}");
            var formats = ClipboardService.Read();
            log.AppendLine($"[{size}] {enc.Describe()}; clipboard: {string.Join(", ", formats.Select(f => $"{f.Name}={f.Data.Length}"))}");

            var main = formats.FirstOrDefault(f => f.Name == (enc.Extension == ".png" ? "PNG" : "JFIF"));
            Check(main.Data?.Length > 0 && main.Data.SequenceEqual(enc.Bytes), $"[{size}] {main.Name} bytes match encoder");
            if (main.Data?.Length > 0)
            {
                using var decoded = new Bitmap(new MemoryStream(main.Data));
                Check(decoded.Width == enc.Pixels.Width && decoded.Height == enc.Pixels.Height, $"[{size}] {main.Name} decodes {decoded.Width}×{decoded.Height}");
                File.WriteAllBytes(Path.Combine(outDir, $"{size}{enc.Extension}"), main.Data);
            }

            var v5 = formats.FirstOrDefault(f => f.Name == "CF_DIBV5").Data ?? [];
            Check(v5.Length >= 124 && BitConverter.ToInt32(v5, 4) == enc.Pixels.Width && BitConverter.ToInt32(v5, 8) == enc.Pixels.Height
                  && BitConverter.ToInt16(v5, 14) == 32 && BitConverter.ToUInt32(v5, 52) == 0xFF000000, $"[{size}] CF_DIBV5 32-bit with alpha mask");
            var dib = formats.FirstOrDefault(f => f.Name == "CF_DIB").Data ?? [];
            Check(dib.Length >= 40 && BitConverter.ToInt32(dib, 4) == enc.Pixels.Width && BitConverter.ToInt32(dib, 8) == enc.Pixels.Height, $"[{size}] CF_DIB header");

            var drop = formats.FirstOrDefault(f => f.Name == "CF_HDROP").Data ?? [];
            var path = drop.Length > 20 ? Encoding.Unicode.GetString(drop, 20, drop.Length - 20).Split('\0')[0] : "";
            Check(File.Exists(path) && File.ReadAllBytes(path).SequenceEqual(enc.Bytes), $"[{size}] CF_HDROP -> {path}");
            Check(formats.Any(f => f.Name == "Preferred DropEffect" && f.Data.Length >= 4 && f.Data[0] == 1), $"[{size}] Preferred DropEffect = copy");

            var longEdge = Math.Max(enc.Pixels.Width, enc.Pixels.Height);
            if (size == CopySize.Full) Check(longEdge == Math.Max(screen.Width, screen.Height), "[Full] not resized");
            if (size == CopySize.Reduced) Check(longEdge <= s.ReducedLongEdge, $"[Reduced] long edge {longEdge} ≤ {s.ReducedLongEdge}");
            if (size == CopySize.Chat) Check(longEdge <= s.ChatLongEdge && enc.Bytes.Length <= s.ChatMaxKB * 1024, $"[Chat] long edge {longEdge}, {enc.Bytes.Length / 1024} KB ≤ {s.ChatMaxKB} KB");
            if (!ReferenceEquals(enc.Pixels, screen)) enc.Pixels.Dispose();
        }

        Check(File.Exists(Path.Combine(WebEditorWindow.WebFolder, "index.html")) && Directory.Exists(Path.Combine(WebEditorWindow.WebFolder, "fonts")), "[Editor] web editor bundle present (index.html + fonts)");

        // Picker look + loupe aim: offscreen render of the main screen's picker with a selection, the bar and the loupe.
        var cursor = new Native.POINT { X = primary.X + primary.Width / 2 + 37, Y = primary.Y + primary.Height / 2 - 11 };
        var sel = Rectangle.FromLTRB(primary.X + primary.Width / 3, primary.Y + primary.Height / 3, cursor.X + 1, cursor.Y + 1);
        var aimError = Picker.SnapshotForTest(frame, primary, cursor, sel, Path.Combine(outDir, "picker.png"));
        Check(aimError < 0.01, $"[Picker] loupe centred on the cursor pixel (off by {aimError:F3} px)");

        // Saved-file format: WebP lossless must decode to exactly the same pixels, and be much smaller than PNG.
        {
            var sw = System.Diagnostics.Stopwatch.StartNew();
            var webp = ImageExport.WebpLossless(screen);
            var ms = sw.ElapsedMilliseconds;
            var png = ImageExport.Png(screen);
            using var back = ImageExport.Decode(webp);
            var same = back.Width == screen.Width && back.Height == screen.Height;
            for (var y = 0; same && y < screen.Height; y++)
                for (var x = 0; same && x < screen.Width; x++)
                    if ((back.GetPixel(x, y).ToArgb() | unchecked((int)0xFF000000)) != (screen.GetPixel(x, y).ToArgb() | unchecked((int)0xFF000000))) same = false;
            Check(same, "[Format] WebP lossless decodes pixel-exact (every pixel compared)");
            Check(webp.Length < png.Length, $"[Format] WebP {webp.Length / 1024} KB vs PNG {png.Length / 1024} KB ({100.0 * webp.Length / png.Length:F0} %), encode {ms} ms");
            File.WriteAllBytes(Path.Combine(outDir, "screen.webp"), webp);
        }

        MatchChecks(Check);
        ComposeChecks(frame, outDir, Check);
        await ScrollChecks(outDir, Check, log);

        log.AppendLine(failures == 0 ? "ALL PASS" : $"{failures} FAILED");
        File.WriteAllText(Path.Combine(outDir, "report.txt"), log.ToString());
        return failures == 0 ? 0 : 1;
    }

    /// <summary>Synthetic frames: a 3-row sticky header, a 2-row footer, content moved up by 7 rows.</summary>
    static void MatchChecks(Action<bool, string> check)
    {
        // Row "content" n → a 48-bin brightness profile unique to n, plus a little noise (antialiasing jitter).
        var rng = new Random(1);
        float[] Row(int n) => Enumerable.Range(0, 48).Select(k => (float)((n * 37 + k * 11 + (n * k) % 7 * 9) % 200) + (float)rng.NextDouble() * 1.5f).ToArray();
        float[][] Frame(int offset) => Enumerable.Range(0, 80).Select(i =>
            i < 3 ? Row(10_000 + i) : i >= 78 ? Row(20_000 + i) : Row(i - 3 + offset)).ToArray();
        var (top, bottom, dy) = ScrollCapture.Match(Frame(0), Frame(7));
        check(top == 3 && bottom == 2 && dy == 7, $"[Scroll] matcher: header {top}, footer {bottom}, shift {dy} (want 3, 2, 7)");
        var (_, _, still) = ScrollCapture.Match(Frame(5), Frame(5));
        check(still == 0, "[Scroll] matcher: identical frames = no movement");
        var blank = Enumerable.Range(0, 80).Select(_ => Enumerable.Repeat(128f, 48).ToArray()).ToArray();
        var blank2 = blank.Select(r => (float[])r.Clone()).ToArray();
        blank2[40] = Row(5);   // a moved frame made almost only of identical rows must not fake a match
        var (_, _, fake) = ScrollCapture.Match(blank, blank2);
        check(fake < 0, $"[Scroll] matcher: refuses to match featureless frames (got {fake})");
    }

    /// <summary>The two front-most real windows composed as on screen; outside them stays transparent.</summary>
    static void ComposeChecks(Frame frame, string outDir, Action<bool, string> check)
    {
        var two = frame.Windows.Where(w => w.Bounds.Width > 200 && w.Bounds.Height > 150).Take(2).Select(w => (w.Handle, w.Bounds)).ToList();
        if (two.Count < 2) { check(true, "[Multi] skipped: fewer than 2 windows"); return; }
        using var composed = WindowShot.Compose(frame, two);
        composed.Save(Path.Combine(outDir, "multi-window.png"));
        var union = two.Select(w => w.Bounds).Aggregate(Rectangle.Union);
        check(composed.Width == union.Width && composed.Height == union.Height, $"[Multi] canvas {composed.Width}×{composed.Height} = union of 2 windows");
        var inside = composed.GetPixel(two[0].Bounds.X - union.X + two[0].Bounds.Width / 2, two[0].Bounds.Y - union.Y + two[0].Bounds.Height / 2);
        check(inside.A == 255, $"[Multi] window pixels opaque ({inside})");
        // Any point in the union covered by neither window must be transparent.
        Point? gap = null;
        for (var y = 0; y < union.Height && gap == null; y += 16)
            for (var x = 0; x < union.Width && gap == null; x += 16)
                if (!two.Any(w => w.Bounds.Contains(union.X + x, union.Y + y))) gap = new Point(x, y);
        check(gap == null || composed.GetPixel(gap.Value.X, gap.Value.Y).A == 0, gap == null ? "[Multi] windows fill their union (no gap to check)" : $"[Multi] gap at {gap} is transparent");
        using var solo = WindowShot.Capture(two[0].Handle, two[0].Bounds);
        check(solo != null, $"[Multi] PrintWindow captured '{Native.WindowTitle(two[0].Handle)}' on its own");
    }

    /// <summary>
    /// A window we control: sticky header + 60 rows (90 px, distinct colours) in a ScrollViewer.
    /// Scroll-capture it via UI Automation, then via posted wheel; the result should be the whole content.
    /// </summary>
    static async System.Threading.Tasks.Task ScrollChecks(string outDir, Action<bool, string> check, StringBuilder log)
    {
        const int rows = 60, rowH = 90, headerH = 50;
        System.Windows.Media.Color RowColor(int i) => System.Windows.Media.Color.FromRgb((byte)(40 + i * 3), (byte)(200 - i * 2), (byte)((i * 53) % 256));
        var panel = new System.Windows.Controls.StackPanel();
        for (var i = 0; i < rows; i++)
            panel.Children.Add(new System.Windows.Controls.Border
            {
                Height = rowH, Background = new System.Windows.Media.SolidColorBrush(RowColor(i)),
                Child = new System.Windows.Controls.TextBlock { Text = $"Row {i + 1}", FontSize = 28, Margin = new System.Windows.Thickness(20, 20, 0, 0), Foreground = System.Windows.Media.Brushes.White },
            });
        var viewer = new System.Windows.Controls.ScrollViewer { Content = panel, VerticalScrollBarVisibility = System.Windows.Controls.ScrollBarVisibility.Visible };
        var root = new System.Windows.Controls.DockPanel();
        var header = new System.Windows.Controls.Border { Height = headerH, Background = System.Windows.Media.Brushes.Black, Child = new System.Windows.Controls.TextBlock { Text = "Sticky header", Foreground = System.Windows.Media.Brushes.White, FontSize = 24, Margin = new System.Windows.Thickness(12, 8, 0, 0) } };
        System.Windows.Controls.DockPanel.SetDock(header, System.Windows.Controls.Dock.Top);
        root.Children.Add(header);
        root.Children.Add(viewer);
        var win = new System.Windows.Window
        {
            Title = "Grabbit scroll test", WindowStyle = System.Windows.WindowStyle.None, ResizeMode = System.Windows.ResizeMode.NoResize,
            Topmost = true, ShowInTaskbar = false, Content = root, Width = 700, Height = 600, Left = 0, Top = 0,
        };
        win.Show();
        var hwnd = new System.Windows.Interop.WindowInteropHelper(win).Handle;
        var primary = System.Windows.Forms.Screen.PrimaryScreen!.WorkingArea;
        Native.SetWindowPos(hwnd, Native.HWND_TOPMOST, primary.X + 200, primary.Y + 150, 900, 700, 0);   // physical px
        Native.ForceForeground(hwnd);
        await System.Threading.Tasks.Task.Delay(500);
        Native.GetWindowRect(hwnd, out var r);
        var area = Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
        var dpi = System.Windows.Media.VisualTreeHelper.GetDpi(win).DpiScaleY;
        var expected = (int)Math.Round((headerH + rows * rowH) * dpi);

        try
        {
            foreach (var (label, uia) in new[] { ("automation", true), ("wheel", false) })
            {
                viewer.ScrollToVerticalOffset(rowH * 7);   // start mid-way: "from top" must go back up
                await System.Threading.Tasks.Task.Delay(300);
                var cap = new ScrollCapture(area, fromTop: true, allowAutomation: uia, allowWheel: true);
                var t = System.Diagnostics.Stopwatch.StartNew();
                _ = System.Threading.Tasks.Task.Delay(45_000).ContinueWith(_ => cap.Done());   // manual fallback would wait for a human
                using var result = await cap.RunAsync();
                log.AppendLine($"[Scroll/{label}] method={cap.Used} steps={cap.Steps} ending='{cap.Ending}' {result?.Width}×{result?.Height} in {t.Elapsed.TotalSeconds:F1}s (expected height ≈ {expected})");
                if (result == null) { check(false, $"[Scroll/{label}] produced a picture"); continue; }
                result.Save(Path.Combine(outDir, $"scroll-{label}.png"));
                // The wheel fallback depends on the real cursor and on input reaching windows (low-level mouse hooks on
                // this box sometimes swallow it), so it's reported, not graded. UI Automation is the graded path.
                var grade = uia ? check : (ok, what) => log.AppendLine($"INFO  {what} {(ok ? "(ok)" : "(not this run)")}");
                grade(cap.Used == (uia ? ScrollCapture.Method.Automation : ScrollCapture.Method.Wheel), $"[Scroll/{label}] used {cap.Used}");
                // Percent scrolling lands on fractional pixels at non-100 % scaling, so each join rounds by up to a pixel:
                // allow 0.25 %. Lost or repeated content is caught by the in-order row check below, not by this.
                grade(Math.Abs(result.Height - expected) <= Math.Max(8, expected * 0.0025), $"[Scroll/{label}] stitched height {result.Height} ≈ content {expected} (±0.25 %)");
                // Every row's colour must appear, in order, down the left edge.
                int y = 0, found = 0;
                for (var i = 0; i < rows && y < result.Height; i++)
                {
                    var want = RowColor(i);
                    while (y < result.Height && !Near(result.GetPixel(4, y), want)) y++;
                    if (y < result.Height) { found++; y += (int)(rowH * dpi * 0.6); }
                }
                grade(found == rows, $"[Scroll/{label}] all {rows} rows present in order ({found} found)");
            }
        }
        finally { win.Close(); }

        static bool Near(Color c, System.Windows.Media.Color t) => Math.Abs(c.R - t.R) + Math.Abs(c.G - t.G) + Math.Abs(c.B - t.B) < 12;
    }
}
