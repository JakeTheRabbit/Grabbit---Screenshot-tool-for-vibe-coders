using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Windows;
using System.Windows.Interop;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace Grabbit;

/// <summary>
/// Timeline editor for a recording (src/editor-web/video.html in WebView2): scrub, trim the ends, split and cut out
/// parts. The page only keeps a list of kept ranges; this window renders them with ffmpeg and copies or saves the result.
/// </summary>
public sealed class VideoEditorWindow : Window
{
    const string AppHost = "grabbit.app", VideoHost = "grabbit.video";

    readonly Controller controller;
    readonly string path, name;
    readonly WebView2 web = new();
    bool dirty, closing;
    VideoInfo? info;
    CancellationTokenSource? rendering;

    public VideoEditorWindow(Controller controller, string path)
    {
        this.controller = controller;
        this.path = path;
        name = Path.GetFileNameWithoutExtension(path);
        Title = $"Grabbit — {name}";
        Content = web;
        Background = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(18, 19, 22));
        SourceInitialized += (_, _) => PlaceWindow();
        Loaded += async (_, _) => await Start();
        Closing += (_, e) =>
        {
            if (closing || !dirty) { rendering?.Cancel(); return; }
            var answer = MessageBox.Show(this, "Keep your edits as a new video next to the original?", "Grabbit",
                MessageBoxButton.YesNoCancel, MessageBoxImage.Question);
            if (answer == MessageBoxResult.Cancel) { e.Cancel = true; return; }
            rendering?.Cancel();
            if (answer != MessageBoxResult.Yes) return;
            // The page holds the drawings, so it sends the export ("closeSave"); the window hides and closes once that's written.
            e.Cancel = true;
            Hide();
            Post(new { type = "keepAndClose" });
        };
    }

    void PlaceWindow()
    {
        Native.GetCursorPos(out var p);
        var work = System.Windows.Forms.Screen.FromPoint(new System.Drawing.Point(p.X, p.Y)).WorkingArea;
        int w = (int)(work.Width * 0.8), h = (int)(work.Height * 0.85);
        Native.SetWindowPos(new WindowInteropHelper(this).Handle, IntPtr.Zero, work.X + (work.Width - w) / 2, work.Y + (work.Height - h) / 2, w, h, Native.SWP_NOZORDER);
    }

    async System.Threading.Tasks.Task Start()
    {
        var data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Grabbit", "WebView2");
        var env = await CoreWebView2Environment.CreateAsync(null, data);
        await web.EnsureCoreWebView2Async(env);
        var core = web.CoreWebView2;
        core.SetVirtualHostNameToFolderMapping(AppHost, WebEditorWindow.WebFolder, CoreWebView2HostResourceAccessKind.Allow);
        core.SetVirtualHostNameToFolderMapping(VideoHost, Path.GetDirectoryName(path)!, CoreWebView2HostResourceAccessKind.Allow);
        core.Settings.IsStatusBarEnabled = false;
        core.WebMessageReceived += (_, e) => OnMessage(e.WebMessageAsJson);
        WebEditorWindow.OpenLinksOutside(core);
        core.Navigate($"https://{AppHost}/video.html");
    }

    void Post(object message) => web.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(message));

    void OnMessage(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var m = doc.RootElement;
            switch (m.GetProperty("type").GetString())
            {
                case "ready":
                {
                    info = Video.Probe(controller.Settings, path);
                    Post(new
                    {
                        type = "load", name, path, url = $"https://{VideoHost}/{Uri.EscapeDataString(Path.GetFileName(path))}",
                        duration = info.Duration, fps = info.Fps, width = info.Width, height = info.Height, hasAudio = info.HasAudio, bytes = info.Bytes,
                        hasSystem = Video.Tracks(info, SoundChoice.System).Count > 0, hasMic = Video.Tracks(info, SoundChoice.Mic).Count > 0,
                    });
                    break;
                }
                case "dirty":
                    dirty = m.GetProperty("value").GetBoolean();
                    break;
                case "export":
                    Export(m.GetProperty("action").GetString()!, Enum.Parse<VideoTarget>(m.GetProperty("target").GetString()!), Ranges(m.GetProperty("segments")),
                        m.GetProperty("edited").GetBoolean(), Enum.Parse<SoundChoice>(m.GetProperty("sound").GetString()!, true),
                        m.GetProperty("overlays").EnumerateArray().Select(o => (o.GetProperty("dataURL").GetString()!, o.GetProperty("from").GetDouble(), o.GetProperty("to").GetDouble())).ToList());
                    break;
                case "cancel":
                    rendering?.Cancel();
                    break;
                case "close":
                    Close();
                    break;
            }
        }
        catch (Exception ex)
        {
            Log.Write("video editor message failed: " + ex);
            controller.Notify("Video editor problem", ex.Message);
        }
    }

    static List<(double, double)> Ranges(JsonElement e) =>
        e.EnumerateArray().Select(r => (r[0].GetDouble(), r[1].GetDouble())).Where(r => r.Item2 - r.Item1 > 0.01).ToList();

    /// <summary>
    /// copy → clipboard (as a file); save → "&lt;name&gt; edited.mp4" next to the original; saveAs → dialog;
    /// copyPath → save, then the path on the clipboard; closeSave → keep edits of a closing window, then close.
    /// An unedited Full copy hands over the original file without re-encoding. <paramref name="drawings"/>: PNG data URLs + source times.
    /// </summary>
    async void Export(string action, VideoTarget target, List<(double Start, double End)> ranges, bool edited, SoundChoice sound,
        List<(string DataURL, double From, double To)> drawings)
    {
        if (rendering != null || ranges.Count == 0 || info == null) return;
        // Untouched cut, no drawings and the sound as recorded (one track at most): the original file will do.
        edited |= drawings.Count > 0 || !Video.Tracks(info, sound).SequenceEqual(Video.Tracks(info, SoundChoice.All)) || info.AudioTracks.Length > 1;
        var hwnd = new WindowInteropHelper(this).Handle;
        var ext = target == VideoTarget.Gif ? ".gif" : ".mp4";
        var suffix = target switch { VideoTarget.Chat => " chat", VideoTarget.Gif => "", _ => edited ? " edited" : "" };
        string? output;
        if (action == "saveAs")
        {
            var dlg = new Microsoft.Win32.SaveFileDialog
            {
                FileName = name + suffix, DefaultExt = ext, InitialDirectory = Path.GetDirectoryName(path),
                Filter = target == VideoTarget.Gif ? "Animated GIF|*.gif" : "MP4 video (H.264)|*.mp4",
            };
            if (dlg.ShowDialog(this) != true) { Post(new { type = "done", ok = false, note = "" }); return; }
            output = dlg.FileName;
        }
        else if (target == VideoTarget.Full && !edited) output = path;   // nothing to render
        else if (action == "closeSave") output = Free(Path.Combine(Path.GetDirectoryName(path)!, name + " edited"), ".mp4");
        else if (action == "copy") { Directory.CreateDirectory(ClipboardService.TempFolder); output = Path.Combine(ClipboardService.TempFolder, name + suffix + ext); }
        else output = Free(Path.Combine(Path.GetDirectoryName(path)!, name + suffix), ext);

        rendering = new CancellationTokenSource();
        var overlays = new List<Overlay>();
        try
        {
            var dir = Path.Combine(Path.GetTempPath(), "Grabbit");
            Directory.CreateDirectory(dir);
            foreach (var (dataURL, from, to) in drawings)
            {
                var png = Path.Combine(dir, $"drawing-{Guid.NewGuid():N}.png");
                File.WriteAllBytes(png, Convert.FromBase64String(dataURL[(dataURL.IndexOf(',') + 1)..]));
                overlays.Add(new Overlay(png, from, to));
            }
            if (output != path)
            {
                var label = target switch { VideoTarget.Chat => "Making a chat-sized copy", VideoTarget.Gif => "Making a GIF", _ => "Rendering" };
                Post(new { type = "progress", value = 0.0, label });
                var last = 0.0;
                await Video.Render(controller.Settings, path, ranges, target, output, v =>
                {
                    if (v - last < 0.01) return;
                    last = v;
                    Dispatcher.BeginInvoke(() => Post(new { type = "progress", value = v, label }));
                }, rendering.Token, sound, overlays);
            }
            var size = $"{new FileInfo(output).Length / 1048576.0:0.0} MB";
            string note;
            switch (action)
            {
                case "copy": ClipboardService.CopyFile(hwnd, output); note = $"Copied {size}"; break;
                case "copyPath": controller.CopyPath(output, hwnd); note = $"Saved {Path.GetFileName(output)}, path copied"; break;
                default: note = $"Saved {Path.GetFileName(output)} ({size})"; break;
            }
            if (target == VideoTarget.Chat && new FileInfo(output).Length > Video.ChatMaxBytes) note += " — still over 94 MB, cut it shorter for Signal";
            Log.Write($"video {action} {target} sound={sound}: {output} ({size}, {ranges.Count} parts, {overlays.Count} drawings)");
            if (action == "closeSave")
            {
                controller.Notify("Edits saved", Path.GetFileName(output));
                closing = true;
                Close();
                return;
            }
            if (action != "copy") dirty = false;
            Post(new { type = "done", ok = true, note });
            controller.Notify(action == "copy" ? "Video copied" : "Video saved", note);
        }
        catch (OperationCanceledException) { Post(new { type = "done", ok = false, note = "Cancelled" }); }
        catch (Exception ex)
        {
            Log.Write("video export failed: " + ex);
            Post(new { type = "done", ok = false, note = "Failed: " + ex.Message });
            if (action == "closeSave") { controller.Notify("Couldn't save edits", ex.Message); Show(); }
        }
        finally
        {
            rendering?.Dispose();
            rendering = null;
            foreach (var o in overlays) try { File.Delete(o.Png); } catch { }
        }
    }

    /// <summary>"&lt;base&gt;.ext", or "&lt;base&gt; 2.ext", … — never overwrites.</summary>
    static string Free(string baseName, string ext)
    {
        var p = baseName + ext;
        for (var i = 2; File.Exists(p); i++) p = $"{baseName} {i}{ext}";
        return p;
    }
}
