// Turning a picture into files and clipboard content: Full (lossless), Smaller (long edge capped) and Chat (JPEG under
// a size budget). Metadata goes in as XMP only when the user set some; otherwise files carry none at all.

use crate::settings::{SaveFormat, Settings};
use anyhow::Result;
use clipboard_rs::{Clipboard, ClipboardContext};
#[cfg(not(windows))]
use clipboard_rs::{common::RustImage, ClipboardContent, RustImageData};
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
    let (file, pixels) = copy_file_for(s, img, size, name)?;
    let files = if s.copy_as_file { vec![file.to_string_lossy().into_owned()] } else { vec![] };
    set_clipboard(Clip { image: Some(&pixels), files: &files, text: None, html: None })?;
    Ok(file)
}

/// Several pictures at once: all of them as files (chats attach each one), and the first as pixels.
pub fn copy_many(s: &Settings, imgs: &[(RgbaImage, String)], size: Size) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    let mut first = None;
    for (img, name) in imgs {
        let (f, px) = copy_file_for(s, img, size, name)?;
        first.get_or_insert(px);
        out.push(f);
    }
    let files: Vec<String> = out.iter().map(|f| f.to_string_lossy().into_owned()).collect();
    set_clipboard(Clip { image: first.as_ref(), files: &files, text: None, html: None })?;
    Ok(out)
}

/// The file a copy puts on the clipboard (in the temp Grabbit folder), and the pixels that go with it.
fn copy_file_for(s: &Settings, img: &RgbaImage, size: Size, name: &str) -> Result<(PathBuf, RgbaImage)> {
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
    Ok((file, pixels))
}

pub fn copy_text(t: &str) -> Result<()> {
    ClipboardContext::new().and_then(|c| c.set_text(t.to_string())).map_err(|e| anyhow::anyhow!("clipboard: {e}"))
}

pub fn copy_file(p: &Path) -> Result<()> {
    ClipboardContext::new().and_then(|c| c.set_files(vec![p.to_string_lossy().into_owned()])).map_err(|e| anyhow::anyhow!("clipboard: {e}"))
}

/// Everything that goes on the clipboard in one go. Windows gets one clipboard session for all formats (clipboard-rs
/// closes the clipboard after an image, which silently drops the formats after it).
pub struct Clip<'a> { pub image: Option<&'a RgbaImage>, pub files: &'a [String], pub text: Option<&'a str>, pub html: Option<&'a str> }

pub fn set_clipboard(c: Clip) -> Result<()> {
    #[cfg(windows)]
    {
        use clipboard_win::{formats, options, raw};
        let _open = clipboard_win::Clipboard::new_attempts(10).map_err(|e| anyhow::anyhow!("clipboard busy: {e}"))?;
        raw::empty().map_err(|e| anyhow::anyhow!("clipboard: {e}"))?;
        if let Some(img) = c.image {
            raw::set_without_clear(formats::CF_DIB, &dib(img)).map_err(|e| anyhow::anyhow!("clipboard picture: {e}"))?;
            if let Some(png) = raw::register_format("PNG") { let _ = raw::set_without_clear(png.get(), &png_bytes(img, None)?); }
        }
        if !c.files.is_empty() { raw::set_file_list_with(c.files, options::NoClear).map_err(|e| anyhow::anyhow!("clipboard files: {e}"))?; }
        if let Some(t) = c.text { raw::set_string_with(t, options::NoClear).map_err(|e| anyhow::anyhow!("clipboard text: {e}"))?; }
        if let (Some(h), Some(f)) = (c.html, raw::register_format("HTML Format")) { let _ = raw::set_without_clear(f.get(), cf_html(h).as_bytes()); }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let ctx = ClipboardContext::new().map_err(|e| anyhow::anyhow!("clipboard: {e}"))?;
        let mut v = Vec::new();
        if let Some(img) = c.image { v.push(ClipboardContent::Image(RustImageData::from_dynamic_image(DynamicImage::ImageRgba8(img.clone())))); }
        if !c.files.is_empty() { v.push(ClipboardContent::Files(c.files.to_vec())); }
        if let Some(t) = c.text { v.push(ClipboardContent::Text(t.to_string())); }
        if let Some(h) = c.html { v.push(ClipboardContent::Html(h.to_string())); }
        ctx.set(v).map_err(|e| anyhow::anyhow!("clipboard: {e}"))
    }
}

/// CF_DIB: a 32-bit bottom-up bitmap with a BITMAPINFOHEADER.
#[cfg(windows)]
fn dib(img: &RgbaImage) -> Vec<u8> {
    let (w, h) = img.dimensions();
    let mut out = Vec::with_capacity(40 + (w * h * 4) as usize);
    for v in [40u32, w] { out.extend_from_slice(&v.to_le_bytes()); }
    out.extend_from_slice(&(h as i32).to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&32u16.to_le_bytes());
    for v in [0u32, w * h * 4, 2835, 2835, 0, 0] { out.extend_from_slice(&v.to_le_bytes()); }
    for y in (0..h).rev() { for x in 0..w { let p = img.get_pixel(x, y); out.extend_from_slice(&[p[2], p[1], p[0], p[3]]); } }
    out
}

/// The CF_HTML wrapper Windows apps expect (byte offsets in a fixed-width header).
#[cfg(windows)]
fn cf_html(fragment: &str) -> String {
    let head = "Version:0.9\r\nStartHTML:0000000000\r\nEndHTML:0000000000\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n";
    let pre = "<html><body>\r\n<!--StartFragment-->";
    let post = "<!--EndFragment-->\r\n</body></html>";
    let start_html = head.len();
    let start_frag = start_html + pre.len();
    let end_frag = start_frag + fragment.len();
    let end_html = end_frag + post.len();
    format!("Version:0.9\r\nStartHTML:{start_html:010}\r\nEndHTML:{end_html:010}\r\nStartFragment:{start_frag:010}\r\nEndFragment:{end_frag:010}\r\n{pre}{fragment}{post}")
}
