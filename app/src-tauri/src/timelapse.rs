// Timed captures: grab the last-picked area (or the whole main screen) every N seconds into a folder, and on stop turn
// the pictures into a timelapse video. Good for watching a dashboard, a build, or a grow room camera page over a day.

use crate::{actions, capture, editor, export, state, video};
use std::{
    path::PathBuf,
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::AppHandle;

struct Session { stop: Arc<AtomicBool>, dir: PathBuf, worker: std::thread::JoinHandle<usize> }
static SESSION: Mutex<Option<Session>> = Mutex::new(None);

pub fn toggle(app: &AppHandle) {
    let cur = SESSION.lock().unwrap().take();
    match cur { Some(s) => finish(app, s), None => start(app) }
}

fn start(app: &AppHandle) {
    let s = state(app).settings.lock().unwrap().clone();
    let every = Duration::from_secs(s.timelapse_seconds.max(1) as u64);
    let rect = *state(app).last_rect.lock().unwrap();
    let dir = PathBuf::from(&s.save_folder).join(export::stamp_name("Timed"));
    if let Err(e) = std::fs::create_dir_all(&dir) { return actions::notify(app, &format!("{e}")); }
    let stop = Arc::new(AtomicBool::new(false));
    let (stop2, dir2) = (stop.clone(), dir.clone());
    let worker = std::thread::spawn(move || {
        let mut n = 0usize;
        let mut next = Instant::now();
        while !stop2.load(Ordering::Relaxed) {
            if Instant::now() >= next {
                next += every;
                let shot = capture::freeze_all().map(|frames| match rect {
                    Some((x, y, w, h)) => capture::crop(&frames, x, y, w, h),
                    None => frames.into_iter().next().map(|f| f.image).unwrap_or_default(),
                });
                match shot {
                    Ok(img) if img.width() > 0 => {
                        n += 1;
                        let _ = export::png_bytes(&img, None).map(|b| std::fs::write(dir2.join(format!("frame-{n:05}.png")), b));
                    }
                    Ok(_) => {}
                    Err(e) => log::warn!("timed capture: {e}"),
                }
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        n
    });
    *SESSION.lock().unwrap() = Some(Session { stop, dir, worker });
    let what = if rect.is_some() { "the last area you picked" } else { "the main screen" };
    actions::notify(app, &format!("Timed captures: {what} every {} s. Use the tray menu again to stop and make the timelapse", s.timelapse_seconds.max(1)));
}

fn finish(app: &AppHandle, sess: Session) {
    sess.stop.store(true, Ordering::Relaxed);
    let n = sess.worker.join().unwrap_or(0);
    if n < 2 { return actions::notify(app, &format!("Timed captures stopped: {n} picture(s) in {}", sess.dir.display())); }
    let s = state(app).settings.lock().unwrap().clone();
    let out = sess.dir.join("timelapse.mp4");
    let pattern = sess.dir.join("frame-%05d.png");
    let mut a: Vec<String> = ["-hide_banner", "-v", "error", "-y", "-framerate", "10", "-i"].map(String::from).to_vec();
    a.push(pattern.to_string_lossy().into());
    a.extend(["-vf".into(), "scale='trunc(iw/2)*2':'trunc(ih/2)*2',format=yuv420p".into()]);
    a.extend(video::h264(&s, 20, 0));
    a.extend(["-movflags".into(), "+faststart".into(), out.to_string_lossy().into()]);
    match video::ffmpeg(&s).and_then(|f| video::run(&f, &a, None, |_| {})) {
        Ok(r) if r.code == 0 => { actions::quick_show(app, Some(&out), &format!("Timelapse of {n} pictures")); editor::open_path(app, &out); }
        Ok(r) => actions::notify(app, &format!("Timelapse failed: {}", r.err.trim())),
        Err(e) => actions::notify(app, &format!("{e}")),
    }
}
