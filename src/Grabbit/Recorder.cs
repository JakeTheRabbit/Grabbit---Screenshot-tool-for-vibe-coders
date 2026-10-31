using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using Rect32 = System.Drawing.Rectangle;

namespace Grabbit;

/// <summary>
/// Records one screen area to video. ffmpeg does the picture: Desktop Duplication (ddagrab) of the monitor the area is on,
/// cropped on the GPU and encoded with NVENC (x264 if there's no NVIDIA card) into a temp .mkv that survives a crash.
/// NAudio does the sound: system audio (WASAPI loopback) and the mic go to WAVs. Stopping muxes it all into an .mp4
/// with faststart, so chat apps can preview it. Windows marked WDA_EXCLUDEFROMCAPTURE (the recording frame and bar) never show up.
/// </summary>
public sealed class Recorder
{
    /// <summary>What actually gets recorded: clipped to one monitor, even width and height (H.264 needs them).</summary>
    public Rect32 Area { get; }
    public Stopwatch Clock { get; } = new();

    readonly AppSettings settings;
    readonly string temp, sysWav, micWav;
    readonly int output;
    readonly Rect32 monitor;
    Process? ffmpeg;
    readonly StringBuilder log = new();
    double videoStart;   // seconds on the audio clock when ffmpeg's first frame went out
    readonly Stopwatch audioClock = new();
    WasapiLoopbackCapture? loopback;
    WasapiOut? keepAlive;
    WaveFileWriter? loopWriter;
    WasapiCapture? mic;
    WaveFileWriter? micWriter;

    Recorder(AppSettings s, Rect32 area, int output, Rect32 monitor)
    {
        settings = s;
        Area = area;
        this.output = output;
        this.monitor = monitor;
        Directory.CreateDirectory(s.VideoFolder);
        var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
        var dir = Path.Combine(Path.GetTempPath(), "Grabbit");
        Directory.CreateDirectory(dir);
        temp = Path.Combine(dir, $"rec-{stamp}.mkv");
        sysWav = Path.Combine(dir, $"rec-{stamp}-system.wav");
        micWav = Path.Combine(dir, $"rec-{stamp}-mic.wav");
    }

    /// <summary>Starts once ffmpeg is writing frames. Throws with ffmpeg's own error if it can't.</summary>
    public static async Task<Recorder> StartAsync(AppSettings s, Rect32 wanted)
    {
        var outputs = Dxgi.Outputs();
        if (outputs.Count == 0) throw new InvalidOperationException("No screens found to record.");
        var centre = new System.Drawing.Point(wanted.X + wanted.Width / 2, wanted.Y + wanted.Height / 2);
        var idx = outputs.FindIndex(o => o.Contains(centre));
        if (idx < 0) idx = outputs.Select((o, i) => (i, a: Rect32.Intersect(o, wanted))).OrderByDescending(x => (long)x.a.Width * x.a.Height).First().i;
        var area = Rect32.Intersect(outputs[idx], wanted);
        area.Width &= ~1;
        area.Height &= ~1;
        if (area.Width < 16 || area.Height < 16) throw new InvalidOperationException("That area is too small to record.");

        var r = new Recorder(s, area, idx, outputs[idx]);
        r.StartAudio();
        try
        {
            if (!await r.StartVideo(Video.HasNvenc(s)) && !await r.StartVideo(nvenc: false))
                throw new IOException("ffmpeg couldn't start recording: " + r.log.ToString().Trim().Split('\n').LastOrDefault());
        }
        catch { r.StopAudio(); throw; }
        r.Clock.Start();
        Log.Write($"recording {area} on output {idx} (monitor {outputs[idx]})");
        return r;
    }

    async Task<bool> StartVideo(bool nvenc)
    {
        // ddagrab's offsets are relative to its monitor.
        var source = $"ddagrab=output_idx={output}:framerate={settings.RecordFps}:offset_x={Area.X - monitor.X}:offset_y={Area.Y - monitor.Y}:video_size={Area.Width}x{Area.Height}:draw_mouse={(settings.RecordCursor ? 1 : 0)}";
        var encode = nvenc
            ? $"-c:v h264_nvenc -preset p4 -tune hq -rc vbr -cq {settings.RecordQuality} -b:v 0"
            : $"-vf hwdownload,format=bgra,format=yuv420p -c:v libx264 -preset veryfast -crf {settings.RecordQuality}";
        var args = $"-hide_banner -y -f lavfi -i \"{source}\" {encode} -g {settings.RecordFps * 2} \"{temp}\"";
        Log.Write("record: " + args);
        var started = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        ffmpeg = Process.Start(new ProcessStartInfo(Video.Ffmpeg(settings), args)
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardError = true,
        })!;
        ffmpeg.ErrorDataReceived += (_, e) =>
        {
            if (e.Data == null) return;
            lock (log) { if (log.Length < 20000) log.AppendLine(e.Data); }
            if (e.Data.StartsWith("Output #0"))
            {
                videoStart = audioClock.Elapsed.TotalSeconds;
                started.TrySetResult(true);
            }
        };
        ffmpeg.EnableRaisingEvents = true;
        ffmpeg.Exited += (_, _) => started.TrySetResult(false);
        ffmpeg.BeginErrorReadLine();
        if (await Task.WhenAny(started.Task, Task.Delay(15000)) != started.Task) { try { ffmpeg.Kill(); } catch { } return false; }
        if (!started.Task.Result) Log.Write($"ffmpeg ({(nvenc ? "nvenc" : "x264")}) exited: {log}");
        return started.Task.Result && !ffmpeg.HasExited;
    }

    void StartAudio()
    {
        audioClock.Start();
        if (settings.RecordSystemAudio)
        {
            try
            {
                loopback = new WasapiLoopbackCapture();
                loopWriter = new WaveFileWriter(sysWav, loopback.WaveFormat);
                loopback.DataAvailable += (_, e) => loopWriter.Write(e.Buffer, 0, e.BytesRecorded);
                // Loopback delivers nothing while the device is silent, which would squash the gaps out of the WAV
                // and pull the sound out of sync. Playing silence keeps the device ticking.
                keepAlive = new WasapiOut(AudioClientShareMode.Shared, 100);
                keepAlive.Init(new SilenceProvider(loopback.WaveFormat));
                keepAlive.Play();
                loopback.StartRecording();
            }
            catch (Exception ex) { Log.Write("system audio unavailable: " + ex.Message); DisposeLoopback(); }
        }
        if (settings.RecordMicrophone)
        {
            try
            {
                mic = new WasapiCapture();
                micWriter = new WaveFileWriter(micWav, mic.WaveFormat);
                mic.DataAvailable += (_, e) => micWriter.Write(e.Buffer, 0, e.BytesRecorded);
                mic.StartRecording();
            }
            catch (Exception ex) { Log.Write("microphone unavailable: " + ex.Message); mic?.Dispose(); mic = null; micWriter?.Dispose(); micWriter = null; }
        }
    }

    void DisposeLoopback()
    {
        keepAlive?.Dispose(); keepAlive = null;
        loopback?.Dispose(); loopback = null;
        loopWriter?.Dispose(); loopWriter = null;
    }

    void StopAudio()
    {
        try { loopback?.StopRecording(); } catch { }
        try { mic?.StopRecording(); } catch { }
        Thread.Sleep(150);   // let the last buffers land before the writers close
        DisposeLoopback();
        mic?.Dispose(); mic = null;
        micWriter?.Dispose(); micWriter = null;
    }

    /// <summary>Stops, muxes the sound in and writes <paramref name="path"/> (.mp4). Returns false if nothing usable was recorded.</summary>
    public async Task<bool> StopAsync(string path)
    {
        Clock.Stop();
        await StopVideo();
        StopAudio();
        try
        {
            if (!File.Exists(temp) || new FileInfo(temp).Length < 1024) { Log.Write("recording empty: " + log); return false; }
            string F(double d) => d.ToString("0.###", CultureInfo.InvariantCulture);
            // System sound and mic stay separate tracks, titled, so the editor can copy either, both mixed, or neither.
            var tracks = new[] { (sysWav, Video.SystemTrack), (micWav, Video.MicTrack) }.Where(t => File.Exists(t.Item1) && new FileInfo(t.Item1).Length > 4096).ToList();
            var inputs = string.Concat(tracks.Select(t => $" -ss {F(videoStart)} -i \"{t.Item1}\""));
            var audio = string.Concat(tracks.Select((t, i) => $" -map {i + 1}:a -metadata:s:a:{i} handler_name=\"{t.Item2}\""))
                        + (tracks.Count > 0 ? " -c:a aac -b:a 160k -shortest" : "");
            var args = $"-hide_banner -v error -y -i \"{temp}\"{inputs} -map 0:v -c:v copy{audio} -movflags +faststart \"{path}\"";
            Log.Write("mux: " + args);
            var r = await Video.RunAsync(Video.Ffmpeg(settings), args, null, CancellationToken.None);
            if (r.Code != 0) throw new IOException("ffmpeg couldn't finish the video: " + r.Error.Trim());
            return true;
        }
        finally { Cleanup(); }
    }

    /// <summary>Stops and throws the recording away.</summary>
    public async Task CancelAsync()
    {
        Clock.Stop();
        await StopVideo();
        StopAudio();
        Cleanup();
    }

    async Task StopVideo()
    {
        if (ffmpeg == null) return;
        try
        {
            if (!ffmpeg.HasExited)
            {
                ffmpeg.StandardInput.Write('q');   // ffmpeg's own "stop": it finishes the file properly
                ffmpeg.StandardInput.Flush();
            }
            using var wait = new CancellationTokenSource(10000);
            try { await ffmpeg.WaitForExitAsync(wait.Token); }
            catch (OperationCanceledException) { ffmpeg.Kill(); }
        }
        catch (Exception ex) { Log.Write("stopping ffmpeg: " + ex.Message); }
        ffmpeg.Dispose();
        ffmpeg = null;
    }

    void Cleanup()
    {
        foreach (var f in new[] { temp, sysWav, micWav })
            try { File.Delete(f); } catch { }
    }
}
