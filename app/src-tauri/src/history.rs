// Capture history: one JSON line per capture (history.jsonl in the config dir). The text in each capture is read in
// the background so old screenshots can be found by the words in them. The watermark id lets Check image name the
// original capture.

use crate::{ocr, settings::config_dir, state};
use image::RgbaImage;
use serde::{Deserialize, Serialize};
use std::io::Write;
use tauri::AppHandle;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Entry {
    pub path: String,
    pub time: String,
    pub width: u32,
    pub height: u32,
    pub mark_id: u32,
    #[serde(default)]
    pub text: String,
    /// AI explanation and tags (Describe, or automatic when that's turned on).
    #[serde(default)]
    pub description: String,
}

fn file() -> std::path::PathBuf { config_dir().join("history.jsonl") }

pub fn all() -> Vec<Entry> {
    std::fs::read_to_string(file()).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

fn append(e: &Entry) {
    let _ = std::fs::create_dir_all(config_dir());
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(file()) {
        let _ = writeln!(f, "{}", serde_json::to_string(e).unwrap_or_default());
    }
}

/// Record a capture; text indexing runs afterwards so it never slows the copy down.
pub fn add(app: &AppHandle, saved: Option<&std::path::Path>, img: &RgbaImage, mark_id: u32) { add_described(app, saved, img, mark_id, None) }

/// Same, with an AI description already made (Describe), which then isn't asked for again.
pub fn add_described(app: &AppHandle, saved: Option<&std::path::Path>, img: &RgbaImage, mark_id: u32, description: Option<String>) {
    let Some(path) = saved else { return };
    let have = description.is_some();
    let mut e = Entry { path: path.to_string_lossy().into_owned(), time: chrono::Local::now().to_rfc3339(), width: img.width(), height: img.height(), mark_id, text: String::new(), description: description.unwrap_or_default() };
    let mut s = state(app).settings.lock().unwrap().clone();
    if have { s.ai.auto_describe = false; }
    if !s.index_text && !s.ai.auto_describe { return append(&e); }
    let img = img.clone();
    tauri::async_runtime::spawn(async move {
        if s.index_text { e.text = ocr::recognize(&img).await.unwrap_or_default(); }
        if s.ai.auto_describe {
            let (s2, i2) = (s.clone(), img.clone());
            if let Ok(Ok(d)) = tauri::async_runtime::spawn_blocking(move || crate::ai::describe(&s2, &i2)).await { e.description = format!("{}\nTags: {}", d.summary, d.tags.join(", ")); }
        }
        append(&e);
    });
}

/// Newest first. Every word of the query must appear in the text or the file name.
pub fn search(query: &str) -> Vec<Entry> {
    let words: Vec<String> = query.to_lowercase().split_whitespace().map(String::from).collect();
    let mut out: Vec<Entry> = all().into_iter().filter(|e| {
        let hay = format!("{} {} {}", e.text, e.description, e.path).to_lowercase();
        words.iter().all(|w| hay.contains(w)) && std::path::Path::new(&e.path).exists()
    }).collect();
    out.reverse();
    out.truncate(200);
    out
}

pub fn by_mark(id: u32) -> Option<Entry> { all().into_iter().rev().find(|e| e.mark_id == id) }
