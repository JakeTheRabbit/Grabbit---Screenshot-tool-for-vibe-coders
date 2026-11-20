// After every capture or recording, optionally: run a command of your own, and/or post to a webhook (n8n, Zapier,
// Home Assistant, Paperless, your own server). Both get the file and what History knows about it.

use crate::{history::Entry, settings::Settings};
use std::process::Command;

/// The JSON a webhook receives (and the command gets as GRABBIT_JSON).
pub fn payload(e: &Entry) -> serde_json::Value {
    let p = std::path::Path::new(&e.path);
    serde_json::json!({
        "event": e.kind, "path": e.path, "name": p.file_name().map(|n| n.to_string_lossy()).unwrap_or_default(),
        "time": e.time, "width": e.width, "height": e.height, "apps": e.apps, "windows": e.windows,
        "text": e.text, "description": e.description, "notes": e.notes, "full_screen": e.full,
    })
}

/// `{file}` in the command becomes the quoted path; GRABBIT_FILE, GRABBIT_KIND and GRABBIT_JSON are set too.
pub fn command_line(cmd: &str, path: &str) -> String { cmd.replace("{file}", &format!("\"{path}\"")) }

pub fn fire(s: &Settings, e: &Entry) {
    let (cmd, url) = (s.after_capture_command.trim().to_string(), s.after_capture_webhook.trim().to_string());
    if cmd.is_empty() && url.is_empty() { return }
    let body = payload(e);
    let e = e.clone();
    std::thread::spawn(move || {
        if !cmd.is_empty() {
            let line = command_line(&cmd, &e.path);
            // cmd.exe has its own quoting, so the line goes to it untouched.
            #[cfg(windows)]
            let mut c = { use std::os::windows::process::CommandExt; let mut c = Command::new("cmd"); c.arg("/C").raw_arg(&line); c };
            #[cfg(not(windows))]
            let mut c = { let mut c = Command::new("sh"); c.args(["-c", &line]); c };
            c.env("GRABBIT_FILE", &e.path).env("GRABBIT_KIND", &e.kind).env("GRABBIT_JSON", body.to_string());
            if let Err(err) = crate::video::hide(&mut c).status() { eprintln!("after-capture command: {err}"); }
        }
        if !url.is_empty() {
            let r = reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(15)).build()
                .and_then(|c| c.post(&url).json(&body).send());
            if let Err(err) = r { eprintln!("after-capture webhook: {err}"); }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_placeholder_is_quoted() {
        assert_eq!(command_line("copy {file} D:\\Inbox", r"C:\Pics\A b.png"), r#"copy "C:\Pics\A b.png" D:\Inbox"#);
    }

    #[test]
    fn runs_the_command_and_posts_the_webhook() {
        use std::io::{Read, Write};
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let dir = std::env::temp_dir().join(format!("grabbit-hooks-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (file, out) = (dir.join("shot.png"), dir.join("ran.txt"));
        std::fs::write(&file, b"x").unwrap();
        let s = Settings {
            after_capture_command: if cfg!(windows) { format!("echo %GRABBIT_KIND%> \"{}\"", out.display()) } else { format!("echo $GRABBIT_KIND > '{}'", out.display()) },
            after_capture_webhook: format!("http://{}/hook", server.local_addr().unwrap()),
            ..Default::default()
        };
        fire(&s, &Entry { path: file.to_string_lossy().into(), kind: "capture".into(), ..Default::default() });
        let (mut conn, _) = server.accept().unwrap();
        conn.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
        let mut req = Vec::new();
        let mut buf = [0u8; 4096];
        while !String::from_utf8_lossy(&req).contains("\"event\"") { let n = match conn.read(&mut buf) { Ok(n) => n, Err(e) => panic!("{e}: {}", String::from_utf8_lossy(&req)) }; if n == 0 { break } req.extend_from_slice(&buf[..n]); }
        let _ = conn.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n");
        let req = String::from_utf8_lossy(&req);
        assert!(req.starts_with("POST /hook") && req.contains("shot.png"), "{req}");
        for _ in 0..50 { if out.exists() { break } std::thread::sleep(std::time::Duration::from_millis(100)); }
        assert_eq!(std::fs::read_to_string(&out).unwrap().trim(), "capture");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn payload_carries_what_history_knows() {
        let e = Entry { path: "/x/Shot 1.png".into(), kind: "capture".into(), apps: vec!["Slack".into()], text: "hello".into(), ..Default::default() };
        let p = payload(&e);
        assert_eq!((p["event"].as_str(), p["name"].as_str(), p["apps"][0].as_str(), p["text"].as_str()), (Some("capture"), Some("Shot 1.png"), Some("Slack"), Some("hello")));
    }
}
