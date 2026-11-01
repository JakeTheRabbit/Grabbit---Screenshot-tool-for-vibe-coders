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
Status: ☐ todo · ◐ partial · ☑ done. **W** = clicked through on Windows (`spikes/all.ps1`). **CI** = the core behind it runs in the `--self-test` on Windows, macOS and Linux every push. Status as of 2026-11-01.

### Capture
- ☑ W · CI: tap key → freeze all screens → picker (region / window / screen), loupe with coordinates, size and colour
- ☑ W: multi-window (Ctrl/Cmd+click) · scrolling capture · up to 4 areas arranged into one picture (row / column / grid / as on screen)
- ☑ W: action bar Copy · Smaller · Chat · Edit · Save · Record · More ▾; areas can be moved and resized after selection
- ☑ W · CI (OCR): copy text (OCR) · read QR · copy colour hex · measure
- ☑ W: pin to screen · repeat last area · delay 3/5/10 s · timed captures → timelapse
- ☑ W: social size presets (picker locks the aspect; export resizes)
### Record
- ☑ W · CI: hold key → record · red frame + Stop bar kept out of the video · pause/resume (area can be moved while paused)
- ☑ W · CI: system sound + mic on separate tracks (macOS via ScreenCaptureKit) · webcam bubble · click/key visualiser
- ☑ W: replay buffer (last 30/60/120 s, hotkey saves)
- ☑ W: social recording presets
### Video editor
- ☑ W · CI: timeline, split/cut/trim/undo, sound picker, drawings and blur boxes per time span
- ☑ W · CI: speed up a part · cut silences · click-driven auto-zoom
- ☑ W: captions (local whisper or OpenAI) — generate, edit, burn in, export .srt
- ☑ W · CI: export Full / Chat / GIF / WebP / social sizes / Beautify
### Picture editor
- ☑ W: Excalidraw editor with redact/step/stickers
- ☑ W: auto-hide private details (OCR → emails, IPs, keys, phones, card numbers → blur)
- ☑ W: AI (optional keys: OpenAI, xAI, Google, or any OpenAI-compatible URL) — remove background, remove object, edit object, edit text, ask, auto description + tags
- ☑ W: Talk to AI — voice note + marks + editable transcript, pasted into ChatGPT/Claude in one go; batch mode ties each picture to its own words
### Branding & protection
- ☑ W · CI: logo/overlay on photos and videos
- ☑ W · CI: invisible watermark (owner + capture id) and Check image
- ☑ W · CI: metadata strip / custom fields
### Share & workflow
- ◐ W: share → Immich, MEGA, S3 (instant link), Obsidian. **OneDrive needs an Entra app registration** (client id is still `PENDING-REGISTRATION`). No OS share sheet yet: "Show in folder" stands in for it.
- ☑ W: searchable history (OCR text + AI description)
- ☑ W: step recorder → SOP (markdown + .docx)
- ☑ W: settings backup / restore (secrets optional)
### Best-in-class additions (from docs/COMPETITORS.md)
- ☑ W: Quick Access card after every capture (drag out, copy, save, edit, pin, share, AI)
- ☑ W · CI: studio layer — cursor + clicks recorded beside the video, auto-zoom and click rings at export, re-editable
- ☑ W · CI: Beautify for pictures and video
- ◐ W: transcript editing — cut caption lines and filler-only lines. Single-word cuts are not done.
- ☑ W: crash-safe recording (.mkv segments, joined at the end), disk-space guard, timer in the tray
- ☑ W: CLI + `grabbit://` links · per-mode hotkeys
- ◐ W: clean desktop while capturing — hides desktop icons. Do Not Disturb is not done.
- ☑ W: instant link (S3: URL copied first, upload in the background)
- ☑ W · CI: high-quality GIF / animated WebP · video blur boxes per time span (static, not tracking)
- Perf rule (Cap left Tauri for native over CPU/RAM while recording): capture, encode and cursor tracking stay in the Rust core and ffmpeg; the webview never touches frames while recording.

### Shipping
- ◐ CI: build + unit tests + self-test on windows-latest, macos-latest, ubuntu-24.04; tagged pushes build draft installers
- ☑ README, docs/, screenshots (made from the demo page), install steps for unsigned builds: SmartScreen "More info → Run anyway", Gatekeeper right-click → Open, AppImage chmod
