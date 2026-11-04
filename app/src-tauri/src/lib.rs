// Grabbit: tray app. Tap the capture key → frozen screens + picker → action bar. Hold it → record.

mod actions;
mod ai;
mod audio;
mod batch;
mod capture;
mod editor;
mod export;
mod history;
mod hotkey;
mod mark;
mod ocr;
mod picker;
mod record;
mod replay;
mod settings;
mod scroll;
mod selftest;
mod share;
mod steps;
mod studio;
mod timelapse;
mod video;
mod voice;

use std::{collections::HashMap, sync::Mutex};
use tauri::{
    http::Response,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

pub use settings::Settings;

#[derive(Default)]
pub struct AppState {
    pub settings: Mutex<Settings>,
    /// Frozen monitors of the capture in progress.
    pub frames: Mutex<Vec<capture::Frame>>,
    pub windows: Mutex<Vec<capture::WinInfo>>,
    /// Last picked rectangle (physical, virtual desktop) for "repeat last area".
    pub last_rect: Mutex<Option<(i32, i32, u32, u32)>>,
    /// What each editor window should open with, keyed by window label.
    pub editor_jobs: Mutex<HashMap<String, editor::Job>>,
}

pub fn state(app: &AppHandle) -> &AppState { app.state::<AppState>().inner() }

/// grabbit://localhost/file/<path>: a local file with CORS allowed and byte ranges, so pages can draw it into a canvas
/// and still export the canvas (the asset protocol taints it), and videos can seek.
fn serve_file(path: &str, range: Option<&str>) -> Response<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let bad = |c: u16| Response::builder().status(c).header("Access-Control-Allow-Origin", "*").body(Vec::new()).unwrap();
    let Ok(mut f) = std::fs::File::open(path) else { return bad(404) };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let mime = match std::path::Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "webp" => "image/webp", "gif" => "image/gif",
        "mp4" | "m4v" => "video/mp4", "webm" => "video/webm", "mov" => "video/quicktime", "mkv" => "video/x-matroska", _ => "application/octet-stream",
    };
    let (start, end) = range.and_then(|r| r.strip_prefix("bytes=")).and_then(|r| r.split_once('-'))
        .map(|(a, b)| (a.parse::<u64>().unwrap_or(0), b.parse::<u64>().ok().unwrap_or(len.saturating_sub(1)).min(len.saturating_sub(1))))
        .unwrap_or((0, len.saturating_sub(1)));
    // Ranges are capped at 8 MB per answer; the player asks for the rest as it needs it.
    let end = if range.is_some() { end.min(start + 8 * 1024 * 1024 - 1) } else { end };
    let mut buf = vec![0u8; (end + 1).saturating_sub(start) as usize];
    if f.seek(SeekFrom::Start(start)).and_then(|_| f.read_exact(&mut buf)).is_err() { return bad(416); }
    let b = Response::builder().header("Content-Type", mime).header("Access-Control-Allow-Origin", "*").header("Accept-Ranges", "bytes");
    if range.is_some() { b.status(206).header("Content-Range", format!("bytes {start}-{end}/{len}")).body(buf).unwrap() } else { b.body(buf).unwrap() }
}

pub(crate) fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() { if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) { out.push(v); i += 3; continue; } }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Serves frozen frames to the picker as raw RGBA (no encoding, so a 4K frame is there at once): grabbit://localhost/frame/<monitor>.
fn serve(app: &AppHandle, path: &str, range: Option<&str>) -> Response<Vec<u8>> {
    let not_found = || Response::builder().status(404).body(Vec::new()).unwrap();
    let path = percent_decode(path);
    if let Some(file) = path.strip_prefix("/file/") { return serve_file(file, range); }
    let Some(i) = path.strip_prefix("/frame/").and_then(|s| s.parse::<usize>().ok()) else { return not_found() };
    let frames = state(app).frames.lock().unwrap();
    let Some(f) = frames.get(i) else { return not_found() };
    Response::builder().header("Content-Type", "application/octet-stream").header("Access-Control-Allow-Origin", "*").body(f.image.as_raw().clone()).unwrap()
}

fn tray(app: &AppHandle) -> tauri::Result<()> {
    let item = |id: &str, text: &str| MenuItem::with_id(app, id, text, true, None::<&str>);
    let menu = Menu::with_items(app, &[
        &item("capture", "Capture")?,
        &item("capture_screen", "Capture whole screen")?,
        &item("record", "Record screen")?,
        &item("replay", "Save replay (last minute)")?,
        &item("batch", "AI batch: talk through screenshots")?,
        &item("steps", "Record steps (how-to)")?,
        &item("timelapse", "Timed captures / timelapse")?,
        &PredefinedMenuItem::separator(app)?,
        &item("open", "Open picture or video…")?,
        &item("folder", "Open Grabbit folder")?,
        &item("history", "Search captures…")?,
        &item("settings", "Settings…")?,
        &PredefinedMenuItem::separator(app)?,
        &item("quit", "Quit Grabbit")?,
    ])?;
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().unwrap())
        .icon_as_template(true)
        .tooltip("Grabbit: tap the capture key for a screenshot, hold it to record")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "capture" => picker::start(app, picker::Mode::Pick),
            "capture_screen" => picker::start(app, picker::Mode::Screen),
            "record" => picker::start(app, picker::Mode::Record),
            "replay" => replay::save_now(app),
            "steps" => steps::toggle(app),
            "batch" => batch::toggle(app),
            "timelapse" => timelapse::toggle(app),
            "open" => editor::open_dialog(app),
            "folder" => { let _ = tauri_plugin_opener::open_path(&state(app).settings.lock().unwrap().save_folder, None::<&str>); }
            "settings" => editor::open_settings(app, None),
            "history" => editor::open_settings(app, Some("History")),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|t, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                picker::start(t.app_handle(), picker::Mode::Pick);
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--self-test") {
        let dir = args.get(i + 1).cloned().unwrap_or_else(|| std::env::temp_dir().join("grabbit-selftest").to_string_lossy().into());
        std::process::exit(selftest::run(std::path::Path::new(&dir)));
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| editor::handle_args(app, &args)))
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(hotkey::on_event).build())
        .plugin(tauri_plugin_log::Builder::new().level(log::LevelFilter::Info).level_for("xcap", log::LevelFilter::Off).max_file_size(2_000_000)
            .targets([tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: Some("grabbit".into()) }),
                      tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout)]).build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--background"])))
        .manage(AppState { settings: Mutex::new(Settings::load()), ..Default::default() })
        .register_asynchronous_uri_scheme_protocol("grabbit", |ctx, req, responder| {
            let app = ctx.app_handle().clone();
            let path = req.uri().path().to_string();
            let range = req.headers().get("range").and_then(|v| v.to_str().ok()).map(String::from);
            std::thread::spawn(move || responder.respond(serve(&app, &path, range.as_deref())));
        })
        .invoke_handler(tauri::generate_handler![
            actions::dev_window,
            picker::picker_info,
            picker::picker_shown,
            picker::picked,
            picker::picker_cancel,
            editor::editor_msg,
            editor::get_settings,
            editor::set_settings,
            editor::open_settings_at,
            editor::settings_export,
            editor::settings_import,
            record::rec_status,
            record::rec_control,
            actions::copy_text,
            scroll::scroll_control,
            actions::copy_file_image,
            actions::picker_delay,
            actions::quick_action,
            actions::drag_out,
            actions::autostart_get,
            actions::autostart_set,
            actions::check_mark,
            actions::open_file,
            share::share_setup,
            share::share_file,
            share::share_targets,
            ai::ai_edit,
            ai::ai_ask,
            voice::voice_open,
            voice::voice_stop,
            voice::voice_restart,
            voice::voice_level,
            voice::copy_for_ai,
            batch::batch_add,
            batch::batch_items,
            batch::batch_finish,
            batch::batch_clear,
            batch::batch_start,
            ai::ai_describe,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            // grabbit://capture, grabbit://record, grabbit://open/<path>… from scripts, launchers and shortcuts.
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // The Windows installers register the scheme; rewriting HKCU\Software\Classes on every start looks like
                // persistence to Defender. Linux keeps it for AppImages, which have no installer.
                #[cfg(target_os = "linux")]
                let _ = app.deep_link().register_all();
                let h = app.handle().clone();
                app.deep_link().on_open_url(move |e| {
                    let args: Vec<String> = std::iter::once(String::new()).chain(e.urls().iter().map(|u| u.to_string())).collect();
                    editor::handle_args(&h, &args);
                });
            }
            tray(app.handle())?;
            hotkey::register_all(app.handle());
            let h = app.handle().clone();
            std::thread::spawn(move || picker::warm(&h));
            replay::sync(app.handle());
            let args: Vec<String> = std::env::args().collect();
            editor::handle_args(app.handle(), &args);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("starting Grabbit")
        .run(|_, e| {
            // A tray app keeps running when its last window closes.
            if let tauri::RunEvent::ExitRequested { api, code: None, .. } = e { api.prevent_exit(); }
        });
}
