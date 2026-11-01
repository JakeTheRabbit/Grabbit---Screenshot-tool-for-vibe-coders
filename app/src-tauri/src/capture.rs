// Freezing the screens: every monitor is grabbed at once when the capture key is tapped, so menus and tooltips stay
// in the picture. Windows are listed too (front to back) so the picker can snap to them, and a window can be grabbed
// on its own even when something covers it.

use anyhow::{Context, Result};
use image::RgbaImage;
use serde::Serialize;
use xcap::{Monitor, Window};

/// A monitor's frozen picture. `x`/`y`/`width`/`height` are in physical pixels on the virtual desktop.
pub struct Frame {
    pub x: i32,
    pub y: i32,
    pub scale: f32,
    pub image: RgbaImage,
}

#[derive(Serialize, Clone, Debug)]
pub struct WinInfo {
    pub id: u32,
    pub title: String,
    pub app: String,
    /// Physical pixels on the virtual desktop.
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// All monitors, grabbed in parallel so they're frozen at the same moment.
/// GRABBIT_DEMO_FRAME=<picture>: every monitor shows that picture instead (README screenshots of a made-up page).
pub fn freeze_all() -> Result<Vec<Frame>> {
    if let Ok(demo) = std::env::var("GRABBIT_DEMO_FRAME") {
        let pic = image::open(&demo).context("GRABBIT_DEMO_FRAME")?;
        return Monitor::all()?.iter().map(|m| {
            let (w, h) = (m.width()?, m.height()?);
            let k = if cfg!(target_os = "macos") { m.scale_factor().unwrap_or(1.0) } else { 1.0 };
            let (pw, ph) = ((w as f32 * k) as u32, (h as f32 * k) as u32);
            Ok(Frame { x: m.x()?, y: m.y()?, scale: m.scale_factor().unwrap_or(1.0), image: pic.resize_to_fill(pw, ph, image::imageops::FilterType::Lanczos3).to_rgba8() })
        }).collect();
    }
    // xcap's Monitor can't cross threads, so each thread looks its monitor up again.
    let n = Monitor::all().context("listing monitors")?.len();
    std::thread::scope(|sc| {
        let jobs: Vec<_> = (0..n).map(|i| sc.spawn(move || -> Result<Frame> {
            let m = Monitor::all()?.into_iter().nth(i).context("monitor went away")?;
            let image = m.capture_image().context("capturing monitor")?;
            Ok(Frame { x: m.x()?, y: m.y()?, scale: m.scale_factor().unwrap_or(1.0), image })
        })).collect();
        jobs.into_iter().map(|j| j.join().map_err(|_| anyhow::anyhow!("capture thread panicked"))?).collect()
    })
}

/// Visible, normal windows, front-most first. Our own windows (picker, bars) are left out.
pub fn windows() -> Vec<WinInfo> {
    let own = std::process::id();
    let mut list: Vec<(i32, WinInfo)> = Window::all()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|w| {
            if w.is_minimized().ok()? || w.pid().ok()? == own { return None; }
            let (width, height) = (w.width().ok()?, w.height().ok()?);
            if width < 40 || height < 40 { return None; }
            // (app_name is skipped: on Windows it reads every exe's version info, which is slow.)
            let info = WinInfo { id: w.id().ok()?, title: w.title().unwrap_or_default(), app: String::new(), x: w.x().ok()?, y: w.y().ok()?, width, height };
            Some((w.z().unwrap_or(0), info))
        })
        .collect();
    list.sort_by_key(|(z, _)| -z);
    list.into_iter().map(|(_, w)| w).collect()
}

/// Grab one window's own pixels (not what's on top of it).
pub fn capture_window(id: u32) -> Result<RgbaImage> {
    let w = Window::all()?.into_iter().find(|w| w.id().ok() == Some(id)).context("window gone")?;
    Ok(w.capture_image()?)
}

/// Cut a rectangle (physical, virtual-desktop coordinates) out of the frozen frames; it may span monitors.
pub fn crop(frames: &[Frame], x: i32, y: i32, w: u32, h: u32) -> RgbaImage {
    let mut out = RgbaImage::new(w.max(1), h.max(1));
    for f in frames {
        let (fx0, fy0) = (f.x.max(x), f.y.max(y));
        let fx1 = (f.x + f.image.width() as i32).min(x + w as i32);
        let fy1 = (f.y + f.image.height() as i32).min(y + h as i32);
        if fx1 <= fx0 || fy1 <= fy0 { continue; }
        let part = image::imageops::crop_imm(&f.image, (fx0 - f.x) as u32, (fy0 - f.y) as u32, (fx1 - fx0) as u32, (fy1 - fy0) as u32).to_image();
        image::imageops::replace(&mut out, &part, (fx0 - x) as i64, (fy0 - y) as i64);
    }
    out
}

/// Several windows captured whole, laid out as on screen, transparent between them.
pub fn compose_windows(ids: &[u32], all: &[WinInfo]) -> Result<RgbaImage> {
    let picked: Vec<&WinInfo> = all.iter().filter(|w| ids.contains(&w.id)).collect();
    anyhow::ensure!(!picked.is_empty(), "no windows");
    let x0 = picked.iter().map(|w| w.x).min().unwrap();
    let y0 = picked.iter().map(|w| w.y).min().unwrap();
    let x1 = picked.iter().map(|w| w.x + w.width as i32).max().unwrap();
    let y1 = picked.iter().map(|w| w.y + w.height as i32).max().unwrap();
    let mut out = RgbaImage::new((x1 - x0) as u32, (y1 - y0) as u32);
    // Back to front, so the front-most window ends up on top.
    for w in picked.iter().rev() {
        let img = capture_window(w.id)?;
        image::imageops::overlay(&mut out, &img, (w.x - x0) as i64, (w.y - y0) as i64);
    }
    Ok(out)
}

/// Several picked areas arranged into one picture: "row" (side by side), "column" (stacked), "grid" (two across) or
/// "screen" (where they were on screen). White between them, so chat copies (JPEG) look right too.
pub fn combine(parts: &[(RgbaImage, i32, i32)], layout: &str) -> RgbaImage {
    const GAP: u32 = 24;
    let white = image::Rgba([255, 255, 255, 255]);
    if layout == "screen" {
        let x0 = parts.iter().map(|p| p.1).min().unwrap_or(0);
        let y0 = parts.iter().map(|p| p.2).min().unwrap_or(0);
        let x1 = parts.iter().map(|p| p.1 + p.0.width() as i32).max().unwrap_or(1);
        let y1 = parts.iter().map(|p| p.2 + p.0.height() as i32).max().unwrap_or(1);
        let mut out = RgbaImage::from_pixel((x1 - x0) as u32, (y1 - y0) as u32, white);
        for (img, x, y) in parts { image::imageops::overlay(&mut out, img, (*x - x0) as i64, (*y - y0) as i64); }
        return out;
    }
    let cols = match layout { "row" => parts.len(), "column" => 1, _ => 2.min(parts.len()) }.max(1);
    let rows = parts.len().div_ceil(cols);
    let col_w: Vec<u32> = (0..cols).map(|c| parts.iter().skip(c).step_by(cols).map(|p| p.0.width()).max().unwrap_or(0)).collect();
    let row_h: Vec<u32> = (0..rows).map(|r| parts.iter().skip(r * cols).take(cols).map(|p| p.0.height()).max().unwrap_or(0)).collect();
    let w = col_w.iter().sum::<u32>() + GAP * (cols as u32 - 1);
    let h = row_h.iter().sum::<u32>() + GAP * (rows as u32 - 1);
    let mut out = RgbaImage::from_pixel(w.max(1), h.max(1), white);
    for (i, (img, _, _)) in parts.iter().enumerate() {
        let (c, r) = (i % cols, i / cols);
        let x = col_w[..c].iter().sum::<u32>() + GAP * c as u32;
        let y = row_h[..r].iter().sum::<u32>() + GAP * r as u32;
        image::imageops::overlay(&mut out, img, x as i64, y as i64);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combine_layouts() {
        let a = (RgbaImage::new(100, 50), 0, 0);
        let b = (RgbaImage::new(80, 70), 300, 10);
        let c = (RgbaImage::new(60, 40), 0, 200);
        let parts = vec![a, b, c];
        assert_eq!(combine(&parts, "row").dimensions(), (100 + 80 + 60 + 48, 70));
        assert_eq!(combine(&parts, "column").dimensions(), (100, 50 + 70 + 40 + 48));
        assert_eq!(combine(&parts, "grid").dimensions(), (100 + 80 + 24, 70 + 40 + 24));
        assert_eq!(combine(&parts, "screen").dimensions(), (380, 240));
    }
}
