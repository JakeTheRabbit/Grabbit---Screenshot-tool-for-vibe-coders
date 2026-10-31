using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows.Input;
using Microsoft.Win32;

namespace Grabbit;

public enum HotkeyAction { Capture, CaptureReduced, CaptureChat, CaptureScreen, CaptureAlt, CaptureScroll, Record }

/// <summary>What happens once you've picked an area with the plain capture key.</summary>
public enum AfterCapture { Ask, Copy, Edit }

/// <summary>
/// File format for saved pictures. Both are pixel-exact. WebP lossless is ~44 % of PNG's size on real captures;
/// PNG is for tools that can't read WebP. The clipboard always carries PNG.
/// </summary>
public enum SaveFormat { WebpLossless, Png }

/// <summary>How a capture lands on the clipboard.</summary>
public enum CopySize { Full, Reduced, Chat }

public sealed class Hotkey
{
    public ModifierKeys Modifiers { get; set; }
    public Key Key { get; set; }

    public Hotkey() { }
    public Hotkey(ModifierKeys modifiers, Key key) { Modifiers = modifiers; Key = key; }

    [JsonIgnore] public bool IsEmpty => Key == Key.None;

    public override string ToString()
    {
        if (IsEmpty) return "";
        var parts = new List<string>();
        if (Modifiers.HasFlag(ModifierKeys.Windows)) parts.Add("Win");
        if (Modifiers.HasFlag(ModifierKeys.Control)) parts.Add("Ctrl");
        if (Modifiers.HasFlag(ModifierKeys.Alt)) parts.Add("Alt");
        if (Modifiers.HasFlag(ModifierKeys.Shift)) parts.Add("Shift");
        parts.Add(Key == Key.Snapshot ? "PrtScn" : Key.ToString());
        return string.Join(" + ", parts);
    }
}

public sealed class AppSettings
{
    public bool StartWithWindows { get; set; }   // off until there's an installed build; the tray menu turns it on
    public AfterCapture AfterCapture { get; set; } = AfterCapture.Ask;
    public bool AutoSave { get; set; } = true;
    public SaveFormat SaveFormat { get; set; } = SaveFormat.WebpLossless;
    public string SaveFolder { get; set; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyPictures), "Grabbit");

    /// <summary>Also put the image on the clipboard as a file, so chat apps (Signal, Slack) attach it with its name.</summary>
    public bool CopyAsFile { get; set; } = true;

    public int ReducedLongEdge { get; set; } = 1920;
    public int ChatLongEdge { get; set; } = 2560;
    public int ChatMaxKB { get; set; } = 2048;
    public bool ShowToasts { get; set; } = true;

    /// <summary>Holding the capture key (PrtScn) this long starts a recording instead of a screenshot. 0 = off.</summary>
    public int HoldToRecordMs { get; set; } = 2000;

    // Recording
    public string VideoFolder { get; set; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyVideos), "Grabbit");
    public int RecordFps { get; set; } = 30;
    /// <summary>Constant-quality level (NVENC cq / x264 crf): lower = better and bigger. 23 is sharp for screen text.</summary>
    public int RecordQuality { get; set; } = 23;
    public bool RecordCursor { get; set; } = true;
    public bool RecordSystemAudio { get; set; } = true;
    /// <summary>On by default: it's its own track, and the editor chooses at copy time whether it goes in.</summary>
    public bool RecordMicrophone { get; set; } = true;
    /// <summary>Put a finished recording on the clipboard as a file (pastes as an attachment in chat apps).</summary>
    public bool CopyRecording { get; set; } = true;
    public bool EditAfterRecording { get; set; } = true;
    /// <summary>Empty = find ffmpeg on PATH.</summary>
    public string FfmpegPath { get; set; } = "";

    public Dictionary<HotkeyAction, Hotkey> Hotkeys { get; set; } = DefaultHotkeys();

    public static Dictionary<HotkeyAction, Hotkey> DefaultHotkeys() => new()
    {
        [HotkeyAction.Capture] = new(ModifierKeys.None, Key.Snapshot),
        [HotkeyAction.CaptureReduced] = new(ModifierKeys.Shift, Key.Snapshot),
        [HotkeyAction.CaptureChat] = new(ModifierKeys.Control, Key.Snapshot),
        [HotkeyAction.CaptureScreen] = new(ModifierKeys.Control | ModifierKeys.Shift, Key.Snapshot),
        // Keyboards without a handy PrtScn (and G-key macros). Ctrl+Alt+R/S/D etc. belong to Team Screen.
        [HotkeyAction.CaptureAlt] = new(ModifierKeys.Control | ModifierKeys.Alt, Key.G),
        [HotkeyAction.CaptureScroll] = new(ModifierKeys.Control | ModifierKeys.Alt | ModifierKeys.Shift, Key.S),
        [HotkeyAction.Record] = new(ModifierKeys.Control | ModifierKeys.Alt, Key.Snapshot),   // again = stop (Ctrl+Alt+Shift+R is taken on this box)
    };

    /// <summary>
    /// GRABBIT_DEMO=&lt;folder&gt;: for README screenshots. Saves, recordings and clipboard files go there (so the editor's
    /// recent strip shows only demo pictures) and Grabbit's overlays stay visible to screen capture.
    /// </summary>
    public static string? DemoFolder => Environment.GetEnvironmentVariable("GRABBIT_DEMO") is { Length: > 0 } d ? d : null;

    public static string Folder => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Grabbit");
    public static string FilePath => Path.Combine(Folder, "settings.json");

    static readonly JsonSerializerOptions Json = new() { WriteIndented = true, Converters = { new JsonStringEnumConverter() } };

    public static AppSettings Load()
    {
        AppSettings s;
        try { s = File.Exists(FilePath) ? JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(FilePath), Json) ?? new() : new(); }
        catch { s = new(); }
        if (DemoFolder != null) s.SaveFolder = s.VideoFolder = DemoFolder;
        foreach (var (action, key) in DefaultHotkeys())   // new actions added in later versions get their defaults
            s.Hotkeys.TryAdd(action, key);
        return s;
    }

    public void Save()
    {
        if (DemoFolder != null) return;   // demo folders must never end up in the real settings file
        Directory.CreateDirectory(Folder);
        File.WriteAllText(FilePath, JsonSerializer.Serialize(this, Json));
    }

    public static void SetStartWithWindows(bool on)
    {
        using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true);
        if (key == null) return;
        if (on) key.SetValue("Grabbit", $"\"{Environment.ProcessPath}\" --background");
        else key.DeleteValue("Grabbit", false);
    }
}
