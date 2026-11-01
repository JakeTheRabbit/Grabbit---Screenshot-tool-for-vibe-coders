# Grabbit 2 — cross-platform plan

Decided 2026-11-01 with Ben:
- **Tauri 2 rewrite.** Rust core plus the existing React/Excalidraw editors. The WPF app (`src/Grabbit`) is retired once v2 matches it.
- **Platforms:** Windows 10/11, macOS 13+, Linux (X11 first-class; Wayland where portals allow). No iOS.
- **Sharing:** OneDrive, Immich, MEGA, plus the OS share sheet. Google Photos (no share links since Mar 2025), iCloud (no API) and Proton (SDK not for third parties) are dropped.
- **Unsigned installers**, with the one extra install click documented for each OS.

**Done means:** every feature below works on all three OSes (or is marked N/A with a reason in the README). CI builds the installers (msi/exe, dmg, AppImage/deb) and runs tests. GitHub has a release, README, docs and screenshots. The app feels simple: one tap-to-capture flow, and everything else one click from the action bar or editor.

## UX rules (anti-bloat)
- One entry point: tap the capture key → picker → action bar. Hold the key → record. That's the whole app for most people.
- The action bar shows 6 primary buttons; **More ▾** holds the rest (OCR, pin, QR, share, AI, measure…).
- The editor's right panel tabs are **Draw · Adjust · AI · Share · Info**, and only Draw is open by default.
- Settings have one page per area. Defaults are good; nothing must be set up before first use.
- Native look: system font, light/dark and accent colour from the OS; Mica on Windows, vibrancy on macOS, Adwaita-like on Linux. The window controls are native.

## Architecture
```
app/                 frontend (Vite + React), one page per window: index (picture editor), video, picker, bar, hint, settings, pin
app/src-tauri/       Rust core
  capture            xcap: monitors, windows, frozen frames, multi-window, scroll capture
  clipboard          image (PNG/DIB) + file list (clipboard-rs)
  hotkey             tap vs hold (global-shortcut Pressed/Released)
  record             ffmpeg sidecar: ddagrab/gdigrab (Win), avfoundation/ScreenCaptureKit (mac), x11grab/pipewire (Linux); audio via cpal (loopback + mic)
  replay             ring-buffer recording (ffmpeg segment_wrap)
  video              probe / render (port of Video.cs: trim, concat, overlays, sound choice, presets)
  ocr                Windows.Media.Ocr · macOS Vision · Linux tesseract
  qr                 rqrr
  meta               EXIF/XMP strip, view, edit, custom fields (images); ffmpeg -map_metadata for video
  mark               logo/overlay on everything + invisible watermark (DCT spread-spectrum, owner id) + verify
  share              OneDrive (Graph, device-code OAuth), Immich (API key), MEGA (megajs-compatible API), OS share sheet
  ai                 OpenAI (gpt-image), xAI (grok image), Google (Gemini image): remove background, remove object, edit object, edit text, ask about image
  captions           whisper.cpp (whisper-rs) local, or OpenAI transcription when a key is set
  history            capture index + OCR text, searchable
  steps              step recorder → markdown / docx SOP
  settings           JSON in the OS config dir
```

## Feature checklist
Status: ☐ todo · ◐ partial · ☑ done (W/M/L = verified on Windows/macOS/Linux)

### Capture
- ☐ Tap key → freeze all screens → picker (region / window / screen), loupe with coordinates, size and colour
- ☐ Multi-window (Ctrl/Cmd+click) · scrolling capture
- ☐ Action bar: Copy · Smaller · Chat · Edit · Save · Record · More ▾
- ☐ Copy text (OCR) · Read QR/barcode · Copy colour hex · Measure
- ☐ Pin to screen · Repeat last area · Delay 3 s/5 s/10 s · Timed captures → timelapse
- ☐ Social size presets (picker locks the aspect ratio; export resizes): Instagram 1:1 / 4:5 / 9:16, Facebook, Snapchat, YouTube 16:9, Shorts/Reels/TikTok 9:16, X, LinkedIn, Pinterest
### Record
- ☐ Hold key 2 s → record · red frame + Stop bar kept out of the video · pause/resume
- ☐ System sound + mic on separate tracks · webcam bubble · click/key visualiser
- ☐ Replay buffer (last 30/60/120 s, hotkey saves)
- ☐ Social recording presets (area locked to aspect; render scales)
### Video editor
- ☐ Filmstrip timeline, split/cut/trim/undo, sound picker, Excalidraw drawings per time span (port)
- ☐ Speed up a part · cut silences automatically · zoom that follows the mouse
- ☐ Captions: generate, edit, burn in or export .srt
- ☐ Export presets: Full / Chat / GIF / social sizes
### Picture editor
- ☐ Excalidraw editor with redact/step/stickers (port)
- ☐ Auto-hide private details (OCR → emails, IPs, keys, phones, card numbers → blur)
- ☐ AI (optional keys): remove background, remove object, edit object, edit text, ask about image
### Branding & protection
- ☐ Logo/overlay on all photos and/or videos (position, size, opacity)
- ☐ Invisible watermark (owner id + capture id) on save; **Check image** tool reads it back from a found copy
- ☐ Metadata: strip on copy/share (default on), view/edit, custom fields (author, copyright, tags)
### Share & workflow
- ☐ Share → OneDrive link · Immich link · MEGA link · OS share sheet
- ☐ Send to Obsidian (vault folder + optional daily-note link)
- ☐ Searchable history (OCR text index)
- ☐ Step recorder → SOP (markdown + .docx)
### Best-in-class additions (from docs/COMPETITORS.md)
- ☐ Quick Access thumbnail after every capture/recording: drag out into any app, plus copy / save / edit / pin / share / close (CleanShot)
- ☐ Studio layer: record cursor + click events as a separate track → click-driven auto-zoom, cursor smoothing, click effects, re-editable after recording (Screen Studio, Cap). Replaces "zoom follows mouse".
- ☐ Beautify: padding, gradient/image background, shadow, rounded corners, auto-balance, presets (CleanShot, Shottr, Xnapper); the same compositor does video backgrounds/padding/aspect
- ☐ Transcript editing: delete words to cut, remove filler words and pauses (from whisper word timestamps)
- ☐ Crash-safe recording: fragmented MP4, disk-space guard, timer in the tray
- ☐ CLI + `grabbit://` URL scheme (capture, record, open) · per-mode custom hotkeys in Settings
- ☐ Clean desktop while capturing: hide desktop icons, Do Not Disturb where the OS allows
- ☐ Instant link: copy the URL first, upload in the background; S3-compatible destination too
- ☐ High-quality GIF / animated WebP · video privacy masks that follow a region on the timeline
- Perf rule (Cap left Tauri for native over CPU/RAM while recording): capture, encode and cursor tracking stay in the Rust core and ffmpeg; the webview never touches frames while recording.

### Shipping
- ☐ CI: build + tests on windows-latest, macos-latest, ubuntu-latest; release artifacts
- ☐ README, docs/, screenshots per OS, install steps (unsigned: SmartScreen "More info → Run anyway", Gatekeeper right-click → Open, AppImage chmod)
