using System;
using System.IO;
using System.Linq;
using System.Threading;
using System.Windows;

namespace Grabbit;

public partial class App : Application
{
    Mutex? single;
    Controller? controller;

    static string CommandFile => Path.Combine(AppSettings.Folder, "command.txt");

    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int processId);

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        DispatcherUnhandledException += (_, ex) =>
        {
            Log.Write("unhandled: " + ex.Exception);   // a failed capture must not take the tray app down
            ex.Handled = true;
        };

        // Headless check used by the build loop: grab, copy every preset, read the clipboard back, exit.
        var self = Array.IndexOf(e.Args, "--selftest");
        if (self >= 0)
        {
            var outDir = e.Args.ElementAtOrDefault(self + 1) ?? Path.Combine(Path.GetTempPath(), "grabbit-selftest");
            SelfTest.RunAsync(outDir).ContinueWith(t => Dispatcher.Invoke(() => Shutdown(t.IsCompletedSuccessfully ? t.Result : 2)));
            return;
        }

        var rt = Array.IndexOf(e.Args, "--record-test");
        if (rt >= 0)
        {
            var outDir = e.Args.ElementAtOrDefault(rt + 1) ?? Path.Combine(Path.GetTempPath(), "grabbit-recordtest");
            RecordTest.RunAsync(outDir).ContinueWith(t => Dispatcher.Invoke(() => Shutdown(t.IsCompletedSuccessfully ? t.Result : 2)));
            return;
        }

        var rs = Array.IndexOf(e.Args, "--readme-shots");
        if (rs >= 0) { Shutdown(ReadmeShots.Run(e.Args[rs + 1], e.Args[rs + 2])); return; }

        // Dev: --record-area x,y,w,h <seconds> <out.mp4> — record an exact area with the overlay up (demo video, README shots).
        var ra = Array.IndexOf(e.Args, "--record-area");
        if (ra >= 0)
        {
            var n = e.Args[ra + 1].Split(',').Select(int.Parse).ToArray();
            async System.Threading.Tasks.Task<int> Run()
            {
                var rec = await Recorder.StartAsync(AppSettings.Load(), new System.Drawing.Rectangle(n[0], n[1], n[2], n[3]));
                using (new RecordingBar(rec.Area, rec, () => { }, () => { }, "PrtScn"))
                    await System.Threading.Tasks.Task.Delay(TimeSpan.FromSeconds(double.Parse(e.Args[ra + 2], System.Globalization.CultureInfo.InvariantCulture)));
                return await rec.StopAsync(e.Args[ra + 3]) ? 0 : 1;
            }
            Run().ContinueWith(t => Dispatcher.Invoke(() => Shutdown(t.IsCompletedSuccessfully ? t.Result : 2)));
            return;
        }

        // Dev check: scroll-capture an exact screen area and save it (no tray, no picker).
        var sa = Array.IndexOf(e.Args, "--scroll-area");
        if (sa >= 0)
        {
            var n = e.Args[sa + 1].Split(',').Select(int.Parse).ToArray();
            var cap = new ScrollCapture(new System.Drawing.Rectangle(n[0], n[1], n[2], n[3]), e.Args.Contains("fromtop"));
            cap.RunAsync().ContinueWith(t => Dispatcher.Invoke(() =>
            {
                using var bmp = t.Result;
                bmp?.Save(e.Args[sa + 2]);
                File.WriteAllText(e.Args[sa + 2] + ".txt", $"method={cap.Used} steps={cap.Steps} ending={cap.Ending} size={bmp?.Width}x{bmp?.Height}");
                Shutdown(bmp == null ? 1 : 0);
            }));
            return;
        }

        var isCommand = e.Args.Any(a => a is "--capture" or "--open" or "--record");
        single = new Mutex(true, "Grabbit.SingleInstance", out var first);
        if (!first)
        {
            // Already in the tray: hand it the command (default: region capture), then quit.
            try
            {
                Directory.CreateDirectory(AppSettings.Folder);
                File.WriteAllLines(CommandFile, isCommand ? e.Args : ["--capture"]);
                // We were just launched by the user, so we may take the foreground; pass that right on,
                // or the tray app's picker opens behind and never gets the click.
                AllowSetForegroundWindow(-1);
                EventWaitHandle.OpenExisting("Grabbit.Command").Set();
            }
            catch { }
            Shutdown();
            return;
        }

        var command = new EventWaitHandle(false, EventResetMode.AutoReset, "Grabbit.Command");
        new Thread(() =>
        {
            while (command.WaitOne())
            {
                string[] args;
                try { args = File.ReadAllLines(CommandFile); File.Delete(CommandFile); } catch { continue; }
                Dispatcher.BeginInvoke(() => controller?.RunCommand(args));
            }
        }) { IsBackground = true, Name = "Grabbit commands" }.Start();

        controller = new Controller(AppSettings.Load());
        controller.Start();
        if (isCommand) controller.RunCommand(e.Args);
    }

    protected override void OnExit(ExitEventArgs e)
    {
        controller?.Dispose();
        single?.Dispose();
        base.OnExit(e);
    }
}
