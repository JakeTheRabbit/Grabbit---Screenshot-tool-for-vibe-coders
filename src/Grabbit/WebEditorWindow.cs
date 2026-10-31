using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace Grabbit;

/// <summary>
/// Hosts the Excalidraw-based editor (src/editor-web, built into EditorWeb\) in WebView2, offline.
/// The page does the drawing; this window feeds it the capture and the recent-captures list, and turns its
/// exported PNG into Grabbit's clipboard copies and files.
/// </summary>
public sealed class WebEditorWindow : Window
{
    const string AppHost = "grabbit.app", SavesHost = "grabbit.saves", ClipHost = "grabbit.clip";

    readonly Controller controller;
    readonly string name;
    readonly byte[]? png;
    readonly int width, height;
    readonly string? scene;   // an .excalidraw project to reopen instead of a picture
    readonly WebView2 web = new();
    bool dirty, closing;

    public static string WebFolder => Path.Combine(AppContext.BaseDirectory, "EditorWeb");

    public WebEditorWindow(Controller controller, Bitmap? capture, string name, string? scene = null)
    {
        this.controller = controller;
        this.name = name;
        this.scene = scene;
        if (capture != null)
        {
            png = ImageExport.Png(capture);
            width = capture.Width;
            height = capture.Height;
        }
        Title = $"Grabbit — {name}";
        Content = web;
        Background = System.Windows.Media.Brushes.White;
        SourceInitialized += (_, _) => PlaceWindow();
        Loaded += async (_, _) => await Start();
        Closing += (_, e) =>
        {
            if (closing || !dirty || web.CoreWebView2 == null) return;
            e.Cancel = true;            // let the page export first; it answers with closeSave or close
            closing = true;
            Post(new { type = "requestClose" });
        };
    }

    void PlaceWindow()
    {
        Native.GetCursorPos(out var p);
        var work = System.Windows.Forms.Screen.FromPoint(new System.Drawing.Point(p.X, p.Y)).WorkingArea;
        int w = (int)(work.Width * 0.85), h = (int)(work.Height * 0.88);
        Native.SetWindowPos(new WindowInteropHelper(this).Handle, IntPtr.Zero, work.X + (work.Width - w) / 2, work.Y + (work.Height - h) / 2, w, h, Native.SWP_NOZORDER);
    }

    async System.Threading.Tasks.Task Start()
    {
        var data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Grabbit", "WebView2");
        var env = await CoreWebView2Environment.CreateAsync(null, data);
        await web.EnsureCoreWebView2Async(env);
        var core = web.CoreWebView2;
        Directory.CreateDirectory(controller.Settings.SaveFolder);
        Directory.CreateDirectory(ClipboardService.TempFolder);
        core.SetVirtualHostNameToFolderMapping(AppHost, WebFolder, CoreWebView2HostResourceAccessKind.Allow);
        core.SetVirtualHostNameToFolderMapping(SavesHost, controller.Settings.SaveFolder, CoreWebView2HostResourceAccessKind.Allow);
        core.SetVirtualHostNameToFolderMapping(ClipHost, ClipboardService.TempFolder, CoreWebView2HostResourceAccessKind.Allow);
        core.Settings.IsStatusBarEnabled = false;
        core.WebMessageReceived += (_, e) => OnMessage(e.WebMessageAsJson);
        OpenLinksOutside(core);
        core.Navigate($"https://{AppHost}/index.html");
    }

    /// <summary>
    /// Web links (Excalidraw's help dialog, docs, GitHub) open in the default browser. The editor page itself never
    /// navigates away, and no stray WebView2 windows open.
    /// </summary>
    internal static void OpenLinksOutside(CoreWebView2 core)
    {
        static bool External(string uri) =>
            Uri.TryCreate(uri, UriKind.Absolute, out var u) && u.Scheme is "http" or "https" or "mailto" && !u.Host.StartsWith("grabbit.");
        static void Open(string uri) =>
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(uri) { UseShellExecute = true });
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            if (External(e.Uri)) Open(e.Uri);
        };
        core.NavigationStarting += (_, e) =>
        {
            if (!External(e.Uri)) return;
            e.Cancel = true;
            Open(e.Uri);
        };
    }

    void Post(object message) => web.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(message));

    object[] Recent()
    {
        static IEnumerable<FileInfo> Images(string dir) =>
            Directory.Exists(dir) ? new DirectoryInfo(dir).EnumerateFiles().Where(f => f.Extension.ToLowerInvariant() is ".webp" or ".png" or ".jpg" or ".jpeg") : [];
        var saves = Images(controller.Settings.SaveFolder).OrderByDescending(f => f.LastWriteTimeUtc).Take(60)
            .Select(f => new { path = f.FullName, url = $"https://{SavesHost}/{Uri.EscapeDataString(f.Name)}", name = f.Name, time = f.LastWriteTimeUtc.ToString("o"), kind = f.Name.Contains(" edited") ? "edited" : "capture", bytes = f.Length });
        var copied = Images(ClipboardService.TempFolder).OrderByDescending(f => f.LastWriteTimeUtc).Take(40)
            .Select(f => new { path = f.FullName, url = $"https://{ClipHost}/{Uri.EscapeDataString(f.Name)}", name = f.Name, time = f.LastWriteTimeUtc.ToString("o"), kind = "copied", bytes = f.Length });
        return saves.Concat(copied).Cast<object>().ToArray();
    }

    /// <summary>Only files in the save folder or the clipboard temp folder may be read by the page.</summary>
    bool Allowed(string path)
    {
        var full = Path.GetFullPath(path);
        return new[] { controller.Settings.SaveFolder, ClipboardService.TempFolder }
            .Any(d => full.StartsWith(Path.GetFullPath(d).TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase));
    }

    void OnMessage(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var m = doc.RootElement;
            switch (m.GetProperty("type").GetString())
            {
                case "ready":
                    Post(new
                    {
                        type = "load", name, scene, recent = Recent(), width, height,
                        dataURL = png != null ? "data:image/png;base64," + Convert.ToBase64String(png) : null,
                    });
                    ready = true;
                    foreach (var q in queued) Post(q);
                    queued.Clear();
                    break;
                case "dirty":
                    dirty = m.GetProperty("value").GetBoolean();
                    break;
                case "getImage":
                {
                    var path = m.GetProperty("path").GetString()!;
                    if (!Allowed(path) || !File.Exists(path)) break;
                    var bytes = File.ReadAllBytes(path);
                    var (w, h) = ImageExport.Measure(bytes);
                    var mime = Path.GetExtension(path).ToLowerInvariant() switch { ".png" => "image/png", ".webp" => "image/webp", _ => "image/jpeg" };
                    Post(new { type = "image", reqId = m.GetProperty("reqId").GetInt32(), dataURL = $"data:{mime};base64,{Convert.ToBase64String(bytes)}", width = w, height = h });
                    break;
                }
                case "export":
                    Export(m.GetProperty("action").GetString()!, Enum.Parse<CopySize>(m.GetProperty("size").GetString()!),
                        m.TryGetProperty("name", out var n) ? n.GetString() ?? name : name, m.GetProperty("dataURL").GetString()!);
                    break;
                case "saveProject":
                    SaveProject(m.GetProperty("json").GetString()!);
                    break;
                case "close":
                    closing = true;
                    Close();
                    break;
            }
        }
        catch (Exception ex)
        {
            Log.Write("editor message failed: " + ex);
            controller.Notify("Editor problem", ex.Message);
        }
    }

    /// <summary>Another picture (or .excalidraw drawing) as a new tab in this window.</summary>
    public void AddTab(Bitmap? capture, string tabName, string? tabScene = null)
    {
        var msg = new
        {
            type = "addTab", name = tabName, scene = tabScene, width = capture?.Width ?? 0, height = capture?.Height ?? 0,
            dataURL = capture != null ? "data:image/png;base64," + Convert.ToBase64String(ImageExport.Png(capture)) : null,
        };
        if (ready) Post(msg); else queued.Add(msg);
    }

    bool ready;
    readonly List<object> queued = new();

    void Export(string action, CopySize size, string name, string dataURL)
    {
        var bytes = Convert.FromBase64String(dataURL[(dataURL.IndexOf(',') + 1)..]);
        using var bmp = new Bitmap(new MemoryStream(bytes));
        var hwnd = new WindowInteropHelper(this).Handle;
        switch (action)
        {
            case "copy":
                controller.CopyImage(bmp, size, name + " edited", hwnd);
                dirty = false;
                break;
            case "copyClose":
                if (controller.CopyImage(bmp, size, name + " edited", hwnd)) { closing = true; Close(); }
                break;
            case "save":
            {
                var dlg = new Microsoft.Win32.SaveFileDialog
                {
                    FileName = name + " edited", DefaultExt = ".webp",
                    Filter = "WebP, lossless (smallest, pixel-exact)|*.webp|PNG (lossless, opens everywhere)|*.png|JPEG (lossy, small photos)|*.jpg",
                    InitialDirectory = controller.Settings.SaveFolder,
                };
                if (dlg.ShowDialog(this) != true) return;
                var ext = Path.GetExtension(dlg.FileName).ToLowerInvariant();
                File.WriteAllBytes(dlg.FileName, ext switch
                {
                    ".jpg" or ".jpeg" => ImageExport.Jpeg(bmp, 92),
                    ".webp" when bmp.Width <= ImageExport.WebpMaxSide && bmp.Height <= ImageExport.WebpMaxSide => ImageExport.WebpLossless(bmp),
                    _ => ImageExport.Png(bmp),
                });
                dirty = false;
                break;
            }
            case "saveQuick" or "copyPath":
            {
                var path = ImageExport.SaveLossless(bmp, FreeBase(name + " edited"), controller.Settings.SaveFormat);
                controller.Notify(action == "copyPath" ? "Saved, path copied" : "Saved", Path.GetFileName(path));
                if (action == "copyPath") controller.CopyPath(path, hwnd);
                dirty = false;
                break;
            }
            case "closeSave":
            {
                // A tab (or the window) closing with changes never copied or saved: keep them rather than ask.
                // The page sends one per unsaved tab, then "close" when it's the window.
                var path = ImageExport.SaveLossless(bmp, FreeBase(name + " edited"), controller.Settings.SaveFormat);
                controller.Notify("Edits saved", Path.GetFileName(path));
                break;
            }
        }
        Log.Write($"editor {action} {size} {bmp.Width}x{bmp.Height}");
    }

    /// <summary>
    /// "&lt;name&gt;" in the save folder (extension added by the encoder), or "&lt;name&gt; 2", "… 3" if a .webp or .png
    /// of that name exists: a saved edit is never overwritten.
    /// </summary>
    string FreeBase(string baseName)
    {
        var dir = controller.Settings.SaveFolder;
        Directory.CreateDirectory(dir);
        bool Taken(string b) => File.Exists(b + ".webp") || File.Exists(b + ".png");
        var path = Path.Combine(dir, baseName);
        for (var i = 2; Taken(path); i++) path = Path.Combine(dir, $"{baseName} {i}");
        return path;
    }

    void SaveProject(string json)
    {
        var dlg = new Microsoft.Win32.SaveFileDialog
        {
            FileName = name, DefaultExt = ".excalidraw", Filter = "Editable Grabbit/Excalidraw drawing|*.excalidraw",
            InitialDirectory = controller.Settings.SaveFolder,
        };
        if (dlg.ShowDialog(this) != true) return;
        File.WriteAllText(dlg.FileName, json);
        controller.Notify("Saved editable drawing", Path.GetFileName(dlg.FileName));
    }
}
