using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Rect32 = System.Drawing.Rectangle;
using Color = System.Drawing.Color;
using Pen = System.Drawing.Pen;
using Brushes = System.Drawing.Brushes;

namespace Grabbit;

/// <summary>
/// --readme-shots &lt;demo.png&gt; &lt;dir&gt;: the picker (selection, bar, loupe), the recording frame + bar and the
/// hold-to-record pill, drawn offscreen over a demo picture. They're excluded from screen capture, so a screenshot can't show them.
/// </summary>
public static class ReadmeShots
{
    const int Pad = 28;

    public static int Run(string demoPng, string dir)
    {
        Directory.CreateDirectory(dir);
        using var demo = new Bitmap(demoPng);
        var full = new Rect32(0, 0, demo.Width, demo.Height);

        // Picker: a region round the KPI cards and chart, the bar and loupe at its bottom-right corner.
        using (var frame = Frame.FromImage(new Bitmap(demo)))
        {
            var sel = new Rect32(262, 150, 1180, 470);
            Picker.SnapshotForTest(frame, full, new Native.POINT { X = sel.Right - 1, Y = sel.Bottom - 1 }, sel, Path.Combine(dir, "picker.png"));
        }

        // Recording: red frame round the area, the bar centred under it, showing 0:07.
        var area = new Rect32(262, 150, 1380, 760);
        using (var shot = new Bitmap(demo))
        {
            using (var g = Graphics.FromImage(shot))
            {
                using var dim = new SolidBrush(Color.FromArgb(70, 0, 0, 0));   // a hint of focus on the recorded area
                using var outside = new Region(full);
                outside.Exclude(area);
                g.FillRegion(dim, outside);
                using var pen = new Pen(Color.FromArgb(220, 232, 17, 35), 3);
                g.DrawRectangle(pen, area.X - 2, area.Y - 2, area.Width + 3, area.Height + 3);
                var rb = new RecordingBar(area, null, () => { }, () => { }, "PrtScn");
                rb.Time.Text = "0:07";
                using var bar = Render(Detach(rb.BarContent, rb.Dispose));
                g.DrawImage(bar, area.X + (area.Width - bar.Width) / 2, area.Bottom + 4 - Pad);
            }
            shot.Save(Path.Combine(dir, "recording.png"));
        }

        // Hold to record: the pill by a cursor, 70 % of the way.
        using (var shot = new Bitmap(demo))
        {
            var at = new System.Drawing.Point(980, 520);
            using (var g = Graphics.FromImage(shot))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                var hint = new HoldHint();
                hint.Progress(0.7);
                using var pill = Render(Detach(hint.Content, hint.Close));
                g.DrawImage(pill, at.X - Pad, at.Y + 4 - Pad);
                DrawCursor(g, at);
            }
            shot.Save(Path.Combine(dir, "hold.png"));
        }
        return 0;
    }

    /// <summary>Takes a window's content out of it (and closes the window) so it can be laid out and drawn on its own.</summary>
    static FrameworkElement Detach(FrameworkElement content, Action close)
    {
        if (content.Parent is System.Windows.Window w) w.Content = null;
        close();
        return content;
    }

    /// <summary>
    /// Drawn inside a fresh padded holder: a new parent forces a full layout (the detached content otherwise keeps its
    /// first-shown text and sizes), and the padding leaves room for the drop shadow. Callers offset by <see cref="Pad"/>.
    /// </summary>
    static Bitmap Render(FrameworkElement el)
    {
        var host = new System.Windows.Controls.Border { Padding = new Thickness(Pad), Child = el };
        host.Measure(new System.Windows.Size(double.PositiveInfinity, double.PositiveInfinity));
        host.Arrange(new Rect(host.DesiredSize));
        host.UpdateLayout();
        var rtb = new RenderTargetBitmap((int)Math.Ceiling(host.DesiredSize.Width), (int)Math.Ceiling(host.DesiredSize.Height), 96, 96, PixelFormats.Pbgra32);
        rtb.Render(host);
        var enc = new PngBitmapEncoder();
        enc.Frames.Add(BitmapFrame.Create(rtb));
        var ms = new MemoryStream();
        enc.Save(ms);
        ms.Position = 0;
        return new Bitmap(ms);
    }

    /// <summary>A plain Windows arrow pointer.</summary>
    static void DrawCursor(Graphics g, System.Drawing.Point p)
    {
        PointF[] arrow = [new(0, 0), new(0, 17), new(4.5f, 13), new(7.5f, 19.5f), new(10, 18.5f), new(7, 12), new(12, 12)];
        for (var i = 0; i < arrow.Length; i++) arrow[i] = new PointF(p.X + arrow[i].X * 1.3f, p.Y + arrow[i].Y * 1.3f);
        g.FillPolygon(Brushes.Black, arrow);
        using var pen = new Pen(Color.White, 1.5f) { LineJoin = LineJoin.Round };
        g.DrawPolygon(pen, arrow);
    }
}
