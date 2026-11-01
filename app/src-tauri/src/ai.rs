// Optional AI edits with the user's own key: remove background, remove or change something in a marked area, change
// text in a picture, and ask about a picture. Nothing is sent anywhere unless an AI button is pressed.

use crate::{export, settings::Settings, state};
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use image::{Rgba, RgbaImage};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::AppHandle;

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Region { pub x: u32, pub y: u32, pub width: u32, pub height: u32 }

#[derive(Deserialize, Debug)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Op {
    RemoveBackground,
    RemoveObject { region: Region },
    EditObject { region: Region, prompt: String },
    EditText { region: Region, text: String },
    Edit { prompt: String },
}

fn http() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder().timeout(Duration::from_secs(300)).user_agent("Grabbit").build().unwrap()
}

fn provider(s: &Settings) -> Result<(&str, &str)> {
    let a = &s.ai;
    let p = if a.provider.is_empty() { "openai" } else { a.provider.as_str() };
    let key = match p { "openai" => &a.openai_key, "google" => &a.google_key, "xai" => &a.xai_key, other => bail!("unknown AI provider {other}") };
    if key.is_empty() { bail!("Add your {} API key in Settings → AI", match p { "openai" => "OpenAI", "google" => "Google AI", _ => "xAI" }) }
    Ok((p, key))
}

fn image_model<'a>(s: &'a Settings, p: &str) -> &'a str {
    if !s.ai.image_model.is_empty() { return &s.ai.image_model; }
    match p { "google" => "gemini-2.5-flash-image", "xai" => "grok-imagine-image", _ => "gpt-image-1.5" }
}

fn chat_model<'a>(s: &'a Settings, p: &str) -> &'a str {
    if !s.ai.chat_model.is_empty() { return &s.ai.chat_model; }
    match p { "google" => "gemini-2.5-flash", "xai" => "grok-4", _ => "gpt-5-mini" }
}

fn png(img: &RgbaImage) -> Result<Vec<u8>> { export::png_bytes(img, None) }
fn data_url(img: &RgbaImage) -> Result<String> { Ok(format!("data:image/png;base64,{}", B64.encode(png(img)?))) }

/// A copy with the region outlined in magenta, for providers that take no mask.
fn marked(img: &RgbaImage, r: Region) -> RgbaImage {
    let mut m = img.clone();
    let t = (img.width().max(img.height()) / 300).max(3);
    let (x1, y1) = ((r.x + r.width).min(img.width() - 1), (r.y + r.height).min(img.height() - 1));
    for y in r.y..=y1 { for x in r.x..=x1 {
        if x < r.x + t || x + t > x1 || y < r.y + t || y + t > y1 { m.put_pixel(x, y, Rgba([255, 0, 255, 255])); }
    } }
    m
}

/// OpenAI mask: transparent where the model may change things.
fn mask(img: &RgbaImage, r: Region) -> RgbaImage {
    let mut m = RgbaImage::from_pixel(img.width(), img.height(), Rgba([0, 0, 0, 255]));
    for y in r.y..(r.y + r.height).min(img.height()) { for x in r.x..(r.x + r.width).min(img.width()) { m.put_pixel(x, y, Rgba([0, 0, 0, 0])); } }
    m
}

fn prompt_for(op: &Op, masked: bool) -> String {
    let area = if masked { "the masked area" } else { "the area outlined in magenta" };
    let tail = if masked { "" } else { " Remove the magenta outline itself." };
    let keep = " Keep everything else exactly as it is: same layout, colours, text and resolution.";
    match op {
        Op::RemoveBackground => "Remove the background completely and keep only the main subject, with clean edges.".into(),
        Op::RemoveObject { .. } => format!("Remove what is inside {area} and fill it in naturally so it looks like it was never there.{tail}{keep}"),
        Op::EditObject { prompt, .. } => format!("In {area}: {prompt}.{tail}{keep}"),
        Op::EditText { text, .. } => format!("Change the text inside {area} to read exactly: \"{text}\". Match the original font, size, weight, colour and alignment.{tail}{keep}"),
        Op::Edit { prompt } => format!("{prompt}.{keep}"),
    }
}

fn region(op: &Op) -> Option<Region> {
    match op { Op::RemoveObject { region } | Op::EditObject { region, .. } | Op::EditText { region, .. } => Some(*region), _ => None }
}

/// Green-screen key for providers that can't return transparency.
fn key_green(img: &mut RgbaImage) {
    for p in img.pixels_mut() {
        let (r, g, b) = (p[0] as i32, p[1] as i32, p[2] as i32);
        let green = g - r.max(b);
        if green > 70 { p[3] = 0; } else if green > 25 { p[3] = (255 - (green - 25) * 255 / 45).clamp(0, 255) as u8; p[1] = r.max(b).max(p[1] as i32 - green) as u8; }
    }
}

pub fn edit(s: &Settings, img: &RgbaImage, op: &Op) -> Result<RgbaImage> {
    let (p, key) = provider(s)?;
    let model = image_model(s, p);
    let c = http();
    let out_bytes: Vec<u8> = match p {
        "openai" => {
            let base = if s.ai.openai_base.is_empty() { "https://api.openai.com/v1" } else { s.ai.openai_base.trim_end_matches('/') };
            let mut form = reqwest::blocking::multipart::Form::new()
                .text("model", model.to_string())
                .text("prompt", prompt_for(op, true))
                .part("image[]", reqwest::blocking::multipart::Part::bytes(png(img)?).file_name("image.png").mime_str("image/png")?);
            if let Some(r) = region(op) { form = form.part("mask", reqwest::blocking::multipart::Part::bytes(png(&mask(img, r))?).file_name("mask.png").mime_str("image/png")?); }
            if matches!(op, Op::RemoveBackground) { form = form.text("background", "transparent"); }
            if !model.contains("mini") { form = form.text("input_fidelity", "high"); }
            let r: Value = c.post(format!("{base}/images/edits")).bearer_auth(key).multipart(form).send()?.json()?;
            let b = r["data"][0]["b64_json"].as_str().with_context(|| format!("OpenAI: {}", r["error"]["message"].as_str().unwrap_or("no image returned")))?;
            B64.decode(b)?
        }
        "google" => {
            let src = match region(op) { Some(r) => marked(img, r), None => img.clone() };
            let mut prompt = prompt_for(op, false);
            if matches!(op, Op::RemoveBackground) { prompt = "Replace the background with a flat, pure green (#00FF00) colour and keep only the main subject, with clean edges. Do not change the subject.".into(); }
            let body = json!({
                "contents": [{ "parts": [{ "text": prompt }, { "inline_data": { "mime_type": "image/png", "data": B64.encode(png(&src)?) } }] }],
                "generationConfig": { "responseModalities": ["TEXT", "IMAGE"] }
            });
            let r: Value = c.post(format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent")).header("x-goog-api-key", key).json(&body).send()?.json()?;
            let parts = r["candidates"][0]["content"]["parts"].as_array().cloned().unwrap_or_default();
            let b = parts.iter().find_map(|p| p["inlineData"]["data"].as_str().or(p["inline_data"]["data"].as_str()))
                .with_context(|| format!("Google: {}", r["error"]["message"].as_str().or(parts.iter().find_map(|p| p["text"].as_str())).unwrap_or("no image returned")))?;
            B64.decode(b)?
        }
        _ => {
            let src = match region(op) { Some(r) => marked(img, r), None => img.clone() };
            let mut prompt = prompt_for(op, false);
            if matches!(op, Op::RemoveBackground) { prompt = "Replace the background with a flat, pure green (#00FF00) colour and keep only the main subject unchanged.".into(); }
            let r: Value = c.post("https://api.x.ai/v1/images/edits").bearer_auth(key)
                .json(&json!({ "model": model, "prompt": prompt, "image": { "url": data_url(&src)?, "type": "image_url" }, "response_format": "b64_json" })).send()?.json()?;
            let b = r["data"][0]["b64_json"].as_str().with_context(|| format!("xAI: {}", r["error"].as_str().or(r["error"]["message"].as_str()).unwrap_or("no image returned")))?;
            B64.decode(b)?
        }
    };
    let mut out = image::load_from_memory(&out_bytes)?.to_rgba8();
    if matches!(op, Op::RemoveBackground) && p != "openai" { key_green(&mut out); }
    // Providers may return a different size; bring it back to the original so drawings line up.
    if out.dimensions() != img.dimensions() { out = image::imageops::resize(&out, img.width(), img.height(), image::imageops::FilterType::Lanczos3); }
    Ok(out)
}

pub fn ask(s: &Settings, img: &RgbaImage, question: &str) -> Result<String> {
    let (p, key) = provider(s)?;
    let model = chat_model(s, p);
    let c = http();
    let url = data_url(&crate::export::scale_to(img, 2048))?;
    match p {
        "google" => {
            let body = json!({ "contents": [{ "parts": [{ "text": question }, { "inline_data": { "mime_type": "image/png", "data": url.split_once(',').unwrap().1 } }] }] });
            let r: Value = c.post(format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent")).header("x-goog-api-key", key).json(&body).send()?.json()?;
            r["candidates"][0]["content"]["parts"].as_array().and_then(|a| a.iter().find_map(|p| p["text"].as_str())).map(String::from)
                .with_context(|| format!("Google: {}", r["error"]["message"].as_str().unwrap_or("no answer")))
        }
        _ => {
            let base = match p { "xai" => "https://api.x.ai/v1", _ if !s.ai.openai_base.is_empty() => s.ai.openai_base.trim_end_matches('/'), _ => "https://api.openai.com/v1" };
            let body = json!({ "model": model, "stream": false, "messages": [{ "role": "user", "content": [{ "type": "text", "text": question }, { "type": "image_url", "image_url": { "url": url } }] }] });
            let raw = c.post(format!("{base}/chat/completions")).bearer_auth(key).json(&body).send()?.text()?;
            let r: Value = serde_json::from_str(&raw).with_context(|| format!("unexpected answer: {}", raw.chars().take(300).collect::<String>()))?;
            r["choices"][0]["message"]["content"].as_str().map(String::from)
                .with_context(|| format!("{}: {}", if p == "xai" { "xAI" } else { "OpenAI" }, r["error"]["message"].as_str().or(r["error"].as_str()).unwrap_or("no answer")))
        }
    }
}

#[derive(serde::Serialize, Clone, Debug, Default)]
pub struct Description { pub summary: String, pub tags: Vec<String> }

const DESCRIBE: &str = "Explain this screenshot for someone who can't see it, in one paragraph of plain English (3-5 sentences): what app or page it is, what it shows, the important numbers, names or messages, and anything that looks wrong or unusual. Then on a new line write 'Tags:' followed by 5 to 10 short lowercase tags separated by commas.";

/// One paragraph of explanation plus tags, from the user's AI provider (or a local OpenAI-compatible one).
pub fn describe(s: &Settings, img: &RgbaImage) -> Result<Description> {
    let out = ask(s, img, DESCRIBE)?;
    let (body, tags) = match out.rsplit_once("Tags:").or_else(|| out.rsplit_once("tags:")) {
        Some((b, t)) => (b.trim().to_string(), t.split(',').map(|x| x.trim().trim_matches('.').to_lowercase()).filter(|x| !x.is_empty()).collect()),
        None => (out.trim().to_string(), vec![]),
    };
    Ok(Description { summary: body, tags })
}

#[tauri::command]
pub async fn ai_describe(app: AppHandle, data_url: String) -> Result<Description, String> {
    let s = state(&app).settings.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Description> {
        let img = image::load_from_memory(&B64.decode(data_url.split_once(',').map(|x| x.1).unwrap_or(&data_url))?)?.to_rgba8();
        describe(&s, &img)
    }).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_edit(app: AppHandle, data_url: String, op: Op) -> Result<String, String> {
    let s = state(&app).settings.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<String> {
        let img = image::load_from_memory(&B64.decode(data_url.split_once(',').map(|x| x.1).unwrap_or(&data_url))?)?.to_rgba8();
        let out = edit(&s, &img, &op)?;
        Ok(format!("data:image/png;base64,{}", B64.encode(png(&out)?)))
    }).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_ask(app: AppHandle, data_url: String, question: String) -> Result<String, String> {
    let s = state(&app).settings.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<String> {
        let img = image::load_from_memory(&B64.decode(data_url.split_once(',').map(|x| x.1).unwrap_or(&data_url))?)?.to_rgba8();
        ask(&s, &img, &question)
    }).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_is_clear_only_inside() {
        let img = RgbaImage::new(10, 10);
        let m = mask(&img, Region { x: 2, y: 2, width: 3, height: 3 });
        assert_eq!(m.get_pixel(3, 3)[3], 0);
        assert_eq!(m.get_pixel(0, 0)[3], 255);
    }

    #[test]
    fn green_key() {
        let mut img = RgbaImage::from_pixel(2, 1, Rgba([0, 255, 0, 255]));
        img.put_pixel(1, 0, Rgba([200, 30, 40, 255]));
        key_green(&mut img);
        assert_eq!(img.get_pixel(0, 0)[3], 0);
        assert_eq!(img.get_pixel(1, 0)[3], 255);
    }

    #[test]
    fn ops_parse() {
        let o: Op = serde_json::from_str(r#"{"op":"editText","region":{"x":1,"y":2,"width":3,"height":4},"text":"Hi"}"#).unwrap();
        assert!(matches!(o, Op::EditText { .. }));
    }
}
