// A notes folder next to every recording, for people and for coding agents that can't watch video:
//   "<video> notes/transcript.md"   what was said, with times, and a still every so often
//   "<video> notes/captions.vtt"    the same words as captions
//   "<video> notes/frames/0001.jpg" stills through the recording
//   "<video> notes/recording.json"  all of it as data
// The spoken words also go into History, so recordings can be found by what was said.

use crate::{settings::Settings, studio, studio::Cue, video};
use anyhow::Result;
use std::path::{Path, PathBuf};

pub struct Notes { pub dir: PathBuf, pub text: String }

fn clock(t: f64) -> String { let t = t.max(0.0) as u64; if t >= 3600 { format!("{}:{:02}:{:02}", t / 3600, t / 60 % 60, t % 60) } else { format!("{}:{:02}", t / 60, t % 60) } }

fn vtt_time(t: f64) -> String {
    let ms = (t.max(0.0) * 1000.0).round() as u64;
    format!("{:02}:{:02}:{:02}.{:03}", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000)
}

pub fn vtt(cues: &[Cue]) -> String {
    let mut s = String::from("WEBVTT\n");
    for c in cues { s += &format!("\n{} --> {}\n{}\n", vtt_time(c.start), vtt_time(c.end), c.text.trim()); }
    s
}

/// Seconds between stills: about thirty through the recording, never closer than five seconds apart.
fn every(duration: f64) -> f64 { (duration / 30.0).max(5.0) }

/// The transcript: spoken lines and stills in time order.
pub fn markdown(name: &str, recorded: &str, duration: f64, video_file: &str, cues: &[Cue], frames: &[(f64, String)], why_no_words: &str) -> String {
    let mut s = format!("# {name}\n\n- Recorded: {recorded}\n- Length: {}\n- Video: [{video_file}](<../{video_file}>)\n\n## What happened\n\n", clock(duration));
    if cues.is_empty() { s += &format!("_{why_no_words}_\n\n"); }
    let (mut c, mut f) = (cues.iter().peekable(), frames.iter().peekable());
    loop {
        let take_frame = match (c.peek(), f.peek()) {
            (None, None) => break,
            (Some(_), None) => false,
            (None, Some(_)) => true,
            (Some(a), Some(b)) => b.0 <= a.start,
        };
        if take_frame { let (t, file) = f.next().unwrap(); s += &format!("![{}](frames/{file})\n\n", clock(*t)); }
        else { let a = c.next().unwrap(); s += &format!("**[{}]** {}\n\n", clock(a.start), a.text.trim()); }
    }
    s
}

pub fn write(s: &Settings, path: &Path) -> Result<Notes> {
    let info = video::probe(s, path)?;
    let stem = path.file_stem().map(|x| x.to_string_lossy().into_owned()).unwrap_or_else(|| "Recording".into());
    let file = path.file_name().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default();
    let dir = path.with_file_name(format!("{stem} notes"));
    let frames_dir = dir.join("frames");
    std::fs::create_dir_all(&frames_dir)?;

    // Words: only when transcription works without asking (a local model, or an OpenAI key).
    let (cues, why) = if info.tracks.is_empty() { (Vec::new(), "No sound was recorded.".to_string()) } else {
        match studio::caption_engine(s) {
            "local" | "openai" => match studio::transcribe(s, path) { Ok(c) => (c, "Nothing was said.".into()), Err(e) => (Vec::new(), format!("Couldn't read the words: {e}")) },
            _ => (Vec::new(), "Words need captions turned on: open the recording in the editor and press Captions once.".into()),
        }
    };

    // Stills.
    let gap = every(info.duration);
    let args: Vec<String> = ["-hide_banner", "-v", "error", "-y", "-i"].iter().map(|x| x.to_string())
        .chain([path.to_string_lossy().into_owned(), "-vf".into(), format!("fps=1/{gap:.3},scale='min(1280,iw)':-2"), "-q:v".into(), "4".into(),
            frames_dir.join("%04d.jpg").to_string_lossy().into_owned()]).collect();
    let _ = video::run(&video::ffmpeg(s)?, &args, None, |_| {});
    let mut names: Vec<String> = std::fs::read_dir(&frames_dir)?.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".jpg")).collect();
    names.sort();
    let frames: Vec<(f64, String)> = names.into_iter().enumerate().map(|(i, n)| ((i as f64 * gap * 10.0).round() / 10.0, n)).collect();

    let recorded = std::fs::metadata(path).and_then(|m| m.modified()).map(|t| chrono::DateTime::<chrono::Local>::from(t).format("%Y-%m-%d %H:%M").to_string()).unwrap_or_default();
    std::fs::write(dir.join("transcript.md"), markdown(&stem, &recorded, info.duration, &file, &cues, &frames, &why))?;
    std::fs::write(dir.join("captions.vtt"), vtt(&cues))?;
    let json = serde_json::json!({
        "video": file, "recorded": recorded, "duration": info.duration, "width": info.width, "height": info.height,
        "transcript": cues.iter().map(|c| serde_json::json!({ "start": c.start, "end": c.end, "text": c.text.trim() })).collect::<Vec<_>>(),
        "frames": frames.iter().map(|(t, n)| serde_json::json!({ "time": t, "file": format!("frames/{n}") })).collect::<Vec<_>>(),
    });
    std::fs::write(dir.join("recording.json"), serde_json::to_string_pretty(&json)?)?;
    Ok(Notes { dir, text: cues.iter().map(|c| c.text.trim()).collect::<Vec<_>>().join(" ") })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn cue(start: f64, text: &str) -> Cue { Cue { start, end: start + 2.0, text: text.into() } }

    #[test]
    fn captions_are_webvtt() {
        let v = vtt(&[cue(61.5, " Click save ")]);
        assert_eq!(v, "WEBVTT\n\n00:01:01.500 --> 00:01:03.500\nClick save\n");
    }

    #[test]
    fn transcript_puts_words_and_stills_in_time_order() {
        let m = markdown("Rec", "2026-11-21 10:00", 75.0, "Rec.mp4", &[cue(3.0, "First"), cue(12.0, "Second")], &[(0.0, "0001.jpg".into()), (10.0, "0002.jpg".into())], "");
        let order: Vec<usize> = ["0001.jpg", "First", "0002.jpg", "Second"].iter().map(|x| m.find(x).unwrap()).collect();
        assert!(order.windows(2).all(|w| w[0] < w[1]), "{m}");
        assert!(m.contains("- Length: 1:15") && m.contains("**[0:12]** Second"));
    }

    /// GRABBIT_NOTES_VIDEO=<a copy of some .mp4> cargo test notes -- --ignored
    #[test]
    #[ignore]
    fn writes_notes_for_a_real_video() {
        let Ok(p) = std::env::var("GRABBIT_NOTES_VIDEO") else { return };
        let n = write(&Settings::default(), Path::new(&p)).unwrap();
        for f in ["transcript.md", "captions.vtt", "recording.json", "frames/0001.jpg"] { assert!(n.dir.join(f).exists(), "{f}"); }
        println!("{}\n---\n{}", n.dir.display(), n.text);
    }

    #[test]
    fn stills_are_spread_out() { assert_eq!(every(20.0), 5.0); assert_eq!(every(600.0), 20.0); }
}
