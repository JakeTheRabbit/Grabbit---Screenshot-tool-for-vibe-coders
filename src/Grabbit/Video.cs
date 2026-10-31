using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Grabbit;

/// <summary>How an edited recording is written out.</summary>
public enum VideoTarget { Full, Chat, Gif }

/// <summary><paramref name="AudioTracks"/>: each audio stream's title, in order ("" when untitled).</summary>
public sealed record VideoInfo(double Duration, double Fps, int Width, int Height, string[] AudioTracks, long Bytes)
{
    public bool HasAudio => AudioTracks.Length > 0;
}

/// <summary>What sound goes into a rendered copy: both tracks mixed, one of them, or none.</summary>
public enum SoundChoice { All, System, Mic, None }

/// <summary>A drawing burned into the video while the source time is between From and To (seconds, before cutting).</summary>
public sealed record Overlay(string Png, double From, double To);

/// <summary>
/// ffmpeg/ffprobe for recordings: find them, probe a file, and render the kept parts of a video
/// (trim + concat) to MP4 or GIF. H.264 goes to NVENC when the GPU has it, otherwise x264.
/// </summary>
public static class Video
{
    public static readonly string[] Extensions = [".mp4", ".mkv", ".mov", ".webm", ".avi"];

    /// <summary>Signal compares its 100 MiB limit against the encrypted, padded size; this leaves room for that.</summary>
    public const long ChatMaxBytes = 94L * 1024 * 1024;

    public static bool IsVideo(string path) => Extensions.Contains(Path.GetExtension(path).ToLowerInvariant());

    /// <summary>Audio track titles Grabbit's recorder writes.</summary>
    public const string SystemTrack = "System sound", MicTrack = "Microphone";

    /// <summary>
    /// Audio stream indexes to use. Untitled tracks (other apps' videos) count as "system": the first one is the sound,
    /// a second one the mic.
    /// </summary>
    public static List<int> Tracks(VideoInfo info, SoundChoice sound)
    {
        var t = info.AudioTracks;
        var sys = Array.IndexOf(t, SystemTrack) is >= 0 and var a ? a : Array.IndexOf(t, MicTrack) == 0 ? -1 : t.Length > 0 ? 0 : -1;
        var mic = Array.IndexOf(t, MicTrack) is >= 0 and var b ? b : t.Length > 1 ? 1 : -1;
        return sound switch
        {
            SoundChoice.All => Enumerable.Range(0, t.Length).ToList(),
            SoundChoice.System when sys >= 0 => [sys],
            SoundChoice.Mic when mic >= 0 => [mic],
            _ => [],
        };
    }

    static string? ffmpeg;

    /// <summary>Settings path, else PATH, else the WinGet links folder.</summary>
    public static string Ffmpeg(AppSettings s)
    {
        if (!string.IsNullOrWhiteSpace(s.FfmpegPath) && File.Exists(s.FfmpegPath)) return s.FfmpegPath;
        if (ffmpeg != null) return ffmpeg;
        var dirs = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries)
            .Append(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "WinGet", "Links"));
        ffmpeg = dirs.Select(d => Path.Combine(d.Trim('"'), "ffmpeg.exe")).FirstOrDefault(File.Exists)
            ?? throw new FileNotFoundException("ffmpeg isn't installed (winget install Gyan.FFmpeg), or set FfmpegPath in settings.");
        return ffmpeg;
    }

    /// <summary>ffprobe next to ffmpeg; a WinGet link points at a shim, so ask ffmpeg's real folder via the link target too.</summary>
    static string Ffprobe(AppSettings s)
    {
        var f = Ffmpeg(s);
        var target = new FileInfo(f).LinkTarget is { } t ? Path.GetFullPath(t, Path.GetDirectoryName(f)!) : f;
        return new[] { target, f }.Select(p => Path.Combine(Path.GetDirectoryName(p)!, "ffprobe.exe")).FirstOrDefault(File.Exists) ?? "ffprobe.exe";
    }

    static bool? nvenc;

    /// <summary>One tiny NVENC encode decides, once per run, which H.264 encoder to use.</summary>
    public static bool HasNvenc(AppSettings s)
    {
        if (nvenc is { } known) return known;
        try
        {
            var r = RunAsync(Ffmpeg(s), "-hide_banner -v error -f lavfi -i color=s=256x256:d=0.1 -c:v h264_nvenc -f null -", null, CancellationToken.None).Result;
            nvenc = r.Code == 0;
        }
        catch { nvenc = false; }
        Log.Write("nvenc: " + nvenc);
        return nvenc.Value;
    }

    /// <summary>H.264 encoder arguments: constant quality, or a target bitrate in kbps.</summary>
    public static string H264(AppSettings s, int quality = 21, int kbps = 0) => HasNvenc(s)
        ? "-c:v h264_nvenc -preset p5 -tune hq " + (kbps > 0 ? $"-rc vbr -b:v {kbps}k -maxrate {kbps * 3 / 2}k -bufsize {kbps * 2}k" : $"-rc vbr -cq {quality} -b:v 0")
        : "-c:v libx264 -preset veryfast " + (kbps > 0 ? $"-b:v {kbps}k -maxrate {kbps * 3 / 2}k -bufsize {kbps * 2}k" : $"-crf {quality}");

    public static VideoInfo Probe(AppSettings s, string path)
    {
        var r = RunAsync(Ffprobe(s), $"-v error -print_format json -show_format -show_streams \"{path}\"", null, CancellationToken.None).Result;
        using var doc = JsonDocument.Parse(r.Output);
        var streams = doc.RootElement.GetProperty("streams").EnumerateArray().ToList();
        var v = streams.FirstOrDefault(x => x.GetProperty("codec_type").GetString() == "video");
        double Num(JsonElement e, string name) =>
            e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var p) && double.TryParse(p.GetString(), CultureInfo.InvariantCulture, out var d) ? d : 0;
        double Rate(string? r)
        {
            var parts = (r ?? "0/1").Split('/');
            return parts.Length == 2 && double.TryParse(parts[0], CultureInfo.InvariantCulture, out var a) && double.TryParse(parts[1], CultureInfo.InvariantCulture, out var b) && b > 0 ? a / b : 0;
        }
        var fps = v.ValueKind == JsonValueKind.Object ? Rate(v.GetProperty("avg_frame_rate").GetString()) : 0;
        return new VideoInfo(
            Num(doc.RootElement.GetProperty("format"), "duration"),
            fps is > 0 and < 1000 ? fps : 30,
            v.ValueKind == JsonValueKind.Object ? v.GetProperty("width").GetInt32() : 0,
            v.ValueKind == JsonValueKind.Object ? v.GetProperty("height").GetInt32() : 0,
            streams.Where(x => x.GetProperty("codec_type").GetString() == "audio")
                .Select(x => x.TryGetProperty("tags", out var tags) && (tags.TryGetProperty("handler_name", out var name) || tags.TryGetProperty("title", out name))
                    ? name.GetString() is { } n && n != "SoundHandler" ? n : ""   // MP4 keeps a track's name as its handler name
                    : "").ToArray(),
            new FileInfo(path).Length);
    }

    /// <summary>
    /// Writes the <paramref name="keep"/> ranges (seconds, in order) of <paramref name="input"/> back to back into <paramref name="output"/>.
    /// Chat: long edge ≤ 1920 and a bitrate that lands under <see cref="ChatMaxBytes"/>. Gif: 12 fps, ≤ 960 px wide, own palette.
    /// <paramref name="sound"/> picks the audio tracks (mixed into one, which is what chat apps play);
    /// <paramref name="overlays"/> are video-sized PNGs burned in during their time span.
    /// </summary>
    public static async Task Render(AppSettings s, string input, IReadOnlyList<(double Start, double End)> keep, VideoTarget target,
        string output, Action<double>? progress, CancellationToken ct, SoundChoice sound = SoundChoice.All, IReadOnlyList<Overlay>? overlays = null)
    {
        var info = Probe(s, input);
        var tracks = target == VideoTarget.Gif ? [] : Tracks(info, sound);
        var audio = tracks.Count > 0;
        overlays ??= [];
        var total = keep.Sum(k => k.End - k.Start);
        string F(double d) => d.ToString("0.###", CultureInfo.InvariantCulture);

        var g = new StringBuilder();
        // Drawings go on first, keyed to the source time, so cutting later moves them with their part of the video.
        var source = "[0:v]";
        for (var i = 0; i < overlays.Count; i++)
        {
            g.Append($"{source}[{i + 1}:v]overlay=0:0:enable='between(t,{F(overlays[i].From)},{F(overlays[i].To)})'[ov{i}];");
            source = $"[ov{i}]";
        }
        if (overlays.Count > 0)
        {
            g.Append($"{source}split={keep.Count}" + string.Concat(Enumerable.Range(0, keep.Count).Select(i => $"[src{i}]")) + ";");
        }
        for (var i = 0; i < keep.Count; i++)
        {
            g.Append($"{(overlays.Count > 0 ? $"[src{i}]" : "[0:v]")}trim=start={F(keep[i].Start)}:end={F(keep[i].End)},setpts=PTS-STARTPTS[v{i}];");
            foreach (var j in tracks)
                g.Append($"[0:a:{j}]atrim=start={F(keep[i].Start)}:end={F(keep[i].End)},asetpts=PTS-STARTPTS[a{i}{(tracks.Count > 1 ? "_" + j : "")}];");
            if (tracks.Count > 1)
                g.Append(string.Concat(tracks.Select(j => $"[a{i}_{j}]")) + $"amix=inputs={tracks.Count}:duration=longest:normalize=0[a{i}];");
        }
        if (keep.Count > 1)
        {
            for (var i = 0; i < keep.Count; i++) g.Append(audio ? $"[v{i}][a{i}]" : $"[v{i}]");
            g.Append($"concat=n={keep.Count}:v=1:a={(audio ? 1 : 0)}[vc]" + (audio ? "[ac];" : ";"));
        }
        else g.Append("[v0]null[vc];" + (audio ? "[a0]anull[ac];" : ""));

        string codec;
        switch (target)
        {
            case VideoTarget.Gif:
                g.Append("[vc]fps=12,scale='min(960,iw)':-2:flags=lanczos,split[ga][gb];[ga]palettegen=stats_mode=diff[gp];[gb][gp]paletteuse=dither=bayer:bayer_scale=4[vo]");
                codec = "";
                break;
            case VideoTarget.Chat:
            {
                g.Append("[vc]scale='trunc(min(iw,1920*iw/max(iw,ih))/2)*2':-2,format=yuv420p[vo]");
                var budget = (int)((ChatMaxBytes * 8 * 0.97 / Math.Max(total, 1) - (audio ? 128_000 : 0)) / 1000);
                codec = H264(s, kbps: Math.Clamp(budget, 200, 6000)) + (audio ? " -c:a aac -b:a 128k" : "");
                break;
            }
            default:
                g.Append("[vc]scale='trunc(iw/2)*2':'trunc(ih/2)*2',format=yuv420p[vo]");
                codec = H264(s, quality: 21) + (audio ? " -c:a aac -b:a 160k" : "");
                break;
        }

        var maps = "-map \"[vo]\"" + (audio ? " -map \"[ac]\"" : "");
        var args = $"-hide_banner -v error -y -i \"{input}\"{string.Concat(overlays.Select(o => $" -i \"{o.Png}\""))} -filter_complex \"{g}\" {maps} {codec} " +
                   (target == VideoTarget.Gif ? "" : $"-g {(int)Math.Round(info.Fps * 2)} -movflags +faststart ") +
                   $"-progress pipe:1 -nostats \"{output}\"";
        Log.Write("render: " + args);
        var r = await RunAsync(Ffmpeg(s), args, line =>
        {
            if (line.StartsWith("out_time_us=") && long.TryParse(line[12..], out var us) && total > 0) progress?.Invoke(Math.Clamp(us / 1e6 / total, 0, 1));
        }, ct);
        if (r.Code != 0)
        {
            try { File.Delete(output); } catch { }
            throw new IOException("ffmpeg failed: " + r.Error.Trim().Split('\n').LastOrDefault());
        }
    }

    public sealed record Result(int Code, string Output, string Error);

    /// <summary>Runs a tool hidden; stdout lines go to <paramref name="line"/> as they arrive. Cancelling kills it.</summary>
    public static async Task<Result> RunAsync(string exe, string args, Action<string>? line, CancellationToken ct)
    {
        var psi = new ProcessStartInfo(exe, args)
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
        };
        using var p = Process.Start(psi)!;
        var output = new StringBuilder();
        var error = p.StandardError.ReadToEndAsync(CancellationToken.None);
        var reading = Task.Run(async () =>   // ConfigureAwait(false) below: Probe / HasNvenc wait on this from the UI thread
        {
            while (await p.StandardOutput.ReadLineAsync() is { } l) { output.AppendLine(l); line?.Invoke(l); }
        });
        using (ct.Register(() => { try { p.Kill(true); } catch { } }))
        {
            await p.WaitForExitAsync(CancellationToken.None).ConfigureAwait(false);
            await reading.ConfigureAwait(false);
        }
        ct.ThrowIfCancellationRequested();
        return new Result(p.ExitCode, output.ToString(), await error.ConfigureAwait(false));
    }
}
