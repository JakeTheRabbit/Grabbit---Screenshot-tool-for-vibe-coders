// Screen recording. ffmpeg grabs and encodes the picture (Desktop Duplication on Windows, AVFoundation on macOS,
// x11grab on Linux) into a crash-safe .mkv per segment. cpal writes the microphone (and Windows system sound) to WAVs.
// Pause ends a segment; Stop muxes each segment's sound in with separate named tracks, joins the segments and writes
// the .mp4 next to a cursor/click track used by the studio effects (auto-zoom, click rings, key captions).

use crate::{actions, audio::Capture, editor, export, settings::Settings, state, video};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{mpsc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Area { pub x: i32, pub y: i32, pub width: u32, pub height: u32 }

/// Resume may carry a new area: the frame was moved or resized while paused.
enum Cmd { Pause, Resume(Option<(i32, i32, u32, u32)>), Stop(bool, mpsc::Sender<Result<Option<PathBuf>>>) }

struct Session { tx: mpsc::Sender<Cmd>, area: Area, started: Instant, paused: Option<Instant>, paused_total: Duration }

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

pub fn is_recording(_app: &AppHandle) -> bool { SESSION.lock().unwrap().is_some() }

/// Seconds recorded so far, not counting pauses.
pub fn elapsed() -> f64 {
    SESSION.lock().unwrap().as_ref().map(|s| {
        let now = s.paused.unwrap_or_else(Instant::now);
        (now - s.started - s.paused_total).as_secs_f64()
    }).unwrap_or(0.0)
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct CursorTrack {
    /// Area size in pixels; positions are relative to the area's top-left.
    pub width: u32,
    pub height: u32,
    /// [seconds, x, y, buttons-down bitmask]
    pub moves: Vec<(f32, i32, i32, u8)>,
    /// [seconds, key label] for the key captions.
    pub keys: Vec<(f32, String)>,
}

pub fn cursor_track(video: &Path) -> Option<CursorTrack> {
    std::fs::read_to_string(video.with_extension("cursor.json")).ok().and_then(|t| serde_json::from_str(&t).ok())
}

/// A monitor in physical pixels, plus how ffmpeg names it on this OS.
struct Screen { x: i32, y: i32, width: u32, height: u32, index: usize }

fn screens(app: &AppHandle) -> Vec<Screen> {
    #[cfg(windows)]
    {
        let d = dxgi_outputs();
        if !d.is_empty() { return d; }
    }
    app.available_monitors().unwrap_or_default().iter().enumerate()
        .map(|(i, m)| Screen { x: m.position().x, y: m.position().y, width: m.size().width, height: m.size().height, index: i }).collect()
}

/// Headless recording for `--self-test`: the middle of the first screen, `secs` long, muxed like a real recording.
pub fn selftest(s: &Settings, dir: &Path, secs: u64) -> Result<PathBuf> {
    #[cfg(windows)]
    let scr = dxgi_outputs().into_iter().next().context("no screens")?;
    #[cfg(not(windows))]
    let scr = {
        let m = xcap::Monitor::all()?.into_iter().next().context("no screens")?;
        let k = if cfg!(target_os = "macos") { m.scale_factor().unwrap_or(1.0) } else { 1.0 };
        Screen { x: (m.x()? as f32 * k) as i32, y: (m.y()? as f32 * k) as i32, width: (m.width()? as f32 * k) as u32, height: (m.height()? as f32 * k) as u32, index: 0 }
    };
    let (w, h) = (640.min(scr.width) & !1, 360.min(scr.height) & !1);
    let area = Area { x: scr.x + (scr.width - w) as i32 / 2, y: scr.y + (scr.height - h) as i32 / 2, width: w, height: h };
    let tmp = dir.join("rec-parts");
    std::fs::create_dir_all(&tmp)?;
    let seg = start_segment(s, area, &scr, &tmp, 0, (area.width, area.height))?;
    std::thread::sleep(Duration::from_secs(secs));
    let done = stop_segment(seg);
    let out = dir.join("selftest.mp4");
    mux(s, &done, &out)?;
    Ok(out)
}

/// ddagrab numbers outputs in DXGI order, which needn't match the OS's monitor order.
#[cfg(windows)]
fn dxgi_outputs() -> Vec<Screen> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
    let mut out = Vec::new();
    unsafe {
        let Ok(f) = CreateDXGIFactory1::<IDXGIFactory1>() else { return out };
        let Ok(a) = f.EnumAdapters1(0) else { return out };
        let mut i = 0;
        while let Ok(o) = a.EnumOutputs(i) {
            if let Ok(d) = o.GetDesc() {
                let r = d.DesktopCoordinates;
                out.push(Screen { x: r.left, y: r.top, width: (r.right - r.left) as u32, height: (r.bottom - r.top) as u32, index: i as usize });
            }
            i += 1;
        }
    }
    out
}

/// What can actually be recorded: clipped to the monitor holding the area's centre, even width and height.
fn fit(app: &AppHandle, x: i32, y: i32, w: u32, h: u32) -> Result<(Area, Screen)> {
    let list = screens(app);
    let (cx, cy) = (x + w as i32 / 2, y + h as i32 / 2);
    let s = list.into_iter().max_by_key(|s| {
        let inside = cx >= s.x && cy >= s.y && cx < s.x + s.width as i32 && cy < s.y + s.height as i32;
        let ix = ((x + w as i32).min(s.x + s.width as i32) - x.max(s.x)).max(0) as i64;
        let iy = ((y + h as i32).min(s.y + s.height as i32) - y.max(s.y)).max(0) as i64;
        (inside, ix * iy)
    }).context("no screens found to record")?;
    let x0 = x.max(s.x);
    let y0 = y.max(s.y);
    let x1 = (x + w as i32).min(s.x + s.width as i32);
    let y1 = (y + h as i32).min(s.y + s.height as i32);
    let a = Area { x: x0, y: y0, width: ((x1 - x0).max(0) as u32) & !1, height: ((y1 - y0).max(0) as u32) & !1 };
    if a.width < 16 || a.height < 16 { bail!("That area is too small to record.") }
    Ok((a, s))
}

/// Linux system sound comes from PulseAudio / PipeWire's monitor source; without a sound server, record picture only.
#[cfg(target_os = "linux")]
fn pulse_ok() -> bool {
    static OK: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *OK.get_or_init(|| Command::new("pactl").arg("info").stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false))
}

fn wayland_only() -> bool {
    cfg!(target_os = "linux") && std::env::var("XDG_SESSION_TYPE").map(|t| t == "wayland").unwrap_or(false) && std::env::var("GRABBIT_FORCE_X11").is_err()
}

/// The first camera ffmpeg can open on this OS, as (input format, input name).
fn webcam(s: &Settings) -> Option<(&'static str, String)> {
    static CAM: std::sync::OnceLock<Option<(&'static str, String)>> = std::sync::OnceLock::new();
    CAM.get_or_init(|| {
        // Tests (and CI, which has no camera) use a generated picture instead of a real camera.
        if std::env::var("GRABBIT_FAKE_CAM").is_ok() { return Some(("lavfi", "testsrc2=s=640x480:r=30".to_string())); }
        if cfg!(target_os = "linux") {
            return Path::new("/dev/video0").exists().then(|| ("v4l2", "/dev/video0".to_string()));
        }
        let fmt = if cfg!(windows) { "dshow" } else { "avfoundation" };
        let args: Vec<String> = ["-hide_banner", "-list_devices", "true", "-f", fmt, "-i", if cfg!(windows) { "dummy" } else { "" }].map(String::from).to_vec();
        let r = video::run(&video::ffmpeg(s).ok()?, &args, None, |_| {}).ok()?;
        let mut video_section = !cfg!(target_os = "macos");
        for l in r.err.lines() {
            if cfg!(target_os = "macos") {
                if l.contains("AVFoundation video devices") { video_section = true; continue; }
                if l.contains("AVFoundation audio devices") { break; }
                // "[AVFoundation indev @ 0x…] [0] FaceTime HD Camera" — skip "Capture screen N".
                if video_section && !l.contains("Capture screen") {
                    if let Some(name) = l.rsplit("] ").next().filter(|_| l.matches('[').count() >= 2) { return Some((fmt, name.trim().to_string())); }
                }
            } else if l.contains("(video)") {
                if let Some(name) = l.split('"').nth(1) { return Some((fmt, format!("video={name}"))); }
            }
        }
        None
    }).clone()
}

/// ffmpeg arguments for one segment's picture (and, on Linux, system sound) into `out`. The webcam, when on, sits in
/// a circle in the bottom-right corner.
fn video_args(s: &Settings, a: Area, scr: &Screen, out: &Path, hw: bool, size: (u32, u32)) -> Vec<String> {
    let fps = s.record_fps.to_string();
    let q = s.record_quality;
    let mut v: Vec<String> = vec!["-hide_banner".into(), "-y".into()];
    let enc = video::hw_encoder(s);
    let cam = if s.record_webcam { webcam(s) } else { None };
    // Filters on the screen picture, before the optional webcam overlay.
    let mut chain: Vec<String> = Vec::new();
    // NVENC can take Desktop Duplication's GPU frames directly; everything else needs them in memory.
    let resized = size != (a.width, a.height);
    let gpu_direct = cfg!(windows) && hw && enc == "h264_nvenc" && cam.is_none() && !resized;

    #[cfg(windows)]
    {
        if hw {
            v.extend(["-f".into(), "lavfi".into(), "-i".into(), format!(
                "ddagrab=output_idx={}:framerate={fps}:offset_x={}:offset_y={}:video_size={}x{}:draw_mouse={}",
                scr.index, a.x - scr.x, a.y - scr.y, a.width, a.height, s.record_cursor as u8)]);
            if !gpu_direct { chain.push("hwdownload".into()); chain.push("format=bgra".into()); }
        } else {
            v.extend(["-f", "gdigrab", "-framerate"].map(String::from));
            v.push(fps.clone());
            v.extend(["-offset_x".into(), a.x.to_string(), "-offset_y".into(), a.y.to_string(), "-video_size".into(), format!("{}x{}", a.width, a.height),
                "-draw_mouse".into(), (s.record_cursor as u8).to_string(), "-i".into(), "desktop".into()]);
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = hw;
        v.extend(["-f", "avfoundation", "-capture_cursor"].map(String::from));
        v.push((s.record_cursor as u8).to_string());
        v.extend(["-framerate".into(), fps.clone(), "-i".into(), format!("Capture screen {}:none", scr.index)]);
        chain.push(format!("crop={}:{}:{}:{}", a.width, a.height, a.x - scr.x, a.y - scr.y));
    }
    #[cfg(target_os = "linux")]
    {
        let _ = (hw, scr);
        let display = std::env::var("DISPLAY").unwrap_or_else(|_| ":0".into());
        v.extend(["-f", "x11grab", "-framerate"].map(String::from));
        v.push(fps.clone());
        v.extend(["-draw_mouse".into(), (s.record_cursor as u8).to_string(), "-video_size".into(), format!("{}x{}", a.width, a.height), "-i".into(), format!("{display}+{},{}", a.x, a.y)]);
    }
    let mut next_input = 1;
    let cam_idx = cam.as_ref().map(|(fmt, name)| {
        v.extend(["-f".into(), fmt.to_string()]);
        if *fmt == "avfoundation" { v.extend(["-framerate".into(), "30".into()]); }
        v.extend(["-i".into(), name.clone()]);
        next_input += 1;
        next_input - 1
    });
    #[cfg(target_os = "linux")]
    let sys_idx = (s.record_system_audio && pulse_ok()).then(|| {
        v.extend(["-f", "pulse", "-i", "@DEFAULT_MONITOR@"].map(String::from));
        next_input += 1;
        next_input - 1
    });
    #[cfg(not(target_os = "linux"))]
    let sys_idx: Option<usize> = None;

    // A part recorded after the frame was resized is fitted to the first part's size, so the parts still join.
    if resized { chain.push(format!("scale={0}:{1}:force_original_aspect_ratio=decrease,pad={0}:{1}:(ow-iw)/2:(oh-ih)/2", size.0, size.1)); }
    if !gpu_direct { chain.push("format=yuv420p".into()); }
    match cam_idx {
        Some(ci) => {
            let d = (a.width.min(a.height) / 4).max(96) & !1;
            let r = d / 2;
            let m = (a.width.min(a.height) / 40).max(8);
            v.extend(["-filter_complex".into(), format!(
                "[0:v]{}[scr];[{ci}:v]scale={d}:{d}:force_original_aspect_ratio=increase,crop={d}:{d},format=yuva420p,geq=lum='p(X,Y)':cb='p(X,Y)':cr='p(X,Y)':a='if(lte((X-{r})*(X-{r})+(Y-{r})*(Y-{r}),{r}*{r}),255,0)'[cam];[scr][cam]overlay=W-w-{m}:H-h-{m}:shortest=1,format=yuv420p[v]",
                chain.join(","))]);
            v.extend(["-map".into(), "[v]".into()]);
            if let Some(si) = sys_idx { v.extend(["-map".into(), format!("{si}:a")]); }
        }
        None => {
            if !chain.is_empty() { v.extend(["-vf".into(), chain.join(",")]); }
            if let Some(si) = sys_idx { v.extend(["-map".into(), "0:v".into(), "-map".into(), format!("{si}:a")]); }
        }
    }
    if gpu_direct {
        v.extend(["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq", "-rc", "vbr"].map(String::from));
        v.extend(["-cq".into(), q.to_string(), "-b:v".into(), "0".into()]);
    } else {
        v.extend(video::h264(s, q, 0));
    }
    if sys_idx.is_some() { v.extend(["-c:a", "flac", "-metadata:s:a:0", "title=System sound"].map(String::from)); }
    v.extend(["-g".into(), (s.record_fps * 2).to_string(), out.to_string_lossy().into()]);
    v
}

struct Segment {
    ffmpeg: Child,
    mkv: PathBuf,
    video_start: Instant,
    system: Option<Capture>,
    mic: Option<Capture>,
    log: std::sync::Arc<Mutex<String>>,
}

fn start_segment(s: &Settings, a: Area, scr: &Screen, dir: &Path, n: usize, size: (u32, u32)) -> Result<Segment> {
    let mkv = dir.join(format!("part{n}.mkv"));
    #[cfg(any(windows, target_os = "macos"))]
    let system = if s.record_system_audio { Capture::system(dir.join(format!("part{n}-system.wav"))).map_err(|e| log::warn!("system sound: {e}")).ok() } else { None };
    #[cfg(target_os = "linux")]
    let system: Option<Capture> = None;
    let mic = if s.record_microphone { Capture::microphone(dir.join(format!("part{n}-mic.wav"))).map_err(|e| log::warn!("microphone: {e}")).ok() } else { None };
    let exe = video::ffmpeg(s)?;
    let mut last_err = String::new();
    for hw in [true, false] {
        let args = video_args(s, a, scr, &mkv, hw, size);
        log::info!("record: {}", args.join(" "));
        let mut c = Command::new(&exe);
        video::hide(c.args(&args).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()));
        let mut child = c.spawn()?;
        let log = std::sync::Arc::new(Mutex::new(String::new()));
        let (tx, rx) = mpsc::channel();
        let (l2, err) = (log.clone(), child.stderr.take().unwrap());
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                if line.starts_with("Output #0") { let _ = tx.send(Instant::now()); }
                let mut g = l2.lock().unwrap();
                if g.len() < 20000 { g.push_str(&line); g.push('\n'); }
            }
        });
        match rx.recv_timeout(Duration::from_secs(15)) {
            Ok(t) if child.try_wait()?.is_none() => return Ok(Segment { ffmpeg: child, mkv, video_start: t, system, mic, log }),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                last_err = log.lock().unwrap().trim().lines().last().unwrap_or("").to_string();
                if !cfg!(windows) { break; }
            }
        }
    }
    bail!("ffmpeg couldn't start recording: {last_err}")
}

struct Done { mkv: PathBuf, tracks: Vec<(PathBuf, &'static str, f64)> }

fn stop_segment(mut seg: Segment) -> Done {
    if let Some(stdin) = seg.ffmpeg.stdin.as_mut() { let _ = stdin.write_all(b"q"); let _ = stdin.flush(); }
    let t0 = Instant::now();
    while seg.ffmpeg.try_wait().ok().flatten().is_none() {
        if t0.elapsed() > Duration::from_secs(10) { let _ = seg.ffmpeg.kill(); break; }
        std::thread::sleep(Duration::from_millis(50));
    }
    log::info!("segment ended: {}", seg.log.lock().unwrap().lines().last().unwrap_or(""));
    let mut tracks = Vec::new();
    for (cap, title) in [(seg.system.take(), video::SYSTEM_TRACK), (seg.mic.take(), video::MIC_TRACK)] {
        let Some(c) = cap else { continue };
        let (p, first) = c.finish();
        // Positive: the sound started before the picture, so skip that much of it.
        let offset = first.map(|f| if seg.video_start >= f { (seg.video_start - f).as_secs_f64() } else { -((f - seg.video_start).as_secs_f64()) }).unwrap_or(0.0);
        if std::fs::metadata(&p).map(|m| m.len() > 4096).unwrap_or(false) { tracks.push((p, title, offset)); }
    }
    Done { mkv: seg.mkv, tracks }
}

/// One segment to .mp4: picture copied, each sound a named AAC track.
fn mux(s: &Settings, d: &Done, out: &Path) -> Result<()> {
    let mut a: Vec<String> = ["-hide_banner", "-v", "error", "-y", "-i"].map(String::from).to_vec();
    a.push(d.mkv.to_string_lossy().into());
    for (p, _, off) in &d.tracks {
        if *off >= 0.0 { a.extend(["-ss".into(), format!("{off:.3}")]); } else { a.extend(["-itsoffset".into(), format!("{:.3}", -off)]); }
        a.extend(["-i".into(), p.to_string_lossy().into()]);
    }
    a.extend(["-map", "0:v", "-c:v", "copy"].map(String::from));
    // Linux records system sound inside the .mkv already.
    let mut n = 0;
    #[cfg(target_os = "linux")]
    let linux_sys = s.record_system_audio && pulse_ok();
    #[cfg(not(target_os = "linux"))]
    let linux_sys = false;
    if linux_sys {
        a.extend(["-map".into(), "0:a?".into(), format!("-metadata:s:a:{n}"), format!("handler_name={}", video::SYSTEM_TRACK)]);
        n += 1;
    }
    for (i, (_, title, _)) in d.tracks.iter().enumerate() {
        a.extend(["-map".into(), format!("{}:a", i + 1), format!("-metadata:s:a:{n}"), format!("handler_name={title}")]);
        n += 1;
    }
    if n > 0 { a.extend(["-c:a", "aac", "-b:a", "160k", "-shortest"].map(String::from)); }
    a.extend(["-movflags".into(), "+faststart".into(), out.to_string_lossy().into()]);
    let r = video::run(&video::ffmpeg(s)?, &a, None, |_| {})?;
    if r.code != 0 { bail!("ffmpeg couldn't finish the video: {}", r.err.trim()) }
    Ok(())
}

fn join(s: &Settings, parts: &[PathBuf], out: &Path) -> Result<()> {
    if parts.len() == 1 { std::fs::rename(&parts[0], out).or_else(|_| std::fs::copy(&parts[0], out).map(|_| ()))?; return Ok(()); }
    let list = out.with_extension("txt");
    std::fs::write(&list, parts.iter().map(|p| format!("file '{}'\n", p.to_string_lossy().replace('\'', "'\\''"))).collect::<String>())?;
    let a: Vec<String> = vec!["-hide_banner".into(), "-v".into(), "error".into(), "-y".into(), "-f".into(), "concat".into(), "-safe".into(), "0".into(),
        "-i".into(), list.to_string_lossy().into(), "-map".into(), "0".into(), "-c".into(), "copy".into(), "-movflags".into(), "+faststart".into(), out.to_string_lossy().into()];
    let r = video::run(&video::ffmpeg(s)?, &a, None, |_| {});
    let _ = std::fs::remove_file(&list);
    let r = r?;
    if r.code != 0 { bail!("joining the paused parts failed: {}", r.err.trim()) }
    Ok(())
}

/// Samples the mouse (and, when key captions are on, keys) while recording.
fn track_cursor(area: Area, scale: f64, stop: std::sync::Arc<std::sync::atomic::AtomicBool>, keys_on: bool) -> std::thread::JoinHandle<CursorTrack> {
    std::thread::spawn(move || {
        use device_query::{DeviceQuery, DeviceState};
        let dev = DeviceState::new();
        let mut t = CursorTrack { width: area.width, height: area.height, ..Default::default() };
        let t0 = Instant::now();
        let mut prev_keys: Vec<device_query::Keycode> = Vec::new();
        let mut last = (i32::MIN, i32::MIN, 0u8);
        while !stop.load(std::sync::atomic::Ordering::Relaxed) {
            let m = dev.get_mouse();
            let (x, y) = ((m.coords.0 as f64 * scale) as i32 - area.x, (m.coords.1 as f64 * scale) as i32 - area.y);
            let b = m.button_pressed.iter().enumerate().skip(1).take(3).fold(0u8, |acc, (i, d)| if *d { acc | (1 << (i - 1)) } else { acc });
            if (x, y, b) != last { t.moves.push((t0.elapsed().as_secs_f32(), x, y, b)); last = (x, y, b); }
            if keys_on {
                let k = dev.get_keys();
                for key in k.iter().filter(|k| !prev_keys.contains(k)) { t.keys.push((t0.elapsed().as_secs_f32(), format!("{key}"))); }
                prev_keys = k;
            }
            std::thread::sleep(Duration::from_millis(16));
        }
        t
    })
}

pub fn start(app: &AppHandle, rect: (i32, i32, u32, u32)) -> Result<()> {
    if is_recording(app) { return Ok(()); }
    if wayland_only() { bail!("Recording on Wayland isn't supported yet. Log in with an X11 session (or set GRABBIT_FORCE_X11=1 under XWayland).") }
    let s = state(app).settings.lock().unwrap().clone();
    video::ffmpeg(&s)?;
    let (area, scr) = fit(app, rect.0, rect.1, rect.2, rect.3)?;
    let dir = std::env::temp_dir().join("Grabbit").join(export::stamp_name("rec").replace(' ', "-"));
    std::fs::create_dir_all(&dir)?;
    // Start the first segment here so errors reach the user straight away.
    let size = (area.width, area.height);
    let first = start_segment(&s, area, &scr, &dir, 0, size)?;
    let (tx, rx) = mpsc::channel::<Cmd>();
    let started = first.video_start;
    let stop_cursor = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    #[cfg(target_os = "macos")]
    let scale = app.primary_monitor().ok().flatten().map(|m| m.scale_factor()).unwrap_or(1.0);
    #[cfg(not(target_os = "macos"))]
    let scale = 1.0;
    let cursor = track_cursor(area, scale, stop_cursor.clone(), s.show_keys);
    let app2 = app.clone();
    std::thread::spawn(move || {
        let (mut area, mut scr) = (area, scr);
        let mut seg = Some(first);
        let mut done: Vec<Done> = Vec::new();
        let mut n = 1;
        while let Ok(cmd) = rx.recv() {
            match cmd {
                Cmd::Pause => if let Some(sg) = seg.take() { done.push(stop_segment(sg)); },
                Cmd::Resume(moved) => if seg.is_none() {
                    if let Some((x, y, w, h)) = moved {
                        match fit(&app2, x, y, w, h) { Ok((a, sc)) => { area = a; scr = sc; } Err(e) => actions::notify(&app2, &format!("{e}")) }
                    }
                    match start_segment(&s, area, &scr, &dir, n, size) { Ok(sg) => seg = Some(sg), Err(e) => actions::notify(&app2, &format!("{e}")) }
                    n += 1;
                },
                Cmd::Stop(keep, reply) => {
                    if let Some(sg) = seg.take() { done.push(stop_segment(sg)); }
                    stop_cursor.store(true, std::sync::atomic::Ordering::Relaxed);
                    let track = cursor.join().unwrap_or_default();
                    let r = if keep { finish(&s, &dir, &done, &track) } else { Ok(None) };
                    let _ = std::fs::remove_dir_all(&dir);
                    let _ = reply.send(r);
                    return;
                }
            }
        }
    });
    *SESSION.lock().unwrap() = Some(Session { tx, area, started, paused: None, paused_total: Duration::ZERO });
    if state(app).settings.lock().unwrap().hide_desktop_icons { desktop_icons(false); }
    show_overlays(app, area);
    Ok(())
}

fn finish(s: &Settings, dir: &Path, done: &[Done], track: &CursorTrack) -> Result<Option<PathBuf>> {
    let mut parts = Vec::new();
    for (i, d) in done.iter().enumerate() {
        if std::fs::metadata(&d.mkv).map(|m| m.len() < 1024).unwrap_or(true) { continue; }
        let p = dir.join(format!("part{i}.mp4"));
        mux(s, d, &p)?;
        parts.push(p);
    }
    if parts.is_empty() { return Ok(None); }
    let folder = PathBuf::from(&s.video_folder);
    std::fs::create_dir_all(&folder)?;
    let out = export::free(&folder, &export::stamp_name("Grabbit"), "mp4");
    join(s, &parts, &out)?;
    if !track.moves.is_empty() { let _ = std::fs::write(out.with_extension("cursor.json"), serde_json::to_string(track)?); }
    Ok(Some(out))
}

pub fn pause_resume(app: &AppHandle) {
    let mut g = SESSION.lock().unwrap();
    let Some(s) = g.as_mut() else { return };
    let frame = app.get_webview_window("recframe");
    if let Some(p) = s.paused.take() {
        s.paused_total += p.elapsed();
        // Where the frame is now (it can be dragged or resized while paused); its border sits just outside the area.
        let moved = frame.as_ref().and_then(|f| {
            let (pos, size, k) = (f.outer_position().ok()?, f.outer_size().ok()?, f.scale_factor().ok()?);
            let b = (3.0 * k).round() as i32;
            let now = (pos.x + b, pos.y + b, (size.width as i32 - 2 * b).max(16) as u32, (size.height as i32 - 2 * b).max(16) as u32);
            (now != (s.area.x, s.area.y, s.area.width, s.area.height)).then_some(now)
        });
        if let Some(m) = moved { s.area = Area { x: m.0, y: m.1, width: m.2, height: m.3 }; }
        let _ = s.tx.send(Cmd::Resume(moved));
    } else { s.paused = Some(Instant::now()); let _ = s.tx.send(Cmd::Pause); }
    // While paused the frame can be grabbed; while recording, clicks go through it.
    if let Some(f) = &frame { let _ = f.set_ignore_cursor_events(s.paused.is_none()); }
    let _ = app.emit("rec-state", s.paused.is_some());
}

pub fn stop(app: &AppHandle, keep: bool) {
    let Some(sess) = SESSION.lock().unwrap().take() else { return };
    close_overlays(app);
    if state(app).settings.lock().unwrap().hide_desktop_icons { desktop_icons(true); }
    let (tx, rx) = mpsc::channel();
    let _ = sess.tx.send(Cmd::Stop(keep, tx));
    let app = app.clone();
    std::thread::spawn(move || {
        match rx.recv().unwrap_or_else(|_| Ok(None)) {
            Ok(Some(path)) => {
                let s = state(&app).settings.lock().unwrap().clone();
                if s.copy_recording { let _ = export::copy_file(&path); }
                actions::quick_show(&app, Some(&path), if s.copy_recording { "Recording copied" } else { "Recording saved" });
                if s.edit_after_recording { editor::open_path(&app, &path); }
            }
            Ok(None) => if keep { actions::notify(&app, "Nothing was recorded") },
            Err(e) => actions::notify(&app, &format!("{e}")),
        }
    });
}

/// The red frame (just outside the recorded area) and the Stop bar. Both are kept out of the video.
fn show_overlays(app: &AppHandle, a: Area) {
    let a2 = app.clone();
    let _ = std::thread::spawn(move || {
        let scale = a2.monitor_from_point(a.x as f64, a.y as f64).ok().flatten().map(|m| m.scale_factor()).unwrap_or(1.0);
        let b = 3.0;
        let (lx, ly, lw, lh) = (a.x as f64 / scale, a.y as f64 / scale, a.width as f64 / scale, a.height as f64 / scale);
        if let Ok(w) = WebviewWindowBuilder::new(&a2, "recframe", WebviewUrl::App("recframe.html".into()))
            .decorations(false).transparent(true).shadow(false).always_on_top(true).skip_taskbar(true).focused(false).resizable(true)
            .position(lx - b, ly - b).inner_size(lw + 2.0 * b, lh + 2.0 * b).build() {
            let _ = w.set_ignore_cursor_events(true);
            exclude_from_capture(&w);
        }
        let mon = a2.monitor_from_point(a.x as f64, a.y as f64).ok().flatten();
        let mon_bottom = mon.as_ref().map(|m| (m.position().y as f64 + m.size().height as f64) / scale).unwrap_or(f64::MAX);
        let (bw, bh) = (300.0, 44.0);
        let by = if ly + lh + b + bh + 8.0 < mon_bottom { ly + lh + b + 8.0 } else if ly - bh - b - 8.0 > 0.0 { ly - bh - b - 8.0 } else { ly + lh - bh - 12.0 };
        if let Ok(w) = WebviewWindowBuilder::new(&a2, "recbar", WebviewUrl::App("recbar.html".into()))
            .decorations(false).transparent(true).shadow(false).always_on_top(true).skip_taskbar(true).focused(false).resizable(false)
            .position(lx + (lw - bw) / 2.0, by).inner_size(bw, bh).build() { exclude_from_capture(&w); }
    });
}

fn close_overlays(app: &AppHandle) {
    for l in ["recframe", "recbar"] { if let Some(w) = app.get_webview_window(l) { let _ = w.destroy(); } }
}

/// Windows: hide (or show again) the desktop icons, by hiding Explorer's desktop list view. Elsewhere this is a no-op:
/// macOS can only do it by restarting Finder, and Linux desktops each do it differently.
pub fn desktop_icons(visible: bool) {
    #[cfg(windows)]
    unsafe {
        use windows::core::w;
        use windows::Win32::UI::WindowsAndMessaging::{FindWindowExW, FindWindowW, ShowWindow, SW_HIDE, SW_SHOW};
        let mut view = None;
        if let Ok(progman) = FindWindowW(w!("Progman"), None) {
            view = FindWindowExW(Some(progman), None, w!("SHELLDLL_DefView"), None).ok();
        }
        if view.is_none() {
            // With a slideshow wallpaper the view lives under one of the WorkerW windows.
            let mut after = None;
            while let Ok(ww) = FindWindowExW(None, after, w!("WorkerW"), None) {
                if let Ok(v) = FindWindowExW(Some(ww), None, w!("SHELLDLL_DefView"), None) { view = Some(v); break; }
                after = Some(ww);
            }
        }
        if let Some(v) = view {
            if let Ok(list) = FindWindowExW(Some(v), None, w!("SysListView32"), None) { let _ = ShowWindow(list, if visible { SW_SHOW } else { SW_HIDE }); }
        }
    }
    #[cfg(not(windows))]
    let _ = visible;
}

pub fn exclude_from_capture(w: &tauri::WebviewWindow) {
    if std::env::var("GRABBIT_DEMO").is_ok() { return; }
    #[cfg(windows)]
    if let Ok(h) = w.hwnd() {
        use windows::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE};
        unsafe { let _ = SetWindowDisplayAffinity(windows::Win32::Foundation::HWND(h.0), WDA_EXCLUDEFROMCAPTURE); }
    }
    #[cfg(target_os = "macos")]
    if let Ok(p) = w.ns_window() {
        use objc2::{msg_send, runtime::AnyObject};
        // NSWindowSharingNone: left out of screenshots and screen recordings.
        unsafe { let _: () = msg_send![p as *mut AnyObject, setSharingType: 0usize]; }
    }
    #[cfg(target_os = "linux")]
    let _ = w;
}

#[tauri::command]
pub fn rec_status() -> serde_json::Value {
    let (recording, paused, area) = {
        let g = SESSION.lock().unwrap();
        (g.is_some(), g.as_ref().map(|s| s.paused.is_some()).unwrap_or(false), g.as_ref().map(|s| s.area))
    };
    serde_json::json!({ "recording": recording, "paused": paused, "elapsed": elapsed(), "area": area })
}

#[tauri::command]
pub fn rec_control(app: AppHandle, what: String) {
    match what.as_str() {
        "stop" => stop(&app, true),
        "discard" => stop(&app, false),
        "pause" => pause_resume(&app),
        _ => {}
    }
}
