// `grabbit --self-test <dir>`: exercises the core on this machine without any window — capture, encoders, metadata,
// watermark, OCR, QR, clipboard, a short real recording and a render — writes <dir>/selftest.json and exits non-zero on
// failure. CI runs it on Windows, macOS and Linux.

use crate::{capture, export, mark, settings::Settings, video};
use serde_json::{json, Value};
use std::path::Path;

fn step(results: &mut Vec<Value>, name: &str, f: impl FnOnce() -> anyhow::Result<String>) {
    let t0 = std::time::Instant::now();
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).unwrap_or_else(|_| Err(anyhow::anyhow!("panicked")));
    let (ok, detail) = match r { Ok(d) => (true, d), Err(e) => (false, format!("{e:#}")) };
    println!("{} {name}: {detail} ({} ms)", if ok { "PASS" } else { "FAIL" }, t0.elapsed().as_millis());
    results.push(json!({ "name": name, "ok": ok, "detail": detail, "ms": t0.elapsed().as_millis() as u64 }));
}

pub fn run(dir: &Path) -> i32 {
    let _ = std::fs::create_dir_all(dir);
    let mut s = Settings::default();
    s.save_folder = dir.join("shots").to_string_lossy().into();
    s.video_folder = dir.join("videos").to_string_lossy().into();
    s.metadata.author = "Grabbit self-test".into();
    s.branding.invisible_mark = true;
    s.branding.owner = "selftest".into();
    let mut r = Vec::new();
    let mut frames = Vec::new();

    step(&mut r, "capture screens", || {
        frames = capture::freeze_all()?;
        anyhow::ensure!(!frames.is_empty(), "no monitors");
        let f = &frames[0];
        // A real capture isn't one flat colour (a black frame means capture permission is missing).
        let px = f.image.as_raw();
        let distinct = px.chunks(4).step_by(97).map(|p| (p[0], p[1], p[2])).collect::<std::collections::HashSet<_>>().len();
        anyhow::ensure!(distinct > 1, "picture is a single colour: screen capture permission missing?");
        Ok(format!("{} monitor(s), first {}x{} @ {}x, {distinct} colours sampled", frames.len(), f.image.width(), f.image.height(), f.scale))
    });
    step(&mut r, "list windows", || Ok(format!("{} windows", capture::windows().len())));

    let shot = if frames.is_empty() { image::RgbaImage::from_pixel(640, 400, image::Rgba([200, 100, 50, 255])) } else {
        let f = &frames[0];
        capture::crop(&frames, f.x + 10, f.y + 10, (f.image.width() - 20).min(1200), (f.image.height() - 20).min(800))
    };
    step(&mut r, "save lossless webp with metadata", || {
        let p = export::save_full(&s, &shot, "selftest")?;
        let bytes = std::fs::read(&p)?;
        let back = image::load_from_memory(&bytes)?.to_rgba8();
        anyhow::ensure!(back.as_raw() == shot.as_raw(), "not pixel-exact");
        anyhow::ensure!(String::from_utf8_lossy(&bytes).contains("Grabbit self-test"), "XMP author missing");
        Ok(format!("{} KB, pixel-exact, XMP present", bytes.len() / 1024))
    });
    step(&mut r, "chat jpeg under budget", || {
        let j = export::chat_jpeg(&shot, 2560, 300)?;
        anyhow::ensure!(j.len() <= 300 * 1024, "too big");
        Ok(format!("{} KB", j.len() / 1024))
    });
    step(&mut r, "invisible watermark", || {
        let mut m = shot.clone();
        // Screens can be flat (CI desktops); give the mark texture to live in.
        for (x, y, p) in m.enumerate_pixels_mut() { if (x / 3 + y / 5) % 7 == 0 { p[0] = p[0].wrapping_add(60); } }
        let marked = mark::apply(&s, &m, 4242);
        let f = mark::check(&marked).ok_or_else(|| anyhow::anyhow!("not found"))?;
        anyhow::ensure!(f.id == 4242 && f.owner_hash == mark::owner_hash("selftest"), "wrong payload");
        Ok("read back owner + id".into())
    });
    step(&mut r, "OCR", || {
        let img = image::load_from_memory(include_bytes!("../tests/fixtures/ocr.png"))?.to_rgba8();
        let w = tauri::async_runtime::block_on(crate::ocr::words(&img))?;
        let text = w.iter().map(|x| x.text.as_str()).collect::<Vec<_>>().join(" ");
        anyhow::ensure!(text.to_lowercase().contains("grabbit"), "read: {text}");
        Ok(text)
    });
    step(&mut r, "clipboard image + text", || {
        export::copy(&s, &shot, export::Size::Reduced, "selftest")?;
        use clipboard_rs::{Clipboard, ClipboardContext};
        let c = ClipboardContext::new().map_err(|e| anyhow::anyhow!("{e}"))?;
        let has = c.has(clipboard_rs::ContentFormat::Image);
        export::copy_text("grabbit-selftest")?;
        let t = c.get_text().map_err(|e| anyhow::anyhow!("{e}"))?;
        anyhow::ensure!(t == "grabbit-selftest", "text read back: {t}");
        Ok(format!("image on clipboard: {has}"))
    });
    step(&mut r, "ffmpeg + encoder", || Ok(format!("{} · {}", video::ffmpeg(&s)?.display(), video::hw_encoder(&s))));
    let mut rec = None;
    step(&mut r, "record 3 s", || {
        let p = crate::record::selftest(&s, dir, 3)?;
        let i = video::probe(&s, &p)?;
        anyhow::ensure!(i.duration > 2.0 && i.width > 0, "duration {}", i.duration);
        rec = Some(p.clone());
        Ok(format!("{}x{} {:.1} s, tracks {:?}", i.width, i.height, i.duration, i.tracks))
    });
    step(&mut r, "record 2 s with webcam bubble (generated camera)", || {
        std::env::set_var("GRABBIT_FAKE_CAM", "1");
        let mut s2 = s.clone();
        s2.record_webcam = true;
        let d2 = dir.join("cam");
        std::fs::create_dir_all(&d2)?;
        let p = crate::record::selftest(&s2, &d2, 2)?;
        let i = video::probe(&s2, &p)?;
        anyhow::ensure!(i.duration > 1.0, "duration {}", i.duration);
        Ok(format!("{}x{} {:.1} s", i.width, i.height, i.duration))
    });
    step(&mut r, "render: cut + speed + GIF + social", || {
        let src = rec.clone().ok_or_else(|| anyhow::anyhow!("no recording"))?;
        let keep = [video::Part { start: 0.0, end: 1.0, speed: 1.0 }, video::Part { start: 1.5, end: 2.5, speed: 2.0 }];
        let mp4 = dir.join("render.mp4");
        video::render(&s, &src, &keep, &video::Target::Social(1080, 1920), &mp4, video::Sound::All, &[], &video::Extras::default(), None, |_| {})?;
        let gif = dir.join("render.gif");
        video::render(&s, &src, &keep, &video::Target::Gif, &gif, video::Sound::None, &[], &video::Extras::default(), None, |_| {})?;
        let i = video::probe(&s, &mp4)?;
        anyhow::ensure!((i.width, i.height) == (1080, 1920), "size {}x{}", i.width, i.height);
        Ok(format!("mp4 {:.1} s, gif {} KB", i.duration, std::fs::metadata(&gif)?.len() / 1024))
    });

    let failed = r.iter().filter(|x| !x["ok"].as_bool().unwrap_or(false)).count();
    let report = json!({ "os": std::env::consts::OS, "arch": std::env::consts::ARCH, "failed": failed, "steps": r });
    let _ = std::fs::write(dir.join("selftest.json"), serde_json::to_string_pretty(&report).unwrap_or_default());
    println!("{}", if failed == 0 { "ALL PASS".to_string() } else { format!("{failed} FAILED") });
    if failed == 0 { 0 } else { 1 }
}
