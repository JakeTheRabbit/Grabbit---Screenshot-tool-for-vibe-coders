// Step recorder: turn a task into a how-to. While it's on, every click captures the window under the mouse with a
// numbered marker where you clicked. Typing is noted as "typed N characters" (never the keys themselves, so passwords
// stay out). Stopping writes steps.md and a Word document next to the pictures and opens the folder.

use crate::{actions, capture, export, settings::Settings, state};
use anyhow::Result;
use image::{Rgba, RgbaImage};
use std::{
    path::{Path, PathBuf},
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::AppHandle;

pub struct Step { pub n: usize, pub image: PathBuf, pub title: String, pub typed: usize }

struct Session { stop: Arc<AtomicBool>, dir: PathBuf, steps: Arc<Mutex<Vec<Step>>>, worker: std::thread::JoinHandle<()> }
static SESSION: Mutex<Option<Session>> = Mutex::new(None);


pub fn toggle(app: &AppHandle) {
    let current = SESSION.lock().unwrap().take();
    match current {
        Some(s) => finish(app, s),
        None => start(app),
    }
}

/// A filled circle with the step number, drawn into the picture at the click.
fn marker(img: &mut RgbaImage, cx: i32, cy: i32, n: usize) {
    let r = (img.width().max(img.height()) as f32 / 70.0).clamp(14.0, 30.0);
    for y in (cy - r as i32 - 3)..=(cy + r as i32 + 3) { for x in (cx - r as i32 - 3)..=(cx + r as i32 + 3) {
        if x < 0 || y < 0 || x >= img.width() as i32 || y >= img.height() as i32 { continue; }
        let d = (((x - cx).pow(2) + (y - cy).pow(2)) as f32).sqrt();
        let p = img.get_pixel_mut(x as u32, y as u32);
        if d <= r { *p = Rgba([229, 57, 53, 255]); } else if d <= r + 3.0 { *p = Rgba([255, 255, 255, 255]); }
    } }
    // The number, drawn with a tiny 3×5 pixel font scaled up: no font files needed on any OS.
    const DIGITS: [[u8; 5]; 10] = [[7, 5, 5, 5, 7], [2, 6, 2, 2, 7], [7, 1, 7, 4, 7], [7, 1, 7, 1, 7], [5, 5, 7, 1, 1], [7, 4, 7, 1, 7], [7, 4, 7, 5, 7], [7, 1, 1, 1, 1], [7, 5, 7, 5, 7], [7, 5, 7, 1, 7]];
    let text = n.to_string();
    let s = (r / 4.0).max(2.0) as i32;
    let w = text.len() as i32 * 4 * s - s;
    let (mut x0, y0) = (cx - w / 2, cy - 5 * s / 2);
    for ch in text.chars() {
        let g = DIGITS[ch.to_digit(10).unwrap_or(0) as usize];
        for (row, bits) in g.iter().enumerate() { for col in 0..3 {
            if bits & (4 >> col) == 0 { continue; }
            for dy in 0..s { for dx in 0..s {
                let (x, y) = (x0 + col * s + dx, y0 + row as i32 * s + dy);
                if x >= 0 && y >= 0 && x < img.width() as i32 && y < img.height() as i32 { img.put_pixel(x as u32, y as u32, Rgba([255, 255, 255, 255])); }
            } }
        } }
        x0 += 4 * s;
    }
}

fn start(app: &AppHandle) {
    let s = state(app).settings.lock().unwrap().clone();
    let dir = PathBuf::from(&s.save_folder).join(export::stamp_name("Steps"));
    if let Err(e) = std::fs::create_dir_all(&dir) { return actions::notify(app, &format!("{e}")); }
    let stop = Arc::new(AtomicBool::new(false));
    let steps = Arc::new(Mutex::new(Vec::<Step>::new()));
    let (stop2, steps2, dir2) = (stop.clone(), steps.clone(), dir.clone());
    let worker = std::thread::spawn(move || {
        use device_query::{DeviceQuery, DeviceState};
        let dev = DeviceState::new();
        let mut was_down = false;
        let mut typed = 0usize;
        let mut prev_keys: Vec<device_query::Keycode> = Vec::new();
        while !stop2.load(Ordering::Relaxed) {
            let m = dev.get_mouse();
            let down = m.button_pressed.get(1).copied().unwrap_or(false);
            let keys = dev.get_keys();
            typed += keys.iter().filter(|k| !prev_keys.contains(k) && format!("{k}").len() <= 2).count();
            prev_keys = keys;
            if down && !was_down {
                let t0 = Instant::now();
                if let Err(e) = shoot(&dir2, &steps2, m.coords, typed) { log::warn!("step capture: {e}"); }
                typed = 0;
                log::info!("step captured in {:?}", t0.elapsed());
            }
            was_down = down;
            std::thread::sleep(Duration::from_millis(12));
        }
    });
    *SESSION.lock().unwrap() = Some(Session { stop, dir, steps, worker });
    let key = s.hotkeys.get(&crate::settings::HotkeyAction::Steps).cloned().unwrap_or_default();
    actions::notify(app, &format!("Recording steps: click through your task, then press {key} (or the tray menu) to finish"));
}

fn shoot(dir: &Path, steps: &Mutex<Vec<Step>>, (mx, my): (i32, i32), typed: usize) -> Result<()> {
    #[cfg(target_os = "macos")]
    let (mx, my) = { let k = xcap::Monitor::all()?.first().and_then(|m| m.scale_factor().ok()).unwrap_or(1.0); ((mx as f32 * k) as i32, (my as f32 * k) as i32) };
    let wins = capture::windows();
    let win = wins.iter().find(|w| mx >= w.x && my >= w.y && mx < w.x + w.width as i32 && my < w.y + w.height as i32);
    let frames = capture::freeze_all()?;
    let (img, ox, oy, title) = match win {
        Some(w) => (capture::crop(&frames, w.x, w.y, w.width, w.height), w.x, w.y, w.title.clone()),
        None => {
            let f = frames.iter().find(|f| mx >= f.x && my >= f.y && mx < f.x + f.image.width() as i32 && my < f.y + f.image.height() as i32).or(frames.first()).ok_or_else(|| anyhow::anyhow!("no screen"))?;
            (f.image.clone(), f.x, f.y, "the desktop".to_string())
        }
    };
    let mut img = img;
    let mut g = steps.lock().unwrap();
    let n = g.len() + 1;
    marker(&mut img, mx - ox, my - oy, n);
    let img = export::scale_to(&img, 1600);
    let path = dir.join(format!("step-{n:02}.png"));
    std::fs::write(&path, export::png_bytes(&img, None)?)?;
    g.push(Step { n, image: path, title: if title.trim().is_empty() { "a window".into() } else { title }, typed });
    Ok(())
}

fn finish(app: &AppHandle, sess: Session) {
    sess.stop.store(true, Ordering::Relaxed);
    let _ = sess.worker.join();
    let steps = std::mem::take(&mut *sess.steps.lock().unwrap());
    if steps.is_empty() { let _ = std::fs::remove_dir(&sess.dir); return actions::notify(app, "Step recorder stopped: no clicks recorded"); }
    let s = state(app).settings.lock().unwrap().clone();
    match write_docs(&s, &sess.dir, &steps) {
        Ok(docx) => {
            actions::notify(app, &format!("Saved {} steps as a how-to", steps.len()));
            let _ = tauri_plugin_opener::reveal_item_in_dir(&docx);
        }
        Err(e) => actions::notify(app, &format!("Couldn't write the how-to: {e}")),
    }
}

fn describe(s: &Step) -> String {
    let typed = if s.typed > 0 { format!("Type {} character{}, then c", s.typed, if s.typed == 1 { "" } else { "s" }) } else { "C".into() };
    format!("{typed}lick in {}.", s.title)
}

pub fn write_docs(s: &Settings, dir: &Path, steps: &[Step]) -> Result<PathBuf> {
    let title = format!("How-to — {}", chrono::Local::now().format("%-d %B %Y"));
    let mut md = format!("# {title}\n\n");
    if !s.metadata.author.is_empty() { md += &format!("By {}\n\n", s.metadata.author); }
    for st in steps {
        md += &format!("## Step {}\n\n{}\n\n![Step {}]({})\n\n", st.n, describe(st), st.n, st.image.file_name().unwrap_or_default().to_string_lossy());
    }
    std::fs::write(dir.join("steps.md"), md)?;

    use docx_rs::{Docx, Paragraph, Pic, Run};
    let mut doc = Docx::new().add_paragraph(Paragraph::new().add_run(Run::new().add_text(&title).bold().size(40)));
    if !s.metadata.author.is_empty() { doc = doc.add_paragraph(Paragraph::new().add_run(Run::new().add_text(format!("By {}", s.metadata.author)).size(22))); }
    for st in steps {
        doc = doc.add_paragraph(Paragraph::new().add_run(Run::new().add_text(format!("Step {}", st.n)).bold().size(28)));
        doc = doc.add_paragraph(Paragraph::new().add_run(Run::new().add_text(describe(st)).size(22)));
        let bytes = std::fs::read(&st.image)?;
        let (w, h) = image::image_dimensions(&st.image)?;
        // Fit 6 inches wide (914400 EMU per inch).
        let wemu = 6 * 914_400u32;
        let hemu = (wemu as u64 * h as u64 / w.max(1) as u64) as u32;
        doc = doc.add_paragraph(Paragraph::new().add_run(Run::new().add_image(Pic::new(&bytes).size(wemu, hemu))));
    }
    let docx = dir.join("Steps.docx");
    doc.build().pack(std::fs::File::create(&docx)?)?;
    Ok(docx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_markdown_and_word() {
        let dir = std::env::temp_dir().join("grabbit-steps-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut img = RgbaImage::from_pixel(400, 300, Rgba([240, 240, 240, 255]));
        marker(&mut img, 200, 150, 12);
        assert_eq!(*img.get_pixel(200, 150 - 12), Rgba([229, 57, 53, 255]));
        let p = dir.join("step-01.png");
        img.save(&p).unwrap();
        let steps = vec![Step { n: 1, image: p, title: "Settings".into(), typed: 5 }];
        let docx = write_docs(&Settings::default(), &dir, &steps).unwrap();
        assert!(std::fs::metadata(&docx).unwrap().len() > 1000);
        let md = std::fs::read_to_string(dir.join("steps.md")).unwrap();
        assert!(md.contains("Type 5 characters, then click in Settings."));
    }
}
