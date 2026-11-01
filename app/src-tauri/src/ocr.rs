// Reading text from pictures with the OS's own engine: Windows.Media.Ocr, macOS Vision, tesseract on Linux.
// Nothing is downloaded and nothing leaves the machine.

use image::RgbaImage;
use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct Word {
    pub text: String,
    /// Pixels in the picture that was read.
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    /// Index of the line the word belongs to.
    pub line: usize,
}

/// Small text reads far better when it's enlarged first; huge pictures are shrunk to the engine's limit.
fn prepare(img: &RgbaImage) -> (RgbaImage, f32) {
    let long = img.width().max(img.height());
    let k = if img.height() < 600 && long < 2500 { 2.0 } else if long > 9000 { 9000.0 / long as f32 } else { 1.0 };
    if k == 1.0 { return (img.clone(), 1.0); }
    let r = image::imageops::resize(img, (img.width() as f32 * k) as u32, (img.height() as f32 * k) as u32, image::imageops::FilterType::CatmullRom);
    (r, k)
}

pub async fn words(img: &RgbaImage) -> anyhow::Result<Vec<Word>> {
    let (big, k) = prepare(img);
    let mut w = tauri::async_runtime::spawn_blocking(move || imp::words(&big)).await??;
    for x in &mut w { x.x /= k; x.y /= k; x.width /= k; x.height /= k; }
    Ok(w)
}

/// Text in reading order, one line per line.
pub async fn recognize(img: &RgbaImage) -> anyhow::Result<String> {
    let w = words(img).await?;
    let mut out = String::new();
    let mut line = usize::MAX;
    for x in w {
        if x.line != line { if line != usize::MAX { out.push('\n'); } line = x.line; } else { out.push(' '); }
        out += &x.text;
    }
    Ok(out)
}

#[cfg(windows)]
mod imp {
    use super::Word;
    use windows::{
        Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap},
        Media::Ocr::OcrEngine,
        Storage::Streams::DataWriter,
    };

    pub fn words(img: &image::RgbaImage) -> anyhow::Result<Vec<Word>> {
        let engine = OcrEngine::TryCreateFromUserProfileLanguages()?;
        let mut bgra = img.as_raw().clone();
        for p in bgra.chunks_exact_mut(4) { p.swap(0, 2); }
        let writer = DataWriter::new()?;
        writer.WriteBytes(&bgra)?;
        let bmp = SoftwareBitmap::CreateCopyFromBuffer(&writer.DetachBuffer()?, BitmapPixelFormat::Bgra8, img.width() as i32, img.height() as i32)?;
        let result = engine.RecognizeAsync(&bmp)?.get()?;
        let mut out = Vec::new();
        for (i, line) in result.Lines()?.into_iter().enumerate() {
            for w in line.Words()? {
                let r = w.BoundingRect()?;
                out.push(Word { text: w.Text()?.to_string(), x: r.X, y: r.Y, width: r.Width, height: r.Height, line: i });
            }
        }
        Ok(out)
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::Word;
    use std::{io::Write, process::{Command, Stdio}};

    pub fn words(img: &image::RgbaImage) -> anyhow::Result<Vec<Word>> {
        let png = crate::export::png_bytes(img, None)?;
        let mut child = Command::new("tesseract").args(["stdin", "stdout", "--psm", "3", "tsv"])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()
            .map_err(|_| anyhow::anyhow!("Copy text needs tesseract: sudo apt install tesseract-ocr (or your distro's package)"))?;
        child.stdin.take().unwrap().write_all(&png)?;
        let out = child.wait_with_output()?;
        let mut words = Vec::new();
        let mut lines = std::collections::HashMap::new();
        for row in String::from_utf8_lossy(&out.stdout).lines().skip(1) {
            let c: Vec<&str> = row.split('\t').collect();
            if c.len() < 12 || c[0] != "5" || c[11].trim().is_empty() { continue; }
            let key = (c[2].to_string(), c[3].to_string(), c[4].to_string());
            let n = lines.len();
            let line = *lines.entry(key).or_insert(n);
            let f = |i: usize| c[i].parse::<f32>().unwrap_or(0.0);
            words.push(Word { text: c[11].to_string(), x: f(6), y: f(7), width: f(8), height: f(9), line });
        }
        Ok(words)
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::Word;
    use objc2::{rc::Retained, AnyThread};
    use objc2_core_foundation::CFData;
    use objc2_core_graphics::{CGBitmapInfo, CGColorRenderingIntent, CGColorSpace, CGDataProvider, CGImage, CGImageAlphaInfo};
    use objc2_foundation::{NSArray, NSDictionary};
    use objc2_vision::{VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel};

    pub fn words(img: &image::RgbaImage) -> anyhow::Result<Vec<Word>> {
        let (w, h) = (img.width() as usize, img.height() as usize);
        unsafe {
            let data = CFData::new(None, img.as_raw().as_ptr(), img.as_raw().len() as isize).ok_or_else(|| anyhow::anyhow!("CFData"))?;
            let provider = CGDataProvider::with_cf_data(Some(&data)).ok_or_else(|| anyhow::anyhow!("CGDataProvider"))?;
            let space = CGColorSpace::new_device_rgb().ok_or_else(|| anyhow::anyhow!("colour space"))?;
            let cg = CGImage::new(w, h, 8, 32, w * 4, Some(&space), CGBitmapInfo(CGImageAlphaInfo::PremultipliedLast.0),
                Some(&provider), std::ptr::null(), false, CGColorRenderingIntent::RenderingIntentDefault).ok_or_else(|| anyhow::anyhow!("CGImage"))?;
            let request = VNRecognizeTextRequest::init(VNRecognizeTextRequest::alloc());
            request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
            request.setUsesLanguageCorrection(true);
            let handler = VNImageRequestHandler::initWithCGImage_options(VNImageRequestHandler::alloc(), &cg, &NSDictionary::new());
            let req: Retained<VNRequest> = Retained::cast_unchecked(request.clone());
            handler.performRequests_error(&NSArray::from_retained_slice(&[req])).map_err(|e| anyhow::anyhow!("Vision: {e:?}"))?;
            let mut out = Vec::new();
            for (i, obs) in request.results().unwrap_or_default().iter().enumerate() {
                let Some(top) = obs.topCandidates(1).firstObject() else { continue };
                let text = top.string().to_string();
                // Vision boxes are normalised with the origin bottom-left; split the line into words evenly.
                let b = obs.boundingBox();
                let (lx, ly, lw, lh) = (b.origin.x as f32 * w as f32, (1.0 - b.origin.y as f32 - b.size.height as f32) * h as f32, b.size.width as f32 * w as f32, b.size.height as f32 * h as f32);
                let total: usize = text.chars().count().max(1);
                let mut pos = 0usize;
                for word in text.split_whitespace() {
                    let start = text[pos..].find(word).map(|o| pos + o).unwrap_or(pos);
                    let cs = text[..start].chars().count();
                    let cl = word.chars().count();
                    out.push(Word { text: word.to_string(), x: lx + lw * cs as f32 / total as f32, y: ly, width: lw * cl as f32 / total as f32, height: lh, line: i });
                    pos = start + word.len();
                }
            }
            Ok(out)
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_fixture() {
        if cfg!(target_os = "linux") && std::process::Command::new("tesseract").arg("--version").output().is_err() { eprintln!("tesseract not installed, skipped"); return; }
        let img = image::open(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/ocr.png")).unwrap().to_rgba8();
        let w = tauri::async_runtime::block_on(super::words(&img)).unwrap();
        let text: Vec<String> = w.iter().map(|x| x.text.to_lowercase()).collect();
        assert!(text.iter().any(|t| t.contains("grabbit")), "{text:?}");
        assert!(text.iter().any(|t| t.contains("192.168.1.10")), "{text:?}");
        let g = w.iter().find(|x| x.text.to_lowercase().contains("grabbit")).unwrap();
        assert!(g.x > 0.0 && g.x < 400.0 && g.y < 110.0, "box {:?}", (g.x, g.y));
    }
}
