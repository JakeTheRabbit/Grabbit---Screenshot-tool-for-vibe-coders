using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using Theme = Grabbit.Picker.Theme;

namespace Grabbit;

/// <summary>
/// "Keep holding to record" pill by the cursor while the capture key is held, filling up as the hold time runs.
/// Click-through, never activated, excluded from capture.
/// </summary>
public sealed class HoldHint
{
    readonly Window window;

    /// <summary>The pill itself, for rendering it offscreen (README shots).</summary>
    internal FrameworkElement Content => (FrameworkElement)window.Content;
    readonly Border fill;
    readonly TextBlock text;
    const double Track = 150;

    public HoldHint()
    {
        fill = new Border { Width = 0, Height = 4, CornerRadius = new CornerRadius(2), HorizontalAlignment = HorizontalAlignment.Left, Background = new SolidColorBrush(Color.FromRgb(232, 17, 35)) };
        text = new TextBlock { Text = "Keep holding to record", FontFamily = Theme.Font, FontSize = 13, FontWeight = FontWeights.SemiBold, Foreground = Brushes.White, Margin = new Thickness(0, 0, 0, 7) };
        window = new Window
        {
            WindowStyle = WindowStyle.None, AllowsTransparency = true, Background = Brushes.Transparent, Topmost = true,
            ShowInTaskbar = false, ShowActivated = false, ResizeMode = ResizeMode.NoResize, SizeToContent = SizeToContent.WidthAndHeight, Title = "Grabbit hold",
            Content = new Border
            {
                Background = Theme.Panel, CornerRadius = new CornerRadius(12), BorderBrush = Theme.Edge, BorderThickness = new Thickness(1),
                Padding = new Thickness(14, 10, 14, 12), Margin = new Thickness(12), Effect = Theme.Shadow(),
                Child = new StackPanel
                {
                    Children =
                    {
                        new StackPanel { Orientation = Orientation.Horizontal, Children = { new TextBlock { Text = "", FontFamily = Theme.Icons, FontSize = 14, Foreground = fill.Background, Margin = new Thickness(0, 1, 8, 0) }, text } },
                        new Border { Width = Track, Height = 4, CornerRadius = new CornerRadius(2), Background = new SolidColorBrush(Color.FromArgb(50, 255, 255, 255)), Child = fill },
                    },
                },
            },
        };
        window.SourceInitialized += (_, _) =>
        {
            var h = new WindowInteropHelper(window).Handle;
            var ex = Native.GetWindowLongPtr(h, Native.GWL_EXSTYLE).ToInt64();
            Native.SetWindowLongPtr(h, Native.GWL_EXSTYLE, new IntPtr(ex | Native.WS_EX_TRANSPARENT | Native.WS_EX_LAYERED));
            Native.ExcludeFromCapture(h);
        };
        window.Loaded += (_, _) =>
        {
            Native.GetCursorPos(out var p);   // just below-right of the pointer, like a tooltip
            Native.SetWindowPos(new WindowInteropHelper(window).Handle, Native.HWND_TOPMOST, p.X + 12, p.Y + 16, 0, 0, Native.SWP_NOSIZE | Native.SWP_NOACTIVATE);
        };
        window.Show();
    }

    public void Progress(double value) => fill.Width = Track * Math.Clamp(value, 0, 1);

    public void Close() => window.Close();
}
