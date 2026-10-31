using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;

namespace Grabbit;

/// <summary>
/// --record-test &lt;dir&gt;: records 4 s of an area on the primary screen with the recording frame and bar up, then checks the file,
/// that the frame never got into the picture, and that cut / chat / GIF renders come out the right length. Exit 0 = pass.
/// </summary>
public static class RecordTest
{
    public static async Task<int> RunAsync(string dir)
    {
        Directory.CreateDirectory(dir);
        var report = new List<string>();
        var failures = 0;
        void Check(bool ok, string what) { report.Add((ok ? "PASS " : "FAIL ") + what); if (!ok) failures++; }
        var s = AppSettings.Load();
        s.VideoFolder = dir;
        try
        {
            var outputs = Dxgi.Outputs();
            report.Add("dxgi outputs: " + string.Join(" ", outputs));
            var screen = System.Windows.Forms.Screen.PrimaryScreen!.Bounds;
            var area = new Rectangle(screen.X + 201, screen.Y + 151, 1281, 721);   // odd on purpose: must come out even
            var rec = await Recorder.StartAsync(s, area);
            Check(rec.Area.Width % 2 == 0 && rec.Area.Height % 2 == 0, $"area made even: {rec.Area}");
            using (new RecordingBar(rec.Area, rec, () => { }, () => { }, "test"))
                await Task.Delay(4000);
            var mp4 = Path.Combine(dir, "recording.mp4");
            Check(await rec.StopAsync(mp4), "stop wrote " + mp4);
            var info = Video.Probe(s, mp4);
            report.Add($"recording: {info}");
            Check(info.Width == rec.Area.Width && info.Height == rec.Area.Height, "size matches the area");
            Check(info.Duration is > 3.0 and < 5.5, $"duration {info.Duration:0.00}s ≈ 4 s");
            Check(!s.RecordSystemAudio || info.AudioTracks.Contains(Video.SystemTrack), $"audio tracks: {string.Join(", ", info.AudioTracks.Select(a => $"'{a}'"))}");
            if (info.AudioTracks.Length > 1)
            {
                var sys = Path.Combine(dir, "system-only.mp4");
                await Video.Render(s, mp4, [(0, info.Duration)], VideoTarget.Full, sys, null, CancellationToken.None, SoundChoice.System);
                var none = Path.Combine(dir, "silent.mp4");
                await Video.Render(s, mp4, [(0, info.Duration)], VideoTarget.Full, none, null, CancellationToken.None, SoundChoice.None);
                Check(Video.Probe(s, sys).AudioTracks.Length == 1 && !Video.Probe(s, none).HasAudio, "sound choice: system only = 1 track, none = silent");
            }

            // The red frame hugs the area's edges; excluded from capture, so the edge pixels must not be red.
            var still = Path.Combine(dir, "still.png");
            await Video.RunAsync(Video.Ffmpeg(s), $"-v error -y -ss 2 -i \"{mp4}\" -frames:v 1 \"{still}\"", null, CancellationToken.None);
            using (var bmp = new Bitmap(still))
            {
                var red = 0;
                for (var x = 0; x < bmp.Width; x++)
                    foreach (var y in new[] { 0, 1, bmp.Height - 2, bmp.Height - 1 })
                    {
                        var c = bmp.GetPixel(x, y);
                        if (c.R > 180 && c.G < 60 && c.B < 70) red++;
                    }
                Check(red < bmp.Width / 10, $"recording frame not in the video ({red} red edge pixels)");
            }

            var cut = Path.Combine(dir, "cut.mp4");
            await Video.Render(s, mp4, [(0.5, 1.5), (2.5, 3.5)], VideoTarget.Full, cut, null, CancellationToken.None);
            var ci = Video.Probe(s, cut);
            Check(Math.Abs(ci.Duration - 2.0) < 0.25, $"two-part cut is 2 s: {ci.Duration:0.00}s, audio={ci.HasAudio}");
            var chat = Path.Combine(dir, "chat.mp4");
            await Video.Render(s, mp4, [(0, info.Duration)], VideoTarget.Chat, chat, null, CancellationToken.None);
            Check(new FileInfo(chat).Length < Video.ChatMaxBytes, $"chat copy {new FileInfo(chat).Length / 1024} KB");
            var gif = Path.Combine(dir, "clip.gif");
            await Video.Render(s, mp4, [(1, 2)], VideoTarget.Gif, gif, null, CancellationToken.None);
            Check(File.Exists(gif) && new FileInfo(gif).Length > 1000, $"gif {new FileInfo(gif).Length / 1024} KB");
        }
        catch (Exception ex) { Check(false, "exception: " + ex); }
        report.Add(failures == 0 ? "ALL PASS" : $"{failures} FAILED");
        File.WriteAllLines(Path.Combine(dir, "report.txt"), report);
        return failures == 0 ? 0 : 1;
    }
}
