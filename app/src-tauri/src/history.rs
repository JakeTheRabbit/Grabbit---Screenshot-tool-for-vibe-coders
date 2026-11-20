// Capture history: one JSON line per capture or recording (history.jsonl in the config dir), with everything that
// helps find it again: when, which programs and windows were in it, where it was pasted, the text in it (read in the
// background), the AI description, stars, "for later", reminders, tags and a note. The History window searches it.
// The watermark id lets Check image name the original capture.

use crate::{ocr, settings::config_dir, state};
use image::RgbaImage;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{io::Write, sync::Mutex};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Paste { pub app: String, pub title: String, pub time: String }

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Entry {
    pub path: String,
    pub time: String,
    pub width: u32,
    pub height: u32,
    pub mark_id: u32,
    pub text: String,
    /// AI explanation and tags (Describe, or automatic when that's turned on).
    pub description: String,
    /// "capture" or "recording".
    pub kind: String,
    /// Programs and window titles the capture covered, front-most first.
    pub apps: Vec<String>,
    pub windows: Vec<String>,
    /// Where it was pasted (Ctrl+V while it was still on the clipboard).
    pub pasted: Vec<Paste>,
    pub starred: bool,
    pub later: bool,
    /// When to remind (RFC 3339), empty for none.
    pub remind: String,
    pub tags: Vec<String>,
    pub note: String,
    /// The whole screen at the moment of the capture, when "keep the full screen" is on.
    pub full: String,
    /// A recording's notes folder (transcript, captions, stills).
    pub notes: String,
}

fn file() -> std::path::PathBuf { config_dir().join("history.jsonl") }
static FILE: Mutex<()> = Mutex::new(());

pub fn all() -> Vec<Entry> {
    let _g = FILE.lock().unwrap();
    std::fs::read_to_string(file()).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

fn append(e: &Entry) {
    let _g = FILE.lock().unwrap();
    let _ = std::fs::create_dir_all(config_dir());
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(file()) {
        let _ = writeln!(f, "{}", serde_json::to_string(e).unwrap_or_default());
    }
}

/// Rewrites the file with `f` applied to every entry for `path` (written to a temp file, then swapped in).
fn change(path: &str, f: impl Fn(&mut Entry)) -> Option<Entry> {
    let _g = FILE.lock().unwrap();
    let mut list: Vec<Entry> = std::fs::read_to_string(file()).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    let mut hit = None;
    for e in list.iter_mut().filter(|e| e.path == path) { f(e); hit = Some(e.clone()); }
    hit.as_ref()?;
    let tmp = file().with_extension("jsonl.tmp");
    let body: String = list.iter().map(|e| serde_json::to_string(e).unwrap_or_default() + "\n").collect();
    std::fs::write(&tmp, body).ok()?;
    std::fs::rename(&tmp, file()).ok()?;
    hit
}

// ---- what was on screen ----

/// The windows a capture covered, set by the picker's action just before the capture is saved.
#[derive(Clone, Debug, Default)]
pub struct Context { pub ids: Vec<u32>, pub titles: Vec<String> }
static CONTEXT: Mutex<Option<Context>> = Mutex::new(None);

/// Windows covering at least a tenth of the area (or that are the area), front-most first, at most four.
pub fn set_context(ids: &[u32], rect: (i32, i32, u32, u32), all: &[crate::capture::WinInfo]) {
    let (x, y, w, h) = rect;
    let area = (w as i64 * h as i64).max(1);
    let mut ctx = Context::default();
    for win in all {
        let ix = (x.max(win.x) as i64, (x + w as i32).min(win.x + win.width as i32) as i64);
        let iy = (y.max(win.y) as i64, (y + h as i32).min(win.y + win.height as i32) as i64);
        let overlap = (ix.1 - ix.0).max(0) * (iy.1 - iy.0).max(0);
        if (ids.contains(&win.id) || overlap * 10 >= area) && !win.title.trim().is_empty() && ctx.ids.len() < 4 {
            ctx.ids.push(win.id);
            ctx.titles.push(win.title.clone());
        }
    }
    *CONTEXT.lock().unwrap() = Some(ctx);
}

/// "Fernhill admin – Orders - Google Chrome" → ("Google Chrome", "Fernhill admin – Orders"): most apps end their
/// title with their own name.
fn split_title(t: &str) -> (String, String) {
    for sep in [" - ", " — ", " – ", " | "] {
        if let Some((page, app)) = t.rsplit_once(sep) { if !app.trim().is_empty() && app.len() <= 40 { return (app.trim().to_string(), page.trim().to_string()); } }
    }
    (String::new(), t.trim().to_string())
}

/// A file name that says what's in it: "Google Chrome – Fernhill admin Orders 2026-11-21 14.32.05".
pub fn smart_name() -> String {
    let stamp = chrono::Local::now().format("%Y-%m-%d %H.%M.%S");
    let ctx = CONTEXT.lock().unwrap().clone().unwrap_or_default();
    let Some(t) = ctx.titles.first() else { return format!("Grabbit {stamp}") };
    let (app, page) = split_title(t);
    let clean = |s: &str| s.chars().map(|c| if r#"<>:"/\|?*"#.contains(c) || c.is_control() { ' ' } else { c }).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
    let short = |s: String, n: usize| if s.chars().count() > n { format!("{}…", s.chars().take(n).collect::<String>().trim_end()) } else { s };
    let (app, page) = (short(clean(&app), 30), short(clean(&page), 60));
    match (app.is_empty(), page.is_empty() || page == app) {
        (false, false) => format!("{app} – {page} {stamp}"),
        (false, true) => format!("{app} {stamp}"),
        (true, false) => format!("{page} {stamp}"),
        _ => format!("Grabbit {stamp}"),
    }
}

/// Program names for windows (slow on Windows: it reads each exe's version info, so only in the background).
fn app_names(ids: &[u32]) -> Vec<String> {
    let wins = xcap::Window::all().unwrap_or_default();
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        if let Some(n) = wins.iter().find(|w| w.id().ok() == Some(*id)).and_then(|w| w.app_name().ok()).filter(|n| !n.is_empty()) {
            if !out.contains(&n) { out.push(n); }
        }
    }
    out
}

// ---- adding ----

/// Record a capture; text indexing runs afterwards so it never slows the copy down.
pub fn add(app: &AppHandle, saved: Option<&std::path::Path>, img: &RgbaImage, mark_id: u32) { add_described(app, saved, img, mark_id, None) }

/// Same, with an AI description already made (Describe), which then isn't asked for again.
pub fn add_described(app: &AppHandle, saved: Option<&std::path::Path>, img: &RgbaImage, mark_id: u32, description: Option<String>) {
    let ctx = CONTEXT.lock().unwrap().take().unwrap_or_default();
    let Some(path) = saved else { return };
    let have = description.is_some();
    let full = FULL.lock().unwrap().take().unwrap_or_default();
    let mut e = Entry { path: path.to_string_lossy().into_owned(), time: chrono::Local::now().to_rfc3339(), width: img.width(), height: img.height(), mark_id,
        description: description.unwrap_or_default(), kind: "capture".into(), windows: ctx.titles.clone(), full, ..Default::default() };
    let mut s = state(app).settings.lock().unwrap().clone();
    if have { s.ai.auto_describe = false; }
    let img = img.clone();
    tauri::async_runtime::spawn(async move {
        let ids = ctx.ids.clone();
        e.apps = tauri::async_runtime::spawn_blocking(move || app_names(&ids)).await.unwrap_or_default();
        for t in &ctx.titles { let (a, _) = split_title(t); if !a.is_empty() && !e.apps.iter().any(|x| x.eq_ignore_ascii_case(&a)) { e.apps.push(a); } }
        if s.index_text { e.text = ocr::recognize(&img).await.unwrap_or_default(); }
        if s.ai.auto_describe {
            let (s2, i2) = (s.clone(), img.clone());
            if let Ok(Ok(d)) = tauri::async_runtime::spawn_blocking(move || crate::ai::describe(&s2, &i2)).await { e.description = format!("{}\nTags: {}", d.summary, d.tags.join(", ")); }
        }
        append(&e);
    });
}

/// A finished recording; its notes folder (and the spoken words, for search) follow in the background.
pub fn add_recording(app: &AppHandle, path: &std::path::Path) {
    let p = path.to_string_lossy().into_owned();
    append(&Entry { path: p.clone(), time: chrono::Local::now().to_rfc3339(), kind: "recording".into(), ..Default::default() });
    let s = state(app).settings.lock().unwrap().clone();
    if !s.recording_notes { return }
    let path = path.to_path_buf();
    std::thread::spawn(move || match crate::notes::write(&s, &path) {
        Ok(n) => { change(&p, |e| { e.text = n.text.clone(); e.notes = n.dir.to_string_lossy().into_owned(); }); }
        Err(e) => eprintln!("recording notes: {e:#}"),
    });
}

// ---- keeping the whole screen ----

static FULL: Mutex<Option<String>> = Mutex::new(None);

/// Saves the screen(s) the area was on, as they were when the capture key was pressed, into "Full screens".
pub fn keep_full_screen(s: &crate::Settings, frames: &[crate::capture::Frame], rect: (i32, i32, u32, u32), name: &str) {
    let (x, y, w, h) = rect;
    let on: Vec<&crate::capture::Frame> = frames.iter().filter(|f| x < f.x + f.image.width() as i32 && x + w as i32 > f.x && y < f.y + f.image.height() as i32 && y + h as i32 > f.y).collect();
    let Some(first) = on.first() else { return };
    let img = if on.len() == 1 { first.image.clone() } else {
        let (l, t) = (on.iter().map(|f| f.x).min().unwrap(), on.iter().map(|f| f.y).min().unwrap());
        let (r, b) = (on.iter().map(|f| f.x + f.image.width() as i32).max().unwrap(), on.iter().map(|f| f.y + f.image.height() as i32).max().unwrap());
        crate::capture::crop(frames, l, t, (r - l) as u32, (b - t) as u32)
    };
    // The name is fixed now (History records it straight away); encoding a whole screen runs in the background.
    let dir = std::path::Path::new(&s.save_folder).join("Full screens");
    if std::fs::create_dir_all(&dir).is_err() { return; }
    let webp = s.save_format == crate::settings::SaveFormat::WebpLossless && img.width().max(img.height()) <= 16383;
    let p = crate::export::free(&dir, &format!("{name} (full screen)"), if webp { "webp" } else { "png" });
    let _ = std::fs::write(&p, b"");
    *FULL.lock().unwrap() = Some(p.to_string_lossy().into_owned());
    let x = crate::export::xmp(s);
    std::thread::spawn(move || {
        let bytes = if webp { crate::export::webp_bytes(&img, x.as_deref()) } else { crate::export::png_bytes(&img, x.as_deref()) };
        if let Ok(b) = bytes { let _ = std::fs::write(&p, b); }
    });
}

// ---- where it was pasted ----

static WATCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[cfg(windows)]
fn clip_seq() -> u32 { unsafe { windows::Win32::System::DataExchange::GetClipboardSequenceNumber() } }
#[cfg(not(windows))]
fn clip_seq() -> u32 { 0 }

/// Watches for Ctrl+V (⌘V, Shift+Insert) while this capture is still what's on the clipboard, for up to 30 minutes,
/// and notes the window it went into. Stops when anything else is copied.
pub fn watch_paste(path: std::path::PathBuf) {
    use device_query::{DeviceQuery, DeviceState, Keycode as K};
    let me = WATCH.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        let seq = clip_seq();
        let dev = DeviceState::new();
        let started = std::time::Instant::now();
        let mut was = false;
        while started.elapsed().as_secs() < 1800 && WATCH.load(std::sync::atomic::Ordering::SeqCst) == me && clip_seq() == seq {
            let k = dev.get_keys();
            let ctrl = k.iter().any(|k| matches!(k, K::LControl | K::RControl | K::LMeta | K::RMeta | K::Command | K::RCommand));
            let paste = (ctrl && k.contains(&K::V)) || (k.contains(&K::Insert) && k.iter().any(|k| matches!(k, K::LShift | K::RShift)));
            if paste && !was {
                std::thread::sleep(std::time::Duration::from_millis(150));
                if let Some(w) = xcap::Window::all().unwrap_or_default().into_iter().find(|w| w.is_focused().unwrap_or(false)) {
                    let title = w.title().unwrap_or_default();
                    let app = w.app_name().ok().filter(|a| !a.is_empty()).unwrap_or_else(|| split_title(&title).0);
                    let p = path.to_string_lossy().into_owned();
                    let paste = Paste { app, title, time: chrono::Local::now().to_rfc3339() };
                    // The entry may still be being written (text reading); try again for a little while.
                    for _ in 0..40 {
                        if change(&p, |e| if !e.pasted.iter().any(|x| x.title == paste.title) { e.pasted.push(paste.clone()) }).is_some() { break; }
                        std::thread::sleep(std::time::Duration::from_millis(500));
                    }
                }
            }
            was = paste;
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
    });
}

// ---- reminders ----

/// Every half minute: anything whose reminder is due pops up, and its History card opens.
pub fn start_reminders(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(30));
        let now = chrono::Local::now();
        for e in all().into_iter().filter(|e| !e.remind.is_empty()) {
            let Ok(due) = chrono::DateTime::parse_from_rfc3339(&e.remind) else { continue };
            if due > now { continue; }
            change(&e.path, |x| x.remind.clear());
            let name = std::path::Path::new(&e.path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            crate::actions::quick_show(&app, Some(std::path::Path::new(&e.path)), &format!("Reminder: {}", if e.note.is_empty() { name } else { e.note.clone() }));
            open(&app, Some(&e.path));
        }
    });
}

// ---- the History window ----

pub fn open(app: &AppHandle, focus: Option<&str>) {
    let enc = |s: &str| s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect::<String>();
    let q = focus.map(|f| format!("?focus={}", enc(f))).unwrap_or_default();
    if let Some(w) = app.get_webview_window("history") {
        if let Some(f) = focus { let _ = w.eval(format!("window.focusCapture && window.focusCapture({f:?})")); }
        let _ = w.unminimize(); let _ = w.show(); let _ = w.set_focus();
        return;
    }
    let a = app.clone();
    std::thread::spawn(move || {
        let b = WebviewWindowBuilder::new(&a, "history", WebviewUrl::App(format!("history.html{q}").into()))
            .title("Grabbit History").inner_size(1240.0, 800.0).min_inner_size(760.0, 480.0).center();
        #[cfg(target_os = "macos")]
        let b = b.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
        if let Ok(w) = b.build() { crate::editor::apply_material(&w); }
    });
}

#[derive(Serialize)]
pub struct Item { #[serde(flatten)] e: Entry, name: String, folder: String, exists: bool, bytes: u64 }

/// Everything, newest first, for the History window to search and filter.
#[tauri::command]
pub fn history_list() -> Vec<Item> {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<Item> = all().into_iter().rev().filter(|e| seen.insert(e.path.clone())).map(|e| {
        let p = std::path::Path::new(&e.path);
        let meta = std::fs::metadata(p).ok();
        Item { name: p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(), folder: p.parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default(), exists: meta.is_some(), bytes: meta.map(|m| m.len()).unwrap_or(0), e }
    }).collect();
    out.retain(|i| i.exists);
    out
}

/// Star, for later, remind, tags, note: only these fields can be changed from the window.
#[tauri::command]
pub fn history_update(path: String, patch: Value) -> Result<(), String> {
    change(&path, |e| {
        if let Some(v) = patch["starred"].as_bool() { e.starred = v; }
        if let Some(v) = patch["later"].as_bool() { e.later = v; }
        if let Some(v) = patch["remind"].as_str() { e.remind = v.to_string(); }
        if let Some(v) = patch["note"].as_str() { e.note = v.to_string(); }
        if let Some(v) = patch["tags"].as_array() { e.tags = v.iter().filter_map(|t| t.as_str().map(|t| t.trim().to_string())).filter(|t| !t.is_empty()).collect(); }
    }).map(|_| ()).ok_or_else(|| "not in history".to_string())
}

/// Forget a capture (the file stays where it is).
#[tauri::command]
pub fn history_remove(path: String) -> Result<(), String> {
    let _g = FILE.lock().unwrap();
    let keep: String = std::fs::read_to_string(file()).unwrap_or_default().lines().filter(|l| serde_json::from_str::<Entry>(l).map(|e| e.path != path).unwrap_or(true)).map(|l| format!("{l}\n")).collect();
    std::fs::write(file(), keep).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_history(app: AppHandle, focus: Option<String>) { open(&app, focus.as_deref()); }

/// The Grabbit folder (or the recordings folder) in Explorer / Finder.
#[tauri::command]
pub fn open_captures_folder(app: AppHandle, videos: Option<bool>) -> Result<(), String> {
    let s = state(&app).settings.lock().unwrap().clone();
    let dir = if videos.unwrap_or(false) { s.video_folder } else { s.save_folder };
    let _ = std::fs::create_dir_all(&dir);
    tauri_plugin_opener::open_path(&dir, None::<&str>).map_err(|e| e.to_string())
}

/// Open a recording's notes folder (looked up by the recording, so only folders Grabbit wrote can be opened).
#[tauri::command]
pub fn open_recording_notes(path: String) -> Result<(), String> {
    let dir = all().into_iter().rev().find(|e| e.path == path && !e.notes.is_empty()).map(|e| e.notes).ok_or("No notes for this recording yet")?;
    tauri_plugin_opener::open_path(&dir, None::<&str>).map_err(|e| e.to_string())
}

/// Newest first. Every word of the query must appear somewhere in what's known about the capture.
pub fn search(query: &str) -> Vec<Entry> {
    let words: Vec<String> = query.to_lowercase().split_whitespace().map(String::from).collect();
    let mut out: Vec<Entry> = all().into_iter().filter(|e| {
        let hay = format!("{} {} {} {} {} {} {}", e.text, e.description, e.path, e.apps.join(" "), e.windows.join(" "), e.tags.join(" "), e.note).to_lowercase();
        words.iter().all(|w| hay.contains(w)) && std::path::Path::new(&e.path).exists()
    }).collect();
    out.reverse();
    out.truncate(200);
    out
}

pub fn by_mark(id: u32) -> Option<Entry> { all().into_iter().rev().find(|e| e.mark_id == id) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_split_into_app_and_page() {
        assert_eq!(split_title("Fernhill admin – Orders - Google Chrome"), ("Google Chrome".into(), "Fernhill admin – Orders".into()));
        assert_eq!(split_title("Untitled"), ("".into(), "Untitled".into()));
    }

    #[test]
    fn smart_names_are_safe_file_names() {
        *CONTEXT.lock().unwrap() = Some(Context { ids: vec![1], titles: vec!["a/b: c? - Notepad".into()] });
        let n = smart_name();
        assert!(n.starts_with("Notepad – a b c "), "{n}");
        assert!(!n.contains(['/', ':', '?']));
        *CONTEXT.lock().unwrap() = None;
        assert!(smart_name().starts_with("Grabbit "));
    }
}
