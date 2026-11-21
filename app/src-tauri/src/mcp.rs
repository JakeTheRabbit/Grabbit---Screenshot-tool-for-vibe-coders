// `grabbit --mcp`: an MCP server on stdin/stdout, so coding agents (Claude Code, Codex, Cursor, T3 Code…) can find
// every capture and recording by what's in it, look at one, and take a screenshot themselves. Runs without the tray
// app or any window; it reads the same history and settings files.

use crate::{capture, export, history, ocr, Settings};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use image::RgbaImage;
use serde_json::{json, Value};
use std::io::{BufRead, Write};

const MAX_EDGE: u32 = 1568;

pub fn run() -> i32 {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() { continue; }
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            let _ = send(&mut out, json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "parse error" } }));
            continue;
        };
        // Notifications (no id) need no answer.
        let Some(id) = msg.get("id").cloned() else { continue };
        let method = msg["method"].as_str().unwrap_or("");
        let reply = match method {
            "initialize" => Ok(json!({
                "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "grabbit", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "Grabbit keeps every screenshot and screen recording the user takes, with the text read from it, the apps and windows it showed, where it was pasted, tags, notes and recording transcripts. Use search_captures to find one (newest first), get_capture to see it, and take_screenshot to look at the screen now."
            })),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": tools() })),
            "tools/call" => Ok(call(msg["params"]["name"].as_str().unwrap_or(""), &msg["params"]["arguments"])),
            _ => Err(json!({ "code": -32601, "message": format!("unknown method {method}") })),
        };
        let body = match reply { Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }), Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": e }) };
        if send(&mut out, body).is_err() { break; }
    }
    0
}

fn send(out: &mut std::io::Stdout, v: Value) -> std::io::Result<()> {
    writeln!(out, "{v}")?;
    out.flush()
}

fn tools() -> Value {
    json!([
        {
            "name": "search_captures",
            "description": "Find the user's screenshots and screen recordings, newest first. Every word of `query` must appear in the capture's text (read from the picture, or said in a recording), the apps or window titles it showed, its file name, tags, note or AI description. Leave `query` empty for the latest ones.",
            "inputSchema": { "type": "object", "properties": {
                "query": { "type": "string", "description": "Words to look for, e.g. 'TypeError checkout'." },
                "kind": { "type": "string", "enum": ["capture", "recording"], "description": "Only screenshots, or only recordings." },
                "since": { "type": "string", "description": "Only captures on or after this date (YYYY-MM-DD)." },
                "starred": { "type": "boolean", "description": "Only starred captures." },
                "limit": { "type": "integer", "description": "How many to return (default 20, at most 100)." }
            } },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "get_capture",
            "description": "Look at one capture from search_captures: the picture itself (scaled to fit), all the text read from it, and its details. For a recording: the transcript with times and a few stills.",
            "inputSchema": { "type": "object", "required": ["path"], "properties": {
                "path": { "type": "string", "description": "The capture's path, as search_captures gave it." },
                "image": { "type": "boolean", "description": "Include the picture (default true)." }
            } },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "take_screenshot",
            "description": "Take a screenshot now, of every screen, one screen, or one window (even if something covers it). It is saved in the user's Grabbit folder and History, and returned with the text read from it.",
            "inputSchema": { "type": "object", "properties": {
                "window": { "type": "string", "description": "Part of a window's title, e.g. 'localhost:5173' or 'Visual Studio Code'. Use list_windows to see them." },
                "screen": { "type": "integer", "description": "Only this screen (0 is the first)." }
            } }
        },
        {
            "name": "list_windows",
            "description": "The windows open on screen, front-most first, for take_screenshot.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true }
        }
    ])
}

/// Settings → Coding agents: register `grabbit --mcp` with Claude Code or Codex (T3 Code runs both, so its threads get
/// it too), or copy the setup for anything else.
#[tauri::command]
pub fn connect_agent(agent: String) -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?.to_string_lossy().into_owned();
    match agent.as_str() {
        "claude" => {
            let claude = |args: &[&str]| {
                let mut c = std::process::Command::new(if cfg!(windows) { "cmd" } else { "claude" });
                if cfg!(windows) { c.args(["/C", "claude"]); }
                #[cfg(windows)]
                { use std::os::windows::process::CommandExt; c.creation_flags(0x0800_0000); }
                c.args(args).output()
            };
            let _ = claude(&["mcp", "remove", "--scope", "user", "grabbit"]);
            let o = claude(&["mcp", "add", "--scope", "user", "grabbit", "--", &exe, "--mcp"]).map_err(|_| "Claude Code isn't installed (the claude command wasn't found)".to_string())?;
            if !o.status.success() { return Err(format!("claude mcp add failed: {}", String::from_utf8_lossy(&o.stderr).trim())); }
            Ok("Added to Claude Code. New Claude Code sessions (in a terminal, the app or T3 Code) can now search your captures.".into())
        }
        "codex" => {
            let dir = dirs::home_dir().ok_or("no home folder")?.join(".codex");
            let file = dir.join("config.toml");
            let cur = std::fs::read_to_string(&file).unwrap_or_default();
            if cur.contains("[mcp_servers.grabbit]") { return Ok("Codex already has Grabbit.".into()); }
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let block = format!("\n[mcp_servers.grabbit]\ncommand = {}\nargs = [\"--mcp\"]\n", toml_str(&exe));
            std::fs::write(&file, format!("{}{block}", cur.trim_end_matches('\n'))).map_err(|e| e.to_string())?;
            Ok("Added to Codex. New Codex sessions (in a terminal, the app or T3 Code) can now search your captures.".into())
        }
        _ => {
            let cfg = json!({ "mcpServers": { "grabbit": { "command": exe, "args": ["--mcp"] } } });
            export::copy_text(&serde_json::to_string_pretty(&cfg).unwrap_or_default()).map_err(|e| e.to_string())?;
            Ok("Copied the MCP setup (JSON). Paste it into Cursor's mcp.json or any other agent's MCP settings.".into())
        }
    }
}

fn toml_str(s: &str) -> String { format!("'{s}'") }

fn call(name: &str, args: &Value) -> Value {
    let r = match name {
        "search_captures" => search(args),
        "get_capture" => get(args),
        "take_screenshot" => shoot(args),
        "list_windows" => Ok(vec![text(serde_json::to_string_pretty(&windows().iter().map(|w| json!({ "title": w.title, "width": w.width, "height": w.height })).collect::<Vec<_>>()).unwrap_or_default())]),
        _ => Err(anyhow::anyhow!("unknown tool {name}")),
    };
    match r {
        Ok(content) => json!({ "content": content }),
        Err(e) => json!({ "content": [text(format!("{e:#}"))], "isError": true }),
    }
}

/// Titled windows only: Grabbit's own hidden windows (and other untitled ones) are no use to an agent.
fn windows() -> Vec<capture::WinInfo> {
    capture::windows().into_iter().filter(|w| !w.title.trim().is_empty() && w.title != "Tauri App").collect()
}

fn text(t: impl Into<String>) -> Value { json!({ "type": "text", "text": t.into() }) }

fn picture(img: &RgbaImage) -> anyhow::Result<Value> {
    let jpg = export::chat_jpeg(img, MAX_EDGE, 900)?;
    Ok(json!({ "type": "image", "data": B64.encode(jpg), "mimeType": "image/jpeg" }))
}

fn kind(e: &history::Entry) -> &str { if e.kind.is_empty() { "capture" } else { &e.kind } }

fn summary(e: &history::Entry, text_chars: usize) -> Value {
    let mut t: String = e.text.chars().take(text_chars).collect();
    if e.text.chars().count() > text_chars { t.push('…'); }
    json!({
        "path": e.path, "kind": kind(e), "time": e.time, "width": e.width, "height": e.height,
        "apps": e.apps, "windows": e.windows,
        "pasted_into": e.pasted.iter().map(|p| format!("{} ({})", p.app, p.title)).collect::<Vec<_>>(),
        "starred": e.starred, "tags": e.tags, "note": e.note, "description": e.description,
        "notes_folder": e.notes, "text": t,
    })
}

fn search(a: &Value) -> anyhow::Result<Vec<Value>> {
    let q = a["query"].as_str().unwrap_or("");
    let limit = a["limit"].as_u64().unwrap_or(20).clamp(1, 100) as usize;
    let since = a["since"].as_str().unwrap_or("");
    let found: Vec<Value> = history::search(q).iter()
        .filter(|e| a["kind"].as_str().is_none_or(|k| kind(e) == k))
        .filter(|e| since.is_empty() || e.time.as_str() >= since)
        .filter(|e| !a["starred"].as_bool().unwrap_or(false) || e.starred)
        .take(limit).map(|e| summary(e, 300)).collect();
    if found.is_empty() { return Ok(vec![text(if q.is_empty() { "No captures yet.".to_string() } else { format!("No captures match '{q}'.") })]); }
    Ok(vec![text(serde_json::to_string_pretty(&found)?)])
}

fn get(a: &Value) -> anyhow::Result<Vec<Value>> {
    let path = a["path"].as_str().unwrap_or("");
    // Only files Grabbit recorded in its history can be read, not any path an agent makes up.
    let e = history::all().into_iter().rev().find(|e| e.path == path).ok_or_else(|| anyhow::anyhow!("Not in Grabbit's history: {path}"))?;
    let mut out = vec![text(serde_json::to_string_pretty(&summary(&e, usize::MAX))?)];
    let want_image = a["image"].as_bool().unwrap_or(true);
    if kind(&e) == "recording" {
        if !e.notes.is_empty() {
            let dir = std::path::Path::new(&e.notes);
            if let Ok(t) = std::fs::read_to_string(dir.join("transcript.md")) { out.push(text(t)); }
            if want_image {
                let mut stills: Vec<_> = std::fs::read_dir(dir).into_iter().flatten().flatten().map(|f| f.path())
                    .filter(|p| p.extension().is_some_and(|x| ["jpg", "jpeg", "png", "webp"].contains(&x.to_string_lossy().to_lowercase().as_str()))).collect();
                stills.sort();
                let step = (stills.len() / 4).max(1);
                for p in stills.iter().step_by(step).take(4) { if let Ok(i) = image::open(p) { out.push(picture(&i.to_rgba8())?); } }
            }
        } else {
            out.push(text("This recording has no notes folder (transcript and stills). Turn on Settings → Recording → notes for new recordings."));
        }
    } else if want_image {
        out.push(picture(&image::open(&e.path)?.to_rgba8())?);
    }
    Ok(out)
}

fn shoot(a: &Value) -> anyhow::Result<Vec<Value>> {
    let img = if let Some(t) = a["window"].as_str().filter(|t| !t.is_empty()) {
        let t = t.to_lowercase();
        let w = windows().into_iter().find(|w| w.title.to_lowercase().contains(&t)).ok_or_else(|| anyhow::anyhow!("No open window has '{t}' in its title. Try list_windows."))?;
        capture::capture_window(w.id)?
    } else {
        let frames = capture::freeze_all()?;
        match a["screen"].as_u64() {
            Some(i) => frames.into_iter().nth(i as usize).ok_or_else(|| anyhow::anyhow!("There is no screen {i}"))?.image,
            None => {
                let x0 = frames.iter().map(|f| f.x).min().unwrap_or(0);
                let y0 = frames.iter().map(|f| f.y).min().unwrap_or(0);
                let x1 = frames.iter().map(|f| f.x + f.image.width() as i32).max().unwrap_or(1);
                let y1 = frames.iter().map(|f| f.y + f.image.height() as i32).max().unwrap_or(1);
                capture::crop(&frames, x0, y0, (x1 - x0) as u32, (y1 - y0) as u32)
            }
        }
    };
    let s = Settings::load();
    let path = export::save_full(&s, &img, &export::stamp_name("Grabbit agent"))?;
    let words = tauri::async_runtime::block_on(ocr::recognize(&img)).unwrap_or_default();
    history::add_entry(history::Entry {
        path: path.to_string_lossy().into_owned(), time: chrono::Local::now().to_rfc3339(), width: img.width(), height: img.height(),
        text: words.clone(), kind: "capture".into(), tags: vec!["agent".into()], ..Default::default()
    });
    Ok(vec![text(format!("Saved {}\n\nText on screen:\n{}", path.display(), words)), picture(&img)?])
}
