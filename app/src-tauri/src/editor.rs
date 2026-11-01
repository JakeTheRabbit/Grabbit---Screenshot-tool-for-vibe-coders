// Editor windows (picture: Excalidraw, video: timeline) and the settings window. Pages talk to the core with
// `editor_msg` (same messages the WPF host used) and get answers as "host" events on their own window.

use crate::{actions, export, history, mark, settings::Settings, state};
use base64::Engine;
use image::RgbaImage;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub enum Job {
    Image { path: PathBuf, name: String, panel: Option<String> },
    Project { path: PathBuf },
    Video { path: PathBuf },
}

static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

fn open_window(app: &AppHandle, page: &str, title: &str, job: Job) {
    let label = format!("editor-{}", NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst));
    state(app).editor_jobs.lock().unwrap().insert(label.clone(), job);
    let (a, page, title) = (app.clone(), page.to_string(), title.to_string());
    let _ = std::thread::spawn(move || {
        let b = WebviewWindowBuilder::new(&a, &label, WebviewUrl::App(page.into()))
            .title(title).inner_size(1280.0, 820.0).min_inner_size(720.0, 480.0).center().focused(true);
        #[cfg(target_os = "macos")]
        let b = b.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
        if let Ok(w) = b.build() { apply_material(&w); }
    });
}

/// Mica on Windows 11, vibrancy on macOS: the window looks like it belongs to the OS.
pub fn apply_material(_w: &WebviewWindow) {
    #[cfg(target_os = "windows")]
    let _ = _w.set_effects(tauri::window::EffectsBuilder::new().effect(tauri::window::Effect::Mica).build());
    #[cfg(target_os = "macos")]
    let _ = _w.set_effects(tauri::window::EffectsBuilder::new().effect(tauri::window::Effect::Sidebar).build());
}

pub fn open_image(app: &AppHandle, img: &RgbaImage, name: &str, panel: Option<&str>) {
    let tmp = std::env::temp_dir().join("Grabbit").join(format!("{name}.png"));
    let _ = std::fs::create_dir_all(tmp.parent().unwrap());
    if let Err(e) = export::png_bytes(img, None).and_then(|b| Ok(std::fs::write(&tmp, b)?)) { return actions::notify(app, &format!("{e}")); }
    open_window(app, "index.html", name, Job::Image { path: tmp, name: name.into(), panel: panel.map(String::from) });
}

pub fn open_path(app: &AppHandle, p: &Path) {
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let name = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    match ext.as_str() {
        "mp4" | "mkv" | "mov" | "webm" | "avi" | "m4v" => open_window(app, "video.html", &name, Job::Video { path: p.into() }),
        "excalidraw" => open_window(app, "index.html", &name, Job::Project { path: p.into() }),
        _ => open_window(app, "index.html", &name.clone(), Job::Image { path: p.into(), name, panel: None }),
    }
}

pub fn open_dialog(app: &AppHandle) {
    use tauri_plugin_dialog::DialogExt;
    let a = app.clone();
    app.dialog().file()
        .add_filter("Pictures and videos", &["png", "jpg", "jpeg", "webp", "gif", "bmp", "excalidraw", "mp4", "mkv", "mov", "webm"])
        .pick_files(move |files| for f in files.unwrap_or_default() { if let Ok(p) = f.into_path() { open_path(&a, &p); } });
}

pub fn open_settings(app: &AppHandle, section: Option<&str>) {
    let url = format!("settings.html{}", section.map(|s| format!("#{s}")).unwrap_or_default());
    if let Some(w) = app.get_webview_window("settings") { let _ = w.eval(&format!("location.hash = {:?}; location.reload()", section.unwrap_or("General"))); let _ = w.set_focus(); return; }
    let a = app.clone();
    let _ = std::thread::spawn(move || {
        let b = WebviewWindowBuilder::new(&a, "settings", WebviewUrl::App(url.into()))
            .title("Grabbit Settings").inner_size(820.0, 620.0).min_inner_size(640.0, 480.0).center();
        #[cfg(target_os = "macos")]
        let b = b.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
        if let Ok(w) = b.build() { apply_material(&w); }
    });
}

/// Command line and second launches: `--open <file>`, `capture`, `capture-screen`, `record`, `settings`, grabbit:// URLs.
pub fn handle_args(app: &AppHandle, args: &[String]) {
    let mut it = args.iter().skip(1).peekable();
    while let Some(a) = it.next() {
        let a = a.trim_start_matches("grabbit://").trim_end_matches('/');
        if let Some(p) = a.strip_prefix("open/") { open_path(app, Path::new(&crate::percent_decode(p))); continue; }
        match a {
            "--open" | "open" => if let Some(p) = it.next() { open_path(app, Path::new(p)); },
            "replay" => crate::replay::save_now(app),
            "steps" => crate::steps::toggle(app),
            "timelapse" => crate::timelapse::toggle(app),
            "capture" | "--capture" => crate::picker::start(app, crate::picker::Mode::Pick),
            "capture-screen" => crate::picker::start(app, crate::picker::Mode::Screen),
            "record" | "--record" => crate::picker::start(app, crate::picker::Mode::Record),
            "settings" => open_settings(app, None),
            p if Path::new(p).is_file() => open_path(app, Path::new(p)),
            _ => {}
        }
    }
}

fn data_url(p: &Path) -> anyhow::Result<(String, u32, u32)> {
    let bytes = std::fs::read(p)?;
    let img = image::load_from_memory(&bytes)?;
    let png = export::png_bytes(&img.to_rgba8(), None)?;
    Ok((format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)), img.width(), img.height()))
}

fn decode_data_url(u: &str) -> anyhow::Result<RgbaImage> {
    let b64 = u.split_once(',').map(|(_, b)| b).unwrap_or(u);
    Ok(image::load_from_memory(&base64::engine::general_purpose::STANDARD.decode(b64)?)?.to_rgba8())
}

#[derive(Serialize)]
struct Recent { path: String, url: String, name: String, time: String, kind: &'static str }

fn recent() -> Vec<Recent> {
    let name = |p: &Path| p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let mut out: Vec<Recent> = history::all().into_iter().rev().filter(|e| Path::new(&e.path).exists()).take(40).map(|e| Recent {
        name: name(Path::new(&e.path)), path: e.path, url: String::new(), time: e.time, kind: "capture",
    }).collect();
    // Copied pictures: export::copy writes each one to the temp Grabbit folder, newest first.
    let mut copied: Vec<_> = std::fs::read_dir(std::env::temp_dir().join("Grabbit")).into_iter().flatten().flatten()
        .filter(|f| matches!(f.path().extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref(), Some("png" | "jpg" | "jpeg" | "webp")))
        .filter_map(|f| Some((f.metadata().ok()?.modified().ok()?, f.path())))
        .collect();
    copied.sort_by(|a, b| b.0.cmp(&a.0));
    out.extend(copied.into_iter().take(40).map(|(t, p)| Recent {
        name: name(&p), path: p.to_string_lossy().into_owned(), url: String::new(),
        time: chrono::DateTime::<chrono::Local>::from(t).to_rfc3339(), kind: "copied",
    }));
    out
}

fn reply(w: &WebviewWindow, m: Value) { let _ = w.emit_to(w.label(), "host", m); }

#[tauri::command]
pub async fn editor_msg(app: AppHandle, window: WebviewWindow, msg: Value) -> Result<Value, String> {
    handle(&app, &window, msg).await.map_err(|e| { let s = e.to_string(); actions::notify(&app, &s); s })
}

async fn handle(app: &AppHandle, w: &WebviewWindow, msg: Value) -> anyhow::Result<Value> {
    let s = state(app).settings.lock().unwrap().clone();
    match msg["type"].as_str().unwrap_or("") {
        "ready" => {
            let job = state(app).editor_jobs.lock().unwrap().remove(w.label());
            match job {
                Some(Job::Image { path, name, panel }) => {
                    let (url, width, height) = data_url(&path)?;
                    reply(w, json!({ "type": "load", "name": name, "dataURL": url, "width": width, "height": height, "recent": recent(), "panel": panel }));
                }
                Some(Job::Project { path }) => {
                    let name = path.file_stem().unwrap_or_default().to_string_lossy().into_owned();
                    reply(w, json!({ "type": "load", "name": name, "scene": std::fs::read_to_string(&path)?, "recent": recent() }));
                }
                Some(Job::Video { path }) => return crate::video::load_message(&s, &path).map(|m| { reply(w, m.clone()); m }),
                None => reply(w, json!({ "type": "recent", "recent": recent() })),
            }
        }
        // The video editor sends "export" too; its messages carry the kept parts.
        "export" if msg.get("segments").is_some() => return crate::video::handle(app, w, "export", &msg, &s).await,
        "export" => {
            let img = decode_data_url(msg["dataURL"].as_str().unwrap_or(""))?;
            let name = msg["name"].as_str().unwrap_or("Grabbit").to_string();
            let edited = format!("{name} edited");
            let id = mark::capture_id();
            let out = mark::apply(&s, &img, id);
            let size = match msg["size"].as_str() { Some("Reduced") => export::Size::Reduced, Some("Chat") => export::Size::Chat, _ => export::Size::Full };
            match msg["action"].as_str().unwrap_or("copy") {
                "copy" | "copyClose" => { export::copy(&s, &out, size, &edited)?; if msg["action"] == "copyClose" { let _ = w.close(); } else { actions::notify(app, "Copied"); reply(w, json!({ "type": "recent", "recent": recent() })); } }
                "saveQuick" | "closeSave" => { let p = export::save_full(&s, &out, &edited)?; history::add(app, Some(&p), &img, id); if msg["action"] == "saveQuick" { actions::notify(app, &format!("Saved {}", p.display())); } }
                "copyPath" => { let p = export::save_full(&s, &out, &edited)?; history::add(app, Some(&p), &img, id); export::copy_text(&p.to_string_lossy())?; actions::notify(app, "Copied the file's path"); }
                "save" => {
                    use tauri_plugin_dialog::DialogExt;
                    let (a, x) = (app.clone(), export::xmp(&s));
                    app.dialog().file().set_directory(&s.save_folder).set_file_name(format!("{edited}.png"))
                        .add_filter("PNG", &["png"]).add_filter("WebP (lossless)", &["webp"]).add_filter("JPEG", &["jpg"])
                        .save_file(move |f| {
                            let Some(p) = f.and_then(|f| f.into_path().ok()) else { return };
                            let r = match p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
                                "webp" => export::webp_bytes(&out, x.as_deref()),
                                "jpg" | "jpeg" => export::chat_jpeg(&out, u32::MAX, u32::MAX / 2048),
                                _ => export::png_bytes(&out, x.as_deref()),
                            }.and_then(|b| Ok(std::fs::write(&p, b)?));
                            if let Err(e) = r { actions::notify(&a, &format!("Couldn't save: {e}")); }
                        });
                }
                "pin" => actions::pin(app, &out)?,
                other => anyhow::bail!("unknown export action {other}"),
            }
        }
        // Share: the rendered picture as a file (branding, watermark and metadata applied), returning its path.
        "exportFile" => {
            let img = decode_data_url(msg["dataURL"].as_str().unwrap_or(""))?;
            let id = mark::capture_id();
            let out = mark::apply(&s, &img, id);
            let dir = std::env::temp_dir().join("Grabbit").join("share");
            std::fs::create_dir_all(&dir)?;
            let p = export::free(&dir, msg["name"].as_str().unwrap_or("Grabbit"), "png");
            std::fs::write(&p, export::png_bytes(&out, export::xmp(&s).as_deref())?)?;
            history::add(app, Some(&p), &img, id);
            return Ok(json!(p));
        }
        "saveProject" => {
            use tauri_plugin_dialog::DialogExt;
            let (a, json) = (app.clone(), msg["json"].as_str().unwrap_or("").to_string());
            app.dialog().file().set_directory(&s.save_folder).add_filter("Excalidraw", &["excalidraw"]).set_file_name("Grabbit.excalidraw")
                .save_file(move |f| if let Some(p) = f.and_then(|f| f.into_path().ok()) { if let Err(e) = std::fs::write(&p, &json) { actions::notify(&a, &format!("{e}")); } });
        }
        "getImage" => {
            let (url, width, height) = data_url(Path::new(msg["path"].as_str().unwrap_or("")))?;
            reply(w, json!({ "type": "image", "reqId": msg["reqId"], "dataURL": url, "width": width, "height": height }));
        }
        "ocr" => {
            let img = decode_data_url(msg["dataURL"].as_str().unwrap_or(""))?;
            return Ok(json!(crate::ocr::words(&img).await?));
        }
        "qr" => {
            let img = decode_data_url(msg["dataURL"].as_str().unwrap_or(""))?;
            return Ok(json!(actions::read_codes(&img)));
        }
        "checkMark" => {
            let img = decode_data_url(msg["dataURL"].as_str().unwrap_or(""))?;
            return Ok(match mark::check(&img) {
                None => json!({ "found": false }),
                Some(f) => json!({ "found": true, "yours": f.owner_hash == mark::owner_hash(&s.branding.owner), "id": f.id, "capture": history::by_mark(f.id) }),
            });
        }
        "search" => return Ok(json!(history::search(msg["query"].as_str().unwrap_or("")))),
        "dirty" | "close" => { if msg["type"] == "close" { let _ = w.close(); } }
        t => return crate::video::handle(app, w, t, &msg, &s).await,
    }
    Ok(Value::Null)
}

#[tauri::command]
pub fn open_settings_at(app: AppHandle, section: String) { open_settings(&app, Some(&section)); }

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Settings { state(&app).settings.lock().unwrap().clone() }

#[tauri::command]
pub fn set_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    settings.save().map_err(|e| e.to_string())?;
    *state(&app).settings.lock().unwrap() = settings;
    crate::hotkey::register_all(&app);
    crate::replay::sync(&app);
    Ok(())
}

/// Settings → Back up: JSON, secrets only when asked for.
#[tauri::command]
pub fn settings_export(app: AppHandle, path: String, secrets: bool) -> Result<(), String> {
    let s = state(&app).settings.lock().unwrap().clone();
    let s = if secrets { s } else { s.without_secrets() };
    let body = json!({ "grabbit": 2, "exported": chrono::Local::now().to_rfc3339(), "secrets": secrets, "settings": s });
    std::fs::write(&path, serde_json::to_string_pretty(&body).unwrap_or_default()).map_err(|e| e.to_string())
}

/// Settings → Restore: applies a backup made on any computer.
#[tauri::command]
pub fn settings_import(app: AppHandle, path: String) -> Result<Settings, String> {
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let next = state(&app).settings.lock().unwrap().restored(&text).map_err(|e| format!("Not a Grabbit settings backup: {e}"))?;
    set_settings(app, next.clone())?;
    Ok(next)
}
