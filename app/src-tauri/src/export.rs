// Turning a picture into files and clipboard content: Full (lossless), Smaller (long edge capped) and Chat (JPEG under
// a size budget). Metadata goes in as XMP only when the user set some; otherwise files carry none at all.

use crate::settings::{SaveFormat, Settings};
use anyhow::Result;
use clipboard_rs::{common::RustImage, Clipboard, ClipboardContent, ClipboardContext, RustImageData};
use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage, RgbaImage};
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Size { Full, Reduced, Chat }

pub fn stamp_name(prefix: &str) -> String {
    format!("{prefix} {}", chrono::Local::now().format("%Y-%m-%d %H.%M.%S"))
}

/// A file name in `dir` that doesn't exist yet: "name.ext", "name (2).ext", …
pub fn free(dir: &Path, name: &str, ext: &str) -> PathBuf {
    let mut p = dir.join(format!("{name}.{ext}"));
    let mut n = 2;
    while p.exists() { p = dir.join(format!("{name} ({n}).{ext}")); n += 1; }
    p
}

pub fn scale_to(img: &RgbaImage, long_edge: u32) -> RgbaImage {
    let (w, h) = img.dimensions();
    if w.max(h) <= long_edge { return img.clone(); }
    let k = long_edge as f32 / w.max(h) as f32;
    image::imageops::resize(img, ((w as f32 * k).round() as u32).max(1), ((h as f32 * k).round() as u32).max(1), FilterType::Lanczos3)
}

/// XMP packet for the user's metadata, or None when there's nothing to write.
pub fn xmp(s: &Settings) -> Option<Vec<u8>> {
    let m = &s.metadata;
    if m.author.is_empty() && m.copyright.is_empty() && m.custom.is_empty() { return None; }
    let esc = |t: &str| t.replace('&', "&amp;").replace('<', "&lt;").replace('"', "&quot;");
    let mut body = String::new();
    if !m.author.is_empty() { body += &format!("<dc:creator><rdf:Seq><rdf:li>{}</rdf:li></rdf:Seq></dc:creator>", esc(&m.author)); }
    if !m.copyright.is_empty() { body += &format!("<dc:rights><rdf:Alt><rdf:li xml:lang=\"x-default\">{}</rdf:li></rdf:Alt></dc:rights>", esc(&m.copyright)); }
    for (k, v) in &m.custom {
        let key: String = k.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
        if !key.is_empty() { body += &format!("<grabbit:{key}>{}</grabbit:{key}>", esc(v)); }
    }
    Some(format!(
        "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?><x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description rdf:about=\"\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:grabbit=\"https://github.com/JakeTheRabbit/grabbit/ns/1.0/\">{body}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>"
    ).into_bytes())
}

pub fn png_bytes(img: &RgbaImage, xmp: Option<&[u8]>) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, img.width(), img.height());
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        if let Some(x) = xmp { enc.add_itxt_chunk("XML:com.adobe.xmp".into(), String::from_utf8_lossy(x).into())?; }
        enc.write_header()?.write_image_data(img.as_raw())?;
    }
    Ok(out)
}

pub fn webp_bytes(img: &RgbaImage, xmp: Option<&[u8]>) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut enc = image_webp::WebPEncoder::new(&mut out);
    if let Some(x) = xmp { enc.set_xmp_metadata(x.to_vec()); }
    enc.encode(img.as_raw(), img.width(), img.height(), image_webp::ColorType::Rgba8)?;
    Ok(out)
}

/// JPEG at the best quality that fits `max_kb`, shrinking the picture if even quality 60 is too big.
pub fn chat_jpeg(img: &RgbaImage, long_edge: u32, max_kb: u32) -> Result<Vec<u8>> {
    let mut rgb = DynamicImage::ImageRgba8(scale_to(img, long_edge)).to_rgb8();
    loop {
        for q in [92u8, 85, 78, 70, 60] {
            let mut out = Vec::new();
            JpegEncoder::new_with_quality(&mut out, q).encode_image(&rgb)?;
            if out.len() <= max_kb as usize * 1024 { return Ok(out); }
        }
        let (w, h) = rgb.dimensions();
        if w.max(h) < 400 { anyhow::bail!("picture won't fit the chat size") }
        rgb = image::imageops::resize(&rgb, w * 3 / 4, h * 3 / 4, FilterType::Lanczos3);
    }
}

/// The saved, full-size copy of a capture.
pub fn save_full(s: &Settings, img: &RgbaImage, name: &str) -> Result<PathBuf> {
    let dir = PathBuf::from(&s.save_folder);
    std::fs::create_dir_all(&dir)?;
    let x = xmp(s);
    // WebP lossless tops out at 16383 px per side.
    let (bytes, ext) = if s.save_format == SaveFormat::WebpLossless && img.width().max(img.height()) <= 16383 {
        (webp_bytes(img, x.as_deref())?, "webp")
    } else {
        (png_bytes(img, x.as_deref())?, "png")
    };
    let p = free(&dir, name, ext);
    std::fs::write(&p, bytes)?;
    Ok(p)
}

/// Put a picture on the clipboard: the pixels, plus (optionally) a named file so chat apps attach it.
pub fn copy(s: &Settings, img: &RgbaImage, size: Size, name: &str) -> Result<PathBuf> {
    let tmp = std::env::temp_dir().join("Grabbit");
    std::fs::create_dir_all(&tmp)?;
    let x = xmp(s);
    let (bytes, ext, pixels) = match size {
        Size::Full => (png_bytes(img, x.as_deref())?, "png", img.clone()),
        Size::Reduced => { let r = scale_to(img, s.reduced_long_edge); (png_bytes(&r, x.as_deref())?, "png", r) }
        Size::Chat => {
            let j = chat_jpeg(img, s.chat_long_edge, s.chat_max_kb)?;
            let px = image::load_from_memory(&j)?.to_rgba8();
            (j, "jpg", px)
        }
    };
    let file = tmp.join(format!("{name}.{ext}"));
    std::fs::write(&file, &bytes)?;
    let ctx = ClipboardContext::new().map_err(|e| anyhow::anyhow!("clipboard: {e}"))?;
    let mut contents = vec![ClipboardContent::Image(RustImageData::from_dynamic_image(DynamicImage::ImageRgba8(pixels)))];
    if s.copy_as_file { contents.push(ClipboardContent::Files(vec![file.to_string_lossy().into_owned()])); }
    ctx.set(contents).map_err(|e| anyhow::anyhow!("clipboard: {e}"))?;
    Ok(file)
}

pub fn copy_text(t: &str) -> Result<()> {
    ClipboardContext::new().and_then(|c| c.set_text(t.to_string())).map_err(|e| anyhow::anyhow!("clipboard: {e}"))
}

pub fn copy_file(p: &Path) -> Result<()> {
    ClipboardContext::new().and_then(|c| c.set_files(vec![p.to_string_lossy().into_owned()])).map_err(|e| anyhow::anyhow!("clipboard: {e}"))
}
