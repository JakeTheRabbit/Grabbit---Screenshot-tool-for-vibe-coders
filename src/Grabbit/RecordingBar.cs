using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shapes;
using System.Windows.Threading;
using Rect32 = System.Drawing.Rectangle;
using Theme = Grabbit.Picker.Theme;

namespace Grabbit;

/// <summary>
/// While recording: a red frame round the area and a small bar (timer · Stop · Discard) beside it. Both are
/// excluded from capture, so neither shows up in the video; the frame lets clicks through to what's under it.
/// </summary>
public sealed class RecordingBar : IDisposable
{
    readonly Window frame, bar;

    /// <summary>The bar's panel and timer, for rendering it offscreen (README shots).</summary>
    internal FrameworkElement BarContent => (FrameworkElement)bar.Content;
    internal TextBlock Time { get; private set; } = null!;
    readonly DispatcherTimer tick;

    public RecordingBar(Rect32 area, Recorder? recorder, Action stop, Action discard, string stopKey)
    {
        frame = new Window
        {
            WindowStyle = WindowStyle.None, AllowsTransparency = true, Background = Brushes.Transparent, Topmost = true,
            ShowInTaskbar = false, ShowActivated = false, ResizeMode = ResizeMode.NoResize, Title = "Grabbit recording frame",
            Content = new Border { BorderBrush = new SolidColorBrush(Color.FromArgb(220, 232, 17, 35)), BorderThickness = new Thickness(2) },
        };
        frame.SourceInitialized += (_, _) =>
        {
            var h = new WindowInteropHelper(frame).Handle;
            var ex = Native.GetWindowLongPtr(h, Native.GWL_EXSTYLE).ToInt64();
            Native.SetWindowLongPtr(h, Native.GWL_EXSTYLE, new IntPtr(ex | Native.WS_EX_TRANSPARENT | Native.WS_EX_LAYERED));
            Native.ExcludeFromCapture(h);
            Native.SetWindowPos(h, Native.HWND_TOPMOST, area.X - 2, area.Y - 2, area.Width + 4, area.Height + 4, Native.SWP_NOACTIVATE);
        };

        var dot = new Ellipse { Width = 10, Height = 10, Fill = new SolidColorBrush(Color.FromRgb(232, 17, 35)), Margin = new Thickness(10, 0, 9, 0), VerticalAlignment = VerticalAlignment.Center };
        dot.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(1, 0.25, TimeSpan.FromMilliseconds(700)) { AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever });
        var time = Time = new TextBlock { Text = "0:00", FontFamily = Theme.Mono, FontSize = 14, Foreground = Brushes.White, VerticalAlignment = VerticalAlignment.Center, MinWidth = 52 };
        var size = new TextBlock
        {
            Text = $"{area.Width} × {area.Height}", FontFamily = Theme.Font, FontSize = 12, Margin = new Thickness(0, 0, 8, 0),
            Foreground = new SolidColorBrush(Color.FromArgb(150, 255, 255, 255)), VerticalAlignment = VerticalAlignment.Center,
        };
        var stopButton = new Picker.BarButton("", "Stop", $"Stop and keep the video ({stopKey})", primary: true);
        stopButton.Click += stop;
        var discardButton = new Picker.BarButton("", "", "Stop and throw the recording away");
        discardButton.Click += discard;
        bar = new Window
        {
            WindowStyle = WindowStyle.None, AllowsTransparency = true, Background = Brushes.Transparent, Topmost = true,
            ShowInTaskbar = false, ResizeMode = ResizeMode.NoResize, SizeToContent = SizeToContent.WidthAndHeight, Title = "Grabbit recording",
            Content = new Border
            {
                Background = Theme.Panel, CornerRadius = new CornerRadius(12), BorderBrush = Theme.Edge, BorderThickness = new Thickness(1),
                Padding = new Thickness(5), Margin = new Thickness(12), Effect = Theme.Shadow(), Cursor = Cursors.SizeAll,
                ToolTip = "Drag to move",
                Child = new StackPanel { Orientation = Orientation.Horizontal, Children = { dot, time, size, stopButton, discardButton } },
            },
        };
        bar.MouseLeftButtonDown += (_, _) => { try { bar.DragMove(); } catch (InvalidOperationException) { } };
        bar.SourceInitialized += (_, _) => Native.ExcludeFromCapture(new WindowInteropHelper(bar).Handle);
        bar.Loaded += (_, _) => PlaceBar(area);

        tick = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(250) };
        tick.Tick += (_, _) =>
        {
            if (recorder == null) return;   // README shots: a fixed time
            var t = recorder.Clock.Elapsed;
            time.Text = t.TotalHours >= 1 ? t.ToString(@"h\:mm\:ss") : t.ToString(@"m\:ss");
        };
        tick.Start();
        frame.Show();
        bar.Show();
    }

    /// <summary>Centred under the area if the screen has room, else above it, else just inside its bottom edge.</summary>
    void PlaceBar(Rect32 area)
    {
        var h = new WindowInteropHelper(bar).Handle;
        Native.GetWindowRect(h, out var r);
        int w = r.Right - r.Left, ht = r.Bottom - r.Top;
        var screen = System.Windows.Forms.Screen.FromRectangle(area).Bounds;
        var x = Math.Clamp(area.X + (area.Width - w) / 2, screen.X, screen.Right - w);
        var y = area.Bottom + 4 + ht <= screen.Bottom ? area.Bottom + 4
              : area.Y - 4 - ht >= screen.Y ? area.Y - 4 - ht
              : area.Bottom - ht - 8;
        Native.SetWindowPos(h, Native.HWND_TOPMOST, x, y, 0, 0, Native.SWP_NOSIZE | Native.SWP_NOACTIVATE);
    }

    public void Dispose()
    {
        tick.Stop();
        frame.Close();
        bar.Close();
    }
}
