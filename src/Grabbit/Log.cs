using System;
using System.IO;

namespace Grabbit;

/// <summary>Append-only diagnostics at %APPDATA%\Grabbit\log.txt (trimmed to the last ~200 KB at startup).</summary>
public static class Log
{
    static readonly string FilePath = Path.Combine(AppSettings.Folder, "log.txt");
    static readonly object Gate = new();

    public static void Trim()
    {
        try
        {
            if (File.Exists(FilePath) && new FileInfo(FilePath).Length > 400_000)
            {
                var text = File.ReadAllText(FilePath);
                File.WriteAllText(FilePath, text[^200_000..]);
            }
        }
        catch { }
    }

    public static void Write(string message)
    {
        try
        {
            lock (Gate)
            {
                Directory.CreateDirectory(AppSettings.Folder);
                File.AppendAllText(FilePath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} {message}{Environment.NewLine}");
            }
        }
        catch { }
    }
}
