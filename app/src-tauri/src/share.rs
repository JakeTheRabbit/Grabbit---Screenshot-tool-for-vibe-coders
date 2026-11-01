// Share: upload a file, copy its link. OneDrive (Microsoft Graph, device-code sign-in), Immich (API key + shared
// link), MEGA (the official MEGAcmd tool), and Send to Obsidian (copy into the vault, link it in today's note).

use crate::{actions, export, settings::Settings, state};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
use tauri::AppHandle;

/// Grabbit's public Microsoft app registration (personal + work accounts, Files.ReadWrite). Overridable in settings.
pub const ONEDRIVE_CLIENT_ID: &str = "PENDING-REGISTRATION";

fn http() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder().timeout(Duration::from_secs(600)).user_agent("Grabbit").build().unwrap()
}

pub fn configured(s: &Settings) -> Vec<&'static str> {
    let sh = &s.share;
    let mut v = Vec::new();
    if !sh.onedrive_token.is_empty() { v.push("onedrive"); }
    if !sh.immich_url.is_empty() && !sh.immich_key.is_empty() { v.push("immich"); }
    if !sh.mega_email.is_empty() && !sh.mega_password.is_empty() { v.push("mega"); }
    if !s.obsidian_vault.is_empty() { v.push("obsidian"); }
    v
}

/// Upload with the given destination (or the first one set up) and copy the link.
pub fn share(app: &AppHandle, path: &Path, target: Option<&str>) -> Result<String> {
    let s = state(app).settings.lock().unwrap().clone();
    let t = match target { Some(t) => t.to_string(), None => configured(&s).first().map(|t| t.to_string()).context("Set up a place to share to in Settings → Sharing")? };
    let link = match t.as_str() {
        "onedrive" => onedrive_upload(app, &s, path)?,
        "immich" => immich_upload(&s, path)?,
        "mega" => mega_upload(&s, path)?,
        "obsidian" => return obsidian_send(&s, path).map(|p| format!("Saved to Obsidian: {}", p.display())),
        other => bail!("unknown share destination {other}"),
    };
    export::copy_text(&link)?;
    Ok(link)
}

pub fn share_path(app: &AppHandle, p: &Path) -> Result<()> {
    let link = share(app, p, None)?;
    actions::notify(app, &format!("Link copied: {link}"));
    Ok(())
}

// ---- OneDrive ----

fn client_id(s: &Settings) -> &str { if s.share.onedrive_client_id.is_empty() { ONEDRIVE_CLIENT_ID } else { &s.share.onedrive_client_id } }

const AUTH: &str = "https://login.microsoftonline.com/common/oauth2/v2.0";
const SCOPE: &str = "Files.ReadWrite offline_access User.Read";

/// Device-code sign-in: open the Microsoft page, put the code on the clipboard, wait for the user to finish.
fn onedrive_sign_in(app: &AppHandle) -> Result<String> {
    let s = state(app).settings.lock().unwrap().clone();
    let c = http();
    let dc: Value = c.post(format!("{AUTH}/devicecode")).form(&[("client_id", client_id(&s)), ("scope", SCOPE)]).send()?.json()?;
    let code = dc["user_code"].as_str().with_context(|| format!("Microsoft sign-in failed: {}", dc["error_description"].as_str().unwrap_or("no code")))?;
    let device = dc["device_code"].as_str().unwrap_or_default().to_string();
    export::copy_text(code)?;
    let _ = tauri_plugin_opener::open_url(dc["verification_uri"].as_str().unwrap_or("https://microsoft.com/devicelogin"), None::<&str>);
    actions::notify(app, &format!("Paste the code {code} (it's on your clipboard) on the Microsoft page"));
    let interval = dc["interval"].as_u64().unwrap_or(5);
    let deadline = std::time::Instant::now() + Duration::from_secs(dc["expires_in"].as_u64().unwrap_or(900));
    while std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_secs(interval));
        let t: Value = c.post(format!("{AUTH}/token")).form(&[
            ("client_id", client_id(&s)), ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"), ("device_code", &device),
        ]).send()?.json()?;
        if let Some(rt) = t["refresh_token"].as_str() {
            let mut g = state(app).settings.lock().unwrap();
            g.share.onedrive_token = rt.to_string();
            g.save()?;
            return Ok("Signed in to OneDrive".into());
        }
        match t["error"].as_str() {
            Some("authorization_pending") | Some("slow_down") => continue,
            Some(e) => bail!("OneDrive sign-in: {}", t["error_description"].as_str().unwrap_or(e)),
            None => bail!("OneDrive sign-in: unexpected answer"),
        }
    }
    bail!("OneDrive sign-in timed out")
}

/// A fresh access token from the stored refresh token (the new refresh token is kept).
fn onedrive_token(app: &AppHandle, s: &Settings) -> Result<String> {
    if s.share.onedrive_token.is_empty() { bail!("Sign in to OneDrive in Settings → Sharing first") }
    let t: Value = http().post(format!("{AUTH}/token")).form(&[
        ("client_id", client_id(s)), ("grant_type", "refresh_token"), ("refresh_token", &s.share.onedrive_token), ("scope", SCOPE),
    ]).send()?.json()?;
    let access = t["access_token"].as_str().with_context(|| format!("OneDrive: {} — sign in again in Settings", t["error_description"].as_str().unwrap_or("token refused")))?;
    if let Some(rt) = t["refresh_token"].as_str() {
        let mut g = state(app).settings.lock().unwrap();
        g.share.onedrive_token = rt.to_string();
        let _ = g.save();
    }
    Ok(access.to_string())
}

fn onedrive_upload(app: &AppHandle, s: &Settings, path: &Path) -> Result<String> {
    let token = onedrive_token(app, s)?;
    let c = http();
    let folder = if s.share.onedrive_folder.is_empty() { "Grabbit" } else { s.share.onedrive_folder.trim_matches('/') };
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let enc = |t: &str| t.split('/').map(actions::urlencode).collect::<Vec<_>>().join("/");
    let target = format!("https://graph.microsoft.com/v1.0/me/drive/root:/{}/{}", enc(folder), enc(&name));
    let size = std::fs::metadata(path)?.len();
    // Upload session for everything: one code path, works for big videos, 10 MiB chunks (multiple of 320 KiB).
    let sess: Value = c.post(format!("{target}:/createUploadSession")).bearer_auth(&token)
        .json(&json!({ "item": { "@microsoft.graph.conflictBehavior": "rename" } })).send()?.json()?;
    let url = sess["uploadUrl"].as_str().with_context(|| format!("OneDrive: {}", sess["error"]["message"].as_str().unwrap_or("couldn't start the upload")))?.to_string();
    let mut f = std::fs::File::open(path)?;
    const CHUNK: u64 = 32 * 320 * 1024;
    let mut off = 0u64;
    let mut item = Value::Null;
    while off < size {
        let n = CHUNK.min(size - off);
        let mut buf = vec![0u8; n as usize];
        std::io::Read::read_exact(&mut f, &mut buf)?;
        let r = c.put(&url).header("Content-Range", format!("bytes {off}-{}/{size}", off + n - 1)).header("Content-Length", n).body(buf).send()?;
        if !r.status().is_success() { bail!("OneDrive upload failed: {}", r.text().unwrap_or_default()) }
        item = r.json().unwrap_or(Value::Null);
        off += n;
    }
    let id = item["id"].as_str().context("OneDrive didn't return the file")?;
    for scope in ["anonymous", "organization"] {
        let l: Value = c.post(format!("https://graph.microsoft.com/v1.0/me/drive/items/{id}/createLink")).bearer_auth(&token)
            .json(&json!({ "type": "view", "scope": scope })).send()?.json()?;
        if let Some(u) = l["link"]["webUrl"].as_str() { return Ok(u.to_string()); }
    }
    bail!("Uploaded to OneDrive, but sharing links are turned off for this account")
}

// ---- Immich ----

fn immich_upload(s: &Settings, path: &Path) -> Result<String> {
    let base = s.share.immich_url.trim_end_matches('/');
    let c = http();
    let meta = std::fs::metadata(path)?;
    let when = chrono::DateTime::<chrono::Utc>::from(meta.modified().unwrap_or(std::time::SystemTime::now())).to_rfc3339();
    let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let form = reqwest::blocking::multipart::Form::new()
        .text("deviceAssetId", format!("grabbit-{name}-{}", meta.len()))
        .text("deviceId", "grabbit")
        .text("fileCreatedAt", when.clone())
        .text("fileModifiedAt", when)
        .file("assetData", path)?;
    let r = c.post(format!("{base}/api/assets")).header("x-api-key", &s.share.immich_key).header("Accept", "application/json").multipart(form).send()?;
    let status = r.status();
    let a: Value = r.json().unwrap_or(Value::Null);
    let id = a["id"].as_str().with_context(|| format!("Immich upload failed ({status}): {}", a["message"].as_str().unwrap_or("check the server address and API key")))?;
    let l: Value = c.post(format!("{base}/api/shared-links")).header("x-api-key", &s.share.immich_key)
        .json(&json!({ "type": "INDIVIDUAL", "assetIds": [id], "allowDownload": true, "showMetadata": false })).send()?.json()?;
    let key = l["key"].as_str().with_context(|| format!("Immich: couldn't make a link: {}", l["message"].as_str().unwrap_or("API key needs the sharedLink.create permission")))?;
    Ok(format!("{base}/share/{key}"))
}

fn immich_test(s: &Settings) -> Result<String> {
    let base = s.share.immich_url.trim_end_matches('/');
    let r: Value = http().get(format!("{base}/api/users/me")).header("x-api-key", &s.share.immich_key).send()?.json()?;
    match r["email"].as_str() { Some(e) => Ok(format!("Connected as {e}")), None => bail!("Immich: {}", r["message"].as_str().unwrap_or("not reachable")) }
}

// ---- MEGA (MEGAcmd) ----

fn mega_tool(name: &str) -> Result<PathBuf> {
    let file = if cfg!(windows) { format!("{name}.bat") } else { name.to_string() };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if let Some(l) = dirs::data_local_dir() { dirs.push(l.join("MEGAcmd")); }
    dirs.push("/Applications/MEGAcmd.app/Contents/MacOS".into());
    dirs.push("/usr/bin".into());
    dirs.into_iter().map(|d| d.join(&file)).find(|p| p.exists()).context(if cfg!(target_os = "macos") { "MEGA sharing needs MEGAcmd: brew install --cask megacmd" } else if cfg!(windows) { "MEGA sharing needs MEGAcmd: winget install Mega.MEGAcmd" } else { "MEGA sharing needs MEGAcmd from mega.io/cmd" })
}

fn mega(args: &[&str]) -> Result<String> {
    let tool = mega_tool(args[0])?;
    let mut c = Command::new(tool);
    crate::video::hide(&mut c);
    let o = c.args(&args[1..]).output()?;
    let out = String::from_utf8_lossy(&o.stdout).into_owned() + &String::from_utf8_lossy(&o.stderr);
    if !o.status.success() { bail!("MEGA: {}", out.trim()) }
    Ok(out)
}

fn mega_login(s: &Settings) -> Result<()> {
    let who = mega(&["mega-whoami"]).unwrap_or_default();
    if who.contains(&s.share.mega_email) { return Ok(()); }
    let _ = mega(&["mega-logout"]);
    mega(&["mega-login", &s.share.mega_email, &s.share.mega_password]).map(|_| ())
}

fn mega_upload(s: &Settings, path: &Path) -> Result<String> {
    mega_login(s)?;
    let folder = format!("/{}", if s.share.mega_folder.is_empty() { "Grabbit" } else { s.share.mega_folder.trim_matches('/') });
    let local = path.to_string_lossy();
    mega(&["mega-put", "-c", &local, &format!("{folder}/")])?;
    let remote = format!("{folder}/{}", path.file_name().unwrap_or_default().to_string_lossy());
    let out = mega(&["mega-export", "-a", "-f", &remote])?;
    out.split_whitespace().find(|w| w.starts_with("https://mega.")).map(String::from).context("MEGA didn't return a link")
}

// ---- Obsidian ----

/// Copy into <vault>/<folder>/ and add an embed to today's daily note (using the vault's daily-note settings).
pub fn obsidian_send(s: &Settings, path: &Path) -> Result<PathBuf> {
    let vault = PathBuf::from(&s.obsidian_vault);
    if !vault.join(".obsidian").exists() { bail!("Pick your Obsidian vault in Settings → Obsidian") }
    let dir = vault.join(if s.obsidian_folder.is_empty() { "Grabbit" } else { &s.obsidian_folder });
    std::fs::create_dir_all(&dir)?;
    let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let dest = dir.join(&name);
    std::fs::copy(path, &dest)?;
    let cfg: Value = std::fs::read_to_string(vault.join(".obsidian").join("daily-notes.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    let fmt = cfg["format"].as_str().filter(|f| !f.is_empty()).unwrap_or("YYYY-MM-DD");
    let now = chrono::Local::now();
    let note_name = fmt.replace("YYYY", &now.format("%Y").to_string()).replace("MM", &now.format("%m").to_string()).replace("DD", &now.format("%d").to_string());
    let note = vault.join(cfg["folder"].as_str().unwrap_or("")).join(format!("{note_name}.md"));
    if let Some(p) = note.parent() { std::fs::create_dir_all(p)?; }
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&note)?;
    writeln!(f, "\n![[{name}]]")?;
    Ok(dest)
}

#[tauri::command]
pub async fn share_setup(app: AppHandle, target: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = state(&app).settings.lock().unwrap().clone();
        match target.as_str() {
            "onedrive" => onedrive_sign_in(&app),
            "immich" => immich_test(&s),
            "mega" => mega_login(&s).map(|_| "Signed in to MEGA".to_string()),
            t => Err(anyhow::anyhow!("unknown {t}")),
        }
    }).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn share_file(app: AppHandle, path: String, target: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || share(&app, Path::new(&path), target.as_deref())).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn share_targets(app: AppHandle) -> Vec<&'static str> { configured(&state(&app).settings.lock().unwrap()) }
