// User settings: one JSON file in the OS config dir (%APPDATA%\Grabbit, ~/Library/Application Support/Grabbit, ~/.config/grabbit).
// Every field has a default, so older files keep loading and new fields appear with their defaults.

use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum AfterCapture { Ask, Copy, Edit }

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum SaveFormat { WebpLossless, Png }

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum HotkeyAction { Capture, CaptureScreen, CaptureRepeat, Record, ReplaySave, Steps }

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Branding {
    /// Logo / overlay image stamped on exports.
    pub logo_path: String,
    pub on_images: bool,
    pub on_videos: bool,
    /// "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center"
    pub position: String,
    /// Logo width as a fraction of the picture's width.
    pub scale: f32,
    pub opacity: f32,
    /// Invisible watermark carrying `owner` + the capture id, readable later with Check image.
    pub invisible_mark: bool,
    pub owner: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Metadata {
    /// Remove EXIF/XMP/GPS/software tags from everything that leaves the app (copy, share, save).
    pub strip: bool,
    pub author: String,
    pub copyright: String,
    /// Extra key → value pairs written as XMP (images) or container tags (video).
    pub custom: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Share {
    pub onedrive_token: String,     // refresh token from the device-code sign-in
    pub onedrive_folder: String,
    pub immich_url: String,
    pub immich_key: String,
    pub mega_email: String,
    pub mega_password: String,
    pub mega_folder: String,
    /// Empty = Grabbit's own Microsoft app registration.
    pub onedrive_client_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Ai {
    pub openai_key: String,
    pub xai_key: String,
    pub google_key: String,
    /// "openai" | "xai" | "google" — which provider the AI buttons use.
    pub provider: String,
    /// Optional OpenAI-compatible base URL (e.g. a local router). Empty = provider default.
    pub openai_base: String,
    /// Describe and tag every capture in the background (needs a key or a local model).
    pub auto_describe: bool,
    /// Empty = the provider's default image / chat model.
    pub image_model: String,
    pub chat_model: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Settings {
    pub after_capture: AfterCapture,
    pub auto_save: bool,
    pub save_format: SaveFormat,
    pub save_folder: String,
    pub copy_as_file: bool,
    pub reduced_long_edge: u32,
    pub chat_long_edge: u32,
    pub chat_max_kb: u32,
    pub hold_to_record_ms: u64,
    pub hotkeys: BTreeMap<HotkeyAction, String>,

    pub video_folder: String,
    pub record_fps: u32,
    pub record_quality: u32,
    pub record_cursor: bool,
    pub record_system_audio: bool,
    pub record_microphone: bool,
    pub record_webcam: bool,
    pub show_clicks: bool,
    pub show_keys: bool,
    pub copy_recording: bool,
    pub edit_after_recording: bool,
    pub ffmpeg_path: String,
    pub replay_seconds: u32,
    pub replay_enabled: bool,
    pub timelapse_seconds: u32,
    pub hide_desktop_icons: bool,

    pub branding: Branding,
    pub metadata: Metadata,
    pub share: Share,
    pub ai: Ai,
    pub obsidian_vault: String,
    pub obsidian_folder: String,
    pub index_text: bool,
}

pub fn default_hotkeys() -> BTreeMap<HotkeyAction, String> {
    use HotkeyAction::*;
    // macOS has no PrtScn key and keeps Cmd+Shift+3/4/5 for itself.
    let (cap, mods) = if cfg!(target_os = "macos") { ("CommandOrControl+Shift+2", "CommandOrControl+Shift") } else { ("PrintScreen", "Control+Alt") };
    BTreeMap::from([
        (Capture, cap.to_string()),
        (CaptureScreen, if cfg!(target_os = "macos") { format!("{mods}+1") } else { "Control+Shift+PrintScreen".into() }),
        (CaptureRepeat, if cfg!(target_os = "macos") { format!("{mods}+Alt+2") } else { "Shift+PrintScreen".into() }),
        (Record, if cfg!(target_os = "macos") { format!("{mods}+Alt+R") } else { format!("{mods}+PrintScreen") }),
        (ReplaySave, if cfg!(target_os = "macos") { format!("{mods}+Alt+B") } else { format!("{mods}+Shift+B") }),
        (Steps, if cfg!(target_os = "macos") { format!("{mods}+Alt+T") } else { format!("{mods}+Shift+T") }),
    ])
}

fn folder(base: Option<PathBuf>) -> String {
    base.unwrap_or_else(|| dirs::home_dir().unwrap_or_default()).join("Grabbit").to_string_lossy().into_owned()
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            after_capture: AfterCapture::Ask,
            auto_save: true,
            save_format: SaveFormat::WebpLossless,
            save_folder: folder(dirs::picture_dir()),
            copy_as_file: true,
            reduced_long_edge: 1920,
            chat_long_edge: 2560,
            chat_max_kb: 2048,
            hold_to_record_ms: 2000,
            hotkeys: default_hotkeys(),
            video_folder: folder(dirs::video_dir()),
            record_fps: 30,
            record_quality: 23,
            record_cursor: true,
            record_system_audio: true,
            record_microphone: true,
            record_webcam: false,
            show_clicks: false,
            show_keys: false,
            copy_recording: true,
            edit_after_recording: true,
            ffmpeg_path: String::new(),
            replay_seconds: 60,
            replay_enabled: false,
            timelapse_seconds: 10,
            hide_desktop_icons: false,
            branding: Branding { position: "bottom-right".into(), scale: 0.15, opacity: 0.8, ..Default::default() },
            metadata: Metadata { strip: true, ..Default::default() },
            share: Share::default(),
            ai: Ai { provider: "openai".into(), ..Default::default() },
            obsidian_vault: String::new(),
            obsidian_folder: "Grabbit".into(),
            index_text: true,
        }
    }
}

pub fn config_dir() -> PathBuf {
    if let Ok(d) = std::env::var("GRABBIT_CONFIG") { return d.into(); }
    dirs::config_dir().unwrap_or_default().join(if cfg!(target_os = "linux") { "grabbit" } else { "Grabbit" })
}

fn path() -> PathBuf { config_dir().join("settings.json") }

impl Settings {
    pub fn load() -> Self {
        let mut s: Settings = std::fs::read_to_string(path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        for (k, v) in default_hotkeys() { s.hotkeys.entry(k).or_insert(v); }
        s
    }

    pub fn save(&self) -> anyhow::Result<()> {
        std::fs::create_dir_all(config_dir())?;
        std::fs::write(path(), serde_json::to_string_pretty(self)?)?;
        Ok(())
    }
}

impl Settings {
    /// A copy without passwords, keys and tokens (for backups you might share or sync).
    pub fn without_secrets(&self) -> Self {
        let mut s = self.clone();
        s.share.onedrive_token.clear();
        s.share.immich_key.clear();
        s.share.mega_password.clear();
        s.ai.openai_key.clear();
        s.ai.xai_key.clear();
        s.ai.google_key.clear();
        s
    }

    /// Restore from a backup: anything the file leaves out keeps its default, and secrets the backup didn't include
    /// keep the values already set here.
    pub fn restored(&self, json: &str) -> anyhow::Result<Self> {
        let mut v: serde_json::Value = serde_json::from_str(json)?;
        if let Some(inner) = v.get("settings") { v = inner.clone(); }
        let mut s: Settings = serde_json::from_value(v)?;
        let keep = |new: &mut String, old: &str| if new.is_empty() { *new = old.to_string(); };
        keep(&mut s.share.onedrive_token, &self.share.onedrive_token);
        keep(&mut s.share.immich_key, &self.share.immich_key);
        keep(&mut s.share.mega_password, &self.share.mega_password);
        keep(&mut s.ai.openai_key, &self.ai.openai_key);
        keep(&mut s.ai.xai_key, &self.ai.xai_key);
        keep(&mut s.ai.google_key, &self.ai.google_key);
        for (k, v) in default_hotkeys() { s.hotkeys.entry(k).or_insert(v); }
        Ok(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_round_trip_keeps_secrets_out() {
        let mut s = Settings::default();
        s.ai.openai_key = "sk-secret".into();
        s.record_fps = 60;
        let backup = serde_json::to_string(&serde_json::json!({ "grabbit": 2, "settings": s.without_secrets() })).unwrap();
        assert!(!backup.contains("sk-secret"));
        let here = Settings { ai: Ai { openai_key: "sk-mine".into(), ..Default::default() }, ..Default::default() };
        let r = here.restored(&backup).unwrap();
        assert_eq!(r.record_fps, 60);
        assert_eq!(r.ai.openai_key, "sk-mine");
        // A partial file still loads, with defaults for the rest.
        let p = here.restored(r#"{ "record_fps": 30 }"#).unwrap();
        assert_eq!(p.chat_max_kb, 2048);
    }
}
