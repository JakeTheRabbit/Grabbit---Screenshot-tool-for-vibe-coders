// Branding and protection for everything that leaves the app.
// - Logo/overlay: a picture stamped in a corner at a set size and opacity.
// - Invisible watermark: 56 bits (owner hash, capture id, 16-bit check) hidden in the 8×8 DCT of the brightness,
//   repeated over the whole picture. It survives re-saving, JPEG down to about quality 70, and cropping. It does not
//   survive heavy resizing. `check` reads it back from a found copy.

use crate::settings::{Branding, Settings};
use image::{imageops::FilterType, Rgba, RgbaImage};

const BITS: usize = 56;
const STRENGTH: f32 = 14.0;
/// Blocks this flat are left alone, so blank areas of a screenshot stay perfectly clean.
const MIN_TEXTURE: f32 = 40.0;
const C1: (usize, usize) = (2, 3);
const C2: (usize, usize) = (3, 2);

pub fn apply(s: &Settings, img: &RgbaImage, id: u32) -> RgbaImage {
    let mut out = img.clone();
    let b = &s.branding;
    if b.on_images { stamp_logo(&mut out, b); }
    if b.invisible_mark { embed(&mut out, payload(&b.owner, id)); }
    out
}

/// Seconds since 2024 / 4: unique per capture within a few seconds, fits 24 bits for ~2 years, then wraps.
pub fn capture_id() -> u32 {
    let secs = chrono::Utc::now().timestamp() - 1_704_067_200;
    ((secs / 4) as u32) & 0xFF_FFFF
}

pub fn owner_hash(owner: &str) -> u32 {
    // FNV-1a, folded to 16 bits.
    let mut h: u32 = 0x811c9dc5;
    for b in owner.trim().to_lowercase().bytes() { h ^= b as u32; h = h.wrapping_mul(0x01000193); }
    (h ^ (h >> 16)) & 0xFFFF
}

/// CRC-16/CCITT over the 40 data bits. The reader tries thousands of alignments, so the check must be this strong.
fn crc16(v: u64) -> u16 {
    let mut c: u16 = 0xFFFF;
    for i in 0..40 { let bit = ((v >> (39 - i)) & 1) as u16 ^ (c >> 15); c <<= 1; if bit == 1 { c ^= 0x1021; } }
    c
}

/// 16-bit owner hash | 24-bit capture id | 16-bit check.
pub fn payload(owner: &str, id: u32) -> u64 {
    let v = ((owner_hash(owner) as u64) << 24) | (id as u64 & 0xFF_FFFF);
    (v << 16) | crc16(v) as u64
}

pub fn stamp_logo(img: &mut RgbaImage, b: &Branding) {
    let Ok(logo) = image::open(&b.logo_path) else { return };
    let w = ((img.width() as f32 * b.scale.clamp(0.02, 1.0)) as u32).max(8);
    let h = (logo.height() as f32 * w as f32 / logo.width() as f32) as u32;
    let mut logo = logo.resize_exact(w, h.max(1), FilterType::Lanczos3).to_rgba8();
    for p in logo.pixels_mut() { p[3] = (p[3] as f32 * b.opacity.clamp(0.0, 1.0)) as u8; }
    let m = (img.width().min(img.height()) / 40) as i64;
    let (iw, ih, lw, lh) = (img.width() as i64, img.height() as i64, logo.width() as i64, logo.height() as i64);
    let (x, y) = match b.position.as_str() {
        "top-left" => (m, m),
        "top-right" => (iw - lw - m, m),
        "bottom-left" => (m, ih - lh - m),
        "center" => ((iw - lw) / 2, (ih - lh) / 2),
        _ => (iw - lw - m, ih - lh - m),
    };
    image::imageops::overlay(img, &logo, x, y);
}

// ---- 8×8 DCT (orthonormal) ----

fn basis() -> [[f32; 8]; 8] {
    let mut c = [[0f32; 8]; 8];
    for (u, row) in c.iter_mut().enumerate() {
        let a = if u == 0 { (1.0f32 / 8.0).sqrt() } else { (2.0f32 / 8.0).sqrt() };
        for (x, v) in row.iter_mut().enumerate() { *v = a * (((2 * x + 1) as f32 * u as f32 * std::f32::consts::PI) / 16.0).cos(); }
    }
    c
}

fn dct(b: &[[f32; 8]; 8], c: &[[f32; 8]; 8]) -> [[f32; 8]; 8] {
    let mut t = [[0f32; 8]; 8];
    let mut o = [[0f32; 8]; 8];
    for u in 0..8 { for y in 0..8 { t[u][y] = (0..8).map(|x| c[u][x] * b[y][x]).sum(); } }
    for v in 0..8 { for u in 0..8 { o[v][u] = (0..8).map(|y| c[v][y] * t[u][y]).sum(); } }
    o
}

fn idct(d: &[[f32; 8]; 8], c: &[[f32; 8]; 8]) -> [[f32; 8]; 8] {
    let mut t = [[0f32; 8]; 8];
    let mut o = [[0f32; 8]; 8];
    for y in 0..8 { for u in 0..8 { t[y][u] = (0..8).map(|v| c[v][y] * d[v][u]).sum(); } }
    for y in 0..8 { for x in 0..8 { o[y][x] = (0..8).map(|u| c[u][x] * t[y][u]).sum(); } }
    o
}

fn luma(p: &Rgba<u8>) -> f32 { 0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32 }

fn block(img: &RgbaImage, bx: u32, by: u32) -> [[f32; 8]; 8] {
    let mut b = [[0f32; 8]; 8];
    for (y, row) in b.iter_mut().enumerate() { for (x, v) in row.iter_mut().enumerate() { *v = luma(img.get_pixel(bx + x as u32, by + y as u32)) - 128.0; } }
    b
}

/// Texture measured on coefficients the mark doesn't touch, so embedder and reader agree on which blocks carry bits.
fn texture(d: &[[f32; 8]; 8]) -> f32 {
    let mut e = 0.0;
    for (v, row) in d.iter().enumerate() { for (u, x) in row.iter().enumerate() {
        if (v, u) != (0, 0) && (v, u) != C1 && (v, u) != C2 && v + u <= 6 { e += x.abs(); }
    } }
    e
}

/// Bits are laid out in an 8×7 tile of blocks repeated over the picture. A crop only shifts the tile's phase, which the
/// reader searches.
const TW: usize = 8;
const TH: usize = 7;
fn bit_for(bx: u32, by: u32) -> usize { (by as usize / 8 % TH) * TW + bx as usize / 8 % TW }

pub fn embed(img: &mut RgbaImage, payload: u64) {
    let c = basis();
    let (w, h) = (img.width() / 8 * 8, img.height() / 8 * 8);
    for by in (0..h).step_by(8) { for bx in (0..w).step_by(8) {
        let src = block(img, bx, by);
        let mut d = dct(&src, &c);
        if texture(&d) < MIN_TEXTURE { continue; }
        let bit = (payload >> (BITS - 1 - bit_for(bx, by))) & 1 == 1;
        let (a, b) = (d[C1.0][C1.1], d[C2.0][C2.1]);
        let mean = (a + b) / 2.0;
        let half = ((a - b).abs() / 2.0).max(STRENGTH / 2.0);
        if bit { d[C1.0][C1.1] = mean + half; d[C2.0][C2.1] = mean - half; } else { d[C1.0][C1.1] = mean - half; d[C2.0][C2.1] = mean + half; }
        let out = idct(&d, &c);
        for y in 0..8 { for x in 0..8 {
            let delta = out[y][x] - src[y][x];
            let p = img.get_pixel_mut(bx + x as u32, by + y as u32);
            for ch in 0..3 { p[ch] = (p[ch] as f32 + delta).round().clamp(0.0, 255.0) as u8; }
        } }
    } }
}

/// Read the mark back. Searches the 64 pixel alignments and the 56 tile phases, so a cropped copy still reads.
/// Returns the payload when its check byte matches.
pub fn read(img: &RgbaImage) -> Option<u64> {
    let c = basis();
    let mut best: Option<(u64, f32)> = None;
    for oy in 0..8 { for ox in 0..8 {
        let mut votes = [0f32; BITS];
        let mut counts = [0u32; BITS];
        let (w, h) = (img.width().saturating_sub(ox), img.height().saturating_sub(oy));
        for by in (0..h / 8 * 8).step_by(8) { for bx in (0..w / 8 * 8).step_by(8) {
            let d = dct(&block(img, bx + ox, by + oy), &c);
            if texture(&d) < MIN_TEXTURE * 0.8 { continue; }
            let i = bit_for(bx, by);
            votes[i] += (d[C1.0][C1.1] - d[C2.0][C2.1]).clamp(-STRENGTH, STRENGTH);
            counts[i] += 1;
        } }
        if counts.iter().any(|&n| n == 0) { continue; }
        // A real mark pushes every block the same way; a clean picture's votes mostly cancel out.
        let conf: f32 = votes.iter().zip(counts).map(|(s, n)| s.abs() / n as f32).sum::<f32>() / BITS as f32;
        if conf < STRENGTH * 0.4 { continue; }
        for py in 0..TH { for px in 0..TW {
            let mut v = 0u64;
            for ty in 0..TH { for tx in 0..TW {
                // Tile cell (tx,ty) in the copy is cell (tx+px, ty+py) of the original.
                let orig = ((ty + py) % TH) * TW + (tx + px) % TW;
                if votes[ty * TW + tx] > 0.0 { v |= 1 << (BITS - 1 - orig); }
            } }
            if crc16(v >> 16) == (v & 0xFFFF) as u16 && v >> 16 != 0 && best.map(|(_, c)| conf > c).unwrap_or(true) { best = Some((v, conf)); }
        } }
    } }
    best.map(|(v, _)| v)
}

pub struct Found { pub owner_hash: u32, pub id: u32 }

pub fn check(img: &RgbaImage) -> Option<Found> {
    read(img).map(|v| Found { owner_hash: ((v >> 40) & 0xFFFF) as u32, id: ((v >> 16) & 0xFF_FFFF) as u32 })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> RgbaImage {
        // Screenshot-like: flat areas plus textured text-ish areas.
        let mut img = RgbaImage::from_pixel(640, 400, Rgba([245, 245, 245, 255]));
        for y in 40..360 { for x in 40..600 {
            let v = ((x * 7 + y * 13) % 31) as u8 * 6 + ((x / 3 + y / 5) % 2) as u8 * 60;
            img.put_pixel(x, y, Rgba([v, v / 2 + 40, 255 - v, 255]));
        } }
        img
    }

    #[test]
    fn round_trip() {
        let mut img = sample();
        let p = payload("ben", 123456);
        embed(&mut img, p);
        assert_eq!(read(&img), Some(p));
        let f = check(&img).unwrap();
        assert_eq!((f.owner_hash, f.id), (owner_hash("ben"), 123456));
    }

    #[test]
    fn survives_jpeg() {
        let mut img = sample();
        let p = payload("ben", 42);
        embed(&mut img, p);
        let mut j = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut j, 80).encode_image(&image::DynamicImage::ImageRgba8(img).to_rgb8()).unwrap();
        let back = image::load_from_memory(&j).unwrap().to_rgba8();
        assert_eq!(read(&back), Some(p));
    }

    #[test]
    fn survives_crop() {
        let mut img = sample();
        let p = payload("ben", 777);
        embed(&mut img, p);
        let cropped = image::imageops::crop_imm(&img, 37, 61, 500, 300).to_image();
        assert_eq!(read(&cropped), Some(p));
    }

    #[test]
    fn clean_image_reads_nothing() {
        assert_eq!(read(&sample()), None);
    }

    #[test]
    fn flat_areas_untouched() {
        let mut img = sample();
        let before = *img.get_pixel(5, 5);
        embed(&mut img, payload("x", 1));
        assert_eq!(*img.get_pixel(5, 5), before);
    }
}
