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
    #[cfg(windows)]
    if keys.values().any(|k| k.contains("PrintScreen")) { take_print_screen_from_snipping_tool(); }
}

/// Windows 11 gives Print Screen to the Snipping Tool by default, through a keyboard hook: our RegisterHotKey still
/// succeeds, but every press opens the Snipping Tool instead. Turn that setting off (Settings → Accessibility →
/// Keyboard), and broadcast the change so it applies at once, no sign-out needed. An absent value means on.
#[cfg(windows)]
fn take_print_screen_from_snipping_tool() {
    use windows::{core::w, Win32::{Foundation::{LPARAM, WPARAM}, System::Registry::*, UI::WindowsAndMessaging::*}};
    let (key, name) = (w!("Control Panel\\Keyboard"), w!("PrintScreenKeyForSnippingEnabled"));
    unsafe {
        let (mut on, mut size) = (1u32, 4u32);
        let _ = RegGetValueW(HKEY_CURRENT_USER, key, name, RRF_RT_REG_DWORD, None, Some(&mut on as *mut u32 as *mut _), Some(&mut size));
        if on == 0 { return; }
        let off = 0u32;
        if RegSetKeyValueW(HKEY_CURRENT_USER, key, name, REG_DWORD.0, Some(&off as *const u32 as *const _), 4).is_err() {
            log::warn!("couldn't take Print Screen back from the Snipping Tool");
            return;
        }
        let _ = SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, WPARAM(0), LPARAM(w!("Policy").as_ptr() as isize), SMTO_ABORTIFHUNG, 2000, None);
        log::info!("turned off the Snipping Tool's Print Screen key so Grabbit gets it");
    }
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
        HotkeyAction::History => crate::history::open(app, None),
    }
}

/// The screens freeze as the key goes down, like a camera shutter, instead of when it comes back up (that waited for
/// the finger, ~0.1 s on every capture). Held on, the open picker shows a filling pill and then turns into the
/// recording picker.
fn tap_or_hold(app: &AppHandle, pressed: bool) {
    if !pressed {
        // Let go before the hold timer fired: the picker stays open for a screenshot.
        if DOWN.swap(false, Ordering::SeqCst) { let _ = app.emit(&picker::event("hold"), -1.0); }
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
            if ms >= HINT_AFTER_MS { let _ = app.emit(&picker::event("hold"), (ms - HINT_AFTER_MS) as f64 / (hold - HINT_AFTER_MS).max(1) as f64); }
            if ms >= hold {
                // Claim the press, so letting go doesn't undo it.
                if DOWN.swap(false, Ordering::SeqCst) { picker::set_mode(&app, picker::Mode::Record); }
                return;
            }
        }
    });
}
