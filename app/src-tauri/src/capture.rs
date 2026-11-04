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
    let n = Monitor::all().context("listing monitors")?.len();
    #[cfg(windows)]
    match dxgi::freeze(n) {
        Ok(f) => return Ok(f),
        Err(e) => log::warn!("fast capture unavailable ({e:#}); using GDI"),
    }
    // xcap's Monitor can't cross threads, so each thread looks its monitor up again.
    std::thread::scope(|sc| {
        let jobs: Vec<_> = (0..n).map(|i| sc.spawn(move || -> Result<Frame> {
            let m = Monitor::all()?.into_iter().nth(i).context("monitor went away")?;
            let image = m.capture_image().context("capturing monitor")?;
            Ok(Frame { x: m.x()?, y: m.y()?, scale: m.scale_factor().unwrap_or(1.0), image })
        })).collect();
        jobs.into_iter().map(|j| j.join().map_err(|_| anyhow::anyhow!("capture thread panicked"))?).collect()
    })
}

/// Frees what fast capture keeps between captures (called when the capture screens are closed for good).
pub fn release() {
    #[cfg(windows)]
    dxgi::release();
}

/// Makes fast capture ready ahead of the first capture (the GPU devices take ~150 ms).
pub fn prepare() {
    #[cfg(windows)]
    dxgi::prepare();
}

/// Windows: the screens straight from the GPU (DXGI desktop duplication), about 5× faster than GDI. The GPU device
/// takes ~150 ms to make, so it's kept; it holds no pictures between captures. Anything unusual (a remote session,
/// an HDR screen, the screens changing) fails here and the capture falls back to GDI.
#[cfg(windows)]
mod dxgi {
    use super::Frame;
    use anyhow::{Context, Result};
    use std::sync::Mutex;
    use windows::core::Interface;
    use windows::Win32::Graphics::{Direct3D::*, Direct3D11::*, Dxgi::{Common::*, *}};
    use windows::Win32::{Foundation::HMODULE, UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI}};

    struct Gpu { dev: ID3D11Device, ctx: ID3D11DeviceContext, outputs: Vec<IDXGIOutput1> }
    // D3D11 devices are free-threaded and the context is made multithread-protected below.
    unsafe impl Send for Gpu {}
    unsafe impl Sync for Gpu {}
    static GPUS: Mutex<Vec<Gpu>> = Mutex::new(Vec::new());

    fn gpus() -> Result<Vec<Gpu>> {
        let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1()? };
        let mut out = Vec::new();
        for a in (0..).map_while(|i| unsafe { factory.EnumAdapters1(i) }.ok()) {
            let outputs: Vec<IDXGIOutput1> = (0..).map_while(|i| unsafe { a.EnumOutputs(i) }.ok()).filter_map(|o| o.cast().ok()).collect();
            if outputs.is_empty() { continue; }
            let (mut dev, mut ctx) = (None, None);
            unsafe { D3D11CreateDevice(&a, D3D_DRIVER_TYPE_UNKNOWN, HMODULE::default(), D3D11_CREATE_DEVICE_BGRA_SUPPORT, None, D3D11_SDK_VERSION, Some(&mut dev), None, Some(&mut ctx))?; }
            let ctx = ctx.context("no device context")?;
            if let Ok(mt) = ctx.cast::<ID3D11Multithread>() { unsafe { let _ = mt.SetMultithreadProtected(true); } }
            out.push(Gpu { dev: dev.context("no device")?, ctx, outputs });
        }
        Ok(out)
    }

    /// Lets go of the GPU devices (the graphics driver holds ~130 MB for them); the next capture makes them again.
    pub fn release() { GPUS.lock().unwrap().clear(); }

    pub fn prepare() {
        let mut cache = GPUS.lock().unwrap();
        if cache.is_empty() { *cache = gpus().unwrap_or_default(); }
    }

    pub fn freeze(monitors: usize) -> Result<Vec<Frame>> {
        let mut cache = GPUS.lock().unwrap();
        if cache.iter().map(|g| g.outputs.len()).sum::<usize>() != monitors { *cache = gpus()?; }
        let results: Vec<(Option<(i32, i32)>, Result<Frame>)> = std::thread::scope(|sc| {
            let jobs: Vec<_> = cache.iter().flat_map(|g| g.outputs.iter().map(move |o| sc.spawn(move || {
                let at = unsafe { o.GetDesc() }.ok().map(|d| (d.DesktopCoordinates.left, d.DesktopCoordinates.top));
                (at, grab(g, o))
            }))).collect();
            jobs.into_iter().map(|j| j.join().unwrap_or((None, Err(anyhow::anyhow!("capture thread panicked"))))).collect()
        });
        let mut frames = Vec::new();
        for (at, r) in results {
            match r {
                Ok(f) => frames.push(f),
                // A screen that showed nothing new in time (or can't be duplicated) is grabbed with GDI instead.
                Err(e) => {
                    log::warn!("fast capture of the screen at {at:?} failed ({e:#}); using GDI for it");
                    if !e.to_string().contains("no desktop frame") { cache.clear(); }
                    let (x, y) = at.context("screen gone")?;
                    let m = xcap::Monitor::all()?.into_iter().find(|m| m.x().ok() == Some(x) && m.y().ok() == Some(y)).context("screen gone")?;
                    frames.push(Frame { x, y, scale: m.scale_factor().unwrap_or(1.0), image: m.capture_image()? });
                }
            }
        }
        Ok(frames)
    }

    fn grab(g: &Gpu, out: &IDXGIOutput1) -> Result<Frame> {
        unsafe {
            let od = out.GetDesc()?;
            let dup = out.DuplicateOutput(&g.dev)?;
            let (mut info, mut res) = (DXGI_OUTDUPL_FRAME_INFO::default(), None);
            // The first frame after duplicating is often empty, and moving the mouse sends pointer-only ones; the
            // desktop's picture follows within a frame or two.
            let until = std::time::Instant::now() + std::time::Duration::from_millis(300);
            while std::time::Instant::now() < until {
                match dup.AcquireNextFrame(50, &mut info, &mut res) {
                    Ok(()) if info.LastPresentTime != 0 => break,
                    Ok(()) => { res = None; dup.ReleaseFrame()?; }
                    Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => {}
                    Err(e) => return Err(e.into()),
                }
            }
            anyhow::ensure!(info.LastPresentTime != 0, "no desktop frame");
            let tex: ID3D11Texture2D = res.context("no frame")?.cast()?;
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            tex.GetDesc(&mut desc);
            anyhow::ensure!(desc.Format == DXGI_FORMAT_B8G8R8A8_UNORM, "screen format {:?}", desc.Format);
            desc.Usage = D3D11_USAGE_STAGING; desc.BindFlags = 0; desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32; desc.MiscFlags = 0;
            let mut staging = None;
            g.dev.CreateTexture2D(&desc, None, Some(&mut staging))?;
            let staging = staging.context("no staging texture")?;
            g.ctx.CopyResource(&staging, &tex);
            drop(tex);
            dup.ReleaseFrame()?;
            let mut map = D3D11_MAPPED_SUBRESOURCE::default();
            g.ctx.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut map))?;
            let (tw, th, pitch) = (desc.Width as usize, desc.Height as usize, map.RowPitch as usize);
            let src = std::slice::from_raw_parts(map.pData as *const u8, pitch * th);
            let (rgba, w, h) = super::from_bgra(src, pitch, tw, th, dup.GetDesc().Rotation.0);
            g.ctx.Unmap(&staging, 0);
            let (mut dx, mut dy) = (96, 96);
            let _ = GetDpiForMonitor(od.Monitor, MDT_EFFECTIVE_DPI, &mut dx, &mut dy);
            let r = od.DesktopCoordinates;
            Ok(Frame { x: r.left, y: r.top, scale: dx as f32 / 96.0, image: image::RgbaImage::from_raw(w as u32, h as u32, rgba).context("frame size")? })
        }
    }
}

/// BGRA rows `pitch` bytes apart (`tw`×`th`, as the screen's panel sees them) → RGBA the way the desktop shows them,
/// undoing a rotated screen (DXGI_MODE_ROTATION: 2 = 90°, 3 = 180°, 4 = 270°).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn from_bgra(src: &[u8], pitch: usize, tw: usize, th: usize, rot: i32) -> (Vec<u8>, usize, usize) {
    let (dw, dh) = if rot == 2 || rot == 4 { (th, tw) } else { (tw, th) };
    let mut out = vec![0u8; dw * dh * 4];
    for (dy, row) in out.chunks_exact_mut(dw * 4).enumerate() {
        if !(2..=4).contains(&rot) {
            for (d, s) in row.chunks_exact_mut(4).zip(src[dy * pitch..dy * pitch + tw * 4].chunks_exact(4)) { d.copy_from_slice(&[s[2], s[1], s[0], 255]); }
            continue;
        }
        for (dx, d) in row.chunks_exact_mut(4).enumerate() {
            let (sx, sy) = match rot { 2 => (dy, th - 1 - dx), 3 => (tw - 1 - dx, th - 1 - dy), _ => (tw - 1 - dy, dx) };
            let s = &src[sy * pitch + sx * 4..sy * pitch + sx * 4 + 4];
            d.copy_from_slice(&[s[2], s[1], s[0], 255]);
        }
    }
    (out, dw, dh)
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
    fn bgra_rotations() {
        // A 3×2 panel, BGRA, rows padded to 16 bytes; each pixel's blue byte is its index.
        let mut src = vec![0u8; 32];
        for i in 0..6u8 { let (x, y) = (i as usize % 3, i as usize / 3); src[y * 16 + x * 4] = i; }
        let blue = |v: &[u8]| v.chunks(4).map(|p| p[2]).collect::<Vec<_>>();
        let (o, w, h) = from_bgra(&src, 16, 3, 2, 1);
        assert_eq!((w, h, blue(&o)), (3, 2, vec![0, 1, 2, 3, 4, 5]));
        let (o, w, h) = from_bgra(&src, 16, 3, 2, 3);
        assert_eq!((w, h, blue(&o)), (3, 2, vec![5, 4, 3, 2, 1, 0]));
        let (o, w, h) = from_bgra(&src, 16, 3, 2, 2);
        assert_eq!((w, h, blue(&o)), (2, 3, vec![3, 0, 4, 1, 5, 2]));
        let (o, w, h) = from_bgra(&src, 16, 3, 2, 4);
        assert_eq!((w, h, blue(&o)), (2, 3, vec![2, 5, 1, 4, 0, 3]));
        assert_eq!(o[3], 255);
    }

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
