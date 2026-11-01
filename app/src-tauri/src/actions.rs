// What happens to a picked area: one place for every action on the bar, the tray and the hotkeys.

use crate::{capture, editor, export, mark, ocr, picker::Picked, record, state, AppState};
use image::RgbaImage;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub fn notify(app: &AppHandle, text: &str) {
    log::info!("{text}");
    let _ = app.emit("toast", text.to_string());
    quick_show(app, None, text);
}

fn grab(st: &AppState, p: &Picked) -> anyhow::Result<RgbaImage> {
    let all = st.windows.lock().unwrap().clone();
    let img = match p.windows.as_slice() {
        [] => capture::crop(&st.frames.lock().unwrap(), p.x, p.y, p.width, p.height),
        [id] => capture::capture_window(*id).or_else(|_| Ok::<_, anyhow::Error>(capture::crop(&st.frames.lock().unwrap(), p.x, p.y, p.width, p.height)))?,
        ids => capture::compose_windows(ids, &all)?,
    };
    Ok(img)
}

pub async fn run(app: &AppHandle, p: Picked) {
    if let Err(e) = run_inner(app, p).await { notify(app, &format!("{e}")); }
}

async fn run_inner(app: &AppHandle, p: Picked) -> anyhow::Result<()> {
    let st = state(app);
    if p.action == "record" {
        st.frames.lock().unwrap().clear();
        return record::start(app, (p.x, p.y, p.width, p.height));
    }
    let mut img = grab(&st, &p)?;
    if let Some((w, h)) = p.size { img = image::imageops::resize(&img, w, h, image::imageops::FilterType::Lanczos3); }
    *st.last_rect.lock().unwrap() = Some((p.x, p.y, p.width, p.height));
    st.frames.lock().unwrap().clear();
    let s = st.settings.lock().unwrap().clone();
    let name = export::stamp_name("Grabbit");
    let id = mark::capture_id();

    let action = match p.action.as_str() {
        "default" => match s.after_capture { crate::settings::AfterCapture::Edit => "edit", _ => "copy" },
        a => a,
    };
    match action {
        "copy" | "reduced" | "chat" | "path" | "pin" | "share" => {
            let out = mark::apply(&s, &img, id);
            let saved = if s.auto_save || action == "path" { Some(export::save_full(&s, &out, &name)?) } else { None };
            crate::history::add(app, saved.as_deref(), &img, id);
            match action {
                "path" => export::copy_text(&saved.as_ref().unwrap().to_string_lossy())?,
                "pin" => pin(app, &out)?,
                "share" => editor::open_image(app, &img, &name, Some("share")),
                _ => {
                    let size = match action { "reduced" => export::Size::Reduced, "chat" => export::Size::Chat, _ => export::Size::Full };
                    let file = export::copy(&s, &out, size, &name)?;
                    quick_show(app, Some(saved.as_deref().unwrap_or(&file)), "Copied");
                }
            }
        }
        "edit" => editor::open_image(app, &img, &name, None),
        "save" => {
            let out = mark::apply(&s, &img, id);
            let app2 = app.clone();
            let dir = s.save_folder.clone();
            use tauri_plugin_dialog::DialogExt;
            app.dialog().file().set_directory(dir).set_file_name(format!("{name}.png"))
                .add_filter("PNG", &["png"]).add_filter("WebP (lossless)", &["webp"]).add_filter("JPEG", &["jpg"])
                .save_file(move |f| {
                    let Some(path) = f.and_then(|f| f.into_path().ok()) else { return };
                    let s = state(&app2).settings.lock().unwrap().clone();
                    let x = export::xmp(&s);
                    let r = match path.extension().and_then(|e| e.to_str()).unwrap_or("png").to_ascii_lowercase().as_str() {
                        "webp" => export::webp_bytes(&out, x.as_deref()),
                        "jpg" | "jpeg" => export::chat_jpeg(&out, u32::MAX, u32::MAX / 2048),
                        _ => export::png_bytes(&out, x.as_deref()),
                    }.and_then(|b| Ok(std::fs::write(&path, b)?));
                    if let Err(e) = r { notify(&app2, &format!("Couldn't save: {e}")); }
                });
        }
        "ocr" => {
            let text = ocr::recognize(&img).await?;
            if text.trim().is_empty() { notify(app, "No text found"); } else { export::copy_text(&text)?; notify(app, &format!("Copied text: {}", first_line(&text))); }
        }
        "qr" => {
            let found = read_codes(&img);
            if found.is_empty() { notify(app, "No QR code found"); } else { export::copy_text(&found.join("\n"))?; notify(app, &format!("Copied: {}", first_line(&found[0]))); }
        }
        other => anyhow::bail!("unknown action {other}"),
    }
    Ok(())
}

fn first_line(t: &str) -> String {
    let l = t.lines().next().unwrap_or("").trim();
    if l.chars().count() > 60 { format!("{}…", l.chars().take(60).collect::<String>()) } else { l.to_string() }
}

pub fn read_codes(img: &RgbaImage) -> Vec<String> {
    let gray = image::DynamicImage::ImageRgba8(img.clone()).to_luma8();
    let mut g = rqrr::PreparedImage::prepare(gray);
    g.detect_grids().into_iter().filter_map(|grid| grid.decode().ok().map(|(_, s)| s)).collect()
}

/// A picture floating on top of everything; drag to move, scroll to zoom, Esc or double-click to close.
pub fn pin(app: &AppHandle, img: &RgbaImage) -> anyhow::Result<()> {
    let path = std::env::temp_dir().join("Grabbit").join(format!("{}.png", export::stamp_name("pin")));
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(&path, export::png_bytes(img, None)?)?;
    let scale = app.primary_monitor()?.map(|m| m.scale_factor()).unwrap_or(1.0);
    let label = format!("pin-{}", chrono::Local::now().timestamp_millis());
    let url = format!("pin.html?p={}", urlencode(&path.to_string_lossy()));
    let a = app.clone();
    let (w, h) = (img.width() as f64 / scale, img.height() as f64 / scale);
    std::thread::spawn(move || {
        let _ = WebviewWindowBuilder::new(&a, &label, WebviewUrl::App(url.into()))
            .decorations(false).always_on_top(true).skip_taskbar(true).resizable(true).shadow(true)
            .inner_size(w.max(80.0), h.max(40.0)).title("Pinned").build();
    });
    Ok(())
}

pub fn urlencode(s: &str) -> String {
    s.bytes().map(|b| match b { b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(), _ => format!("%{b:02X}") }).collect()
}

/// The quick-access card in the corner after a capture: thumbnail you can drag into other apps, plus edit / pin / share.
pub fn quick_show(app: &AppHandle, file: Option<&std::path::Path>, text: &str) {
    let url = format!("quick.html?t={}{}", urlencode(text), file.map(|f| format!("&p={}", urlencode(&f.to_string_lossy()))).unwrap_or_default());
    let a = app.clone();
    let h = if file.is_some() { 230.0 } else { 64.0 };
    let _ = std::thread::spawn(move || {
        if let Some(w) = a.get_webview_window("quick") { let _ = w.destroy(); }
        let Ok(Some(m)) = a.primary_monitor() else { return };
        let s = m.scale_factor();
        let (mw, mh) = (m.size().width as f64 / s, m.size().height as f64 / s);
        let w = 300.0;
        let _ = WebviewWindowBuilder::new(&a, "quick", WebviewUrl::App(url.into()))
            .decorations(false).transparent(true).shadow(false).always_on_top(true).skip_taskbar(true).focused(false).resizable(false)
            .inner_size(w, h).position(m.position().x as f64 / s + mw - w - 20.0, m.position().y as f64 / s + mh - h - 64.0)
            .build();
    });
}

#[tauri::command]
pub fn copy_text(text: String) -> Result<(), String> { export::copy_text(&text).map_err(|e| e.to_string()) }

#[tauri::command]
pub fn copy_file_image(app: AppHandle, path: String) -> Result<(), String> {
    let s = state(&app).settings.lock().unwrap().clone();
    let img = image::open(&path).map_err(|e| e.to_string())?.to_rgba8();
    export::copy(&s, &img, export::Size::Full, &export::stamp_name("Grabbit")).map(|_| ()).map_err(|e| e.to_string())
}

/// "Capture again in N s": close the picker, wait, then freeze the screens afresh (menus can be opened meanwhile).
#[tauri::command]
pub fn picker_delay(app: AppHandle, secs: u64) {
    crate::picker::close_pickers(&app);
    notify(&app, &format!("Capturing in {secs} s…"));
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(secs));
        if let Some(w) = app.get_webview_window("quick") { let _ = w.destroy(); }
        std::thread::sleep(std::time::Duration::from_millis(150));
        let a = app.clone();
        let _ = std::thread::spawn(move || crate::picker::start(&a, crate::picker::Mode::Pick));
    });
}

/// Buttons on the quick-access card.
#[tauri::command]
pub fn quick_action(app: AppHandle, action: String, path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let is_video = matches!(p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(), Some("mp4" | "mkv" | "mov" | "webm" | "gif"));
    match action.as_str() {
        "edit" => editor::open_path(&app, p),
        "folder" => tauri_plugin_opener::reveal_item_in_dir(p).map_err(|e| e.to_string())?,
        "pin" if !is_video => pin(&app, &image::open(p).map_err(|e| e.to_string())?.to_rgba8()).map_err(|e| e.to_string())?,
        "share" if is_video => editor::open_path(&app, p),
        "share" => editor::open_image(&app, &image::open(p).map_err(|e| e.to_string())?.to_rgba8(), &p.file_stem().unwrap_or_default().to_string_lossy(), Some("share")),
        _ => {}
    }
    Ok(())
}

/// Drag the quick-access thumbnail into another app: the OS gets the file itself.
#[tauri::command]
pub fn drag_out(app: AppHandle, window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    let preview = image::open(&p).ok().map(|i| export::png_bytes(&i.thumbnail(160, 160).to_rgba8(), None).unwrap_or_default());
    let icon = match preview { Some(b) if !b.is_empty() => drag::Image::Raw(b), _ => drag::Image::File(p.clone()) };
    let opts = drag::Options::default();
    let a = app.clone();
    let done = move |_r: drag::DragResult, _c: drag::CursorPosition| {
        let a = a.clone();
        let _ = std::thread::spawn(move || if let Some(w) = a.get_webview_window("quick") { let _ = w.destroy(); });
    };
    #[cfg(target_os = "linux")]
    let r = window.gtk_window().map_err(|e| e.to_string()).and_then(|g| drag::start_drag(&g, drag::DragItem::Files(vec![p]), icon, done, opts).map_err(|e| e.to_string()));
    #[cfg(not(target_os = "linux"))]
    let r = drag::start_drag(&window, drag::DragItem::Files(vec![p]), icon, done, opts).map_err(|e| e.to_string());
    r
}

#[tauri::command]
pub fn autostart_get(app: AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
pub fn autostart_set(app: AppHandle, on: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let a = app.autolaunch();
    if on { a.enable() } else { a.disable() }.map_err(|e| e.to_string())
}

/// Check image: read Grabbit's invisible watermark from a file, and name the original capture when it's ours.
#[tauri::command]
pub async fn check_mark(app: AppHandle, path: String) -> Result<serde_json::Value, String> {
    let owner = state(&app).settings.lock().unwrap().branding.owner.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let img = image::open(&path).map_err(|e| e.to_string())?.to_rgba8();
        Ok(match mark::check(&img) {
            None => serde_json::json!({ "found": false }),
            Some(f) => serde_json::json!({ "found": true, "yours": f.owner_hash == mark::owner_hash(&owner), "id": f.id, "capture": crate::history::by_mark(f.id) }),
        })
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn open_file(app: AppHandle, path: String) { editor::open_path(&app, std::path::Path::new(&path)); }
