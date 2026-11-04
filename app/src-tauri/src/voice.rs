// Voice notes for AI chats: capture something, say what you want done, and paste picture + words into ChatGPT,
// Claude or any chat in one go. The microphone records until Done, the speech is transcribed (on this computer, or
// with OpenAI), and the clipboard gets the picture (as pixels and as a file), the words as text, and both together as
// HTML. The words are also printed under the picture, so the model reads them even where a chat keeps only the image.

use crate::{actions, audio::Capture, editor, export, state, studio};
use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use cpal::traits::{DeviceTrait, HostTrait};
use std::{
    path::{Path, PathBuf},
    sync::{mpsc, Mutex},
};
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

enum Msg { Stop(bool, mpsc::Sender<Result<Option<PathBuf>>>) }
static REC: Mutex<Option<mpsc::Sender<Msg>>> = Mutex::new(None);

pub fn start_mic() -> Result<()> {
    let wav = std::env::temp_dir().join("Grabbit").join(format!("{}.wav", export::stamp_name("voice").replace(' ', "-")));
    std::fs::create_dir_all(wav.parent().unwrap())?;
    let (ready_tx, ready_rx) = mpsc::channel::<Result<()>>();
    let (tx, rx) = mpsc::channel::<Msg>();
    // cpal streams stay on the thread that made them.
    std::thread::spawn(move || {
        let cap = match Capture::microphone(wav) { Ok(c) => { let _ = ready_tx.send(Ok(())); c } Err(e) => { let _ = ready_tx.send(Err(e)); return; } };
        if let Ok(Msg::Stop(keep, reply)) = rx.recv() {
            let (p, _) = cap.finish();
            let _ = reply.send(Ok(keep.then_some(p)));
        }
    });
    ready_rx.recv().context("microphone thread ended")??;
    *REC.lock().unwrap() = Some(tx);
    Ok(())
}

/// Open the AI-pack window for a picture or a video and start listening. `title`: the captured window's title.
pub fn open(app: &AppHandle, picture: &Path, video: Option<&Path>, title: &str) {
    let mic = start_mic();
    let name = cpal::default_host().default_input_device().and_then(|d| d.description().ok()).map(|d| d.name().to_string()).unwrap_or_default();
    let url = format!("voice.html?t={}&p={}&mic={}{}{}", actions::urlencode(title), actions::urlencode(&picture.to_string_lossy()), actions::urlencode(&name),
        video.map(|v| format!("&v={}", actions::urlencode(&v.to_string_lossy()))).unwrap_or_default(),
        if let Err(e) = &mic { format!("&err={}", actions::urlencode(&format!("{e}"))) } else { String::new() });
    let a = app.clone();
    std::thread::spawn(move || {
        if let Some(w) = actions::reuse_window(&a, "voice", &url) { let _ = w.set_focus(); return; }
        let b = WebviewWindowBuilder::new(&a, "voice", WebviewUrl::App(url.into()))
            .title("Talk about it").inner_size(980.0, 720.0).min_inner_size(700.0, 520.0).always_on_top(true).focused(true).center();
        match b.build() { Ok(w) => { editor::apply_material(&w); let _ = w.set_focus(); } Err(e) => log::warn!("talk window: {e}") }
    });
}

/// Picker / quick card / editor entry: a picture file on disk.
#[tauri::command]
pub fn voice_open(app: AppHandle, path: String, video: Option<String>, title: Option<String>) { open(&app, Path::new(&path), video.as_deref().map(Path::new), title.as_deref().unwrap_or("")); }

/// Stop the microphone; `keep` = transcribe and return the timed lines, otherwise throw the recording away.
async fn stop(s: &crate::settings::Settings, keep: bool) -> Result<Vec<studio::Cue>> {
    let Some(tx) = REC.lock().unwrap().take() else { return Ok(vec![]) };
    let (rtx, rrx) = mpsc::channel();
    let _ = tx.send(Msg::Stop(keep, rtx));
    let s = s.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<studio::Cue>> {
        let Some(wav) = rrx.recv()?? else { return Ok(vec![]) };
        let cues = studio::transcribe(&s, &wav);
        let _ = std::fs::remove_file(&wav);
        let _ = std::fs::remove_file(wav.with_extension("srt"));
        cues
    }).await?
}

pub async fn stop_and_transcribe(s: &crate::settings::Settings) -> Result<Vec<studio::Cue>> { stop(s, true).await }

#[tauri::command]
pub async fn voice_stop(app: AppHandle, keep: bool) -> Result<Vec<studio::Cue>, String> {
    let s = state(&app).settings.lock().unwrap().clone();
    stop(&s, keep).await.map_err(|e| e.to_string())
}

/// How loud the microphone has been since the last call (0–1), so the Talk window shows it's hearing you.
#[tauri::command]
pub fn voice_level() -> f32 { crate::audio::MIC_PEAK.swap(0, std::sync::atomic::Ordering::Relaxed) as f32 / 32767.0 }

#[tauri::command]
pub fn voice_restart() -> Result<(), String> {
    if let Some(tx) = REC.lock().unwrap().take() { let (r, _) = mpsc::channel(); let _ = tx.send(Msg::Stop(false, r)); }
    start_mic().map_err(|e| e.to_string())
}

fn esc(t: &str) -> String { t.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;") }

/// The clipboard for an AI chat: picture pixels, the picture (and any extra files, e.g. the video) as files, the
/// words as plain text, and words + picture as HTML.
#[tauri::command]
pub fn copy_for_ai(images: Vec<String>, text: String, files: Vec<String>) -> Result<Vec<String>, String> {
    (|| -> Result<Vec<String>> {
        let dir = std::env::temp_dir().join("Grabbit").join("for-ai");
        std::fs::create_dir_all(&dir)?;
        let stamp = export::stamp_name("Grabbit for AI");
        let mut pngs = Vec::new();
        let mut first = None;
        for (i, u) in images.iter().enumerate() {
            let img = image::load_from_memory(&B64.decode(u.split_once(',').map(|x| x.1).unwrap_or(u))?)?;
            let p = dir.join(if images.len() == 1 { format!("{stamp}.png") } else { format!("{stamp} {:02}.png", i + 1) });
            std::fs::write(&p, export::png_bytes(&img.to_rgba8(), None)?)?;
            if first.is_none() { first = Some(img); }
            pngs.push(p);
        }
        let mut all: Vec<String> = pngs.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        all.extend(files.into_iter().filter(|f| Path::new(f).exists()));
        let mut html = format!("<div>{}</div>", esc(&text).replace('\n', "<br>"));
        for p in &pngs { html += &format!("<p><img src=\"data:image/png;base64,{}\"></p>", B64.encode(std::fs::read(p)?)); }
        let first = first.map(|i| i.to_rgba8());
        export::set_clipboard(export::Clip { image: first.as_ref(), files: &all, text: Some(&text), html: Some(&html) })?;
        Ok(all)
    })().map_err(|e| e.to_string())
}
