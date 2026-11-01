// Scrolling capture: scroll an area with mouse-wheel events and stitch the frames into one tall picture. If the app
// doesn't move for the wheel, the user scrolls and Grabbit stitches whatever comes into view. Frames are matched by
// coarse row signatures, so sticky headers and footers appear once and re-antialiased text at fractional scaling still
// matches. (Port of the Windows version's matcher, which used UI Automation first; wheel events work on every OS.)

use crate::{actions, export, mark, state};
use anyhow::{Context, Result};
use image::RgbaImage;
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const BINS: usize = 48;
const MAX_HEIGHT: u32 = 30000;
const MAX_STEPS: usize = 300;

static STOP: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);

type Rows = Vec<[f32; BINS]>;

/// Each row as 48 bins of mean brightness, ignoring the right-hand strip where scroll bars live.
pub fn rows(img: &RgbaImage) -> Rows {
    let w = (img.width() - (img.width() / 10).min(24)).max(BINS as u32);
    let mut out = Vec::with_capacity(img.height() as usize);
    for y in 0..img.height() {
        let mut f = [0f32; BINS];
        let mut n = [0u32; BINS];
        for x in 0..w.min(img.width()) {
            let p = img.get_pixel(x, y);
            let b = (x as usize * BINS) / w as usize;
            f[b] += (p[0] as f32 * 299.0 + p[1] as f32 * 587.0 + p[2] as f32 * 114.0) / 1000.0;
            n[b] += 1;
        }
        for k in 0..BINS { f[k] /= n[k].max(1) as f32; }
        out.push(f);
    }
    out
}

fn dist(a: &[f32; BINS], b: &[f32; BINS]) -> f32 { a.iter().zip(b).map(|(x, y)| (x - y).abs()).sum::<f32>() / BINS as f32 }

fn same(a: &Rows, b: &Rows) -> bool { a.len() == b.len() && a.iter().zip(b).all(|(x, y)| dist(x, y) <= 0.5) }

/// How far content moved up between two frames: (rows unchanged at the top, at the bottom, shift).
/// Shift 0 = nothing moved; -1 = moved but no trustworthy overlap.
pub fn matched(a: &Rows, b: &Rows) -> (usize, usize, i32) {
    let h = a.len().min(b.len());
    let mut top = 0;
    while top < h && dist(&a[top], &b[top]) < 1.0 { top += 1; }
    if top == h { return (0, 0, 0); }
    let mut bottom = 0;
    while bottom < h - top && dist(&a[h - 1 - bottom], &b[h - 1 - bottom]) < 1.0 { bottom += 1; }
    let (z0, z1) = (top, h - bottom);
    // Only rows that differ from the row above (text, edges) vote, so flat stretches can't fake a match.
    let info: Vec<usize> = (z0 + 1..z1).filter(|&i| dist(&b[i], &b[i - 1]) > 2.0).collect();
    if info.len() < 4 { return (top, bottom, -1); }
    let (mut best, mut best_dy) = (f32::MAX, -1i32);
    let mut costs = Vec::new();
    for dy in 1..(z1 - z0).saturating_sub(4) {
        let (mut sum, mut n) = (0f32, 0usize);
        for &i in &info { if i + dy >= z1 { break; } sum += dist(&a[i + dy], &b[i]); n += 1; }
        if n < 4.max(info.len() / 8) { break; }
        let c = sum / n as f32;
        costs.push(c);
        if c < best { best = c; best_dy = dy as i32; }
    }
    if best_dy < 0 { return (top, bottom, -1); }
    costs.sort_by(|a, b| a.total_cmp(b));
    let median = costs[costs.len() / 2];
    if best < 6.0 && best < median * 0.35 { (top, bottom, best_dy) } else { (top, bottom, -1) }
}

/// Join the first frame and every step's newly revealed band; one footer height for the whole capture.
pub fn stitch(first: &RgbaImage, steps: &[(RgbaImage, i32, usize)]) -> RgbaImage {
    if steps.is_empty() { return first.clone(); }
    let footer = steps.iter().map(|s| s.2).min().unwrap_or(0) as u32;
    let mut slices: Vec<(&RgbaImage, u32, u32)> = vec![(first, 0, first.height() - footer)];
    for (f, dy, _) in steps { let z1 = f.height() - footer; slices.push((f, z1 - *dy as u32, z1)); }
    let last = &steps.last().unwrap().0;
    slices.push((last, last.height() - footer, last.height()));
    let h: u32 = slices.iter().map(|s| s.2.saturating_sub(s.1)).sum();
    let mut out = RgbaImage::new(first.width(), h);
    let mut y = 0;
    for (src, y0, y1) in slices {
        if y1 <= y0 { continue; }
        let part = image::imageops::crop_imm(src, 0, y0, src.width(), y1 - y0).to_image();
        image::imageops::replace(&mut out, &part, 0, y as i64);
        y += y1 - y0;
    }
    out
}

/// One frame of the area, from the monitor it's on.
fn grab(x: i32, y: i32, w: u32, h: u32) -> Result<RgbaImage> {
    let m = xcap::Monitor::from_point(x + w as i32 / 2, y + h as i32 / 2)?;
    let (mx, my) = (m.x()?, m.y()?);
    let k = if cfg!(target_os = "macos") { m.scale_factor().unwrap_or(1.0) } else { 1.0 };
    // xcap regions are in the monitor's own coordinates (points on macOS).
    Ok(m.capture_region(((x - (mx as f32 * k) as i32).max(0) as f32 / k) as u32, ((y - (my as f32 * k) as i32).max(0) as f32 / k) as u32, (w as f32 / k) as u32, (h as f32 / k) as u32)?)
}

fn settled(x: i32, y: i32, w: u32, h: u32) -> Result<(RgbaImage, Rows)> {
    std::thread::sleep(Duration::from_millis(90));
    let mut img = grab(x, y, w, h)?;
    let mut r = rows(&img);
    for _ in 0..10 {
        std::thread::sleep(Duration::from_millis(70));
        let img2 = grab(x, y, w, h)?;
        let r2 = rows(&img2);
        if same(&r2, &r) { break; }
        img = img2;
        r = r2;
    }
    Ok((img, r))
}

fn status(app: &AppHandle, t: &str) { let _ = app.emit_to("scrollbar", "status", t.to_string()); }

pub fn run(app: &AppHandle, (x, y, w, h): (i32, i32, u32, u32)) -> Result<Option<RgbaImage>> {
    use enigo::{Axis, Coordinate, Enigo, Mouse};
    STOP.store(false, Ordering::SeqCst);
    CANCEL.store(false, Ordering::SeqCst);
    let mut enigo = Enigo::new(&enigo::Settings::default()).context("Grabbit can't send scroll events (macOS: allow it in Privacy & Security → Accessibility)")?;
    // Wheel events go where the pointer is: park it just inside the area's right edge, centred.
    #[cfg(target_os = "macos")]
    let k = xcap::Monitor::from_point(x, y).ok().and_then(|m| m.scale_factor().ok()).unwrap_or(1.0);
    #[cfg(not(target_os = "macos"))]
    let k = 1.0f32;
    let (px, py) = (((x + w as i32 - 12) as f32 / k) as i32, ((y + h as i32 / 2) as f32 / k) as i32);
    let _ = enigo.move_mouse(px, py, Coordinate::Abs);

    let (first, mut prev_rows) = settled(x, y, w, h)?;
    let mut steps: Vec<(RgbaImage, i32, usize)> = Vec::new();
    let (mut total, mut unit, mut notches, mut still) = (first.height() as i32, 0i32, 3i32, 0);
    let mut manual = false;
    while !STOP.load(Ordering::SeqCst) {
        if manual { status(app, "Scroll the window yourself (slowly), then press Done"); std::thread::sleep(Duration::from_millis(120)); }
        else {
            status(app, &format!("Scrolling… {total} px · don't move the mouse"));
            let _ = enigo.move_mouse(px, py, Coordinate::Abs);
            let _ = enigo.scroll(notches, Axis::Vertical);
        }
        let (next, r) = if manual { let i = grab(x, y, w, h)?; let r = rows(&i); (i, r) } else { settled(x, y, w, h)? };
        let (top, bottom, dy) = matched(&prev_rows, &r);
        if dy == 0 {
            if manual { continue; }
            if steps.is_empty() { manual = true; log::info!("scroll: wheel didn't move, manual"); continue; }
            still += 1;
            if still >= 2 { break; }
            continue;
        }
        if dy < 0 {
            if steps.is_empty() && notches > 1 { notches = 1; continue; }
            log::info!("scroll: lost the overlap after {} steps", steps.len());
            break;
        }
        still = 0;
        total += dy;
        let z1 = next.height() as i32 - bottom as i32;
        if unit == 0 { unit = (dy / notches).max(1); notches = ((0.5 * (z1 - top as i32) as f32 / unit as f32) as i32).clamp(1, 20); }
        steps.push((next, dy, bottom));
        prev_rows = r;
        if total as u32 >= MAX_HEIGHT || steps.len() >= MAX_STEPS { break; }
    }
    if CANCEL.load(Ordering::SeqCst) { return Ok(None); }
    log::info!("scroll capture: {} steps, {total} px, {}", steps.len(), if manual { "manual" } else { "wheel" });
    Ok(Some(stitch(&first, &steps)))
}

/// Picker action: run the capture with a small status bar, then copy, save and offer the editor.
pub fn start(app: &AppHandle, rect: (i32, i32, u32, u32)) {
    let a = app.clone();
    std::thread::spawn(move || {
        let scale = a.monitor_from_point(rect.0 as f64, rect.1 as f64).ok().flatten().map(|m| m.scale_factor()).unwrap_or(1.0);
        let (lx, ly, lw) = (rect.0 as f64 / scale, rect.1 as f64 / scale, rect.2 as f64 / scale);
        let bar = WebviewWindowBuilder::new(&a, "scrollbar", WebviewUrl::App("recbar.html?mode=scroll".into()))
            .decorations(false).transparent(true).shadow(false).always_on_top(true).skip_taskbar(true).focused(false).resizable(false)
            .position(lx + (lw - 360.0) / 2.0, (ly - 54.0).max(8.0)).inner_size(360.0, 44.0).build();
        if let Ok(b) = &bar { crate::record::exclude_from_capture(b); }
        let r = run(&a, rect);
        if let Some(b) = a.get_webview_window("scrollbar") { let _ = b.destroy(); }
        match r {
            Ok(Some(img)) => {
                let s = state(&a).settings.lock().unwrap().clone();
                let id = mark::capture_id();
                let out = mark::apply(&s, &img, id);
                let name = export::stamp_name("Grabbit scroll");
                let saved = export::save_full(&s, &out, &name).ok();
                crate::history::add(&a, saved.as_deref(), &img, id);
                match export::copy(&s, &out, export::Size::Full, &name) {
                    Ok(f) => actions::quick_show(&a, Some(saved.as_deref().unwrap_or(&f)), &format!("Copied {}×{}", img.width(), img.height())),
                    Err(e) => actions::notify(&a, &format!("{e}")),
                }
            }
            Ok(None) => {}
            Err(e) => actions::notify(&a, &format!("Scrolling capture: {e}")),
        }
    });
}

#[tauri::command]
pub fn scroll_control(what: String) {
    if what == "cancel" { CANCEL.store(true, Ordering::SeqCst); }
    STOP.store(true, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    /// A tall "page" with text-like stripes, a sticky header, viewed through a 300-px window.
    fn page() -> RgbaImage {
        let mut p = RgbaImage::from_pixel(400, 2000, Rgba([250, 250, 250, 255]));
        for y in 0..2000u32 { for x in 20..380u32 {
            if (y / 7) % 3 == 0 && ((x * 13 + y * 7) % 23) < 11 { p.put_pixel(x, y, Rgba([((y * 3) % 200) as u8, 40, ((x + y) % 255) as u8, 255])); }
        } }
        p
    }
    fn view(p: &RgbaImage, at: u32) -> RgbaImage {
        let mut v = image::imageops::crop_imm(p, 0, at, 400, 300).to_image();
        for y in 0..30 { for x in 0..400 { v.put_pixel(x, y, Rgba([30, 30, 120, 255])); } }   // sticky header
        v
    }

    #[test]
    fn finds_shift_and_stitches() {
        let p = page();
        let (a, b, c) = (view(&p, 0), view(&p, 120), view(&p, 240));
        let (top, _, dy) = matched(&rows(&a), &rows(&b));
        assert_eq!(dy, 120);
        assert!(top >= 30);
        let (_, bottom2, dy2) = matched(&rows(&b), &rows(&c));
        assert_eq!(dy2, 120);
        let out = stitch(&a, &[(b, 120, 0), (c, 120, bottom2)]);
        assert_eq!(out.height(), 300 + 240);
        // The stitched picture matches the page below the header.
        assert_eq!(out.get_pixel(100, 400), p.get_pixel(100, 400));
    }

    #[test]
    fn nothing_moved() {
        let p = page();
        assert_eq!(matched(&rows(&view(&p, 50)), &rows(&view(&p, 50))).2, 0);
    }
}
