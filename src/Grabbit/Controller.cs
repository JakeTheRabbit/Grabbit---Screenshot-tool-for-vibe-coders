using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;

namespace Grabbit;

/// <summary>Owns the hotkeys, the tray icon and the last capture; turns a pick into files + clipboard or the editor.</summary>
public sealed class Controller : IDisposable
{
    public AppSettings Settings { get; }
    public bool HasLast => last != null;
    public event Action? Changed;

    readonly HotkeyManager hotkeys = new();
    TrayIcon? tray;
    Frame? frame;           // kept until the next capture: the picker hands back areas of it
    Bitmap? last;
    string lastName = "";

    public Controller(AppSettings settings) => Settings = settings;

    public void Start()
    {
        Log.Trim();
        Log.Write("start");
        ClipboardService.CleanTemp();
        AppSettings.SetStartWithWindows(Settings.StartWithWindows);
        tray = new TrayIcon(this);
        hotkeys.Pressed += OnHotkey;
        var failed = hotkeys.Register(Settings.Hotkeys);
        Log.Write(failed.Count == 0 ? "hotkeys: all registered" : "hotkeys taken by another app: " + string.Join(", ", failed.Select(a => $"{a}={Settings.Hotkeys[a]}")));
        if (failed.Count > 0)
            tray.Notify("Some Grabbit hotkeys are taken", string.Join(", ", failed.Select(a => Settings.Hotkeys[a].ToString())) + " — another app already uses them.");
    }

    public string KeyFor(HotkeyAction a) => Settings.Hotkeys.TryGetValue(a, out var k) ? k.ToString() : "";

    public void Notify(string title, string text) { if (Settings.ShowToasts) tray?.Notify(title, text); }

    void OnHotkey(HotkeyAction action)
    {
        switch (action)
        {
            case HotkeyAction.Capture or HotkeyAction.CaptureAlt: TapOrHold(action); break;
            case HotkeyAction.CaptureReduced: Capture(CopySize.Reduced, AfterCapture.Copy); break;   // the size keys mean "copy at this size"
            case HotkeyAction.CaptureChat: Capture(CopySize.Chat, AfterCapture.Copy); break;
            case HotkeyAction.CaptureScreen: CaptureScreen(CopySize.Full); break;
            case HotkeyAction.CaptureScroll: Capture(CopySize.Full, Settings.AfterCapture, scrollMode: true); break;
            case HotkeyAction.Record: Record(); break;
        }
    }

    System.Windows.Threading.DispatcherTimer? holding;

    /// <summary>
    /// The capture key: a quick press = screenshot, held for <see cref="AppSettings.HoldToRecordMs"/> = record.
    /// RegisterHotKey only reports the press, so the key's live state is polled until it's let go or the time is up.
    /// While a recording runs, the key stops it.
    /// </summary>
    void TapOrHold(HotkeyAction action)
    {
        if (holding != null) return;
        if (recorder != null) { _ = StopRecording(keep: true); return; }
        if (Settings.HoldToRecordMs <= 0) { Capture(CopySize.Full, Settings.AfterCapture); return; }
        var vk = System.Windows.Input.KeyInterop.VirtualKeyFromKey(Settings.Hotkeys[action].Key);
        var held = Stopwatch.StartNew();
        HoldHint? hint = null;
        holding = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(25) };
        holding.Tick += (_, _) =>
        {
            var down = (Native.GetAsyncKeyState(vk) & 0x8000) != 0;
            var ms = held.ElapsedMilliseconds;
            if (down && ms < Settings.HoldToRecordMs)
            {
                if (ms >= 300) (hint ??= new HoldHint()).Progress(ms / (double)Settings.HoldToRecordMs);   // a tap never sees it
                return;
            }
            holding!.Stop();
            holding = null;
            hint?.Close();
            Log.Write($"capture key {(down ? "held" : "released")} after {ms} ms");
            if (down) Record(); else Capture(CopySize.Full, Settings.AfterCapture);
        };
        holding.Start();
    }

    /// <summary>--capture [region|screen] [--size full|reduced|chat] [--edit]  ·  --open &lt;image&gt; (straight into the editor)</summary>
    public void RunCommand(string[] args)
    {
        Log.Write("command: " + string.Join(' ', args));
        var open = Array.IndexOf(args, "--open");
        if (open >= 0 && args.ElementAtOrDefault(open + 1) is { } path && File.Exists(path))
        {
            OpenEditorFile(path);
            return;
        }
        if (args.Contains("--record")) { Record(); return; }
        var i = Array.IndexOf(args, "--size");
        var size = i >= 0 && Enum.TryParse<CopySize>(args.ElementAtOrDefault(i + 1), true, out var s) ? s : CopySize.Full;
        var after = args.Contains("--edit") ? AfterCapture.Edit : i >= 0 ? AfterCapture.Copy : Settings.AfterCapture;
        if (args.Contains("screen")) CaptureScreen(size); else Capture(size, after, scrollMode: args.Contains("scroll"));
    }

    public void Capture(CopySize size, AfterCapture after, bool scrollMode = false, bool recordMode = false)
    {
        if (Picker.IsOpen || scrolling || recorder != null || startingRecording) { Log.Write("capture ignored: picker, scroll or recording already running"); return; }
        var t = Stopwatch.StartNew();
        frame?.Dispose();
        frame = Frame.Grab();
        var f = frame;
        Log.Write($"grabbed {f.Bounds} in {t.ElapsedMilliseconds} ms, {f.Windows.Count} windows");
        Picker.Show(f, after, pick =>
        {
            Log.Write($"picked {pick.What} {pick.Area} {pick.Outcome} size={pick.Size ?? size} windows={pick.Windows?.Count ?? 0} scroll={pick.Scroll}");
            if (pick.Scroll) { _ = Scroll(f, pick, pick.Size ?? size); return; }
            if (pick.Outcome == Outcome.Record) { StartRecording(pick.Windows is { Count: > 0 } w ? w.Select(x => x.Bounds).Aggregate(Rectangle.Union) : pick.Area); return; }
            var image = pick.Windows is { Count: > 1 } windows ? WindowShot.Compose(f, windows) : f.Crop(pick.Area);
            Deliver(image, pick.Outcome, pick.Size ?? size, pick.What);
        }, scrollMode, recordMode);
        Log.Write($"picker shown after {t.ElapsedMilliseconds} ms");
    }

    bool scrolling;

    /// <summary>Scrolling capture on the live screen (the picker has closed), with a small Done / Cancel status.</summary>
    async System.Threading.Tasks.Task Scroll(Frame f, Pick pick, CopySize size)
    {
        scrolling = true;
        try
        {
            var area = pick.Area;
            if (pick.FromTop && f.WindowAt(area.X + area.Width / 2, area.Y + area.Height / 2) is { } win) Native.ForceForeground(win.Handle);
            await System.Threading.Tasks.Task.Delay(250);   // let the picker vanish and the target repaint
            var capture = new ScrollCapture(area, pick.FromTop);
            var status = new ScrollStatusWindow(capture, area);
            status.Show();
            Bitmap? result;
            try { result = await capture.RunAsync(status.Status); }
            finally { status.Close(); }
            if (result == null) { Notify("Scrolling capture cancelled", ""); return; }
            Deliver(result, pick.Outcome, size, $"{pick.What} (scrolled {result.Height} px, {capture.Ending})");
        }
        catch (Exception ex)
        {
            Log.Write("scroll capture failed: " + ex);
            Notify("Scrolling capture failed", ex.Message);
        }
        finally { scrolling = false; }
    }

    /// <summary>The monitor under the cursor, no picker.</summary>
    public void CaptureScreen(CopySize size)
    {
        frame?.Dispose();
        frame = Frame.Grab();
        Native.GetCursorPos(out var p);
        Deliver(frame.Crop(frame.MonitorAt(p.X, p.Y)), Settings.AfterCapture == AfterCapture.Edit ? Outcome.Edit : Outcome.Copy, size, "Screen");
    }

    async void Deliver(Bitmap image, Outcome outcome, CopySize size, string what)
    {
        last?.Dispose();
        last = image;
        lastName = $"Grabbit {DateTime.Now:yyyy-MM-dd HHmmss}";
        string note;
        try
        {
            // Saved losslessly as WebP (or PNG); encoding a 4K frame takes ~0.6 s, so it runs off the UI thread on its own copy.
            Directory.CreateDirectory(Settings.SaveFolder);
            var copy = new Bitmap(image);
            var baseName = Path.Combine(Settings.SaveFolder, lastName);
            var save = Settings.AutoSave || outcome is Outcome.Save or Outcome.CopyPath
                ? System.Threading.Tasks.Task.Run(() => { using (copy) return ImageExport.SaveLossless(copy, baseName, Settings.SaveFormat); })
                : null;
            if (save == null) copy.Dispose();
            note = outcome switch
            {
                Outcome.Edit => OpenedInEditor(),
                Outcome.Save => "Saved " + await save!,
                Outcome.CopyPath => CopyPath(await save!),   // the file exists before its path is handed out
                _ => "Copied " + Copy(image, size, lastName, hotkeys.Handle),
            };
            if (save != null && outcome is Outcome.Copy or Outcome.Edit) Log.Write("saved " + await save);
        }
        catch (Exception ex) { note = "Failed: " + ex.Message; Log.Write("deliver failed: " + ex); }
        Log.Write($"delivered {image.Width}x{image.Height}: {note}");
        Changed?.Invoke();
        if (outcome != Outcome.Edit) Notify(what.Length > 60 ? what[..57] + "…" : what, note);
    }

    string OpenedInEditor() { OpenEditor(); return "Opened in the editor"; }

    // ---- Recording ----

    Recorder? recorder;
    RecordingBar? recordingBar;
    bool startingRecording;
    public bool IsRecording => recorder != null;
    public string? LastVideo { get; private set; }

    /// <summary>Hotkey / tray: pick an area and record it; while recording, stop.</summary>
    public void Record()
    {
        if (recorder != null) { _ = StopRecording(keep: true); return; }
        Capture(CopySize.Full, AfterCapture.Copy, recordMode: true);
    }

    async void StartRecording(Rectangle area)
    {
        startingRecording = true;
        try
        {
            await System.Threading.Tasks.Task.Delay(200);   // the picker has to be off the screen before the first frame
            recorder = await Recorder.StartAsync(Settings, area);
            recordingBar = new RecordingBar(recorder.Area, recorder, () => _ = StopRecording(keep: true), () => _ = StopRecording(keep: false), KeyFor(HotkeyAction.Record));
            Changed?.Invoke();
        }
        catch (Exception ex)
        {
            Log.Write("record failed: " + ex);
            Notify("Couldn't start recording", ex.Message);
            recorder = null;
        }
        finally { startingRecording = false; }
    }

    async System.Threading.Tasks.Task StopRecording(bool keep)
    {
        var r = recorder;
        if (r == null) return;
        recorder = null;
        recordingBar?.Dispose();
        recordingBar = null;
        Changed?.Invoke();
        if (!keep) { await r.CancelAsync(); Notify("Recording discarded", ""); return; }
        var path = Path.Combine(Settings.VideoFolder, $"Grabbit {DateTime.Now:yyyy-MM-dd HHmmss}.mp4");
        try
        {
            if (!await r.StopAsync(path)) { Notify("Nothing was recorded", "See the log for ffmpeg's output."); return; }
            LastVideo = path;
            var note = $"{r.Clock.Elapsed:m\\:ss} · {new FileInfo(path).Length / 1048576.0:0.0} MB";
            if (Settings.CopyRecording) { ClipboardService.CopyFile(hotkeys.Handle, path); note += " · copied"; }
            Log.Write($"recorded {path} ({note})");
            Notify("Recording saved", note);
            if (Settings.EditAfterRecording) OpenVideo(path);
        }
        catch (Exception ex)
        {
            Log.Write("finishing recording failed: " + ex);
            Notify("Recording failed", ex.Message);
        }
    }

    readonly System.Collections.Generic.Dictionary<string, VideoEditorWindow> videoEditors = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>The timeline editor for a video; one window per file.</summary>
    public void OpenVideo(string path)
    {
        if (!videoEditors.TryGetValue(path, out var w))
        {
            w = new VideoEditorWindow(this, path);
            videoEditors[path] = w;
            w.Closed += (_, _) => videoEditors.Remove(path);
            w.Show();
        }
        if (w.WindowState == System.Windows.WindowState.Minimized) w.WindowState = System.Windows.WindowState.Normal;
        var h = new System.Windows.Interop.WindowInteropHelper(w).Handle;
        if (!w.Activate() || Native.GetForegroundWindow() != h) Native.ForceForeground(h);
    }

    public void PickVideo()
    {
        var dlg = new Microsoft.Win32.OpenFileDialog
        {
            Filter = "Videos|" + string.Join(";", Video.Extensions.Select(e => "*" + e)), InitialDirectory = Settings.VideoFolder,
        };
        if (dlg.ShowDialog() == true) OpenVideo(dlg.FileName);
    }

    public void OpenVideoFolder()
    {
        Directory.CreateDirectory(Settings.VideoFolder);
        Process.Start(new ProcessStartInfo(Settings.VideoFolder) { UseShellExecute = true });
    }

    /// <summary>The file's path as text, in quotes like Explorer's "Copy as path" (pastes safely into shells and chats).</summary>
    public string CopyPath(string path, IntPtr owner = default)
    {
        ClipboardService.CopyText(owner == IntPtr.Zero ? hotkeys.Handle : owner, $"\"{path}\"");
        return "Copied path " + path;
    }

    string Copy(Bitmap image, CopySize size, string name, IntPtr owner)
    {
        var enc = ImageExport.Encode(image, size, Settings);
        try
        {
            ClipboardService.CopyImage(owner, enc, Settings.CopyAsFile, name + size switch { CopySize.Reduced => " small", CopySize.Chat => " chat", _ => "" });
            return enc.Describe();
        }
        finally { if (!ReferenceEquals(enc.Pixels, image)) enc.Pixels.Dispose(); }
    }

    /// <summary>Clipboard copy for the editor; tells the user what landed and returns false on failure.</summary>
    public bool CopyImage(Bitmap image, CopySize size, string name, IntPtr owner)
    {
        try
        {
            Notify("Copied", Copy(image, size, name, owner));
            return true;
        }
        catch (Exception ex)
        {
            Log.Write("editor copy failed: " + ex);
            Notify("Copy failed", ex.Message);
            return false;
        }
    }

    public void CopyLast(CopySize size)
    {
        if (last == null) return;
        CopyImage(last, size, lastName, hotkeys.Handle);
    }

    WebEditorWindow? editor;   // one editor window; more pictures arrive as tabs

    public void OpenEditor()
    {
        if (last != null) Edit(last, lastName);
    }

    /// <summary>A picture (PNG/JPEG/…) or an editable .excalidraw drawing, straight into the editor.</summary>
    public void OpenEditorFile(string path)
    {
        if (Video.IsVideo(path)) { OpenVideo(path); return; }
        var name = Path.GetFileNameWithoutExtension(path);
        if (path.EndsWith(".excalidraw", StringComparison.OrdinalIgnoreCase)) { Edit(null, name, File.ReadAllText(path)); return; }
        using var file = ImageExport.Decode(File.ReadAllBytes(path));   // Skia: reads WebP too, which GDI+ can't
        Edit(file, name);
    }

    void Edit(Bitmap? picture, string name, string? scene = null)
    {
        if (editor == null)
        {
            editor = new WebEditorWindow(this, picture, name, scene);
            editor.Closed += (_, _) => editor = null;
            editor.Show();
        }
        else
        {
            editor.AddTab(picture, name, scene);
            if (editor.WindowState == System.Windows.WindowState.Minimized) editor.WindowState = System.Windows.WindowState.Normal;
        }
        var h = new System.Windows.Interop.WindowInteropHelper(editor).Handle;
        if (!editor.Activate() || Native.GetForegroundWindow() != h) Native.ForceForeground(h);
    }

    public void Toggle(Action<AppSettings> change)
    {
        change(Settings);
        Settings.Save();
        AppSettings.SetStartWithWindows(Settings.StartWithWindows);
        Changed?.Invoke();
    }

    public void OpenFolder()
    {
        Directory.CreateDirectory(Settings.SaveFolder);
        Process.Start(new ProcessStartInfo(Settings.SaveFolder) { UseShellExecute = true });
    }

    public void OpenSettingsFile()
    {
        if (!File.Exists(AppSettings.FilePath)) Settings.Save();
        Process.Start(new ProcessStartInfo("notepad.exe", $"\"{AppSettings.FilePath}\""));
    }

    public void Dispose()
    {
        if (recorder != null) StopRecording(keep: true).Wait(15000);   // quitting mid-recording keeps what was recorded
        hotkeys.Dispose();
        tray?.Dispose();
        frame?.Dispose();
        last?.Dispose();
    }
}
