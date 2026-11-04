// Global keys. The capture key is tap-or-hold: pressing it opens the picker at once; keep holding → a pill fills up
// in the picker, and at `hold_to_record_ms` it becomes the recording picker. While recording, the same key stops it.

use crate::{picker, settings::HotkeyAction, state};
use std::{
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
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

/// The screens freeze as the key goes down, like a camera shutter, instead of when it comes back up (that waited for
/// the finger, ~0.1 s on every capture). Held on, the open picker shows a filling pill and then turns into the
/// recording picker.
fn tap_or_hold(app: &AppHandle, pressed: bool) {
    if !pressed {
        // Let go before the hold timer fired: the picker stays open for a screenshot.
        if DOWN.swap(false, Ordering::SeqCst) { let _ = app.emit("hold", -1.0); }
        return;
    }
    if DOWN.swap(true, Ordering::SeqCst) { return; }   // key auto-repeat
    // While recording the key stops it, and that's all it does.
    if crate::record::is_recording(app) { DOWN.store(false, Ordering::SeqCst); picker::start(app, picker::Mode::Pick); return; }
    picker::start(app, picker::Mode::Pick);
    let hold = state(app).settings.lock().unwrap().hold_to_record_ms;
    if hold == 0 { DOWN.store(false, Ordering::SeqCst); return; }
    let me = PRESS.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        let t0 = Instant::now();
        loop {
            std::thread::sleep(Duration::from_millis(25));
            if !DOWN.load(Ordering::SeqCst) || PRESS.load(Ordering::SeqCst) != me { return; }
            let ms = t0.elapsed().as_millis() as u64;
            if ms >= HINT_AFTER_MS { let _ = app.emit("hold", (ms - HINT_AFTER_MS) as f64 / (hold - HINT_AFTER_MS).max(1) as f64); }
            if ms >= hold {
                // Claim the press, so letting go doesn't undo it.
                if DOWN.swap(false, Ordering::SeqCst) { picker::set_mode(&app, picker::Mode::Record); }
                return;
            }
        }
    });
}
