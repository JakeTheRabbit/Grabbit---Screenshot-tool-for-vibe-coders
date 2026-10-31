using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Grabbit;

/// <summary>
/// Writes every useful format in one go (Greenshot's approach) through raw Win32, so the format list and
/// its order are exactly what we choose: PNG / JFIF for modern apps, DIBV5 for alpha, DIB for old apps,
/// and a file drop so chat apps attach the picture as a named file.
/// </summary>
public static class ClipboardService
{
    static readonly uint CfPng = Native.RegisterClipboardFormat("PNG");
    static readonly uint CfJfif = Native.RegisterClipboardFormat("JFIF");
    static readonly uint CfDropEffect = Native.RegisterClipboardFormat("Preferred DropEffect");

    public static string TempFolder => AppSettings.DemoFolder is { } demo ? Path.Combine(demo, "clip") : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Grabbit", "clip");

    /// <returns>The temp file placed on the clipboard as a file drop, if any.</returns>
    public static string? CopyImage(IntPtr owner, Encoded img, bool asFile, string baseName)
    {
        var items = new List<(uint, byte[])>
        {
            (img.Extension == ".png" ? CfPng : CfJfif, img.Bytes),
            (Native.CF_DIBV5, ImageExport.DibV5(img.Pixels)),
            (Native.CF_DIB, ImageExport.Dib(img.Pixels)),
        };
        string? file = null;
        if (asFile)
        {
            Directory.CreateDirectory(TempFolder);
            file = Path.Combine(TempFolder, baseName + img.Extension);
            File.WriteAllBytes(file, img.Bytes);
            items.Add((Native.CF_HDROP, DropFiles(file)));
            items.Add((CfDropEffect, BitConverter.GetBytes(1)));   // DROPEFFECT_COPY: paste never moves our temp file
        }
        Put(owner, items);
        return file;
    }

    /// <summary>A file (a recording) as a file drop: chat apps attach it, Explorer pastes a copy.</summary>
    public static void CopyFile(IntPtr owner, string path) =>
        Put(owner, [(Native.CF_HDROP, DropFiles(path)), (CfDropEffect, BitConverter.GetBytes(1))]);

    public static void CopyText(IntPtr owner, string text) =>
        Put(owner, [(CfUnicodeText, Encoding.Unicode.GetBytes(text + "\0"))]);

    const uint CfUnicodeText = 13;

    /// <summary>Clipboard temp files older than a day; called at startup.</summary>
    public static void CleanTemp()
    {
        try
        {
            foreach (var f in Directory.EnumerateFiles(TempFolder))
                if (File.GetLastWriteTimeUtc(f) < DateTime.UtcNow.AddDays(-1)) File.Delete(f);
        }
        catch { }
    }

    static byte[] DropFiles(string path)
    {
        // DROPFILES { DWORD pFiles = 20; POINT pt; BOOL fNC; BOOL fWide = 1 } then a double-null-terminated UTF-16 list.
        var names = Encoding.Unicode.GetBytes(path + "\0\0");
        var buf = new byte[20 + names.Length];
        BitConverter.GetBytes(20).CopyTo(buf, 0);
        BitConverter.GetBytes(1).CopyTo(buf, 16);
        names.CopyTo(buf, 20);
        return buf;
    }

    static void Put(IntPtr owner, List<(uint Format, byte[] Data)> items)
    {
        // Another app (clipboard managers, RDP) may hold the clipboard for a moment; give it up to ~2 s.
        for (var attempt = 0; !Native.OpenClipboard(owner); attempt++)
        {
            if (attempt == 40) throw new IOException("The clipboard is busy (another app has it open).");
            Thread.Sleep(50);
        }
        try
        {
            Native.EmptyClipboard();
            foreach (var (format, data) in items)
            {
                var h = Native.GlobalAlloc(Native.GMEM_MOVEABLE, (UIntPtr)data.Length);
                var p = Native.GlobalLock(h);
                Marshal.Copy(data, 0, p, data.Length);
                Native.GlobalUnlock(h);
                if (Native.SetClipboardData(format, h) == IntPtr.Zero) Native.GlobalFree(h);   // on success the clipboard owns it
            }
        }
        finally { Native.CloseClipboard(); }
    }

    /// <summary>Format names and byte sizes currently on the clipboard (for the self-test).</summary>
    public static List<(uint Format, string Name, byte[] Data)> Read()
    {
        var list = new List<(uint, string, byte[])>();
        for (var attempt = 0; !Native.OpenClipboard(IntPtr.Zero); attempt++)   // same retry as writing: others hold it briefly
        {
            if (attempt == 10) return list;
            Thread.Sleep(50);
        }
        try
        {
            for (uint f = Native.EnumClipboardFormats(0); f != 0; f = Native.EnumClipboardFormats(f))
            {
                var sb = new StringBuilder(128);
                var name = Native.GetClipboardFormatName(f, sb, sb.Capacity) > 0 ? sb.ToString() : f switch
                {
                    Native.CF_DIB => "CF_DIB", Native.CF_DIBV5 => "CF_DIBV5", Native.CF_HDROP => "CF_HDROP", 2 => "CF_BITMAP", _ => $"#{f}",
                };
                var h = Native.GetClipboardData(f);
                var data = Array.Empty<byte>();
                if (h != IntPtr.Zero && f != 2 && (int)(ulong)Native.GlobalSize(h) is var size and > 0)
                {
                    var p = Native.GlobalLock(h);
                    if (p != IntPtr.Zero) { data = new byte[size]; Marshal.Copy(p, data, 0, size); Native.GlobalUnlock(h); }
                }
                list.Add((f, name, data));
            }
        }
        finally { Native.CloseClipboard(); }
        return list;
    }
}
