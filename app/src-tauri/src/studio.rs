// Studio effects for recordings, built from the cursor/key track saved next to each video, so they can be changed after
// recording: auto-zoom on clicks (eased in and out), click rings, key captions. Plus silence detection and captions
// (ffmpeg's whisper filter with a downloaded model, or OpenAI transcription with the user's key).

use crate::{record::CursorTrack, settings::Settings, video};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Deserialize, Clone, Copy, Debug, Default)]
pub struct Studio { pub zoom: bool, pub clicks: bool, pub keys: bool }

impl Studio { pub fn any(&self) -> bool { self.zoom || self.clicks || self.keys } }

const ZOOM: f64 = 1.8;
const EASE_IN: f64 = 0.45;
const EASE_OUT: f64 = 0.6;

/// Click times and places (area pixels).
fn clicks(t: &CursorTrack) -> Vec<(f64, f64, f64)> {
    let mut out = Vec::new();
    let mut prev = 0u8;
    for &(time, x, y, b) in &t.moves {
        if b & 1 != 0 && prev & 1 == 0 { out.push((time as f64, x as f64, y as f64)); }
        prev = b;
    }
    out
}

/// Clicks close together share one zoom: (start, end, centre x, centre y).
fn zoom_groups(c: &[(f64, f64, f64)]) -> Vec<(f64, f64, f64, f64)> {
    let mut g: Vec<(f64, f64, Vec<(f64, f64)>)> = Vec::new();
    for &(t, x, y) in c {
        match g.last_mut() { Some(last) if t - last.1 < 2.5 => { last.1 = t; last.2.push((x, y)); } _ => g.push((t, t, vec![(x, y)])) }
    }
    g.into_iter().map(|(a, b, pts)| {
        let n = pts.len() as f64;
        ((a - EASE_IN - 0.15).max(0.0), b + 1.6, pts.iter().map(|p| p.0).sum::<f64>() / n, pts.iter().map(|p| p.1).sum::<f64>() / n)
    }).collect()
}

fn f(v: f64) -> String { format!("{v:.3}") }

/// 0→1→0 envelope with smoothstep ends, as an ffmpeg expression of `it` (input time).
fn envelope(a: f64, b: f64) -> String {
    let up = format!("clip((it-{})/{},0,1)", f(a), f(EASE_IN));
    let down = format!("clip(({}-it)/{},0,1)", f(b), f(EASE_OUT));
    format!("(({up})*({up})*(3-2*({up})))*(({down})*({down})*(3-2*({down})))")
}

/// Filters for one video stream label `src` → `out`. `w`/`h`/`fps` describe the video.
pub fn filters(s: &Studio, t: &CursorTrack, w: u32, h: u32, fps: f64, src: &str, out: &str, ring_input: Option<usize>) -> String {
    let mut g = String::new();
    let mut cur = src.to_string();
    // Click rings first, in video coordinates, so the zoom carries them.
    if let (true, Some(ri)) = (s.clicks, ring_input) {
        for (i, (tc, x, y)) in clicks(t).into_iter().enumerate() {
            let next = format!("[ck{i}]");
            g += &format!("{cur}[{ri}:v]overlay=x={}-overlay_w/2:y={}-overlay_h/2:enable='between(t,{},{})'{next};", f(x), f(y), f(tc), f(tc + 0.45));
            cur = next;
        }
    }
    if s.zoom {
        let groups = zoom_groups(&clicks(t));
        if !groups.is_empty() {
            let env: Vec<String> = groups.iter().map(|&(a, b, _, _)| envelope(a, b)).collect();
            let total = format!("min(1,{})", env.join("+"));
            let z = format!("1+{}*{}", f(ZOOM - 1.0), total);
            let cx = format!("({}+(1-{total})*{})", groups.iter().zip(&env).map(|(g, e)| format!("{e}*{}", f(g.2))).collect::<Vec<_>>().join("+"), f(w as f64 / 2.0));
            let cy = format!("({}+(1-{total})*{})", groups.iter().zip(&env).map(|(g, e)| format!("{e}*{}", f(g.3))).collect::<Vec<_>>().join("+"), f(h as f64 / 2.0));
            let next = "[zm]".to_string();
            // zoompan rounds to whole pixels; working at 2× and scaling back down keeps the motion smooth.
            g += &format!("{cur}scale={}:{}:flags=lanczos,zoompan=z='{z}':x='clip(2*{cx}-iw/zoom/2,0,iw-iw/zoom)':y='clip(2*{cy}-ih/zoom/2,0,ih-ih/zoom)':d=1:s={}x{}:fps={}{next};",
                w * 2, h * 2, w, h, f(fps));
            cur = next;
        }
    }
    if s.keys && !t.keys.is_empty() {
        let font = font_file().map(|p| format!("fontfile='{}':", p.replace('\\', "/").replace(':', "\\:"))).unwrap_or_default();
        for (i, (tk, k)) in merge_keys(&t.keys).into_iter().enumerate() {
            let next = format!("[ky{i}]");
            let txt = k.replace('\\', "\\\\\\\\").replace('\'', "\u{2019}").replace(':', "\\:").replace('%', "\\%");
            g += &format!("{cur}drawtext={font}text='{txt}':fontsize=h/22:fontcolor=white:box=1:boxcolor=black@0.62:boxborderw=18:x=(w-text_w)/2:y=h-text_h-h/12:enable='between(t,{},{})'{next};", f(tk), f(tk + 1.4));
            cur = next;
        }
    }
    g += &format!("{cur}null{out};");
    g
}

/// Keys pressed close together read as one caption ("Ctrl + Shift + P").
fn merge_keys(keys: &[(f32, String)]) -> Vec<(f64, String)> {
    let mut out: Vec<(f64, String)> = Vec::new();
    for (t, k) in keys {
        let k = match k.as_str() { "LControl" | "RControl" => "Ctrl", "LShift" | "RShift" => "Shift", "LAlt" | "RAlt" => "Alt", "LMeta" | "RMeta" | "Meta" => if cfg!(target_os = "macos") { "Cmd" } else { "Win" }, "Enter" => "Enter", x => x };
        match out.last_mut() { Some(l) if (*t as f64) - l.0 < 0.6 => { if !l.1.split(" + ").any(|x| x == k) { l.1 += &format!(" + {k}"); } } _ => out.push((*t as f64, k.to_string())) }
    }
    out
}

fn font_file() -> Option<String> {
    ["C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/arialbd.ttf", "/System/Library/Fonts/SFNS.ttf", "/System/Library/Fonts/Helvetica.ttc",
     "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf", "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf"]
        .into_iter().find(|p| Path::new(p).exists()).map(String::from)
}

/// The click ring picture (drawn once, kept in the temp folder).
pub fn ring_png() -> Result<PathBuf> {
    let p = std::env::temp_dir().join("Grabbit").join("ring.png");
    if p.exists() { return Ok(p); }
    std::fs::create_dir_all(p.parent().unwrap())?;
    let n = 96u32;
    let mut img = image::RgbaImage::new(n, n);
    let c = n as f32 / 2.0;
    for (x, y, px) in img.enumerate_pixels_mut() {
        let d = ((x as f32 - c).powi(2) + (y as f32 - c).powi(2)).sqrt();
        let a = (1.0 - ((d - 36.0).abs() / 5.0)).clamp(0.0, 1.0) * 0.95 + if d < 30.0 { 0.18 } else { 0.0 };
        *px = image::Rgba([255, 214, 10, (a.min(1.0) * 255.0) as u8]);
    }
    img.save(&p)?;
    Ok(p)
}

/// Quiet stretches (seconds) of all sound tracks mixed, at least `min` long.
pub fn silences(s: &Settings, path: &Path, min: f64) -> Result<Vec<(f64, f64)>> {
    let info = video::probe(s, path)?;
    if info.tracks.is_empty() { bail!("This video has no sound") }
    let mix = if info.tracks.len() > 1 { format!("amix=inputs={}:normalize=0,", info.tracks.len()) } else { String::new() };
    let inputs: String = (0..info.tracks.len()).map(|i| format!("[0:a:{i}]")).collect();
    let args: Vec<String> = vec!["-hide_banner".into(), "-nostats".into(), "-i".into(), path.to_string_lossy().into(),
        "-filter_complex".into(), format!("{inputs}{mix}silencedetect=noise=-38dB:d={}", f(min)), "-f".into(), "null".into(), "-".into()];
    let r = video::run(&video::ffmpeg(s)?, &args, None, |_| {})?;
    let mut out = Vec::new();
    let mut start = None;
    for l in r.err.lines() {
        if let Some(v) = l.split("silence_start: ").nth(1) { start = v.trim().parse::<f64>().ok(); }
        if let (Some(a), Some(v)) = (start, l.split("silence_end: ").nth(1)) {
            if let Some(b) = v.split_whitespace().next().and_then(|x| x.parse::<f64>().ok()) { out.push((a.max(0.0), b)); start = None; }
        }
    }
    if let Some(a) = start { out.push((a, info.duration)); }
    Ok(out)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Cue { pub start: f64, pub end: f64, pub text: String }

pub fn model_path() -> PathBuf { crate::settings::config_dir().join("models").join("ggml-base.bin") }
pub const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";

fn has_whisper_filter(s: &Settings) -> bool {
    let a: Vec<String> = vec!["-hide_banner".into(), "-filters".into()];
    video::ffmpeg(s).ok().and_then(|f| video::run(&f, &a, None, |_| {}).ok()).map(|r| r.out.contains(" whisper ")).unwrap_or(false)
}

/// "local" (ffmpeg whisper + model present), "download" (filter there, model missing), "openai", or "none".
pub fn caption_engine(s: &Settings) -> &'static str {
    if has_whisper_filter(s) { if model_path().exists() { "local" } else if s.ai.openai_key.is_empty() { "download" } else { "openai" } }
    else if !s.ai.openai_key.is_empty() { "openai" } else { "none" }
}

pub fn download_model(progress: impl Fn(f64)) -> Result<PathBuf> {
    let p = model_path();
    std::fs::create_dir_all(p.parent().unwrap())?;
    let mut r = reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(1800)).build()?.get(MODEL_URL).send()?;
    if !r.status().is_success() { bail!("model download failed: {}", r.status()) }
    let total = r.content_length().unwrap_or(148_000_000) as f64;
    let tmp = p.with_extension("part");
    let mut f = std::fs::File::create(&tmp)?;
    let mut buf = vec![0u8; 1 << 20];
    let mut got = 0f64;
    loop {
        let n = std::io::Read::read(&mut r, &mut buf)?;
        if n == 0 { break; }
        std::io::Write::write_all(&mut f, &buf[..n])?;
        got += n as f64;
        progress(got / total);
    }
    drop(f);
    std::fs::rename(&tmp, &p)?;
    Ok(p)
}

fn parse_srt(t: &str) -> Vec<Cue> {
    let ts = |x: &str| -> Option<f64> {
        let x = x.trim().replace(',', ".");
        let p: Vec<&str> = x.split(':').collect();
        if p.len() != 3 { return None; }
        Some(p[0].parse::<f64>().ok()? * 3600.0 + p[1].parse::<f64>().ok()? * 60.0 + p[2].parse::<f64>().ok()?)
    };
    t.replace("\r\n", "\n").split("\n\n").filter_map(|b| {
        let mut l = b.lines().skip_while(|l| !l.contains("-->"));
        let (a, z) = l.next()?.split_once("-->")?;
        let text = l.collect::<Vec<_>>().join(" ").trim().to_string();
        (!text.is_empty()).then(|| Cue { start: ts(a).unwrap_or(0.0), end: ts(z).unwrap_or(0.0), text })
    }).collect()
}

/// Transcribe the video's sound (all tracks mixed). Writes "<video>.srt" and returns the cues.
pub fn transcribe(s: &Settings, path: &Path) -> Result<Vec<Cue>> {
    let info = video::probe(s, path)?;
    if info.tracks.is_empty() { bail!("This video has no sound to caption") }
    let srt = path.with_extension("srt");
    let mix_in: String = (0..info.tracks.len()).map(|i| format!("[0:a:{i}]")).collect();
    let mix = if info.tracks.len() > 1 { format!("{mix_in}amix=inputs={}:normalize=0,", info.tracks.len()) } else { format!("{mix_in}") };
    match caption_engine(s) {
        "local" => {
            let dest = srt.to_string_lossy().replace('\\', "/").replace(':', "\\:");
            let model = model_path().to_string_lossy().replace('\\', "/").replace(':', "\\:");
            let args: Vec<String> = vec!["-hide_banner".into(), "-v".into(), "error".into(), "-y".into(), "-i".into(), path.to_string_lossy().into(),
                "-filter_complex".into(), format!("{mix}aresample=16000,whisper=model='{model}':language=auto:queue=10:destination='{dest}':format=srt"),
                "-f".into(), "null".into(), "-".into()];
            let r = video::run(&video::ffmpeg(s)?, &args, None, |_| {})?;
            if r.code != 0 { bail!("captioning failed: {}", r.err.trim().lines().last().unwrap_or("")) }
        }
        "openai" => {
            let mp3 = std::env::temp_dir().join("Grabbit").join("captions.mp3");
            std::fs::create_dir_all(mp3.parent().unwrap())?;
            let args: Vec<String> = vec!["-hide_banner".into(), "-v".into(), "error".into(), "-y".into(), "-i".into(), path.to_string_lossy().into(),
                "-filter_complex".into(), format!("{mix}aresample=16000[a]"), "-map".into(), "[a]".into(), "-ac".into(), "1".into(), "-b:a".into(), "48k".into(), mp3.to_string_lossy().into()];
            let r = video::run(&video::ffmpeg(s)?, &args, None, |_| {})?;
            if r.code != 0 { bail!("couldn't extract the sound: {}", r.err.trim()) }
            let base = if s.ai.openai_base.is_empty() { "https://api.openai.com/v1" } else { s.ai.openai_base.trim_end_matches('/') };
            let form = reqwest::blocking::multipart::Form::new().text("model", "whisper-1").text("response_format", "srt").file("file", &mp3)?;
            let resp = reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(600)).build()?
                .post(format!("{base}/audio/transcriptions")).bearer_auth(&s.ai.openai_key).multipart(form).send()?;
            let ok = resp.status().is_success();
            let body = resp.text()?;
            if !ok { bail!("OpenAI transcription failed: {body}") }
            std::fs::write(&srt, body)?;
        }
        "download" => bail!("Captions need the speech model (148 MB, downloaded once)."),
        _ => bail!("Captions need an ffmpeg with whisper (ffmpeg 8+) or an OpenAI key in Settings → AI."),
    }
    Ok(parse_srt(&std::fs::read_to_string(&srt).context("no captions written")?))
}

pub fn write_srt(path: &Path, cues: &[Cue]) -> Result<()> {
    let ts = |t: f64| { let ms = (t * 1000.0).round() as u64; format!("{:02}:{:02}:{:02},{:03}", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000) };
    let body: String = cues.iter().enumerate().map(|(i, c)| format!("{}\n{} --> {}\n{}\n\n", i + 1, ts(c.start), ts(c.end), c.text)).collect();
    std::fs::write(path, body)?;
    Ok(())
}

/// Burn-in filter for an .srt (styled for legibility).
pub fn subtitles_filter(srt: &Path) -> String {
    let p = srt.to_string_lossy().replace('\\', "/").replace(':', "\\:").replace('\'', "\\'");
    format!("subtitles='{p}':force_style='FontName=Arial,Fontsize=20,Bold=1,PrimaryColour=&H00FFFFFF,BackColour=&H99000000,BorderStyle=4,Outline=6,Shadow=0,MarginV=36'")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_and_envelope() {
        let t = CursorTrack { width: 100, height: 100, moves: vec![(1.0, 10, 10, 1), (1.1, 10, 10, 0), (2.0, 30, 30, 1), (2.1, 30, 30, 0), (9.0, 90, 90, 1)], keys: vec![] };
        let g = zoom_groups(&clicks(&t));
        assert_eq!(g.len(), 2);
        assert!((g[0].2 - 20.0).abs() < 1e-9);
        let f = filters(&Studio { zoom: true, clicks: true, keys: false }, &t, 1280, 720, 30.0, "[0:v]", "[st]", Some(3));
        assert!(f.contains("zoompan") && f.contains("[3:v]overlay") && f.ends_with("[st];"));
    }

    #[test]
    fn keys_merge() {
        let k = merge_keys(&[(1.0, "LControl".into()), (1.2, "C".into()), (5.0, "Enter".into())]);
        assert_eq!(k.len(), 2);
        assert_eq!(k[0].1, "Ctrl + C");
    }

    #[test]
    fn srt_round_trip() {
        let p = std::env::temp_dir().join("grabbit-test.srt");
        write_srt(&p, &[Cue { start: 1.5, end: 3.25, text: "Hello there".into() }]).unwrap();
        let c = parse_srt(&std::fs::read_to_string(&p).unwrap());
        assert_eq!(c.len(), 1);
        assert!((c[0].end - 3.25).abs() < 1e-9);
    }
}
