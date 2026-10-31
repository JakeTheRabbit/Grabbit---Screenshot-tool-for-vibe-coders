using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Rect32 = System.Drawing.Rectangle;
using System.Windows.Media.Animation;
using System.Windows.Shapes;
using WpfRectangle = System.Windows.Shapes.Rectangle;
using WpfPath = System.Windows.Shapes.Path;

namespace Grabbit;

public enum Outcome { Copy, Edit, Save, CopyPath, Record }

/// <summary>
/// What the user chose in the picker and what to do with it (<paramref name="Size"/> null = the hotkey's size).
/// <paramref name="Windows"/>: several windows picked with Ctrl+click. <paramref name="Scroll"/>: scrolling capture
/// (<paramref name="FromTop"/> when a whole window was picked: start at the top and take everything).
/// </summary>
public sealed record Pick(Rect32 Area, string What, Outcome Outcome, CopySize? Size,
    IReadOnlyList<(IntPtr Handle, Rect32 Bounds)>? Windows = null, bool Scroll = false, bool FromTop = false);

/// <summary>
/// Snipping-style picker drawn over the frozen frame: drag = region, click = window under the cursor
/// (click on the desktop = that screen), Ctrl+click = add/remove windows for a multi-window capture,
/// F = whole screen, Esc / right-click = cancel.
/// After a selection, <see cref="AfterCapture.Ask"/> shows a bar at the mouse (Copy · Smaller · Chat size · Edit · Scroll).
/// Held while letting go of a drag: Ctrl = edit, Shift = copy smaller, Alt = copy chat-sized (skips the bar).
/// <paramref name="scrollMode"/>: tray "Scrolling capture" — the selection starts scrolling straight away.
/// </summary>
public static class Picker
{
    static List<PickerWindow>? open;

    public static bool IsOpen => open != null;

    /// <param name="recordMode">tray / hotkey "Record": the selection starts a recording straight away.</param>
    public static void Show(Frame frame, AfterCapture after, Action<Pick> picked, bool scrollMode = false, bool recordMode = false)
    {
        if (open != null) return;
        Native.POINT? start = null;
        var dragging = false;
        var selection = Rect32.Empty;
        (Rect32 Area, string What, bool IsWindow)? pending = null;   // selected, waiting for a choice on the bar
        var multi = new List<(IntPtr Handle, string Title, Rect32 Bounds)>();
        var source = ImageExport.ToSource(frame.Image);

        void Close()
        {
            foreach (var w in open!) w.Close();
            open = null;
        }

        void Finish(Rect32 area, string what, Outcome outcome, CopySize? size, bool scroll = false, bool fromTop = false)
        {
            // Multi-window keeps the screen's front-to-back order so overlaps compose the way they looked.
            var windows = multi.Count > 0 && !scroll
                ? frame.Windows.Where(w => multi.Any(m => m.Handle == w.Handle)).Select(w => (w.Handle, w.Bounds)).ToList()
                : null;
            Close();
            picked(new Pick(area, what, outcome, size, windows, scroll, fromTop));
        }

        void Choose(Outcome outcome, CopySize? size, bool scroll)
        {
            if (pending is { } p) Finish(p.Area, p.What, outcome, size, scroll, scroll && p.IsWindow);
        }

        void ShowChoice(Rect32 area, string what, bool isWindow)
        {
            pending = (area, what, isWindow);
            foreach (var o in open!)
            {
                o.Highlight(area, $"{what} · {area.Width} × {area.Height}", true);
                o.Marks(multi.Select(m => m.Bounds));
                o.HideLoupe();
            }
            Native.GetCursorPos(out var at);   // the bar opens where the mouse let go
            var host = open!.FirstOrDefault(o => o.Monitor.Contains(at.X, at.Y)) ?? open!.OrderByDescending(o => Overlap(o.Monitor, area)).First();
            foreach (var o in open!) if (o != host) o.HideBar();
            host.ShowBar(at, canScroll: multi.Count == 0);
        }

        void Release(Rect32 area, string what, bool isWindow)
        {
            var mods = Keyboard.Modifiers;
            if (scrollMode) Finish(area, what, Outcome.Copy, null, scroll: true, fromTop: isWindow);
            else if (recordMode) Finish(area, what, Outcome.Record, null);
            else if (mods.HasFlag(ModifierKeys.Control)) Finish(area, what, Outcome.Edit, null);
            else if (mods.HasFlag(ModifierKeys.Shift)) Finish(area, what, Outcome.Copy, CopySize.Reduced);
            else if (mods.HasFlag(ModifierKeys.Alt)) Finish(area, what, Outcome.Copy, CopySize.Chat);
            else if (after == AfterCapture.Ask) ShowChoice(area, what, isWindow);
            else Finish(area, what, after == AfterCapture.Edit ? Outcome.Edit : Outcome.Copy, null);
        }

        /// <summary>Ctrl+click: add or remove a window; the bar then acts on all of them.</summary>
        void ToggleWindow((IntPtr Handle, string Title, Rect32 Bounds) win)
        {
            var i = multi.FindIndex(m => m.Handle == win.Handle);
            if (i >= 0) multi.RemoveAt(i); else multi.Add(win);
            if (multi.Count == 0) { ClearPending(); Hover(); return; }
            var union = multi.Select(m => m.Bounds).Aggregate(Rect32.Union);
            ShowChoice(union, multi.Count == 1 ? Label(multi[0].Title, multi[0].Bounds).Split(" · ")[0] : $"{multi.Count} windows", false);
        }

        void ClearPending()
        {
            pending = null;
            multi.Clear();
            foreach (var o in open!) { o.HideBar(); o.Marks([]); }
        }

        void Hover()
        {
            if (pending != null) return;
            Native.GetCursorPos(out var p);
            var w = frame.WindowAt(p.X, p.Y);
            var r = w?.Bounds ?? frame.MonitorAt(p.X, p.Y);
            foreach (var o in open!) o.Highlight(r, w is { } win ? Label(win.Title, r) : $"Whole screen · {r.Width} × {r.Height}", false);
        }

        var hint = scrollMode
            ? "Scrolling capture:  click a window to take everything you could scroll to  ·  or drag the area that scrolls  ·  Esc cancel"
            : recordMode
            ? "Record:  drag an area  ·  click a window  ·  click the desktop or F for the whole screen  ·  Esc cancel"
            : "Drag a region  ·  Click a window  ·  Ctrl+click several windows  ·  F whole screen  ·  hold Ctrl = edit, Shift = smaller, Alt = chat  ·  Esc cancel";
        open = frame.Monitors.Distinct().Select(m => new PickerWindow(m, frame.Bounds, source, Choose, hint, Close)).ToList();
        foreach (var w in open)
        {
            w.MouseLeftButtonDown += (_, _) =>   // buttons on the bar mark the click handled, so this is the image
            {
                // Clicking away from the bar starts a new selection; Ctrl+click keeps building a multi-window set.
                if (pending != null && !(Keyboard.Modifiers.HasFlag(ModifierKeys.Control) && multi.Count > 0)) ClearPending();
                Native.GetCursorPos(out var p);
                start = p;
                dragging = false;
                w.CaptureMouse();
            };
            w.MouseMove += (_, _) =>
            {
                Native.GetCursorPos(out var p);
                if (pending == null) foreach (var o in open!) o.Loupe(p, start is { } d && dragging ? $"{Math.Abs(p.X - d.X) + 1} × {Math.Abs(p.Y - d.Y) + 1}" : null);
                if (start is not { } s) { Hover(); return; }
                if (!dragging && Math.Abs(p.X - s.X) < 5 && Math.Abs(p.Y - s.Y) < 5) return;   // still a click
                dragging = true;
                selection = Rect32.FromLTRB(Math.Min(s.X, p.X), Math.Min(s.Y, p.Y), Math.Max(s.X, p.X) + 1, Math.Max(s.Y, p.Y) + 1);
                foreach (var o in open!) o.Highlight(selection, $"{selection.Width} × {selection.Height}", true);
            };
            w.MouseLeftButtonUp += (_, _) =>
            {
                if (start is not { } s) return;
                w.ReleaseMouseCapture();
                start = null;
                if (dragging && selection.Width > 2 && selection.Height > 2) { Release(selection, "Region", false); return; }
                var win = frame.WindowAt(s.X, s.Y);
                if (win is { } hit && Keyboard.Modifiers.HasFlag(ModifierKeys.Control) && !scrollMode && !recordMode) ToggleWindow(hit);
                else if (win is { } one) Release(one.Bounds, string.IsNullOrWhiteSpace(one.Title) ? "Window" : one.Title, true);
                else Release(frame.MonitorAt(s.X, s.Y), "Screen", false);
            };
            w.MouseRightButtonUp += (_, _) => Close();
            w.KeyDown += (_, e) =>
            {
                if (e.Key == Key.Escape) { if (pending != null) { ClearPending(); Hover(); } else Close(); }
                else if (pending != null && e.Key is Key.Enter or Key.C) Choose(Outcome.Copy, null, false);
                else if (pending != null && e.Key == Key.E) Choose(Outcome.Edit, null, false);
                else if (pending != null && e.Key == Key.S && Keyboard.Modifiers.HasFlag(ModifierKeys.Control)) Choose(Outcome.Save, null, false);
                else if (pending != null && e.Key == Key.S && multi.Count == 0) Choose(Outcome.Copy, null, true);
                else if (pending != null && e.Key == Key.P) Choose(Outcome.CopyPath, null, false);
                else if (pending != null && e.Key == Key.R) Choose(Outcome.Record, null, false);
                else if (pending == null && e.Key == Key.F) { Native.GetCursorPos(out var p); Release(frame.MonitorAt(p.X, p.Y), "Screen", false); }
            };
        }
        foreach (var w in open) w.Place();

        Native.GetCursorPos(out var cur);
        var under = open.FirstOrDefault(w => w.Monitor.Contains(cur.X, cur.Y)) ?? open[0];
        var handle = new WindowInteropHelper(under).Handle;
        if (!under.Activate() || Native.GetForegroundWindow() != handle) Native.ForceForeground(handle);
        under.Focus();
        Log.Write($"picker foreground: {Native.GetForegroundWindow() == handle}");
        Hover();
    }

    /// <summary>
    /// Self-test: lay out a picker for one monitor offscreen with a selection, the bar and the loupe at <paramref name="cursor"/>,
    /// render it to <paramref name="png"/>, and return how far (in pixels) the loupe's centre is from the cursor's pixel.
    /// </summary>
    internal static double SnapshotForTest(Frame frame, Rect32 monitor, Native.POINT cursor, Rect32 selection, string png)
    {
        var w = new PickerWindow(monitor, frame.Bounds, ImageExport.ToSource(frame.Image), (_, _, _) => { }, "Drag a region  ·  Click a window  ·  Esc cancel", () => { });
        w.Highlight(selection, $"Region · {selection.Width} × {selection.Height}", true);
        w.ShowBar(cursor);
        w.Loupe(cursor, $"{selection.Width} × {selection.Height}");
        w.Settle();
        var root = (FrameworkElement)w.Content;
        // The window places everything in DIPs at its own DPI (the system's, offscreen); lay out and render at that
        // scale so the picture fills the snapshot instead of its top-left 1/scale.
        var s = VisualTreeHelper.GetDpi(w).DpiScaleX;
        var size = new Size(monitor.Width / s, monitor.Height / s);
        root.Measure(size);
        root.Arrange(new Rect(size));
        root.UpdateLayout();
        var rtb = new RenderTargetBitmap(monitor.Width, monitor.Height, 96 * s, 96 * s, PixelFormats.Pbgra32);
        rtb.Render(root);
        var enc = new PngBitmapEncoder();
        enc.Frames.Add(BitmapFrame.Create(rtb));
        using (var f = System.IO.File.Create(png)) enc.Save(f);
        var c = w.LoupeCentrePixels();
        w.Close();
        return Math.Max(Math.Abs(c.X - (cursor.X - monitor.X + 0.5)), Math.Abs(c.Y - (cursor.Y - monitor.Y + 0.5)));
    }

    static long Overlap(Rect32 a, Rect32 b)
    {
        var i = Rect32.Intersect(a, b);
        return i.IsEmpty ? 0 : (long)i.Width * i.Height;
    }

    static string Label(string title, Rect32 r)
    {
        title = title.Length > 60 ? title[..57] + "…" : title;
        return $"{(title.Length > 0 ? title + " · " : "")}{r.Width} × {r.Height}";
    }

    /// <summary>Icon + label pill on the action bar, with hover and press motion.</summary>
    internal sealed class BarButton : Border
    {
        public event Action? Click;

        public BarButton(string glyph, string text, string tip, bool primary = false)
        {
            CornerRadius = new CornerRadius(8);
            Padding = new Thickness(text.Length > 0 ? 11 : 10, 7, text.Length > 0 ? 13 : 10, 7);
            Margin = new Thickness(2, 0, 2, 0);
            Cursor = Cursors.Hand;
            ToolTip = tip;
            RenderTransformOrigin = new Point(0.5, 0.5);
            var scale = new ScaleTransform(1, 1);
            RenderTransform = scale;
            var rest = primary ? Theme.Accent : Color.FromArgb(0, 255, 255, 255);
            var hover = primary ? Theme.AccentHover : Color.FromArgb(34, 255, 255, 255);
            var bg = new SolidColorBrush(rest);
            Background = bg;
            var row = new StackPanel { Orientation = Orientation.Horizontal };
            row.Children.Add(new TextBlock
            {
                Text = glyph, FontFamily = Theme.Icons, FontSize = 15, Foreground = Brushes.White, VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(0, 0, text.Length > 0 ? 7 : 0, 0),
            });
            if (text.Length > 0)
                row.Children.Add(new TextBlock { Text = text, FontFamily = Theme.Font, FontSize = 13, FontWeight = FontWeights.SemiBold, Foreground = Brushes.White, VerticalAlignment = VerticalAlignment.Center });
            Child = row;

            void Press(double to) { scale.BeginAnimation(ScaleTransform.ScaleXProperty, Theme.Ease(to, 80)); scale.BeginAnimation(ScaleTransform.ScaleYProperty, Theme.Ease(to, 80)); }
            MouseEnter += (_, _) => bg.BeginAnimation(SolidColorBrush.ColorProperty, new ColorAnimation(hover, Theme.Fast));
            MouseLeave += (_, _) => { bg.BeginAnimation(SolidColorBrush.ColorProperty, new ColorAnimation(rest, Theme.Fast)); Press(1); };
            MouseLeftButtonDown += (_, e) => { Press(0.94); e.Handled = true; };
            MouseLeftButtonUp += (_, e) => { Press(1); e.Handled = true; Click?.Invoke(); };
        }
    }

    internal static class Theme
    {
        public static readonly Color Accent = Color.FromRgb(56, 132, 255), AccentHover = Color.FromRgb(86, 152, 255);
        public static readonly FontFamily Font = new("Segoe UI Variable Text, Segoe UI");
        public static readonly FontFamily Icons = new("Segoe Fluent Icons, Segoe MDL2 Assets");
        public static readonly FontFamily Mono = new("Cascadia Mono, Consolas");
        public static readonly Duration Fast = new(TimeSpan.FromMilliseconds(110));
        public static readonly IEasingFunction Out = new CubicEase { EasingMode = EasingMode.EaseOut };
        public static DoubleAnimation Ease(double to, int ms) => new(to, TimeSpan.FromMilliseconds(ms)) { EasingFunction = Out };
        public static Brush Panel => new SolidColorBrush(Color.FromArgb(236, 22, 22, 26));
        public static Brush Edge => new SolidColorBrush(Color.FromArgb(40, 255, 255, 255));
        public static System.Windows.Media.Effects.Effect Shadow(double blur = 26, double depth = 6) =>
            new System.Windows.Media.Effects.DropShadowEffect { BlurRadius = blur, ShadowDepth = depth, Direction = 270, Opacity = 0.45, Color = Colors.Black };
    }

    sealed class PickerWindow : Window
    {
        public Rect32 Monitor { get; }

        // One animated rectangle drives both the hole in the dim layer and the selection outline, so they glide together.
        readonly RectangleGeometry full = new();
        readonly RectangleGeometry hole = new(Rect.Empty);
        readonly WpfPath dim = new() { Fill = new SolidColorBrush(Color.FromArgb(140, 6, 8, 12)), IsHitTestVisible = false };
        readonly WpfPath glow = new() { Stroke = new SolidColorBrush(Color.FromArgb(70, 255, 255, 255)), StrokeThickness = 4, IsHitTestVisible = false };
        readonly WpfPath outline = new() { Stroke = new SolidColorBrush(Theme.Accent), StrokeThickness = 2, IsHitTestVisible = false };
        readonly Canvas handles = new() { IsHitTestVisible = false };
        readonly TextBlock labelText = new() { Foreground = Brushes.White, FontSize = 12.5, FontFamily = Theme.Font, FontWeight = FontWeights.SemiBold };
        readonly Border label;
        readonly Border bar;
        readonly Border hint;
        readonly Canvas marks = new() { IsHitTestVisible = false };
        readonly BarButton scrollButton;

        public PickerWindow(Rect32 monitor, Rect32 desktop, BitmapSource frame, Action<Outcome, CopySize?, bool> choose, string hintText, Action closeAll)
        {
            Monitor = monitor;
            ThemeMode = ThemeMode.None;
            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.NoResize;
            Topmost = true;
            ShowInTaskbar = false;
            Cursor = Cursors.Cross;
            Title = "Grabbit";
            Background = Brushes.Black;
            UseLayoutRounding = true;

            // This monitor's slice of the frozen frame, stretched to the window so DPI never matters.
            slice = new CroppedBitmap(frame, new Int32Rect(monitor.X - desktop.X, monitor.Y - desktop.Y, monitor.Width, monitor.Height));
            slice.Freeze();
            var picture = new Image { Source = slice, Stretch = Stretch.Fill };
            RenderOptions.SetBitmapScalingMode(picture, BitmapScalingMode.NearestNeighbor);

            dim.Data = new CombinedGeometry(GeometryCombineMode.Exclude, full, hole);
            glow.Data = hole;
            outline.Data = hole;

            label = new Border
            {
                Background = Theme.Panel, CornerRadius = new CornerRadius(7), Padding = new Thickness(9, 4, 9, 5),
                BorderBrush = Theme.Edge, BorderThickness = new Thickness(1), Child = labelText, Visibility = Visibility.Collapsed, IsHitTestVisible = false,
            };
            var canvas = new Canvas { IsHitTestVisible = false };
            canvas.Children.Add(label);

            hint = new Border
            {
                Background = Theme.Panel, CornerRadius = new CornerRadius(20), BorderBrush = Theme.Edge, BorderThickness = new Thickness(1),
                Padding = new Thickness(18, 9, 18, 10), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Top,
                Margin = new Thickness(0, 22, 0, 0), IsHitTestVisible = false, Effect = Theme.Shadow(20, 4),
                Child = new TextBlock { Foreground = new SolidColorBrush(Color.FromArgb(230, 255, 255, 255)), FontSize = 13, FontFamily = Theme.Font, Text = hintText },
            };

            BarButton Act(string glyph, string text, string tip, Outcome outcome, CopySize? size, bool primary = false, bool scroll = false)
            {
                var b = new BarButton(glyph, text, tip, primary);
                b.Click += () => choose(outcome, size, scroll);
                return b;
            }
            static Border Divider() => new() { Width = 1, Margin = new Thickness(5, 6, 5, 6), Background = new SolidColorBrush(Color.FromArgb(46, 255, 255, 255)) };
            var close = new BarButton("", "", "Close without capturing (Esc twice)");
            close.Click += closeAll;
            bar = new Border
            {
                Background = Theme.Panel, CornerRadius = new CornerRadius(12), BorderBrush = Theme.Edge, BorderThickness = new Thickness(1),
                Padding = new Thickness(5), HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Top,
                Visibility = Visibility.Collapsed, Cursor = Cursors.Arrow, Effect = Theme.Shadow(),
                RenderTransformOrigin = new Point(0, 0), RenderTransform = new ScaleTransform(1, 1),
                Child = new StackPanel
                {
                    Orientation = Orientation.Horizontal,
                    Children =
                    {
                        Act("", "Copy", "Copy full size (Enter or C)", Outcome.Copy, CopySize.Full, primary: true),
                        Act("", "Smaller", "Copy with the long edge cut down (Shift as you let go)", Outcome.Copy, CopySize.Reduced),
                        Act("", "Chat", "Copy as a small JPEG for chat apps (Alt as you let go)", Outcome.Copy, CopySize.Chat),
                        Divider(),
                        Act("", "Edit", "Open in the editor to draw on it (E, or Ctrl as you let go)", Outcome.Edit, null),
                        (scrollButton = Act("", "Scroll", "Scrolling capture (S): a window is captured top to bottom; an area scrolls down from where it is", Outcome.Copy, null, scroll: true)),
                        Divider(),
                        Act("", "Save", "Save to the Grabbit folder, leave the clipboard alone (Ctrl+S)", Outcome.Save, null),
                        Act("", "Copy path", "Save, then copy the file's path in quotes, like Explorer's Copy as path (P)", Outcome.CopyPath, null),
                        Divider(),
                        Act("", "Record", "Record this area as a video (R); stop from the bar under it", Outcome.Record, null),
                        Divider(),
                        close,
                    },
                },
            };

            // Loupe: 21 × 21 source pixels at 8×, pixel grid, crosshair, the centre pixel framed.
            // Sized per DPI in SizeLens so every zoomed pixel is a whole number of screen pixels: at 150 % a plain
            // 176-DIP lens gives 12.57 px per pixel, and the pixels and the grid drift apart (looks doubled).
            loupeBrush = new ImageBrush(slice) { ViewboxUnits = BrushMappingMode.Absolute, Stretch = Stretch.Fill };
            zoomed = new Border { Background = loupeBrush };
            RenderOptions.SetBitmapScalingMode(zoomed, BitmapScalingMode.NearestNeighbor);
            gridTile = new RectangleGeometry();
            gridBrush = new DrawingBrush
            {
                TileMode = TileMode.Tile, ViewportUnits = BrushMappingMode.Absolute,
                Drawing = new GeometryDrawing(null, new Pen(new SolidColorBrush(Color.FromArgb(28, 255, 255, 255)), 0.6), gridTile),
            };
            var grid = new Rectangle { IsHitTestVisible = false, Fill = gridBrush };
            var crossBrush = new SolidColorBrush(Color.FromArgb(120, 56, 132, 255));
            crossV = new Rectangle { Fill = crossBrush, HorizontalAlignment = HorizontalAlignment.Center, IsHitTestVisible = false };
            crossH = new Rectangle { Fill = crossBrush, VerticalAlignment = VerticalAlignment.Center, IsHitTestVisible = false };
            centre = new Rectangle { Stroke = Brushes.White, StrokeThickness = 1.5, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, IsHitTestVisible = false };
            lens = new Grid { Children = { zoomed, grid, crossV, crossH, centre } };
            SizeLens(1);
            // The shadow sits on its own layer: an Effect on the lens itself renders it through a resampled surface.
            loupe = new Grid
            {
                HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Top, IsHitTestVisible = false, Visibility = Visibility.Collapsed,
                Children =
                {
                    new Border { Background = Theme.Panel, CornerRadius = new CornerRadius(12), Effect = Theme.Shadow(22, 5) },
                    new Border
                    {
                        Background = Theme.Panel, CornerRadius = new CornerRadius(12), BorderBrush = Theme.Edge, BorderThickness = new Thickness(1), Padding = new Thickness(5),
                        Child = new StackPanel { Children = { lens, new DockPanel { Margin = new Thickness(4, 6, 4, 2), Children = { loupeSwatch, loupeText } } } },
                    },
                },
            };
            DockPanel.SetDock(loupeSwatch, Dock.Left);
            Content = new Grid { Children = { picture, dim, marks, glow, outline, handles, canvas, hint, bar, loupe } };
        }

        const int LoupeSpan = 21;
        readonly CroppedBitmap slice;
        readonly ImageBrush loupeBrush;
        readonly Grid loupe, lens;
        readonly Border zoomed;
        readonly DrawingBrush gridBrush;
        readonly RectangleGeometry gridTile;
        readonly Rectangle crossV, crossH, centre;
        double lensScale;
        bool loupeLeft, loupeUp;   // which side of the cursor it sits on; kept until it stops fitting, so it never flickers between sides
        // Fixed width: text that grows and shrinks as you move would otherwise nudge the loupe across the flip point.
        readonly TextBlock loupeText = new() { Foreground = Brushes.White, FontSize = 12, FontFamily = Theme.Mono, VerticalAlignment = VerticalAlignment.Center, LineHeight = 17, Width = 150, TextTrimming = TextTrimming.CharacterEllipsis };
        readonly Rectangle loupeSwatch = new() { Width = 16, Height = 16, RadiusX = 4, RadiusY = 4, Margin = new Thickness(0, 0, 8, 0), Stroke = new SolidColorBrush(Color.FromArgb(90, 255, 255, 255)), StrokeThickness = 1, VerticalAlignment = VerticalAlignment.Center };

        public void Place()
        {
            WindowStartupLocation = WindowStartupLocation.Manual;
            var h = new WindowInteropHelper(this).EnsureHandle();
            Native.ExcludeFromCapture(h);   // never appear in anyone's capture
            Fit(h);
            dim.Opacity = 0;
            Show();
            Fit(h);
            dim.BeginAnimation(OpacityProperty, Theme.Ease(1, 160));   // the screen eases into the dimmed picker
            // The hint steps back after a few seconds so it doesn't sit on what you're aiming at.
            hint.BeginAnimation(OpacityProperty, new DoubleAnimation(0.45, TimeSpan.FromMilliseconds(600)) { BeginTime = TimeSpan.FromSeconds(4) });
            // WPF re-applies its own size after layout and after a DPI change; put the exact bounds back each time.
            DpiChanged += (_, _) => Fit(h);
            Dispatcher.BeginInvoke(System.Windows.Threading.DispatcherPriority.Loaded, () =>
            {
                Fit(h);
                Native.GetWindowRect(h, out var r);
                Log.Write($"picker window {r.Left},{r.Top},{r.Right - r.Left}x{r.Bottom - r.Top} for monitor {Monitor} (frame {slice.DpiX:0} dpi)");
            });
        }

        void Fit(IntPtr h)
        {
            for (var i = 0; i < 2; i++)   // twice: the first move can trigger a DPI rescale
                Native.SetWindowPos(h, Native.HWND_TOPMOST, Monitor.X, Monitor.Y, Monitor.Width, Monitor.Height, Native.SWP_NOACTIVATE);
        }

        double Scale => VisualTreeHelper.GetDpi(this).DpiScaleX;

        Rect Local(Rect32 r)
        {
            var s = Scale;
            return new Rect((r.X - Monitor.X) / s, (r.Y - Monitor.Y) / s, r.Width / s, r.Height / s);
        }

        public void Highlight(Rect32 area, string text, bool dragging)
        {
            var s = Scale;
            full.Rect = new Rect(0, 0, Monitor.Width / s, Monitor.Height / s);
            var part = Rect32.Intersect(area, Monitor);
            handles.Children.Clear();
            if (part.IsEmpty)
            {
                hole.BeginAnimation(RectangleGeometry.RectProperty, null);
                hole.Rect = Rect.Empty;
                label.Visibility = Visibility.Collapsed;
                return;
            }
            var r = Local(part);
            // Hover glides from window to window; a drag follows the mouse exactly.
            if (!dragging && !hole.Rect.IsEmpty)
                hole.BeginAnimation(RectangleGeometry.RectProperty, new RectAnimation(r, Theme.Fast) { EasingFunction = Theme.Out });
            else { hole.BeginAnimation(RectangleGeometry.RectProperty, null); hole.Rect = r; }
            outline.Opacity = dragging ? 1 : 0.85;
            outline.StrokeDashArray = dragging ? null : new DoubleCollection { 5, 3 };
            if (dragging)
                foreach (var (x, y) in new[] { (r.Left, r.Top), (r.Right, r.Top), (r.Left, r.Bottom), (r.Right, r.Bottom) })
                {
                    var dot = new Ellipse { Width = 9, Height = 9, Fill = Brushes.White, Stroke = new SolidColorBrush(Theme.Accent), StrokeThickness = 2 };
                    Canvas.SetLeft(dot, x - 4.5); Canvas.SetTop(dot, y - 4.5);
                    handles.Children.Add(dot);
                }
            labelText.Text = text;
            label.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
            var top = r.Y >= label.DesiredSize.Height + 8 ? r.Y - label.DesiredSize.Height - 6 : r.Y + 6;
            Canvas.SetLeft(label, Math.Max(4, r.X));
            Canvas.SetTop(label, top);
            label.Visibility = Visibility.Visible;
        }

        /// <summary>Outlines for every window in a multi-window set.</summary>
        public void Marks(IEnumerable<Rect32> areas)
        {
            marks.Children.Clear();
            foreach (var a in areas)
            {
                var part = Rect32.Intersect(a, Monitor);
                if (part.IsEmpty) continue;
                var r = Local(part);
                var box = new Rectangle
                {
                    Width = r.Width, Height = r.Height, RadiusX = 6, RadiusY = 6, Stroke = new SolidColorBrush(Theme.Accent), StrokeThickness = 2.5,
                    Fill = new SolidColorBrush(Color.FromArgb(36, 56, 132, 255)),
                };
                Canvas.SetLeft(box, r.X); Canvas.SetTop(box, r.Y);
                marks.Children.Add(box);
            }
        }

        /// <summary>Bar just below-right of the mouse (flipped left/up near the screen edge), popping in under your hand.</summary>
        public void ShowBar(Native.POINT at, bool canScroll = true)
        {
            scrollButton.Visibility = canScroll ? Visibility.Visible : Visibility.Collapsed;
            var s = Scale;
            double mx = (at.X - Monitor.X) / s, my = (at.Y - Monitor.Y) / s;
            bar.Visibility = Visibility.Visible;
            bar.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
            var size = bar.DesiredSize;
            double w = Monitor.Width / s, h = Monitor.Height / s;
            var right = mx + 14 + size.Width <= w - 8;
            var below = my + 14 + size.Height <= h - 8;
            var x = right ? mx + 14 : mx - 14 - size.Width;
            var y = below ? my + 14 : my - 14 - size.Height;
            bar.Margin = new Thickness(Math.Clamp(x, 8, Math.Max(8, w - size.Width - 8)), Math.Clamp(y, 8, Math.Max(8, h - size.Height - 8)), 0, 0);
            bar.RenderTransformOrigin = new Point(right ? 0 : 1, below ? 0 : 1);   // grows out of the cursor's corner
            var scale = (ScaleTransform)bar.RenderTransform;
            scale.BeginAnimation(ScaleTransform.ScaleXProperty, new DoubleAnimation(0.92, 1, TimeSpan.FromMilliseconds(170)) { EasingFunction = new BackEase { Amplitude = 0.3, EasingMode = EasingMode.EaseOut } });
            scale.BeginAnimation(ScaleTransform.ScaleYProperty, new DoubleAnimation(0.92, 1, TimeSpan.FromMilliseconds(170)) { EasingFunction = new BackEase { Amplitude = 0.3, EasingMode = EasingMode.EaseOut } });
            bar.BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(120)));
            Cursor = Cursors.Arrow;
        }

        public void HideBar()
        {
            bar.Visibility = Visibility.Collapsed;
            Cursor = Cursors.Cross;
        }

        /// <summary>Greenshot-style loupe: 21 px around the cursor at 8×, crosshair on the exact pixel, position / size / colour.</summary>
        public void Loupe(Native.POINT p, string? size)
        {
            if (!Monitor.Contains(p.X, p.Y)) { HideLoupe(); return; }
            int lx = p.X - Monitor.X, ly = p.Y - Monitor.Y;
            // Viewbox is in the bitmap's DIPs, not pixels: a 144-dpi frame (150 % screen) is 1.5× smaller in DIPs.
            // Converting here is what keeps the zoom centred on the pixel under the cursor.
            var k = 96.0 / slice.DpiX;
            loupeBrush.Viewbox = new Rect((lx - LoupeSpan / 2) * k, (ly - LoupeSpan / 2) * k, LoupeSpan * k, LoupeSpan * k);
            var c = PixelAt(lx, ly);
            loupeText.Text = $"{p.X}, {p.Y}{(size != null ? $"   {size}" : "")}\n#{c.R:X2}{c.G:X2}{c.B:X2}";
            loupeSwatch.Fill = new SolidColorBrush(c);
            var s = Scale;
            SizeLens(s);
            double mx = lx / s, my = ly / s, w = Monitor.Width / s, h = Monitor.Height / s;
            loupe.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
            var ls = loupe.DesiredSize;
            // Keep clear of the cursor and on screen; change sides only when the current side runs out of room.
            if (loupeLeft ? mx - 26 - ls.Width < 0 : mx + 26 + ls.Width > w) loupeLeft = !loupeLeft;
            if (loupeUp ? my - 26 - ls.Height < 0 : my + 26 + ls.Height > h) loupeUp = !loupeUp;
            var x = Math.Clamp(loupeLeft ? mx - 26 - ls.Width : mx + 26, 0, Math.Max(0, w - ls.Width));
            var y = Math.Clamp(loupeUp ? my - 26 - ls.Height : my + 26, 0, Math.Max(0, h - ls.Height));
            loupe.Margin = new Thickness(Math.Round(x * s) / s, Math.Round(y * s) / s, 0, 0);   // on whole screen pixels
            if (loupe.Visibility != Visibility.Visible)
            {
                loupe.Visibility = Visibility.Visible;
                loupe.BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(120)));
            }
        }

        public void HideLoupe() => loupe.Visibility = Visibility.Collapsed;

        /// <summary>A whole number (8 or more) of screen pixels per zoomed pixel at this window's DPI.</summary>
        void SizeLens(double s)
        {
            if (s == lensScale) return;
            lensScale = s;
            var cell = Math.Round(8.4 * s) / s;
            var size = cell * LoupeSpan;
            lens.Width = lens.Height = zoomed.Width = zoomed.Height = size;
            lens.Clip = new RectangleGeometry(new Rect(0, 0, size, size), 8, 8);
            gridTile.Rect = new Rect(0, 0, cell, cell);
            gridBrush.Viewport = new Rect(0, 0, cell, cell);
            crossV.Width = crossH.Height = cell;
            centre.Width = centre.Height = cell + 3;
        }

        /// <summary>Jump every entrance animation to its end (offscreen snapshot for the self-test).</summary>
        public void Settle()
        {
            foreach (var el in new UIElement[] { bar, loupe, dim, hint }) { el.BeginAnimation(OpacityProperty, null); el.Opacity = 1; }
            var s = (ScaleTransform)bar.RenderTransform;
            s.BeginAnimation(ScaleTransform.ScaleXProperty, null); s.BeginAnimation(ScaleTransform.ScaleYProperty, null);
            s.ScaleX = s.ScaleY = 1;
        }

        /// <summary>Exact frame pixel under the cursor, for the colour readout and the self-test.</summary>
        public Color PixelAt(int x, int y)
        {
            if (x < 0 || y < 0 || x >= slice.PixelWidth || y >= slice.PixelHeight) return Colors.Black;
            var px = new byte[4];
            slice.CopyPixels(new Int32Rect(x, y, 1, 1), px, 4, 0);
            return Color.FromRgb(px[2], px[1], px[0]);
        }

        /// <summary>What the loupe's centre is showing (for the self-test): the Viewbox centre, back in pixels.</summary>
        public Point LoupeCentrePixels()
        {
            var v = loupeBrush.Viewbox;
            var k = slice.DpiX / 96.0;
            return new Point((v.X + v.Width / 2) * k, (v.Y + v.Height / 2) * k);
        }
    }
}
