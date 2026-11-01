// AI batch: many pictures, each tied to its own explanation, pasted into an AI chat in one go.
// Narrated: start the batch and keep talking while you take screenshots; whatever you say after a capture (until the
// next one) belongs to that picture. Or add pictures one at a time from the Talk-to-AI window with their own words.
// Finishing opens a review window: every picture with its words, editable, then one Copy for AI.

use crate::{actions, export, state, studio};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::Mutex,
    time::Instant,
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Serialize, Clone, Debug)]
pub struct Item { pub path: PathBuf, pub text: String, pub title: String, #[serde(skip)] pub at: f64 }

struct Batch { items: Vec<Item>, narrated: bool, started: Instant, dir: PathBuf }
static BATCH: Mutex<Option<Batch>> = Mutex::new(None);

pub fn narrating() -> bool { BATCH.lock().unwrap().as_ref().map(|b| b.narrated).unwrap_or(false) }

fn ensure(narrated: bool) -> anyhow::Result<()> {
    let mut g = BATCH.lock().unwrap();
    if g.is_none() {
        let dir = std::env::temp_dir().join("Grabbit").join(export::stamp_name("ai-batch").replace(' ', "-"));
        std::fs::create_dir_all(&dir)?;
        *g = Some(Batch { items: vec![], narrated, started: Instant::now(), dir });
    }
    Ok(())
}

/// Tray / hotkey: start a narrated batch, or finish the one running.
pub fn toggle(app: &AppHandle) {
    if narrating() { return finish(app); }
    if let Err(e) = crate::voice::start_mic() { return actions::notify(app, &format!("Microphone: {e}")); }
    if let Err(e) = ensure(true) { return actions::notify(app, &format!("{e}")); }
    if let Some(b) = BATCH.lock().unwrap().as_mut() { b.narrated = true; b.started = Instant::now(); }
    show_bar(app);
    actions::notify(app, "AI batch: take screenshots and talk about each one after you take it. Press Done on the bar when finished");
}

/// A capture taken while a batch is on joins it (a copy, so later edits to the original don't matter).
pub fn add_capture(app: &AppHandle, img: &image::RgbaImage, title: &str) {
    let mut g = BATCH.lock().unwrap();
    let Some(b) = g.as_mut() else { return };
    let p = b.dir.join(format!("{:02}.png", b.items.len() + 1));
    if export::png_bytes(img, None).and_then(|x| Ok(std::fs::write(&p, x)?)).is_ok() {
        let at = b.started.elapsed().as_secs_f64();
        b.items.push(Item { path: p, text: String::new(), title: title.to_string(), at });
    }
    let n = b.items.len();
    drop(g);
    let _ = tauri::Emitter::emit_to(app, "batchbar", "count", n);
}

/// From the Talk-to-AI window: this picture with these words.
#[tauri::command]
pub fn batch_add(app: AppHandle, path: String, text: String, title: String) -> Result<usize, String> {
    ensure(false).map_err(|e| e.to_string())?;
    let mut g = BATCH.lock().unwrap();
    let b = g.as_mut().unwrap();
    let p = b.dir.join(format!("{:02}.png", b.items.len() + 1));
    std::fs::copy(&path, &p).map_err(|e| e.to_string())?;
    b.items.push(Item { path: p, text, title, at: 0.0 });
    let n = b.items.len();
    drop(g);
    show_bar(&app);
    let _ = tauri::Emitter::emit_to(&app, "batchbar", "count", n);
    Ok(n)
}

/// Speech split at the moments pictures were taken: what's said after picture k (until k+1) is about picture k;
/// anything said before the first picture goes with the first.
pub fn split(cues: &[studio::Cue], at: &[f64]) -> Vec<String> {
    let mut out = vec![String::new(); at.len()];
    for c in cues {
        let mid = (c.start + c.end) / 2.0;
        let i = at.iter().rposition(|&t| t <= mid).unwrap_or(0);
        if let Some(s) = out.get_mut(i) { if !s.is_empty() { s.push(' '); } s.push_str(c.text.trim()); }
    }
    out
}

/// Done: transcribe the narration, give each picture its words, open the review window.
pub fn finish(app: &AppHandle) {
    let narrated = narrating();
    if let Some(w) = app.get_webview_window("batchbar") { let _ = w.destroy(); }
    let app = app.clone();
    std::thread::spawn(move || {
        if narrated {
            actions::notify(&app, "Turning your words into text…");
            let s = state(&app).settings.lock().unwrap().clone();
            let cues = tauri::async_runtime::block_on(crate::voice::stop_and_transcribe(&s));
            match cues {
                Ok(cues) => {
                    let mut g = BATCH.lock().unwrap();
                    if let Some(b) = g.as_mut() {
                        let at: Vec<f64> = b.items.iter().map(|i| i.at).collect();
                        for (item, t) in b.items.iter_mut().zip(split(&cues, &at)) { if item.text.is_empty() { item.text = t; } }
                        b.narrated = false;
                    }
                }
                Err(e) => actions::notify(&app, &format!("Couldn't turn speech into text: {e}. You can type each picture's words in the review window")),
            }
        }
        if BATCH.lock().unwrap().as_ref().map(|b| b.items.is_empty()).unwrap_or(true) {
            *BATCH.lock().unwrap() = None;
            return actions::notify(&app, "AI batch ended: no pictures were taken");
        }
        let a = app.clone();
        if let Some(w) = a.get_webview_window("aibatch") { let _ = w.destroy(); }
        match WebviewWindowBuilder::new(&a, "aibatch", WebviewUrl::App("voice.html?batch=1".into()))
            .title("AI batch").inner_size(1040.0, 760.0).min_inner_size(760.0, 520.0).focused(true).center().build() {
            Ok(w) => crate::editor::apply_material(&w),
            Err(e) => log::warn!("AI batch window: {e}"),
        }
    });
}

#[tauri::command]
pub fn batch_items() -> Vec<Item> { BATCH.lock().unwrap().as_ref().map(|b| b.items.clone()).unwrap_or_default() }

#[tauri::command]
pub fn batch_finish(app: AppHandle) { finish(&app); }

/// Empty the batch (after copying, or to start over).
#[tauri::command]
pub fn batch_clear(app: AppHandle) {
    if narrating() { let s = state(&app).settings.lock().unwrap().clone(); let _ = tauri::async_runtime::block_on(crate::voice::stop_and_transcribe(&s)); }
    if let Some(b) = BATCH.lock().unwrap().take() { let _ = std::fs::remove_dir_all(&b.dir); }
    if let Some(w) = app.get_webview_window("batchbar") { let _ = w.destroy(); }
}

fn show_bar(app: &AppHandle) {
    let a = app.clone();
    std::thread::spawn(move || {
        if a.get_webview_window("batchbar").is_some() { return; }
        let Ok(Some(m)) = a.primary_monitor() else { return };
        let s = m.scale_factor();
        let (mw, w) = (m.size().width as f64 / s, 380.0);
        if let Ok(win) = WebviewWindowBuilder::new(&a, "batchbar", WebviewUrl::App("recbar.html?mode=batch".into()))
            .decorations(false).transparent(true).shadow(false).always_on_top(true).skip_taskbar(true).focused(false).resizable(false)
            .position(m.position().x as f64 / s + (mw - w) / 2.0, m.position().y as f64 / s + 12.0).inner_size(w, 44.0).build() {
            crate::record::exclude_from_capture(&win);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn speech_follows_the_picture_it_was_said_after() {
        let c = |a: f64, b: f64, t: &str| studio::Cue { start: a, end: b, text: t.into() };
        let cues = [c(0.5, 1.5, "first,"), c(3.0, 4.0, "make this blue"), c(9.0, 10.0, "and this one bigger")];
        assert_eq!(split(&cues, &[2.0, 8.0]), vec!["first, make this blue".to_string(), "and this one bigger".to_string()]);
    }
}

#[tauri::command]
pub fn batch_start(app: AppHandle) { toggle(&app); }
