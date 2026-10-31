using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Interop;
using Microsoft.Win32;
using Forms = System.Windows.Forms;
using WpfFontFamily = System.Windows.Media.FontFamily;

namespace Grabbit;

/// <summary>Notification-area icon. Left click captures; right click opens a themed WPF menu.</summary>
public sealed class TrayIcon : IDisposable
{
    readonly Controller c;
    readonly Forms.NotifyIcon icon;
    readonly Icon glyph;

    public TrayIcon(Controller controller)
    {
        c = controller;
        glyph = DrawIcon();
        icon = new Forms.NotifyIcon { Visible = true, Icon = glyph, Text = $"Grabbit — {c.KeyFor(HotkeyAction.Capture)}: tap = screenshot, hold = record" };
        icon.MouseUp += (_, e) =>
        {
            if (e.Button == Forms.MouseButtons.Left) { if (c.IsRecording) c.Record(); else c.Capture(CopySize.Full, c.Settings.AfterCapture); }
            else if (e.Button == Forms.MouseButtons.Right) ShowMenu();
        };
    }

    public void Notify(string title, string text) =>
        icon.ShowBalloonTip(3000, title, string.IsNullOrEmpty(text) ? " " : text, Forms.ToolTipIcon.None);

    void ShowMenu()
    {
        var menu = new ContextMenu { Placement = PlacementMode.MousePoint };
        MenuItem Item(string header, string glyph, Action click, string keys = "", bool isChecked = false, bool enabled = true)
        {
            var mi = new MenuItem
            {
                Header = header, IsChecked = isChecked, IsEnabled = enabled, InputGestureText = keys,
                Icon = new TextBlock { Text = glyph, FontFamily = new WpfFontFamily("Segoe Fluent Icons, Segoe MDL2 Assets"), FontSize = 14 },
            };
            mi.Click += (_, _) => click();
            return mi;
        }
        var s = c.Settings;

        menu.Items.Add(Item("Capture region or window", "", () => c.Capture(CopySize.Full, s.AfterCapture), c.KeyFor(HotkeyAction.Capture)));
        menu.Items.Add(Item("Capture and edit", "", () => c.Capture(CopySize.Full, AfterCapture.Edit)));
        menu.Items.Add(Item("Scrolling capture…", "", () => c.Capture(CopySize.Full, s.AfterCapture, scrollMode: true), c.KeyFor(HotkeyAction.CaptureScroll)));
        menu.Items.Add(Item("Capture this whole screen", "", () => c.CaptureScreen(CopySize.Full), c.KeyFor(HotkeyAction.CaptureScreen)));
        menu.Items.Add(Item("Capture, copy smaller", "", () => c.Capture(CopySize.Reduced, AfterCapture.Copy), c.KeyFor(HotkeyAction.CaptureReduced)));
        menu.Items.Add(Item("Capture, copy chat-sized", "", () => c.Capture(CopySize.Chat, AfterCapture.Copy), c.KeyFor(HotkeyAction.CaptureChat)));
        menu.Items.Add(new Separator());
        menu.Items.Add(c.IsRecording
            ? Item("Stop recording", "\uE71A", c.Record, c.KeyFor(HotkeyAction.Record))
            : Item("Record screen…", "\uE7C8", c.Record, c.KeyFor(HotkeyAction.Record)));
        menu.Items.Add(Item("Edit last recording", "\uE714", () => c.OpenVideo(c.LastVideo!), enabled: c.LastVideo != null));
        menu.Items.Add(Item("Edit a video…", "\uE8E5", c.PickVideo));
        menu.Items.Add(Item("Open recordings folder", "\uE8B7", c.OpenVideoFolder));
        var rec = new MenuItem { Header = "Recording options" };
        rec.Items.Add(Item("Record system sound", "", () => c.Toggle(x => x.RecordSystemAudio = !x.RecordSystemAudio), isChecked: s.RecordSystemAudio));
        rec.Items.Add(Item("Record microphone", "", () => c.Toggle(x => x.RecordMicrophone = !x.RecordMicrophone), isChecked: s.RecordMicrophone));
        rec.Items.Add(Item("Show the mouse pointer", "", () => c.Toggle(x => x.RecordCursor = !x.RecordCursor), isChecked: s.RecordCursor));
        rec.Items.Add(Item("60 fps (default 30)", "", () => c.Toggle(x => x.RecordFps = x.RecordFps == 60 ? 30 : 60), isChecked: s.RecordFps == 60));
        rec.Items.Add(Item("Copy when finished", "", () => c.Toggle(x => x.CopyRecording = !x.CopyRecording), isChecked: s.CopyRecording));
        rec.Items.Add(Item("Open the video editor when finished", "", () => c.Toggle(x => x.EditAfterRecording = !x.EditAfterRecording), isChecked: s.EditAfterRecording));
        menu.Items.Add(rec);
        menu.Items.Add(new Separator());
        menu.Items.Add(Item("Edit last capture", "", c.OpenEditor, enabled: c.HasLast));
        var again = new MenuItem { Header = "Copy last capture as", IsEnabled = c.HasLast };
        again.Items.Add(Item("Full size (PNG)", "", () => c.CopyLast(CopySize.Full)));
        again.Items.Add(Item($"Smaller (≤ {s.ReducedLongEdge} px, PNG)", "", () => c.CopyLast(CopySize.Reduced)));
        again.Items.Add(Item($"Chat-sized (JPEG ≤ {s.ChatMaxKB / 1024.0:0.#} MB)", "", () => c.CopyLast(CopySize.Chat)));
        menu.Items.Add(again);
        menu.Items.Add(Item("Open screenshots folder", "", c.OpenFolder));
        menu.Items.Add(new Separator());
        var after = new MenuItem { Header = $"After {c.KeyFor(HotkeyAction.Capture)}" };
        after.Items.Add(Item("Ask (Copy · Smaller · Chat · Edit)", "", () => c.Toggle(x => x.AfterCapture = AfterCapture.Ask), isChecked: s.AfterCapture == AfterCapture.Ask));
        after.Items.Add(Item("Copy straight away", "", () => c.Toggle(x => x.AfterCapture = AfterCapture.Copy), isChecked: s.AfterCapture == AfterCapture.Copy));
        after.Items.Add(Item("Open the editor", "", () => c.Toggle(x => x.AfterCapture = AfterCapture.Edit), isChecked: s.AfterCapture == AfterCapture.Edit));
        menu.Items.Add(after);
        menu.Items.Add(Item("Save to folder automatically", "", () => c.Toggle(x => x.AutoSave = !x.AutoSave), isChecked: s.AutoSave));
        menu.Items.Add(Item("Also copy as a file (chat apps)", "", () => c.Toggle(x => x.CopyAsFile = !x.CopyAsFile), isChecked: s.CopyAsFile));
        menu.Items.Add(Item("Start with Windows", "", () => c.Toggle(x => x.StartWithWindows = !x.StartWithWindows), isChecked: s.StartWithWindows));
        menu.Items.Add(Item("Edit settings file…", "", c.OpenSettingsFile));
        menu.Items.Add(new Separator());
        menu.Items.Add(Item("Exit", "", () => Application.Current.Shutdown()));

        // Without foreground the menu would never close on an outside click.
        menu.Opened += (_, _) => { if (PresentationSource.FromVisual(menu) is HwndSource src) Native.SetForegroundWindow(src.Handle); };
        menu.IsOpen = true;
    }

    /// <summary>Four crop corners round a dot, tinted for the taskbar theme.</summary>
    static Icon DrawIcon()
    {
        using var k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
        var ink = k?.GetValue("SystemUsesLightTheme") is int v && v == 1 ? Color.FromArgb(28, 28, 28) : Color.White;
        using var bmp = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using var pen = new Pen(ink, 3f) { StartCap = LineCap.Round, EndCap = LineCap.Round };
            const float a = 4, b = 28, l = 8;
            g.DrawLines(pen, [new PointF(a, a + l), new PointF(a, a), new PointF(a + l, a)]);
            g.DrawLines(pen, [new PointF(b - l, a), new PointF(b, a), new PointF(b, a + l)]);
            g.DrawLines(pen, [new PointF(a, b - l), new PointF(a, b), new PointF(a + l, b)]);
            g.DrawLines(pen, [new PointF(b - l, b), new PointF(b, b), new PointF(b, b - l)]);
            using var dot = new SolidBrush(Color.FromArgb(232, 17, 35));
            g.FillEllipse(dot, 11, 11, 10, 10);
        }
        return Icon.FromHandle(bmp.GetHicon());
    }

    public void Dispose()
    {
        icon.Visible = false;
        icon.Dispose();
        Native.DestroyIcon(glyph.Handle);
        glyph.Dispose();
    }
}
