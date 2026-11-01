// Grabbit: tray app. Tap the capture key → frozen screens + picker → action bar. Hold it → record.

mod actions;
mod ai;
mod audio;
mod capture;
mod editor;
mod export;
mod history;
mod hotkey;
mod mark;
mod ocr;
mod picker;
mod record;
mod settings;
mod share;
mod video;

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

/// Serves frozen frames to the picker as raw RGBA (no encoding, so a 4K frame is there at once): grabbit://localhost/frame/<monitor>.
fn serve(app: &AppHandle, path: &str) -> Response<Vec<u8>> {
    let not_found = || Response::builder().status(404).body(Vec::new()).unwrap();
    let path = path.replace("%2F", "/").replace("%2f", "/");
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
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| editor::handle_args(app, &args)))
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(hotkey::on_event).build())
        .plugin(tauri_plugin_log::Builder::new().level(log::LevelFilter::Info).level_for("xcap", log::LevelFilter::Off).max_file_size(2_000_000)
            .targets([tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: Some("grabbit".into()) }),
                      tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout)]).build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--background"])))
        .manage(AppState { settings: Mutex::new(Settings::load()), ..Default::default() })
        .register_asynchronous_uri_scheme_protocol("grabbit", |ctx, req, responder| {
            let app = ctx.app_handle().clone();
            let path = req.uri().path().to_string();
            std::thread::spawn(move || responder.respond(serve(&app, &path)));
        })
        .invoke_handler(tauri::generate_handler![
            picker::picker_info,
            picker::picker_shown,
            picker::picked,
            picker::picker_cancel,
            editor::editor_msg,
            editor::get_settings,
            editor::set_settings,
            record::rec_status,
            record::rec_control,
            actions::copy_text,
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
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            tray(app.handle())?;
            hotkey::register_all(app.handle());
            let h = app.handle().clone();
            std::thread::spawn(move || picker::warm(&h));
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
