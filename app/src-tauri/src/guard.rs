// Keeping Grabbit healthy without anyone noticing: Windows restarts it after a crash or hang, the helper programs it
// starts (ffmpeg, tesseract) end with it instead of lingering, panics are logged with a backtrace instead of lost,
// and old temporary files are cleared at startup.

use std::time::{Duration, SystemTime};

pub fn install() {
    std::panic::set_hook(Box::new(|info| {
        log::error!("panic: {info}\n{}", std::backtrace::Backtrace::force_capture());
        // A panic on the main thread ends the app: make it a crash Windows knows about, so it restarts Grabbit.
        if std::thread::current().name() == Some("main") { std::process::abort(); }
    }));
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::Recovery::{RegisterApplicationRestart, RESTART_NO_PATCH, RESTART_NO_REBOOT};
        // Restarted (quietly, in the tray) after a crash or a hang, once it has run for a minute.
        let _ = RegisterApplicationRestart(windows::core::w!("--background"), RESTART_NO_PATCH | RESTART_NO_REBOOT);
    }
    std::thread::spawn(|| clean_temp(&std::env::temp_dir().join("Grabbit"), Duration::from_secs(14 * 24 * 3600)));
}

/// Ties a helper process to Grabbit: it ends when Grabbit ends, even after a crash (a Windows job object that kills
/// its processes when its last handle closes; the handle is only ever closed by Grabbit exiting).
#[cfg(windows)]
pub fn adopt(child: &std::process::Child) {
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;
    use windows::Win32::{Foundation::HANDLE, System::JobObjects::*};
    struct Job(HANDLE);
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}
    static JOB: OnceLock<Option<Job>> = OnceLock::new();
    let job = JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(None, windows::core::PCWSTR::null()).ok()?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info as *const _ as *const _, std::mem::size_of_val(&info) as u32).ok()?;
        Some(Job(job))
    });
    if let Some(Job(job)) = job { unsafe { let _ = AssignProcessToJobObject(*job, HANDLE(child.as_raw_handle())); } }
}

#[cfg(not(windows))]
pub fn adopt(_child: &std::process::Child) {}

/// Deletes files under `dir` older than `age` (copies made for the clipboard, shares, AI batches, thumbnails), and
/// folders left empty. The "Copied" list in the editor shows these, so they're kept two weeks.
fn clean_temp(dir: &std::path::Path, age: Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    for e in entries.flatten() {
        let p = e.path();
        let Ok(m) = e.metadata() else { continue };
        if m.is_dir() {
            clean_temp(&p, age);
            let _ = std::fs::remove_dir(&p);   // only succeeds when empty
        } else if m.modified().ok().and_then(|t| now.duration_since(t).ok()).is_some_and(|d| d > age) {
            let _ = std::fs::remove_file(&p);
        }
    }
}
