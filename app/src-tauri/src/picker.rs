// The picker: one borderless, top-most window per monitor showing that monitor's frozen frame. The page handles
// dragging, window snapping, the loupe and the action bar, then reports what was picked and which action to run.

use crate::{actions, capture, state};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
pub enum Mode { Pick, Screen, Record }

#[derive(Serialize)]
pub struct PickerInfo {
    frame: usize,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    mode: Mode,
    windows: Vec<capture::WinInfo>,
    last_rect: Option<(i32, i32, u32, u32)>,
    os: &'static str,
}

#[derive(Deserialize, Debug)]
pub struct Picked {
    pub action: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub windows: Vec<u32>,
    /// Social-media preset: the output is resized to exactly this many pixels.
    #[serde(default)]
    pub size: Option<(u32, u32)>,
}

static MODE: std::sync::Mutex<Mode> = std::sync::Mutex::new(Mode::Pick);

fn pickers(app: &AppHandle) -> Vec<tauri::WebviewWindow> {
    app.webview_windows().into_iter().filter(|(l, _)| l.starts_with("picker-")).map(|(_, w)| w).collect()
}

/// Pickers are hidden, not destroyed: the next capture reuses the warm windows and opens instantly.
pub fn close_pickers(app: &AppHandle) {
    OPEN.store(false, std::sync::atomic::Ordering::SeqCst);
    for w in pickers(app) { let _ = w.hide(); let _ = w.emit_to(w.label(), "reset", ()); }
}

static OPEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Cover exactly one monitor. Moving a window onto a monitor with a different scale makes Windows resize it after
/// the move, so the size is re-applied until it sticks.
fn cover(w: &tauri::WebviewWindow, m: &tauri::Monitor) {
    let (pos, size) = (*m.position(), *m.size());
    let _ = w.set_position(PhysicalPosition::new(pos.x, pos.y));
    for _ in 0..5 {
        let _ = w.set_size(PhysicalSize::new(size.width, size.height));
        let _ = w.set_position(PhysicalPosition::new(pos.x, pos.y));
        std::thread::sleep(std::time::Duration::from_millis(15));
        if w.outer_size().map(|s| s == size).unwrap_or(false) && w.outer_position().map(|p| p == pos).unwrap_or(false) { return; }
    }
    log::warn!("picker window didn't fit monitor at {pos:?}: {:?}", w.outer_size());
}

/// One hidden picker window per monitor, created ahead of time (startup, and whenever the monitors change).
pub fn warm(app: &AppHandle) {
    let monitors = app.available_monitors().unwrap_or_default();
    let have = pickers(app).len();
    if have > monitors.len() { for w in pickers(app) { let _ = w.destroy(); } }
    for (i, m) in monitors.iter().enumerate() {
        let label = format!("picker-{i}");
        let w = match app.get_webview_window(&label) {
            Some(w) => w,
            None => {
                let Ok(w) = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("picker.html".into()))
                    .decorations(false).resizable(false).skip_taskbar(true).always_on_top(true).shadow(false)
                    .visible(false).focused(false).build() else { continue };
                #[cfg(target_os = "macos")]
                let _ = w.set_visible_on_all_workspaces(true);
                w
            }
        };
        cover(&w, m);
    }
}

static STARTING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Callable from anywhere: the work runs on its own thread, because building WebView2 windows from the main thread
/// (tray, shortcut and single-instance callbacks) deadlocks on Windows.
pub fn start(app: &AppHandle, mode: Mode) {
    if STARTING.swap(true, std::sync::atomic::Ordering::SeqCst) { return; }
    let app = app.clone();
    std::thread::spawn(move || {
        start_now(&app, mode);
        STARTING.store(false, std::sync::atomic::Ordering::SeqCst);
    });
}

fn start_now(app: &AppHandle, mode: Mode) {
    if crate::record::is_recording(app) { crate::record::stop(app, true); return; }
    if OPEN.load(std::sync::atomic::Ordering::SeqCst) { return; }
    let t0 = std::time::Instant::now();
    let frames = match capture::freeze_all() {
        Ok(f) => f,
        Err(e) => return actions::notify(app, &format!("Couldn't capture the screen: {e}")),
    };
    let t1 = t0.elapsed();
    *state(app).windows.lock().unwrap() = capture::windows();
    log::info!("picker: frames {t1:?}, windows {:?}", t0.elapsed() - t1);
    *state(app).frames.lock().unwrap() = frames;
    *MODE.lock().unwrap() = mode;

    if mode == Mode::Screen {
        let cur = app.cursor_position().unwrap_or_default();
        let r = {
            let frames = state(app).frames.lock().unwrap();
            frames.iter().find(|f| (cur.x as i32) >= f.x && (cur.y as i32) >= f.y && (cur.x as i32) < f.x + f.image.width() as i32 && (cur.y as i32) < f.y + f.image.height() as i32)
                .or(frames.first()).map(|f| (f.x, f.y, f.image.width(), f.image.height()))
        };
        if let Some((x, y, width, height)) = r {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { actions::run(&app, Picked { action: "default".into(), x, y, width, height, windows: vec![], size: None }).await });
        }
        return;
    }

    let monitors = app.available_monitors().unwrap_or_default();
    if pickers(app).len() != monitors.len() { warm(app); }
    let origins: Vec<(i32, i32)> = state(app).frames.lock().unwrap().iter().map(|f| (f.x, f.y)).collect();
    OPEN.store(true, std::sync::atomic::Ordering::SeqCst);
    for (i, m) in monitors.iter().enumerate() {
        let pos = m.position();
        let frame = origins.iter().position(|&(x, y)| x == pos.x && y == pos.y).unwrap_or(i.min(origins.len().saturating_sub(1)));
        if let Some(w) = app.get_webview_window(&format!("picker-{i}")) {
            cover(&w, m);
            let _ = w.emit_to(w.label(), "open", frame);
        }
    }
}

/// Shift+capture key: the same rectangle as last time, straight to the default action.
pub fn repeat_last(app: &AppHandle) {
    let Some((x, y, width, height)) = *state(app).last_rect.lock().unwrap() else { return start(app, Mode::Pick) };
    match capture::freeze_all() {
        Ok(f) => *state(app).frames.lock().unwrap() = f,
        Err(e) => return actions::notify(app, &format!("Couldn't capture the screen: {e}")),
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move { actions::run(&app, Picked { action: "default".into(), x, y, width, height, windows: vec![], size: None }).await });
}

/// The page has drawn its new frame: show it, and give the window under the mouse the keyboard.
#[tauri::command]
pub fn picker_shown(app: AppHandle, window: tauri::WebviewWindow) {
    if !OPEN.load(std::sync::atomic::Ordering::SeqCst) { return; }
    let _ = window.show();
    let cur = app.cursor_position().unwrap_or_default();
    if let (Ok(p), Ok(s)) = (window.outer_position(), window.outer_size()) {
        if cur.x as i32 >= p.x && (cur.x as i32) < p.x + s.width as i32 && cur.y as i32 >= p.y && (cur.y as i32) < p.y + s.height as i32 { let _ = window.set_focus(); }
    }
}

#[tauri::command]
pub fn picker_info(app: AppHandle, frame: usize) -> Option<PickerInfo> {
    let frames = state(&app).frames.lock().unwrap();
    let f = frames.get(frame)?;
    Some(PickerInfo {
        frame, x: f.x, y: f.y, width: f.image.width(), height: f.image.height(),
        mode: *MODE.lock().unwrap(),
        windows: state(&app).windows.lock().unwrap().clone(),
        last_rect: *state(&app).last_rect.lock().unwrap(),
        os: std::env::consts::OS,
    })
}

#[tauri::command]
pub async fn picked(app: AppHandle, pick: Picked) -> Result<(), String> {
    close_pickers(&app);
    let mut pick = pick;
    if *MODE.lock().unwrap() == Mode::Record && pick.action == "default" { pick.action = "record".into(); }
    actions::run(&app, pick).await;
    Ok(())
}

#[tauri::command]
pub fn picker_cancel(app: AppHandle) {
    close_pickers(&app);
    state(&app).frames.lock().unwrap().clear();
}
