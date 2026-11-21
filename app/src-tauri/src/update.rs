// Updates: look for a new version at start and twice a day, download it quietly, and offer a restart from the
// tray. The release's latest.json is signed with the project's updater key, so only real releases install.

use std::sync::{Mutex, OnceLock};
use tauri::{menu::MenuItem, AppHandle, Wry};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{actions::notify, state};

const RELEASES: &str = "https://github.com/JakeTheRabbit/Grabbit---Screenshot-tool-for-vibe-coders/releases/latest";

/// The tray's update item: "Check for updates", or "Restart to update to x" once one is downloaded.
pub static ITEM: OnceLock<MenuItem<Wry>> = OnceLock::new();
static READY: Mutex<Option<(Update, Vec<u8>)>> = Mutex::new(None);
static BUSY: Mutex<bool> = Mutex::new(false);

/// deb and rpm installs belong to the package manager; only the AppImage can replace itself on Linux.
fn can_install() -> bool { !cfg!(target_os = "linux") || std::env::var_os("APPIMAGE").is_some() }

pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        loop {
            if state(&app).settings.lock().unwrap().auto_update { check(&app, false).await; }
            tokio::time::sleep(std::time::Duration::from_secs(12 * 3600)).await;
        }
    });
}

/// The tray item: restart into a downloaded update, or look for one now.
pub fn tray_click(app: &AppHandle) {
    let ready = READY.lock().unwrap().take();
    if let Some((u, bytes)) = ready {
        log::info!("installing Grabbit {}", u.version);
        if let Err(e) = u.install(bytes) { notify(app, &format!("Couldn't install the update: {e}")); return; }
        app.restart();
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move { check(&app, true).await });
}

async fn check(app: &AppHandle, asked: bool) {
    if READY.lock().unwrap().is_some() { return; }
    { let mut b = BUSY.lock().unwrap(); if *b { return; } *b = true; }
    let r = find(app, asked).await;
    *BUSY.lock().unwrap() = false;
    if let Err(e) = r {
        log::warn!("update check: {e}");
        if asked { notify(app, &format!("Couldn't check for updates: {e}")); }
    }
}

async fn find(app: &AppHandle, asked: bool) -> anyhow::Result<()> {
    let Some(u) = app.updater()?.check().await? else {
        if asked { notify(app, &format!("Grabbit {} is the latest version", app.package_info().version)); }
        return Ok(());
    };
    log::info!("Grabbit {} is out", u.version);
    if !can_install() {
        notify(app, &format!("Grabbit {} is out. Get it from the Releases page.", u.version));
        let _ = tauri_plugin_opener::open_url(RELEASES, None::<&str>);
        return Ok(());
    }
    if asked { notify(app, &format!("Downloading Grabbit {}…", u.version)); }
    let bytes = u.download(|_, _| {}, || {}).await?;
    let v = u.version.clone();
    *READY.lock().unwrap() = Some((u, bytes));
    if let Some(i) = ITEM.get() { let _ = i.set_text(format!("Restart to update to {v}")); }
    notify(app, &format!("Grabbit {v} is ready. Restart to update from the tray menu."));
    Ok(())
}
