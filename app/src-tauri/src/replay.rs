// Replay buffer: always records the screen the mouse was on when it started, keeping only the last N seconds (2-second
// segments in a ring on disk, sound in a ring in memory). The save hotkey turns the last N seconds into a normal
// recording: copied, saved, opened in the editor.

use crate::{actions, editor, export, settings::Settings, state, video};
use anyhow::{bail, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::{
    collections::VecDeque,
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::AppHandle;

const SEG: u32 = 2;

/// The last `secs` of a sound source, in memory.
struct Ring { buf: Arc<Mutex<(VecDeque<i16>, Instant)>>, rate: u32, channels: u16, _stream: cpal::Stream, _keep: Option<cpal::Stream> }

impl Ring {
    fn new(device: cpal::Device, cfg: cpal::SupportedStreamConfig, secs: u32, keep: Option<cpal::Stream>) -> Result<Self> {
        let cap = (cfg.sample_rate() * cfg.channels() as u32 * (secs + 4)) as usize;
        let buf = Arc::new(Mutex::new((VecDeque::with_capacity(cap), Instant::now())));
        let b = buf.clone();
        let stream = device.build_input_stream_raw(cfg.config(), cfg.sample_format(), move |data: &cpal::Data, _| {
            let mut g = b.lock().unwrap();
            for s in crate::audio::samples_i16(data) { if g.0.len() >= cap { g.0.pop_front(); } g.0.push_back(s); }
            g.1 = Instant::now();
        }, |e| log::warn!("replay audio: {e}"), None)?;
        stream.play()?;
        Ok(Ring { buf, rate: cfg.sample_rate(), channels: cfg.channels(), _stream: stream, _keep: keep })
    }

    /// Write the newest `secs` as a WAV; returns how long ago the newest sample arrived.
    fn dump(&self, path: &Path, secs: f64) -> Result<Duration> {
        let g = self.buf.lock().unwrap();
        let n = ((secs * self.rate as f64) as usize * self.channels as usize).min(g.0.len());
        let spec = hound::WavSpec { channels: self.channels, sample_rate: self.rate, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(path, spec)?;
        for s in g.0.iter().skip(g.0.len() - n) { w.write_sample(*s)?; }
        w.finalize()?;
        Ok(g.1.elapsed())
    }
}

struct Buffer { ffmpeg: Child, dir: PathBuf, secs: u32, sys: Option<Ring>, mic: Option<Ring>, started: Instant }

// cpal streams aren't Send on every OS, so the buffer lives on its own thread and is driven by messages.
enum Msg { Save(mpsc::Sender<Result<PathBuf>>), Stop }
use std::sync::mpsc;
static CTL: Mutex<Option<mpsc::Sender<Msg>>> = Mutex::new(None);

pub fn running() -> bool { CTL.lock().unwrap().is_some() }

fn start_buffer(s: &Settings) -> Result<Buffer> {
    let secs = s.replay_seconds.clamp(10, 600);
    let dir = std::env::temp_dir().join("Grabbit").join("replay");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    let wrap = secs / SEG + 3;
    let m = xcap::Monitor::all()?.into_iter().find(|m| m.is_primary().unwrap_or(false)).or_else(|| xcap::Monitor::all().ok()?.into_iter().next()).context("no screen")?;
    #[cfg(target_os = "macos")]
    let _ = &m; // AVFoundation names the screen instead of using its position
    let mut a: Vec<String> = vec!["-hide_banner".into(), "-loglevel".into(), "error".into(), "-y".into()];
    let fps = "30".to_string();
    #[cfg(windows)]
    a.extend(["-f".into(), "gdigrab".into(), "-framerate".into(), fps.clone(), "-offset_x".into(), m.x()?.to_string(), "-offset_y".into(), m.y()?.to_string(),
        "-video_size".into(), format!("{}x{}", m.width()? & !1, m.height()? & !1), "-draw_mouse".into(), "1".into(), "-i".into(), "desktop".into()]);
    #[cfg(target_os = "macos")]
    a.extend(["-f".into(), "avfoundation".into(), "-capture_cursor".into(), "1".into(), "-framerate".into(), fps.clone(), "-i".into(), "Capture screen 0:none".into()]);
    #[cfg(target_os = "linux")]
    a.extend(["-f".into(), "x11grab".into(), "-framerate".into(), fps.clone(), "-draw_mouse".into(), "1".into(),
        "-video_size".into(), format!("{}x{}", m.width()? & !1, m.height()? & !1), "-i".into(), format!("{}+{},{}", std::env::var("DISPLAY").unwrap_or(":0".into()), m.x()?, m.y()?)]);
    a.extend(["-vf".into(), "scale='trunc(min(iw,1920*iw/max(iw,ih))/2)*2':-2,format=yuv420p".into()]);
    a.extend(video::h264(s, 26, 0));
    a.extend(["-g".into(), "60".into(), "-f".into(), "segment".into(), "-segment_time".into(), SEG.to_string(), "-segment_wrap".into(), wrap.to_string(),
        "-reset_timestamps".into(), "1".into(), "-segment_format".into(), "mpegts".into(), dir.join("rep%03d.ts").to_string_lossy().into()]);
    let mut c = Command::new(video::ffmpeg(s)?);
    video::hide(c.args(&a).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()));
    let ffmpeg = c.spawn()?;
    let host = cpal::default_host();
    let mic = if s.record_microphone { host.default_input_device().and_then(|d| { let c = d.default_input_config().ok()?; Ring::new(d, c, secs, None).ok() }) } else { None };
    #[cfg(windows)]
    let sys = if s.record_system_audio { host.default_output_device().and_then(|d| {
        let c = d.default_output_config().ok()?;
        let keep = crate::audio::silence_stream(&d, &c).ok();
        Ring::new(d, c, secs, keep).ok()
    }) } else { None };
    #[cfg(not(windows))]
    let sys = None;
    Ok(Buffer { ffmpeg, dir, secs, sys, mic, started: Instant::now() })
}

fn save(s: &Settings, b: &Buffer) -> Result<PathBuf> {
    let mut segs: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(&b.dir)?.filter_map(|e| e.ok()).map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "ts").unwrap_or(false))
        .filter_map(|p| Some((std::fs::metadata(&p).ok()?.modified().ok()?, p))).collect();
    segs.sort();
    // The newest segment is still being written: leave it out, so every part is complete.
    segs.pop();
    let need = (b.secs / SEG + 1) as usize;
    let segs: Vec<PathBuf> = segs.into_iter().rev().take(need).rev().map(|(_, p)| p).collect();
    if segs.is_empty() { bail!("The replay buffer has nothing yet; give it a few seconds") }
    let list = b.dir.join("list.txt");
    std::fs::File::create(&list)?.write_all(segs.iter().map(|p| format!("file '{}'\n", p.to_string_lossy().replace('\'', "'\\''"))).collect::<String>().as_bytes())?;
    let joined = b.dir.join("joined.mp4");
    let ff = video::ffmpeg(s)?;
    let r = video::run(&ff, &["-hide_banner", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", &list.to_string_lossy(), "-c", "copy", &joined.to_string_lossy()].map(String::from), None, |_| {})?;
    if r.code != 0 { bail!("couldn't join the replay: {}", r.err.trim()) }
    let dur = video::probe(s, &joined)?.duration;
    // The video ends when the last complete segment ended; sound rings run up to now.
    let video_end_ago = segs.last().and_then(|p| std::fs::metadata(p).ok()?.modified().ok()?.elapsed().ok()).unwrap_or_default().as_secs_f64();
    let mut inputs: Vec<String> = vec!["-hide_banner".into(), "-v".into(), "error".into(), "-y".into(), "-i".into(), joined.to_string_lossy().into()];
    let mut maps: Vec<String> = vec!["-map".into(), "0:v".into(), "-c:v".into(), "copy".into()];
    let mut n = 0;
    for (ring, title, name) in [(&b.sys, video::SYSTEM_TRACK, "sys.wav"), (&b.mic, video::MIC_TRACK, "mic.wav")] {
        let Some(ring) = ring else { continue };
        let wav = b.dir.join(name);
        let newest_ago = ring.dump(&wav, dur + video_end_ago + 1.0)?;
        // Trim the sound's tail so it ends where the picture ends.
        let total = dur + video_end_ago + 1.0;
        let start = (total - dur - (video_end_ago - newest_ago.as_secs_f64())).max(0.0);
        inputs.extend(["-ss".into(), format!("{start:.3}"), "-i".into(), wav.to_string_lossy().into()]);
        n += 1;
        maps.extend(["-map".into(), format!("{n}:a"), format!("-metadata:s:a:{}", n - 1), format!("handler_name={title}")]);
    }
    if n > 0 { maps.extend(["-c:a", "aac", "-b:a", "160k", "-shortest"].map(String::from)); }
    let folder = PathBuf::from(&s.video_folder);
    std::fs::create_dir_all(&folder)?;
    let out = export::free(&folder, &export::stamp_name("Grabbit replay"), "mp4");
    inputs.extend(maps);
    inputs.extend(["-movflags".into(), "+faststart".into(), out.to_string_lossy().into()]);
    let r = video::run(&ff, &inputs, None, |_| {})?;
    if r.code != 0 { bail!("couldn't finish the replay: {}", r.err.trim()) }
    Ok(out)
}

/// Start or stop to match the settings (called at startup and whenever settings change).
pub fn sync(app: &AppHandle) {
    let s = state(app).settings.lock().unwrap().clone();
    let on = s.replay_enabled;
    if on == running() { return; }
    if !on { if let Some(tx) = CTL.lock().unwrap().take() { let _ = tx.send(Msg::Stop); } return; }
    let (tx, rx) = mpsc::channel::<Msg>();
    *CTL.lock().unwrap() = Some(tx);
    let app = app.clone();
    std::thread::spawn(move || {
        let mut b = match start_buffer(&s) {
            Ok(b) => b,
            Err(e) => { *CTL.lock().unwrap() = None; return actions::notify(&app, &format!("Replay buffer couldn't start: {e}")); }
        };
        log::info!("replay buffer on: last {} s", b.secs);
        while let Ok(m) = rx.recv() {
            match m {
                Msg::Save(reply) => { let _ = reply.send(if b.started.elapsed() < Duration::from_secs(SEG as u64 * 2) { Err(anyhow::anyhow!("The replay buffer only just started")) } else { save(&s, &b) }); }
                Msg::Stop => break,
            }
        }
        if let Some(i) = b.ffmpeg.stdin.as_mut() { let _ = i.write_all(b"q"); }
        let _ = b.ffmpeg.wait();
        let _ = std::fs::remove_dir_all(&b.dir);
    });
}

pub fn save_now(app: &AppHandle) {
    let tx = CTL.lock().unwrap().clone();
    let Some(tx) = tx else { return actions::notify(app, "Turn on the replay buffer in Settings → Recording first") };
    let (rtx, rrx) = mpsc::channel();
    let _ = tx.send(Msg::Save(rtx));
    let app = app.clone();
    std::thread::spawn(move || match rrx.recv().unwrap_or_else(|_| Err(anyhow::anyhow!("replay buffer stopped"))) {
        Ok(p) => {
            let s = state(&app).settings.lock().unwrap().clone();
            if s.copy_recording { let _ = export::copy_file(&p); }
            actions::quick_show(&app, Some(&p), "Replay saved");
            if s.edit_after_recording { editor::open_path(&app, &p); }
        }
        Err(e) => actions::notify(&app, &format!("{e}")),
    });
}
