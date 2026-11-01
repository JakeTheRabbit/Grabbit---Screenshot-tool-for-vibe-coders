// Global keys. The capture key is tap-or-hold: let go quickly → screenshot; keep holding → a pill fills up near the
// mouse, and at `hold_to_record_ms` a recording starts. While recording, the same key stops it.

use crate::{picker, settings::HotkeyAction, state};
use std::{
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

static DOWN: AtomicBool = AtomicBool::new(false);
/// Bumped on every press so a stale hold timer can tell it's been superseded.
static PRESS: AtomicU64 = AtomicU64::new(0);
const HINT_AFTER_MS: u64 = 300;

pub fn register_all(app: &AppHandle) {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let keys = state(app).settings.lock().unwrap().hotkeys.clone();
    let mut taken = Vec::new();
    for (_, key) in keys.iter().filter(|(_, k)| !k.is_empty()) {
        if gs.register(key.as_str()).is_err() { taken.push(key.clone()); }
    }
    if !taken.is_empty() { log::warn!("hotkeys already taken by another app: {}", taken.join(", ")); }
}

fn action_for(app: &AppHandle, sc: &Shortcut) -> Option<HotkeyAction> {
    let keys = state(app).settings.lock().unwrap().hotkeys.clone();
    keys.into_iter().find(|(_, k)| k.parse::<Shortcut>().map(|p| p.id() == sc.id()).unwrap_or(false)).map(|(a, _)| a)
}

pub fn on_event(app: &AppHandle, sc: &Shortcut, ev: ShortcutEvent) {
    let Some(action) = action_for(app, sc) else { return };
    let pressed = ev.state() == ShortcutState::Pressed;
    match action {
        HotkeyAction::Capture => tap_or_hold(app, pressed),
        _ if !pressed => {}
        HotkeyAction::CaptureScreen => picker::start(app, picker::Mode::Screen),
        HotkeyAction::CaptureRepeat => picker::repeat_last(app),
        HotkeyAction::Record => picker::start(app, picker::Mode::Record),
        HotkeyAction::ReplaySave => crate::replay::save_now(app),
        HotkeyAction::Steps => crate::steps::toggle(app),
    }
}

fn tap_or_hold(app: &AppHandle, pressed: bool) {
    if !pressed {
        // Released: a tap if the hold timer hasn't fired yet.
        if DOWN.swap(false, Ordering::SeqCst) { close_hint(app); picker::start(app, picker::Mode::Pick); }
        return;
    }
    if DOWN.swap(true, Ordering::SeqCst) { return; }   // key auto-repeat
    let hold = state(app).settings.lock().unwrap().hold_to_record_ms;
    if hold == 0 { DOWN.store(false, Ordering::SeqCst); picker::start(app, picker::Mode::Pick); return; }
    let me = PRESS.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        let t0 = Instant::now();
        let mut shown = false;
        loop {
            std::thread::sleep(Duration::from_millis(25));
            if !DOWN.load(Ordering::SeqCst) || PRESS.load(Ordering::SeqCst) != me { return; }
            let ms = t0.elapsed().as_millis() as u64;
            if ms >= HINT_AFTER_MS {
                if !shown { show_hint(&app); shown = true; }
                let _ = app.emit_to("hint", "progress", (ms - HINT_AFTER_MS) as f64 / (hold - HINT_AFTER_MS).max(1) as f64);
            }
            if ms >= hold {
                // Claim the press so the release doesn't also take a screenshot.
                if DOWN.swap(false, Ordering::SeqCst) {
                    close_hint(&app);
                    let a = app.clone();
                    let _ = std::thread::spawn(move || picker::start(&a, picker::Mode::Record));
                }
                return;
            }
        }
    });
}

fn show_hint(app: &AppHandle) {
    let a = app.clone();
    let _ = std::thread::spawn(move || {
        let pos = a.cursor_position().unwrap_or_default();
        let _ = WebviewWindowBuilder::new(&a, "hint", WebviewUrl::App("hint.html".into()))
            .decorations(false).transparent(true).shadow(false).always_on_top(true).skip_taskbar(true)
            .focused(false).resizable(false).inner_size(240.0, 56.0)
            .position(pos.x / a.primary_monitor().ok().flatten().map(|m| m.scale_factor()).unwrap_or(1.0) + 18.0,
                      pos.y / a.primary_monitor().ok().flatten().map(|m| m.scale_factor()).unwrap_or(1.0) + 22.0)
            .build()
            .map(|w| { let _ = w.set_ignore_cursor_events(true); });
    });
}

fn close_hint(app: &AppHandle) {
    let a = app.clone();
    let _ = std::thread::spawn(move || { if let Some(w) = a.get_webview_window("hint") { let _ = w.close(); } });
}
