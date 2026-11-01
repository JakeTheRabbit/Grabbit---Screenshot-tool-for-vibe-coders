// ffmpeg for recordings: find it, probe files, and render the kept parts of a video (trim, speed, concat, drawings
// burned in, sound choice) as MP4, chat-sized MP4, GIF, animated WebP, or a social-media size.

use crate::{actions, export, settings::Settings};
use anyhow::{bail, Context, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, WebviewWindow};

pub const SYSTEM_TRACK: &str = "System sound";
pub const MIC_TRACK: &str = "Microphone";
/// Signal compares its 100 MiB limit against the encrypted, padded size; this leaves room for that.
pub const CHAT_MAX_BYTES: u64 = 94 * 1024 * 1024;

/// Social presets: name → output size. The picture is fitted inside and the rest filled with a blurred copy.
pub const SOCIAL: &[(&str, u32, u32)] = &[
    ("Instagram post 1:1", 1080, 1080),
    ("Instagram portrait 4:5", 1080, 1350),
    ("Instagram / Facebook story 9:16", 1080, 1920),
    ("Reels / TikTok / Shorts 9:16", 1080, 1920),
    ("Snapchat 9:16", 1080, 1920),
    ("YouTube 16:9", 1920, 1080),
    ("YouTube 4K", 3840, 2160),
    ("Facebook post 1.91:1", 1200, 630),
    ("X / Twitter 16:9", 1600, 900),
    ("LinkedIn 1.91:1", 1200, 627),
    ("Pinterest 2:3", 1000, 1500),
];

pub fn hide(c: &mut Command) -> &mut Command {
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; c.creation_flags(0x0800_0000); }
    c
}

pub fn ffmpeg(s: &Settings) -> Result<PathBuf> { tool(s, "ffmpeg") }

fn tool(s: &Settings, name: &str) -> Result<PathBuf> {
    let exe = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    if !s.ffmpeg_path.is_empty() {
        let p = Path::new(&s.ffmpeg_path);
        let cand = if name == "ffmpeg" { p.to_path_buf() } else { p.with_file_name(&exe) };
        if cand.exists() { return Ok(cand); }
    }
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    // Next to Grabbit (bundled), WinGet links, Homebrew, MacPorts.
    if let Ok(me) = std::env::current_exe() { if let Some(d) = me.parent() { dirs.insert(0, d.to_path_buf()); } }
    if let Some(l) = dirs::data_local_dir() { dirs.push(l.join("Microsoft").join("WinGet").join("Links")); }
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/usr/bin"].map(PathBuf::from));
    for d in dirs {
        let p = d.join(&exe);
        if p.exists() {
            // WinGet links are symlinks to the real install; ffprobe sits next to the real one.
            return Ok(std::fs::canonicalize(&p).ok().filter(|_| name == "ffprobe").unwrap_or(p));
        }
        if name == "ffprobe" {
            if let Ok(real) = std::fs::canonicalize(d.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" })) {
                let q = real.with_file_name(&exe);
                if q.exists() { return Ok(q); }
            }
        }
    }
    bail!("{}", install_hint())
}

pub fn install_hint() -> &'static str {
    if cfg!(windows) { "Recording needs ffmpeg: winget install Gyan.FFmpeg" }
    else if cfg!(target_os = "macos") { "Recording needs ffmpeg: brew install ffmpeg" }
    else { "Recording needs ffmpeg: sudo apt install ffmpeg (or your distro's package)" }
}

pub struct RunResult { pub code: i32, pub out: String, pub err: String }

/// Runs a tool hidden. `line` gets stdout lines as they arrive. `key` registers the process so it can be cancelled.
pub fn run(exe: &Path, args: &[String], key: Option<&str>, mut line: impl FnMut(&str)) -> Result<RunResult> {
    let mut c = Command::new(exe);
    hide(c.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()));
    let mut child = c.spawn().with_context(|| format!("starting {}", exe.display()))?;
    if let Some(k) = key { RUNNING.lock().unwrap().insert(k.to_string(), child.id()); }
    let stderr = child.stderr.take().unwrap();
    let err_t = std::thread::spawn(move || { let mut s = String::new(); let _ = std::io::Read::read_to_string(&mut BufReader::new(stderr), &mut s); s });
    let mut out = String::new();
    for l in BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok) { line(&l); out += &l; out.push('\n'); }
    let status = child.wait()?;
    if let Some(k) = key { RUNNING.lock().unwrap().remove(k); }
    Ok(RunResult { code: status.code().unwrap_or(-1), out, err: err_t.join().unwrap_or_default() })
}

static RUNNING: std::sync::LazyLock<Mutex<HashMap<String, u32>>> = std::sync::LazyLock::new(Default::default);

fn kill(pid: u32) {
    #[cfg(windows)]
    { let _ = hide(&mut Command::new("taskkill")).args(["/PID", &pid.to_string(), "/T", "/F"]).status(); }
    #[cfg(not(windows))]
    { let _ = Command::new("kill").arg(pid.to_string()).status(); }
}


/// Which H.264 hardware encoder works here, tested once: NVENC, Apple VideoToolbox, Intel/AMD via QSV/AMF, else x264.
pub fn hw_encoder(s: &Settings) -> &'static str {
    static ENC: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();
    ENC.get_or_init(|| {
        let Ok(f) = ffmpeg(s) else { return "libx264" };
        let cands: &[&'static str] = if cfg!(target_os = "macos") { &["h264_videotoolbox"] } else { &["h264_nvenc", "h264_qsv", "h264_amf"] };
        for c in cands {
            let args: Vec<String> = ["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=s=256x256:d=0.1", "-c:v", c, "-f", "null", "-"].iter().map(|s| s.to_string()).collect();
            if run(&f, &args, None, |_| {}).map(|r| r.code == 0).unwrap_or(false) { return c; }
        }
        "libx264"
    })
}


/// H.264 encoder arguments: constant quality, or a target bitrate in kbps.
pub fn h264(s: &Settings, quality: u32, kbps: u32) -> Vec<String> {
    let enc = hw_encoder(s);
    let mut a: Vec<String> = vec!["-c:v".into(), enc.into()];
    let rate = |a: &mut Vec<String>| a.extend(["-b:v".into(), format!("{kbps}k"), "-maxrate".into(), format!("{}k", kbps * 3 / 2), "-bufsize".into(), format!("{}k", kbps * 2)]);
    match enc {
        "h264_nvenc" => { a.extend(["-preset", "p5", "-tune", "hq", "-rc", "vbr"].map(String::from)); if kbps > 0 { rate(&mut a) } else { a.extend(["-cq".into(), quality.to_string(), "-b:v".into(), "0".into()]) } }
        "h264_videotoolbox" => { if kbps > 0 { rate(&mut a) } else { a.extend(["-q:v".into(), (100 - quality * 2).clamp(30, 90).to_string()]) } }
        "h264_qsv" | "h264_amf" => { if kbps > 0 { rate(&mut a) } else { a.extend(["-global_quality".into(), quality.to_string()]) } }
        _ => { a.extend(["-preset", "veryfast"].map(String::from)); if kbps > 0 { rate(&mut a) } else { a.extend(["-crf".into(), quality.to_string()]) } }
    }
    a
}

pub struct Info { pub duration: f64, pub fps: f64, pub width: u32, pub height: u32, pub tracks: Vec<String>, pub bytes: u64 }

pub fn probe(s: &Settings, path: &Path) -> Result<Info> {
    let args: Vec<String> = vec!["-v".into(), "error".into(), "-print_format".into(), "json".into(), "-show_format".into(), "-show_streams".into(), path.to_string_lossy().into()];
    let r = run(&tool(s, "ffprobe")?, &args, None, |_| {})?;
    let doc: Value = serde_json::from_str(&r.out).context("reading ffprobe output")?;
    let streams = doc["streams"].as_array().cloned().unwrap_or_default();
    let v = streams.iter().find(|x| x["codec_type"] == "video").cloned().unwrap_or(Value::Null);
    let rate = |r: &str| { let (a, b) = r.split_once('/').unwrap_or((r, "1")); let (a, b) = (a.parse::<f64>().unwrap_or(0.0), b.parse::<f64>().unwrap_or(1.0)); if b > 0.0 { a / b } else { 0.0 } };
    let fps = rate(v["avg_frame_rate"].as_str().unwrap_or("0/1"));
    Ok(Info {
        duration: doc["format"]["duration"].as_str().and_then(|d| d.parse().ok()).unwrap_or(0.0),
        fps: if fps > 0.0 && fps < 1000.0 { fps } else { 30.0 },
        width: v["width"].as_u64().unwrap_or(0) as u32,
        height: v["height"].as_u64().unwrap_or(0) as u32,
        tracks: streams.iter().filter(|x| x["codec_type"] == "audio").map(|x| {
            let t = &x["tags"];
            let n = t["handler_name"].as_str().or(t["title"].as_str()).unwrap_or("");
            if n == "SoundHandler" { String::new() } else { n.to_string() }
        }).collect(),
        bytes: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
    })
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Sound { All, System, Mic, None }

/// Audio stream indexes for a sound choice. Untitled tracks (other apps' videos): first = sound, second = mic.
pub fn tracks(info: &Info, sound: Sound) -> Vec<usize> {
    let t = &info.tracks;
    let pos = |n: &str| t.iter().position(|x| x == n);
    let sys = pos(SYSTEM_TRACK).or(if pos(MIC_TRACK) == Some(0) { None } else if !t.is_empty() { Some(0) } else { None });
    let mic = pos(MIC_TRACK).or(if t.len() > 1 { Some(1) } else { None });
    match sound {
        Sound::All => (0..t.len()).collect(),
        Sound::System => sys.into_iter().collect(),
        Sound::Mic => mic.into_iter().collect(),
        Sound::None => vec![],
    }
}

#[derive(Clone, Debug)]
pub struct Part { pub start: f64, pub end: f64, pub speed: f64 }

#[derive(Clone, Debug, PartialEq)]
pub enum Target { Full, Chat, Gif, Webp, Social(u32, u32), Beautify }

pub struct Overlay { pub png: PathBuf, pub from: f64, pub to: f64 }

/// Effects applied on the source timeline, before cutting: studio effects and burnt-in captions.
#[derive(Default)]
pub struct Extras { pub studio: Option<(crate::studio::Studio, crate::record::CursorTrack)>, pub subs: Option<PathBuf>, pub blurs: Vec<Blur> }

/// A privacy blur: video pixels, shown while the source time is between `from` and `to`.
#[derive(serde::Deserialize, Clone, Copy, Debug)]
pub struct Blur { pub x: u32, pub y: u32, pub width: u32, pub height: u32, pub from: f64, pub to: f64 }

fn f(d: f64) -> String { format!("{:.3}", d).trim_end_matches('0').trim_end_matches('.').to_string() }

/// atempo only takes 0.5–2 per stage, so bigger changes chain several.
fn atempo(speed: f64) -> String {
    let mut s = speed;
    let mut parts = Vec::new();
    while s > 2.0 { parts.push("atempo=2".to_string()); s /= 2.0; }
    while s < 0.5 { parts.push("atempo=0.5".to_string()); s /= 0.5; }
    if (s - 1.0).abs() > 1e-3 { parts.push(format!("atempo={}", f(s))); }
    if parts.is_empty() { "anull".into() } else { parts.join(",") }
}

/// Build the ffmpeg arguments (testable without running anything).
pub fn render_args(s: &Settings, input: &Path, info: &Info, keep: &[Part], target: &Target, output: &Path, sound: Sound, overlays: &[Overlay], logo: Option<&Path>, extras: &Extras) -> Vec<String> {
    let tr = if matches!(target, Target::Gif | Target::Webp) { vec![] } else { tracks(info, sound) };
    let audio = !tr.is_empty();
    let total: f64 = keep.iter().map(|k| (k.end - k.start) / k.speed).sum();
    let mut g = String::new();
    let mut src = "[0:v]".to_string();
    // Inputs: 0 video, then drawings, then the click ring, then the logo.
    let ring_idx = 1 + overlays.len();
    let has_ring = extras.studio.as_ref().map(|(st, _)| st.clicks).unwrap_or(false);
    let logo_idx = ring_idx + has_ring as usize;
    // Blurs first, so nothing drawn on top gets blurred by accident.
    for (i, b) in extras.blurs.iter().enumerate() {
        let (x, y) = (b.x.min(info.width.saturating_sub(4)), b.y.min(info.height.saturating_sub(4)));
        let (w, h) = (b.width.clamp(4, info.width - x) & !1, b.height.clamp(4, info.height - y) & !1);
        let r = (w.min(h) / 6).clamp(4, 40);
        g += &format!("{src}split[bm{i}][bs{i}];[bs{i}]crop={w}:{h}:{x}:{y},boxblur={r}:3[bb{i}];[bm{i}][bb{i}]overlay={x}:{y}:enable='between(t,{},{})'[bz{i}];", f(b.from), f(b.to));
        src = format!("[bz{i}]");
    }
    for (i, o) in overlays.iter().enumerate() {
        g += &format!("{src}[{}:v]overlay=0:0:enable='between(t,{},{})'[ov{i}];", i + 1, f(o.from), f(o.to));
        src = format!("[ov{i}]");
    }
    if let Some((st, track)) = &extras.studio {
        if st.any() { g += &crate::studio::filters(st, track, info.width, info.height, info.fps, &src, "[stu]", has_ring.then_some(ring_idx)); src = "[stu]".into(); }
    }
    if let Some(srt) = &extras.subs { g += &format!("{src}{}[sub];", crate::studio::subtitles_filter(srt)); src = "[sub]".into(); }
    let pre = src != "[0:v]";
    if pre { g += &format!("{src}split={}{};", keep.len(), (0..keep.len()).map(|i| format!("[src{i}]")).collect::<String>()); }
    for (i, k) in keep.iter().enumerate() {
        let vin = if !pre { "[0:v]".to_string() } else { format!("[src{i}]") };
        g += &format!("{vin}trim=start={}:end={},setpts=(PTS-STARTPTS)/{}[v{i}];", f(k.start), f(k.end), f(k.speed));
        for j in &tr {
            let tag = if tr.len() > 1 { format!("_{j}") } else { String::new() };
            // Tracks are mixed, so each is made stereo 48 kHz first.
            let fmt = if tr.len() > 1 { ",aformat=sample_rates=48000:channel_layouts=stereo" } else { "" };
            g += &format!("[0:a:{j}]atrim=start={}:end={},asetpts=PTS-STARTPTS,{}{fmt}[a{i}{tag}];", f(k.start), f(k.end), atempo(k.speed));
        }
        // amerge + pan, not amix: ffmpeg 6.1's amix inside concat segments eats memory without limit
        // when the picture has a long gap (a stalled screen grab).
        if tr.len() > 1 {
            let sum = |c: usize| (0..tr.len()).map(|t| format!("c{}", t * 2 + c)).collect::<Vec<_>>().join("+");
            g += &format!("{}amerge=inputs={},pan=stereo|c0={}|c1={}[a{i}];", tr.iter().map(|j| format!("[a{i}_{j}]")).collect::<String>(), tr.len(), sum(0), sum(1));
        }
    }
    if keep.len() > 1 {
        for i in 0..keep.len() { g += &if audio { format!("[v{i}][a{i}]") } else { format!("[v{i}]") }; }
        g += &format!("concat=n={}:v=1:a={}[vc]{}", keep.len(), audio as u8, if audio { "[ac];" } else { ";" });
    } else {
        g += "[v0]null[vc];";
        if audio { g += "[a0]anull[ac];"; }
    }
    let n_in = logo_idx;
    let mut vc = "[vc]".to_string();
    // Beautify: the picture on a gradient with rounded corners, same size as the recording.
    let beauty_idx = if *target == Target::Beautify { Some((n_in + logo.is_some() as usize, n_in + logo.is_some() as usize + 1)) } else { None };
    if logo.is_some() {
        let b = &s.branding;
        let m = "main_w/40";
        let (x, y) = match b.position.as_str() {
            "top-left" => (m.to_string(), m.to_string()), "top-right" => (format!("main_w-overlay_w-{m}"), m.to_string()),
            "bottom-left" => (m.to_string(), format!("main_h-overlay_h-{m}")), "center" => ("(main_w-overlay_w)/2".into(), "(main_h-overlay_h)/2".into()),
            _ => (format!("main_w-overlay_w-{m}"), format!("main_h-overlay_h-{m}")),
        };
        g += &format!("[{n_in}:v]format=rgba,colorchannelmixer=aa={}[lg0];[lg0][vc]scale2ref=w=main_w*{}:h=ow/mdar[lg][vb];[vb][lg]overlay={x}:{y}[vl];", f(b.opacity as f64), f(b.scale as f64));
        vc = "[vl]".into();
    }
    let mut codec: Vec<String> = Vec::new();
    match target {
        Target::Gif => g += &format!("{vc}fps=12,scale='min(960,iw)':-2:flags=lanczos,split[ga][gb];[ga]palettegen=stats_mode=diff[gp];[gb][gp]paletteuse=dither=sierra2_4a[vo]"),
        Target::Webp => { g += &format!("{vc}fps=15,scale='min(1280,iw)':-2:flags=lanczos[vo]"); codec.extend(["-c:v", "libwebp_anim", "-lossless", "0", "-q:v", "75", "-loop", "0"].map(String::from)); }
        Target::Chat => {
            g += &format!("{vc}scale='trunc(min(iw,1920*iw/max(iw,ih))/2)*2':-2,format=yuv420p[vo]");
            let budget = ((CHAT_MAX_BYTES as f64 * 8.0 * 0.97 / total.max(1.0) - if audio { 128_000.0 } else { 0.0 }) / 1000.0) as u32;
            codec = h264(s, 0, budget.clamp(200, 6000));
            if audio { codec.extend(["-c:a", "aac", "-b:a", "128k"].map(String::from)); }
        }
        Target::Social(w, h) => {
            g += &format!("{vc}split[fg0][bg0];[bg0]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},boxblur=40:2,eq=brightness=-0.08[bg];[fg0]scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[vo]");
            codec = h264(s, 20, 0);
            if audio { codec.extend(["-c:a", "aac", "-b:a", "192k"].map(String::from)); }
        }
        Target::Beautify => {
            let (bi, mi) = beauty_idx.unwrap();
            let (fw, fh) = beautify_inner(info.width, info.height);
            g += &format!("{vc}scale={fw}:{fh}:flags=lanczos,format=yuva420p[fg0];[fg0][{mi}:v]alphamerge[fg];[{bi}:v][fg]overlay=(W-w)/2:(H-h)/2:shortest=1,format=yuv420p[vo]");
            codec = h264(s, 21, 0);
            if audio { codec.extend(["-c:a", "aac", "-b:a", "160k"].map(String::from)); }
        }
        Target::Full => {
            g += &format!("{vc}scale='trunc(iw/2)*2':'trunc(ih/2)*2',format=yuv420p[vo]");
            codec = h264(s, 21, 0);
            if audio { codec.extend(["-c:a", "aac", "-b:a", "160k"].map(String::from)); }
        }
    }
    let mut a: Vec<String> = ["-hide_banner", "-v", "error", "-y", "-i"].map(String::from).to_vec();
    a.push(input.to_string_lossy().into());
    for o in overlays { a.push("-i".into()); a.push(o.png.to_string_lossy().into()); }
    if has_ring { a.extend(["-loop".into(), "1".into(), "-i".into(), crate::studio::ring_png().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()]); }
    if let Some(l) = logo { a.push("-i".into()); a.push(l.to_string_lossy().into()); }
    if *target == Target::Beautify {
        let (bg, mask) = beautify_layers(info.width & !1, info.height & !1).unwrap_or_default();
        // The background loops (the overlay ends with the video); the mask is read once and alphamerge keeps reusing it
        // (looping it too would make alphamerge run forever).
        a.extend(["-loop".into(), "1".into(), "-i".into(), bg.to_string_lossy().into(), "-i".into(), mask.to_string_lossy().into()]);
    }
    a.extend(["-filter_complex".into(), g, "-map".into(), "[vo]".into()]);
    if audio { a.extend(["-map".into(), "[ac]".into()]); }
    a.extend(codec);
    if !matches!(target, Target::Gif | Target::Webp) { a.extend(["-g".into(), ((info.fps * 2.0).round() as u32).to_string(), "-movflags".into(), "+faststart".into()]); }
    if s.metadata.strip { a.extend(["-map_metadata".into(), "-1".into()]); }
    if !s.metadata.author.is_empty() { a.extend(["-metadata".into(), format!("artist={}", s.metadata.author)]); }
    if !s.metadata.copyright.is_empty() { a.extend(["-metadata".into(), format!("copyright={}", s.metadata.copyright)]); }
    for (k, v) in &s.metadata.custom { a.extend(["-metadata".into(), format!("{k}={v}")]); }
    a.extend(["-progress".into(), "pipe:1".into(), "-nostats".into(), output.to_string_lossy().into()]);
    a
}

/// Size of the recording inside the Beautify frame (88 %, even).
fn beautify_inner(w: u32, h: u32) -> (u32, u32) { (((w as f32 * 0.88) as u32) & !1, ((h as f32 * 0.88) as u32) & !1) }

/// The gradient background and the rounded-corner mask for Beautify, drawn once per size.
fn beautify_layers(w: u32, h: u32) -> Result<(PathBuf, PathBuf)> {
    let dir = std::env::temp_dir().join("Grabbit");
    std::fs::create_dir_all(&dir)?;
    let (bg, mask) = (dir.join(format!("beauty-bg-{w}x{h}.png")), dir.join(format!("beauty-mask-{w}x{h}.png")));
    if !bg.exists() {
        let (a, b) = ([255f32, 122., 69.], [232f32, 57., 109.]);
        let img = image::RgbaImage::from_fn(w, h, |x, y| {
            let t = ((x as f32 / w as f32) + (y as f32 / h as f32)) / 2.0;
            image::Rgba([(a[0] + (b[0] - a[0]) * t) as u8, (a[1] + (b[1] - a[1]) * t) as u8, (a[2] + (b[2] - a[2]) * t) as u8, 255])
        });
        img.save(&bg)?;
    }
    if !mask.exists() {
        let (fw, fh) = beautify_inner(w, h);
        let r = (fw.min(fh) as f32 * 0.03).max(8.0);
        let img = image::GrayImage::from_fn(fw, fh, |x, y| {
            let (cx, cy) = ((x as f32 + 0.5).clamp(r, fw as f32 - r), (y as f32 + 0.5).clamp(r, fh as f32 - r));
            let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
            image::Luma([((r - d + 0.5).clamp(0.0, 1.0) * 255.0) as u8])
        });
        img.save(&mask)?;
    }
    Ok((bg, mask))
}

pub fn render(s: &Settings, input: &Path, keep: &[Part], target: &Target, output: &Path, sound: Sound, overlays: &[Overlay], extras: &Extras, key: Option<&str>, mut progress: impl FnMut(f64)) -> Result<()> {
    let info = probe(s, input)?;
    let total: f64 = keep.iter().map(|k| (k.end - k.start) / k.speed).sum();
    let logo = (s.branding.on_videos && Path::new(&s.branding.logo_path).exists()).then(|| PathBuf::from(&s.branding.logo_path));
    let args = render_args(s, input, &info, keep, target, output, sound, overlays, logo.as_deref(), extras);
    log::info!("render: {}", args.join(" "));
    if std::env::var("GRABBIT_VERBOSE").is_ok() { eprintln!("render: {}", args.join(" ")); }
    // Safety net: no render may run far longer than its video could need.
    let k = key.map(String::from).unwrap_or_else(|| format!("render-{}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)));
    let limit = std::time::Duration::from_secs_f64((total * 20.0).max(120.0));
    let (k2, timed_out) = (k.clone(), std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)));
    let flag = timed_out.clone();
    std::thread::spawn(move || {
        let t0 = std::time::Instant::now();
        while t0.elapsed() < limit { std::thread::sleep(std::time::Duration::from_millis(500)); if !RUNNING.lock().unwrap().contains_key(&k2) && t0.elapsed().as_secs() > 2 { return; } }
        if let Some(pid) = RUNNING.lock().unwrap().get(&k2).copied() { flag.store(true, std::sync::atomic::Ordering::SeqCst); kill(pid); }
    });
    let r = run(&ffmpeg(s)?, &args, Some(&k), |l| {
        if let Some(us) = l.strip_prefix("out_time_us=").and_then(|v| v.parse::<f64>().ok()) { if total > 0.0 { progress((us / 1e6 / total).clamp(0.0, 1.0)); } }
    })?;
    if timed_out.load(std::sync::atomic::Ordering::SeqCst) { let _ = std::fs::remove_file(output); bail!("rendering took far too long and was stopped"); }
    if r.code != 0 {
        let _ = std::fs::remove_file(output);
        bail!("ffmpeg failed: {}", r.err.trim().lines().last().unwrap_or("unknown error"));
    }
    Ok(())
}

pub fn load_message(s: &Settings, path: &Path) -> Result<Value> {
    let info = probe(s, path)?;
    Ok(json!({
        "type": "load",
        "name": path.file_stem().unwrap_or_default().to_string_lossy(),
        "path": path, "url": "",
        "duration": info.duration, "fps": info.fps, "width": info.width, "height": info.height,
        "hasAudio": !info.tracks.is_empty(), "bytes": info.bytes,
        "hasSystem": !tracks(&info, Sound::System).is_empty(), "hasMic": !tracks(&info, Sound::Mic).is_empty(),
        "social": SOCIAL.iter().map(|(n, w, h)| json!({ "name": n, "width": w, "height": h })).collect::<Vec<_>>(),
        "cursor": crate::record::cursor_track(path),
        "hasCaptions": path.with_extension("srt").exists(),
    }))
}

/// Video editor messages: export (copy / save / saveAs / copyPath / closeSave), cancel.
pub async fn handle(app: &AppHandle, w: &WebviewWindow, t: &str, m: &Value, s: &Settings) -> Result<Value> {
    match t {
        "cancel" => { if let Some(pid) = RUNNING.lock().unwrap().get(w.label()).copied() { kill(pid); } }
        "silences" => {
            let path = PathBuf::from(m["path"].as_str().unwrap_or(""));
            let (s, min) = (s.clone(), m["min"].as_f64().unwrap_or(0.8));
            let r = tauri::async_runtime::spawn_blocking(move || crate::studio::silences(&s, &path, min)).await??;
            return Ok(json!(r));
        }
        "captionEngine" => return Ok(json!(crate::studio::caption_engine(s))),
        "downloadModel" => {
            let w2 = w.clone();
            tauri::async_runtime::spawn_blocking(move || crate::studio::download_model(|p| { let _ = w2.emit_to(w2.label(), "host", json!({ "type": "progress", "value": p, "label": "Downloading the speech model" })); })).await??;
            return Ok(Value::Null);
        }
        "captions" => {
            let path = PathBuf::from(m["path"].as_str().unwrap_or(""));
            let s = s.clone();
            let r = tauri::async_runtime::spawn_blocking(move || crate::studio::transcribe(&s, &path)).await??;
            return Ok(json!(r));
        }
        "saveCaptions" => {
            let path = PathBuf::from(m["path"].as_str().unwrap_or(""));
            let cues: Vec<crate::studio::Cue> = serde_json::from_value(m["cues"].clone())?;
            crate::studio::write_srt(&path.with_extension("srt"), &cues)?;
            return Ok(json!(path.with_extension("srt")));
        }
        "export" => {
            let (app, w, m, s) = (app.clone(), w.clone(), m.clone(), s.clone());
            tauri::async_runtime::spawn_blocking(move || {
                let r = export_video(&app, &w, &m, &s);
                let done = match r {
                    Ok(note) => json!({ "type": "done", "ok": true, "note": note }),
                    Err(e) => json!({ "type": "done", "ok": false, "note": format!("Failed: {e}") }),
                };
                let _ = w.emit_to(w.label(), "host", done);
            });
        }
        other => bail!("unknown message {other}"),
    }
    Ok(Value::Null)
}

fn export_video(app: &AppHandle, w: &WebviewWindow, m: &Value, s: &Settings) -> Result<String> {
    let path = PathBuf::from(m["path"].as_str().context("no path")?);
    let info = probe(s, &path)?;
    let keep: Vec<Part> = m["segments"].as_array().cloned().unwrap_or_default().iter()
        .map(|r| Part { start: r[0].as_f64().unwrap_or(0.0), end: r[1].as_f64().unwrap_or(0.0), speed: r.get(2).and_then(|x| x.as_f64()).unwrap_or(1.0).clamp(0.25, 16.0) })
        .filter(|p| p.end - p.start > 0.01).collect();
    anyhow::ensure!(!keep.is_empty(), "nothing left to export");
    let target = match m["target"].as_str().unwrap_or("Full") {
        "Chat" => Target::Chat, "Gif" => Target::Gif, "Webp" => Target::Webp, "Beautify" => Target::Beautify,
        t if t.starts_with("Social:") => { let (a, b) = t[7..].split_once('x').unwrap_or(("1080", "1080")); Target::Social(a.parse()?, b.parse()?) }
        _ => Target::Full,
    };
    let sound = match m["sound"].as_str().unwrap_or("All").to_ascii_lowercase().as_str() { "system" => Sound::System, "mic" => Sound::Mic, "none" => Sound::None, _ => Sound::All };
    let drawings = m["overlays"].as_array().cloned().unwrap_or_default();
    let studio: crate::studio::Studio = serde_json::from_value(m["studio"].clone()).unwrap_or_default();
    let extras = Extras {
        studio: if studio.any() { crate::record::cursor_track(&path).map(|t| (studio, t)) } else { None },
        subs: if m["burnCaptions"].as_bool().unwrap_or(false) { Some(path.with_extension("srt")).filter(|p| p.exists()) } else { None },
        blurs: serde_json::from_value(m["blurs"].clone()).unwrap_or_default(),
    };
    let speed_changed = keep.iter().any(|p| (p.speed - 1.0).abs() > 1e-3);
    let edited = m["edited"].as_bool().unwrap_or(false) || !drawings.is_empty() || speed_changed || tracks(&info, sound) != tracks(&info, Sound::All) || info.tracks.len() > 1
        || s.branding.on_videos || s.metadata.strip || extras.studio.is_some() || extras.subs.is_some() || !extras.blurs.is_empty();
    let name = path.file_stem().unwrap_or_default().to_string_lossy().into_owned();
    let dir = path.parent().unwrap_or(Path::new(".")).to_path_buf();
    let ext = match target { Target::Gif => "gif", Target::Webp => "webp", _ => "mp4" };
    let suffix = match &target { Target::Chat => " chat".to_string(), Target::Beautify => " styled".to_string(), Target::Social(w, h) => format!(" {w}x{h}"), Target::Gif | Target::Webp => String::new(), Target::Full => if edited { " edited".into() } else { String::new() } };
    let action = m["action"].as_str().unwrap_or("copy");
    let output = match action {
        "saveAs" => PathBuf::from(m["saveTo"].as_str().context("no file chosen")?),
        _ if target == Target::Full && !edited => path.clone(),
        "copy" | "share" => { let t = std::env::temp_dir().join("Grabbit"); std::fs::create_dir_all(&t)?; t.join(format!("{name}{suffix}.{ext}")) }
        _ => export::free(&dir, &format!("{name}{suffix}"), ext),
    };
    let tmp = std::env::temp_dir().join("Grabbit");
    std::fs::create_dir_all(&tmp)?;
    let mut overlays = Vec::new();
    for (i, d) in drawings.iter().enumerate() {
        let png = tmp.join(format!("drawing-{}-{i}.png", std::process::id()));
        let b64 = d["dataURL"].as_str().unwrap_or("").split_once(',').map(|x| x.1).unwrap_or("");
        std::fs::write(&png, base64::engine::general_purpose::STANDARD.decode(b64)?)?;
        overlays.push(Overlay { png, from: d["from"].as_f64().unwrap_or(0.0), to: d["to"].as_f64().unwrap_or(0.0) });
    }
    let result = (|| -> Result<String> {
        if output != path {
            let label = match target { Target::Beautify => "Adding the background", Target::Chat => "Making a chat-sized copy", Target::Gif => "Making a GIF", Target::Webp => "Making an animated WebP", Target::Social(..) => "Making the social-size copy", _ => "Rendering" };
            let mut last = -1.0;
            render(s, &path, &keep, &target, &output, sound, &overlays, &extras, Some(w.label()), |v| {
                if v - last >= 0.01 { last = v; let _ = w.emit_to(w.label(), "host", json!({ "type": "progress", "value": v, "label": label })); }
            })?;
        }
        let size = format!("{:.1} MB", std::fs::metadata(&output)?.len() as f64 / 1048576.0);
        let mut note = match action {
            "copy" => { export::copy_file(&output)?; format!("Copied {size}") }
            "copyPath" => { export::copy_text(&output.to_string_lossy())?; format!("Saved {}, path copied", output.file_name().unwrap_or_default().to_string_lossy()) }
            _ => format!("Saved {} ({size})", output.file_name().unwrap_or_default().to_string_lossy()),
        };
        if target == Target::Chat && std::fs::metadata(&output)?.len() > CHAT_MAX_BYTES { note += " — still over 94 MB, cut it shorter for Signal"; }
        if action == "closeSave" { let _ = w.destroy(); actions::notify(app, &format!("Edits saved: {}", output.display())); }
        if action == "share" {
            let link = crate::share::share(app, &output, m["shareTo"].as_str())?;
            note = if link.starts_with("http") { format!("Link copied: {link}") } else { link };
        }
        Ok(note)
    })();
    for o in overlays { let _ = std::fs::remove_file(o.png); }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(tracks: &[&str]) -> Info { Info { duration: 10.0, fps: 30.0, width: 1920, height: 1080, tracks: tracks.iter().map(|s| s.to_string()).collect(), bytes: 0 } }

    #[test]
    fn sound_tracks() {
        let i = info(&[SYSTEM_TRACK, MIC_TRACK]);
        assert_eq!(tracks(&i, Sound::All), vec![0, 1]);
        assert_eq!(tracks(&i, Sound::System), vec![0]);
        assert_eq!(tracks(&i, Sound::Mic), vec![1]);
        assert!(tracks(&i, Sound::None).is_empty());
        assert_eq!(tracks(&info(&[MIC_TRACK]), Sound::System), Vec::<usize>::new());
        assert_eq!(tracks(&info(&[""]), Sound::System), vec![0]);
    }

    #[test]
    fn atempo_chains() {
        assert_eq!(atempo(1.0), "anull");
        assert_eq!(atempo(4.0), "atempo=2,atempo=2");
        assert_eq!(atempo(3.0), "atempo=2,atempo=1.5");
    }

    /// Real render with studio effects: GRABBIT_VIDEO_TEST=<recording.mp4 with .cursor.json> cargo test studio_render -- --ignored
    #[test]
    #[ignore]
    fn studio_render() {
        let input = PathBuf::from(std::env::var("GRABBIT_VIDEO_TEST").expect("set GRABBIT_VIDEO_TEST"));
        let s = Settings::default();
        let info = probe(&s, &input).unwrap();
        let mut track = crate::record::cursor_track(&input).expect("cursor track");
        // Make sure there are clicks and keys to draw.
        track.moves.push((1.0, 200, 150, 1)); track.moves.push((1.1, 200, 150, 0));
        track.keys.push((2.0, "LControl".into())); track.keys.push((2.1, "S".into()));
        let extras = Extras { studio: Some((crate::studio::Studio { zoom: true, clicks: true, keys: true }, track)), subs: None,
            blurs: vec![Blur { x: 100, y: 100, width: 300, height: 200, from: 0.5, to: 3.0 }] };
        let out = std::env::temp_dir().join("grabbit-studio-test.mp4");
        let keep = [Part { start: 0.0, end: info.duration.min(4.0), speed: 1.0 }];
        render(&s, &input, &keep, &Target::Full, &out, Sound::All, &[], &extras, None, |_| {}).unwrap();
        let o = probe(&s, &out).unwrap();
        assert_eq!((o.width, o.height), (info.width, info.height));
        assert!(o.duration > 3.0);
    }

    #[test]
    fn args_cut_speed_social() {
        let s = Settings::default();
        let keep = [Part { start: 0.0, end: 2.0, speed: 1.0 }, Part { start: 4.0, end: 8.0, speed: 2.0 }];
        let a = render_args(&s, Path::new("in.mp4"), &info(&[SYSTEM_TRACK, MIC_TRACK]), &keep, &Target::Social(1080, 1920), Path::new("out.mp4"), Sound::All, &[], None, &Extras::default()).join(" ");
        assert!(a.contains("setpts=(PTS-STARTPTS)/2"));
        assert!(a.contains("atempo=2"));
        assert!(a.contains("concat=n=2:v=1:a=1"));
        assert!(a.contains("scale=1080:1920:force_original_aspect_ratio=decrease"));
        assert!(a.contains("-map_metadata -1"));
    }
}
