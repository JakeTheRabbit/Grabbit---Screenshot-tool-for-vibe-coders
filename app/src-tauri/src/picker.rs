// The picker: one borderless, top-most window per monitor showing that monitor's frozen frame. The page handles
// dragging, window snapping, the loupe and the action bar, then reports what was picked and which action to run.

use crate::{actions, capture, state};
use serde::{Deserialize, Serialize};
use std::sync::{atomic::{AtomicBool, AtomicU64, Ordering::SeqCst}, Mutex};
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
    /// Earlier areas of a multi-area capture (physical rects), combined with this one using `layout`.
    #[serde(default)]
    pub extra: Vec<(i32, i32, u32, u32)>,
    #[serde(default)]
    pub layout: Option<String>,
}

static MODE: Mutex<Mode> = Mutex::new(Mode::Pick);

fn pickers(app: &AppHandle) -> Vec<tauri::WebviewWindow> {
    app.webview_windows().into_iter().filter(|(l, _)| l.starts_with("picker-")).map(|(_, w)| w).collect()
}

/// Pickers are hidden, not destroyed: the next capture reuses the warm windows and opens at once. Hidden, they tell
/// WebView2 to use little memory, and Grabbit hands back its own idle memory a few seconds later. With Settings →
/// General → "Instant capture" off they're closed for good a minute after the last capture instead. (Shrinking them
/// while hidden saved nothing and made every capture slower, so they keep their size.)
pub fn close_pickers(app: &AppHandle) {
    OPEN.store(false, SeqCst);
    for w in pickers(app) { let _ = w.hide(); awake(&w, false); let _ = w.emit_to(w.label(), "reset", ()); }
    let gen = GEN.fetch_add(1, SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        if GEN.load(SeqCst) != gen || OPEN.load(SeqCst) { return; }
        trim_memory();
        std::thread::sleep(std::time::Duration::from_secs(57));
        if GEN.load(SeqCst) == gen && !OPEN.load(SeqCst) && !state(&app).settings.lock().unwrap().instant_capture { drop_pickers(&app); }
    });
}

/// Instant capture at start-up: the hidden pickers and the GPU capture are made ready, then idle memory is handed back.
pub fn prepare(app: &AppHandle) {
    warm(app);
    for w in pickers(app) { awake(&w, false); }
    capture::prepare();
    std::thread::sleep(std::time::Duration::from_secs(5));
    if !OPEN.load(SeqCst) { trim_memory(); }
}

/// Lets Windows take back the memory Grabbit isn't using between captures (mostly the graphics driver's, ~100 MB);
/// it comes back in a few milliseconds when it's needed.
fn trim_memory() {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::Threading::{GetCurrentProcess, SetProcessWorkingSetSize};
        let _ = SetProcessWorkingSetSize(GetCurrentProcess(), usize::MAX, usize::MAX);
    }
}

/// Every start and close bumps this, so a pending clean-up knows a newer capture has happened since.
static GEN: AtomicU64 = AtomicU64::new(0);
/// Picker windows get fresh labels each time they're made: a destroyed window's label stays taken until the event loop
/// has run, so reusing it would fail.
static EPOCH: AtomicU64 = AtomicU64::new(0);
/// Pages that have loaded (they can hear "open"), and the frame each newer window should open with once it has.
static READY: Mutex<(Vec<String>, Vec<(String, usize)>)> = Mutex::new((Vec::new(), Vec::new()));
/// Set when a picker page reports it has drawn its frame (picker_shown).
static SHOWN: AtomicBool = AtomicBool::new(false);
/// Rebuilds since a picker last showed: one is tried, then the capture gives up with a message.
static REPAIRS: AtomicU64 = AtomicU64::new(0);
/// When the current capture started, for the "picker shown after …" log line.
static STARTED: Mutex<Option<std::time::Instant>> = Mutex::new(None);

fn drop_pickers(app: &AppHandle) {
    for w in pickers(app) { let _ = w.destroy(); }
    capture::release();
    EPOCH.fetch_add(1, SeqCst);
    *READY.lock().unwrap() = (Vec::new(), Vec::new());
}

/// A new picker page asks once it listens: was a capture waiting for it? (A window built for a capture loads after
/// the capture has started, so it would miss the "open" event.)
#[tauri::command]
pub fn picker_pending(window: tauri::WebviewWindow) -> Option<usize> {
    let mut r = READY.lock().unwrap();
    let label = window.label().to_string();
    if !r.0.contains(&label) { r.0.push(label.clone()); }
    let i = r.1.iter().position(|(l, _)| *l == label)?;
    Some(r.1.remove(i).1)
}

static OPEN: AtomicBool = AtomicBool::new(false);

/// Cover exactly one monitor. Moving a window onto a monitor with a different scale makes Windows resize it after
/// the move, so the size is re-applied until it sticks.
pub fn cover(w: &tauri::WebviewWindow, m: &tauri::Monitor) {
    let (pos, size) = (*m.position(), *m.size());
    let fits = || w.outer_size().map(|s| s == size).unwrap_or(false) && w.outer_position().map(|p| p == pos).unwrap_or(false);
    // Already in place (every capture after the first): nothing to wait for.
    if fits() { return; }
    let _ = w.set_position(PhysicalPosition::new(pos.x, pos.y));
    for _ in 0..5 {
        let _ = w.set_size(PhysicalSize::new(size.width, size.height));
        let _ = w.set_position(PhysicalPosition::new(pos.x, pos.y));
        std::thread::sleep(std::time::Duration::from_millis(15));
        if fits() { return; }
    }
    log::warn!("picker window didn't fit monitor at {pos:?}: {:?}", w.outer_size());
}

/// One hidden picker window per monitor: made when a capture starts (or at startup when kept ready), and again
/// whenever the monitors change.
pub fn warm(app: &AppHandle) {
    let monitors = app.available_monitors().unwrap_or_default();
    if pickers(app).len() != monitors.len() { drop_pickers(app); }
    let e = EPOCH.load(SeqCst);
    // All screens at once: each window's page loads while the others are being made.
    std::thread::scope(|sc| for (i, m) in monitors.iter().enumerate() {
        sc.spawn(move || {
            let label = format!("picker-{e}-{i}");
            let w = match app.get_webview_window(&label) {
                Some(w) => w,
                None => {
                    let Ok(w) = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("picker.html".into()))
                        .decorations(false).resizable(false).skip_taskbar(true).always_on_top(true).shadow(false)
                        .visible(false).focused(false).build() else { return };
                    #[cfg(target_os = "macos")]
                    let _ = w.set_visible_on_all_workspaces(true);
                    w
                }
            };
            cover(&w, m);
        });
    });
}

static STARTING: AtomicBool = AtomicBool::new(false);

/// Callable from anywhere: the work runs on its own thread, because building WebView2 windows from the main thread
/// (tray, shortcut and single-instance callbacks) deadlocks on Windows.
pub fn start(app: &AppHandle, mode: Mode) {
    if STARTING.swap(true, SeqCst) { return; }
    let app = app.clone();
    std::thread::spawn(move || {
        start_now(&app, mode);
        STARTING.store(false, SeqCst);
    });
}

fn start_now(app: &AppHandle, mode: Mode) {
    if crate::record::is_recording(app) { crate::record::stop(app, true); return; }
    if OPEN.load(SeqCst) { return; }
    GEN.fetch_add(1, SeqCst);
    *STARTED.lock().unwrap() = Some(std::time::Instant::now());
    // Set first: holding the key can switch it to Record while the screens are still being grabbed.
    *MODE.lock().unwrap() = mode;
    // The picker windows are made (when they aren't there yet) while the screens are being captured.
    let builder = (mode != Mode::Screen && pickers(app).len() != app.available_monitors().map(|m| m.len()).unwrap_or(0))
        .then(|| { let a = app.clone(); std::thread::spawn(move || warm(&a)) });
    let t0 = std::time::Instant::now();
    // The window list (for snapping) is read while the screens are grabbed.
    let windows = (mode != Mode::Screen).then(|| std::thread::spawn(capture::windows));
    let frames = match capture::freeze_all() {
        Ok(f) => f,
        Err(e) => return actions::notify(app, &format!("Couldn't capture the screen: {e}")),
    };
    let t1 = t0.elapsed();
    if let Some(w) = windows { *state(app).windows.lock().unwrap() = w.join().unwrap_or_default(); }
    log::info!("picker: frames {t1:?}, windows {:?}", t0.elapsed() - t1);
    *state(app).frames.lock().unwrap() = frames;

    if mode == Mode::Screen {
        let cur = app.cursor_position().unwrap_or_default();
        let r = {
            let frames = state(app).frames.lock().unwrap();
            frames.iter().find(|f| (cur.x as i32) >= f.x && (cur.y as i32) >= f.y && (cur.x as i32) < f.x + f.image.width() as i32 && (cur.y as i32) < f.y + f.image.height() as i32)
                .or(frames.first()).map(|f| (f.x, f.y, f.image.width(), f.image.height()))
        };
        if let Some((x, y, width, height)) = r {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { actions::run(&app, Picked { action: "default".into(), x, y, width, height, windows: vec![], size: None, extra: vec![], layout: None }).await });
        }
        return;
    }

    if let Some(b) = builder { let _ = b.join(); }
    let monitors = app.available_monitors().unwrap_or_default();
    if pickers(app).len() != monitors.len() { warm(app); }
    let origins: Vec<(i32, i32)> = state(app).frames.lock().unwrap().iter().map(|f| (f.x, f.y)).collect();
    OPEN.store(true, SeqCst);
    SHOWN.store(false, SeqCst);
    let e = EPOCH.load(SeqCst);
    for (i, m) in monitors.iter().enumerate() {
        let pos = m.position();
        let frame = origins.iter().position(|&(x, y)| x == pos.x && y == pos.y).unwrap_or(i.min(origins.len().saturating_sub(1)));
        if let Some(w) = app.get_webview_window(&format!("picker-{e}-{i}")) {
            cover(&w, m);
            let mut r = READY.lock().unwrap();
            if r.0.iter().any(|l| l == w.label()) { send_frame(app, &w, frame); }
            else { r.1.retain(|(l, _)| l != w.label()); r.1.push((w.label().to_string(), frame)); }
        }
    }
    // Self-repair: a picker page that crashed or hung never shows. Throw the windows away and start once more.
    let (app, mode) = (app.clone(), mode);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(6));
        if OPEN.load(SeqCst) && !SHOWN.load(SeqCst) {
            log::warn!("picker didn't show in 6 s; rebuilding the picker windows");
            OPEN.store(false, SeqCst);
            drop_pickers(&app);
            if REPAIRS.fetch_add(1, SeqCst) == 0 { start(&app, mode); }
            else { REPAIRS.store(0, SeqCst); actions::notify(&app, "The capture screen didn't open. Try again; if it keeps happening, restart Grabbit."); }
        }
    });
}

/// Hands a loaded picker page its frame. On Windows the pixels go into memory shared with the page, together with
/// the picker details: no copying through the page's network stack, which took 0.2–0.5 s for a 4K screen.
fn send_frame(app: &AppHandle, w: &tauri::WebviewWindow, frame: usize) {
    #[cfg(windows)]
    {
        let (app2, label) = (app.clone(), w.label().to_string());
        let Some(info) = info(app, frame).and_then(|i| serde_json::to_string(&i).ok()) else { return };
        let sent = w.with_webview(move |pv| unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::*;
            use windows_core::Interface;
            let res = (|| -> windows_core::Result<()> {
                set_awake(&pv, true);
                let wv = pv.controller().CoreWebView2()?;
                let frames = state(&app2).frames.lock().unwrap();
                let Some(f) = frames.get(frame) else { return Ok(()) };
                let raw = f.image.as_raw();
                let buf = pv.environment().cast::<ICoreWebView2Environment12>()?.CreateSharedBuffer(raw.len() as u64)?;
                let mut p = std::ptr::null_mut();
                buf.Buffer(&mut p)?;
                std::ptr::copy_nonoverlapping(raw.as_ptr(), p, raw.len());
                drop(frames);
                wv.cast::<ICoreWebView2_17>()?.PostSharedBufferToScript(&buf, COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_WRITE, &windows_core::HSTRING::from(info))
            })();
            if let Err(e) = res { log::warn!("shared frame failed ({e}); sending it the slow way"); let _ = app2.emit_to(&label, "open", frame); }
        });
        if sent.is_ok() { return; }
    }
    awake(w, true);
    let _ = w.emit_to(w.label(), "open", frame);
}

/// A hidden picker tells WebView2 it's not on screen and may use little memory, so its processes give most of their
/// memory back while the page stays loaded; it's woken when the next frame arrives. (Hiding the window alone doesn't
/// do this: four hidden pickers held ~500 MB.)
fn awake(w: &tauri::WebviewWindow, on: bool) {
    #[cfg(windows)]
    let _ = w.with_webview(move |pv| set_awake(&pv, on));
    #[cfg(not(windows))]
    let _ = (w, on);
}

#[cfg(windows)]
fn set_awake(pv: &tauri::webview::PlatformWebview, on: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use windows_core::Interface;
    unsafe {
        let c = pv.controller();
        let _ = c.SetIsVisible(on);
        if let Ok(wv) = c.CoreWebView2().and_then(|w| w.cast::<ICoreWebView2_19>()) {
            let _ = wv.SetMemoryUsageTargetLevel(if on { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW });
        }
    }
}

/// The capture key held long enough: the picker that opened on the press becomes the recording picker. (It may still
/// be getting ready; it then opens in this mode.)
pub fn set_mode(app: &AppHandle, mode: Mode) {
    *MODE.lock().unwrap() = mode;
    let _ = app.emit("picker-mode", mode);
}

/// Shift+capture key: the same rectangle as last time, straight to the default action.
pub fn repeat_last(app: &AppHandle) {
    let Some((x, y, width, height)) = *state(app).last_rect.lock().unwrap() else { return start(app, Mode::Pick) };
    match capture::freeze_all() {
        Ok(f) => *state(app).frames.lock().unwrap() = f,
        Err(e) => return actions::notify(app, &format!("Couldn't capture the screen: {e}")),
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move { actions::run(&app, Picked { action: "default".into(), x, y, width, height, windows: vec![], size: None, extra: vec![], layout: None }).await });
}

/// The page has drawn its new frame: show it, and give the window under the mouse the keyboard.
#[tauri::command]
pub fn picker_shown(app: AppHandle, window: tauri::WebviewWindow) {
    if !OPEN.load(SeqCst) { return; }
    if !SHOWN.swap(true, SeqCst) { if let Some(t) = STARTED.lock().unwrap().take() { log::info!("picker shown after {:?}", t.elapsed()); } }
    REPAIRS.store(0, SeqCst);
    let _ = window.show();
    let cur = app.cursor_position().unwrap_or_default();
    if let (Ok(p), Ok(s)) = (window.outer_position(), window.outer_size()) {
        if cur.x as i32 >= p.x && (cur.x as i32) < p.x + s.width as i32 && cur.y as i32 >= p.y && (cur.y as i32) < p.y + s.height as i32 { let _ = window.set_focus(); }
    }
}

#[tauri::command]
pub fn picker_info(app: AppHandle, frame: usize) -> Option<PickerInfo> { info(&app, frame) }

fn info(app: &AppHandle, frame: usize) -> Option<PickerInfo> {
    let frames = state(app).frames.lock().unwrap();
    let f = frames.get(frame)?;
    Some(PickerInfo {
        frame, x: f.x, y: f.y, width: f.image.width(), height: f.image.height(),
        mode: *MODE.lock().unwrap(),
        windows: state(app).windows.lock().unwrap().clone(),
        last_rect: *state(app).last_rect.lock().unwrap(),
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
