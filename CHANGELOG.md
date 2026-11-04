# Changelog

All notable changes to Grabbit are listed here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Grabbit uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Installers for every version are on the [Releases](https://github.com/JakeTheRabbit/grabbit/releases) page.

## [Unreleased]

### Changed

- **The screens freeze as soon as you press the capture key**, not when you let go of it, which saved the time your finger is on the key (about 0.1 s) on every capture. Keep holding and a "Keep holding to record" pill fills in the capture screen; at the end it becomes the recording capture screen, ready for you to pick the area.
- **The frozen picture is ready sooner on Windows.** Memory for each screen is set up while the screens are being grabbed, and all screens are copied into it at once instead of one after another.

### Removed

- The separate hold-to-record pill window by the mouse; the pill is now part of the capture screen.

## [2.0.14] - 2026-11-05

### Changed

- **Captures open about 4× faster.** On a PC with four screens (two of them 4K), the screens now freeze 0.13–0.22 s after you press the key, down from about 0.5 s, and the first capture after starting or a pause no longer takes 1.5–3 s.
  - Windows grabs the screens straight from the graphics card (DXGI), about 3× faster than before. It falls back to the old way per screen when that doesn't work, for example over Remote Desktop.
  - The frozen picture reaches the capture screen through shared memory instead of being copied, which saved up to half a second per 4K screen.
  - The capture screens no longer wait to be resized when they're already the right size.
- **Instant capture** (Settings → General) replaces *Keep the capture screen ready* and is on by default. Between captures the capture screens sleep and give their memory back (about 80 MB in Task Manager with four screens). Turn it off for under 10 MB while idle, with a slower first capture.
- **Copy is ready sooner.** Saving the file and copying to the clipboard now happen at the same time, the picture is compressed once instead of twice, and the clipboard is no longer held open while it's compressed.
- Release builds are optimised for speed instead of size.

## [2.0.13] - 2026-11-04

### Added

- **Frame a picture.** Select a picture you've added to the editor and click **Frame** to set a border (colour, width, opacity), rounded corners and how see-through the picture is. The colour swatches colour the border too.
- **Layers panel.** A **Layers** button lists everything you've added, top first. Drag a layer or use its arrows to change the order, show or hide it (hidden layers are left out of copies and saves), click it to select it, or delete it. Ctrl+Z undoes any of these.
- **Drag captures onto the picture.** Drag anything from Captures or Copied onto the picture you're editing, and it lands where you drop it.

### Changed

- **Resizing keeps proportions.** Dragging any corner or side of text, a box, an ellipse, a picture or a sticker resizes it in proportion. Hold **Shift** to stretch it freely.

## [2.0.12] - 2026-11-04

### Added

- **Font menu.** The text tools list every font installed on your computer, each shown in its own style. Picking one also changes the selected text and numbered steps.
- **Beautify → Apply to the picture.** Puts the background, padding, rounded corners and shadow into the picture you're editing, together with your drawings. Ctrl+Z undoes it.

### Fixed

- Beautify only changed copies and saves, so the picture on screen never changed.

## [2.0.11] - 2026-11-04

### Added

- **Light and dark mode.** Settings → General → Appearance: same as the system, light or dark. Every window changes at once, title bars included.
- **Self-repair.**
  - Windows restarts Grabbit after a crash or a hang.
  - A capture screen that doesn't appear is rebuilt and tried once more.
  - A damaged settings file is replaced with the last good copy.
  - Temporary files older than two weeks are cleared.
- **Keep the capture screen ready** setting (Settings → General) for instant captures at the cost of memory.

### Changed

- **New look.** Every window uses the same clean style. Every screen and setting was checked in both modes for text size, contrast and fit.
- **Much lighter.** Idle memory drops from about 300–800 MB to under 10 MB. The capture screens are made when you capture and closed a minute after the last one, so the first capture after a pause takes about 2 seconds.
- The editor opens lighter, and the captures panel uses small thumbnails.
- Recording helpers (ffmpeg) close with Grabbit instead of lingering.

### Fixed

- Webcam recordings came out short: a slow camera held back the whole recording, so a minute could come out as 12 seconds. The screen and the camera now record separately, and the bubble is added when you stop.

## [2.0.10] - 2026-11-04

### Added

- **Captures panel in the editor:**
  - Shows recordings as well as pictures, grouped by day with the day of the week.
  - Sort by date, name or size. Show only pictures or only recordings. Pick a single day on a calendar.
  - List, small or big pictures.
  - Folders: make them and drag pictures onto them.
  - Drag the edge to resize it (the pictures grow with it), dock it on any side, or hide it.
- **Vertical tabs.** Open pictures are tabs down the side with thumbnails, like Microsoft Edge, and can be narrowed to just the pictures. Tabs across the top are still in the layout menu.
- **Several areas across screens.** "Add another area" and Ctrl+drag work across all your screens, up to 8 areas. The areas stay separate pictures by default: Mark up opens a tab each, Copy puts them all on the clipboard as files, and Save saves each one. You can still join them into one picture.
- The Talk window names your microphone, shows a live level meter, and tells you when the microphone hears nothing.
- Tooltips in every window, drawn inside the page (including the picker and the corner card, where Windows tooltips used to open out of sight), with fuller descriptions throughout.

### Changed

- The action bar's buttons say what they do: Copy smaller, Copy for chat, Mark up, Save as…, Record video, Add another area.

### Fixed

- The Talk window and the corner card failed to open when one was already showing.
- The corner card's Talk button did nothing.
- The shape and size list was white on white.
- With the toolbar on the left or right, the captures panel was pushed off the window.

## [2.0.9] - 2026-11-03

### Fixed

- The Beautify, Share, AI and Info panel covered the right side of the picture and the toolbar. It now takes its own space and the picture refits beside it.

## [2.0.8] - 2026-11-03

### Changed

- The new markup editor is the default for pictures ([docs/markup-editor.md](docs/markup-editor.md)). The classic Excalidraw editor is still in the layout menu (**Use the classic editor**), and Grabbit remembers your choice.
- `.excalidraw` projects always open in the classic editor.

## [2.0.7] - 2026-11-03

### Changed

- The exe's file properties show a publisher (JakeTheRabbit), copyright and homepage.

### Fixed

- Fewer Microsoft Defender false positives: Grabbit no longer rewrites its `grabbit://` link handler in the registry on every start (the installer already registers it). That start-up write next to a Run key is what `Behavior:Win32/Persistence.A!ml` reacts to.

## [2.0.6] - 2026-11-02

### Added

- **New picture editor (beta)**, made for screenshots, built on Fabric.js. Turn it on from the layout button → *Try the new editor (beta)*.
  - The capture is the canvas, fitted under the tools.
  - Arrow and line (drag either end to re-aim), box, ellipse, pen, highlighter, text (with an optional background), numbered steps.
  - Pixelate, blur and black out as drag tools; spotlight; a 2× magnifier; crop; eyedropper.
  - Every tool has a key; colour, width, fill, text size and shadow apply to what's selected or what you draw next.
  - Ctrl+wheel to zoom, Space+drag to pan, 0 to fit, Ctrl+V pastes any picture.

## [2.0.5] - 2026-11-02

### Changed

- After you drag an area, Copy sits right by the mouse instead of at the far end of the bar.
- The editor toolbar can go on any side: top, bottom, left or right.

### Fixed

- Arrows, lines and pen strokes were hard to click on a zoomed-out capture.
- The editor's zoom/undo bar was cut off; the capture list now scrolls instead of squashing thumbnails.

## [2.0.4] - 2026-11-02

2.0.3 was versioned but never released; its changes are in this release.

### Added

- Hide: switch a pixelated or blurred area to Black out, or back.
- Tabs: close every tab for an empty editor; thumbnails have Insert and New tab buttons; the Copied tab lists your copies.
- Talk button in the editor toolbar for voice notes.
- Beautify shows a live preview.

### Fixed

- Undo didn't cover Pixelate, Blur, Black out, Spotlight or AI edits, and Ctrl+Z / Delete didn't work straight after clicking a toolbar button.
- Emoji, icons and step badges went in too small and on top of each other; the sticker picker now closes after a pick, on Esc or on a click outside.
- New pictures opened under the style panel.
- Video editor: the video was partly hidden while drawing on it.
- Spotlight dimmed earlier drawings; AI box edits left the marking box behind.
- OpenAI "no credits" errors now explain that API credits are separate from ChatGPT plans.

## [2.0.2] - 2026-11-01

### Fixed

- The capture overlay on PCs with several monitors: every screen showed the same frame, and the mouse lagged.

## [2.0.1] - 2026-11-01

### Added

- OneDrive sharing (Settings → Sharing → Sign in) for personal, work and school accounts.

## [2.0.0] - 2026-11-01

Grabbit 2 is a full rewrite on Tauri: one app for Windows, macOS and Linux. Tap the key to capture, hold it to record.

### Added

- **Capture:** region, window, screen, several windows, scrolling capture, up to 4 areas in one picture, move and resize after selecting, repeat last area, delay, timed captures.
- **Tools:** copy text (OCR), read QR codes, colour hex, measure, pin to screen, hide private details automatically.
- **Recording:** system sound and microphone on separate tracks, webcam bubble, click and key overlay, pause and resume, replay buffer.
- **Video editor:** cut, speed parts up, cut silences, auto-zoom on clicks, captions (burned in or `.srt`), blur boxes, GIF, WebP, social sizes, Beautify.
- **Talk to AI:** talk over a screenshot or recording, mark what you mean, fix the transcript, and paste it all into ChatGPT or Claude in one go. Batch mode ties each picture to its own words.
- **AI with your own key** (OpenAI, xAI, Google, or any OpenAI-compatible endpoint): remove the background or objects, edit text, ask about a picture, description and tags.
- **Sharing** to Immich, MEGA, S3 (link copied instantly) and Obsidian; searchable history.
- Logo overlay, invisible watermark with a Check image tool, metadata stripping and custom fields.
- Step recorder that writes a how-to (Markdown and `.docx`); settings backup and restore.
- `--self-test` and CI on Windows, macOS and Linux.

[Unreleased]: https://github.com/JakeTheRabbit/grabbit/compare/v2.0.14...HEAD
[2.0.14]: https://github.com/JakeTheRabbit/grabbit/compare/v2.0.13...v2.0.14
[2.0.13]: https://github.com/JakeTheRabbit/grabbit/compare/v2.0.12...v2.0.13
[2.0.12]: https://github.com/JakeTheRabbit/grabbit/compare/v2.0.11...v2.0.12
[2.0.11]: https://github.com/JakeTheRabbit/grabbit/compare/v2.0.10...v2.0.11
[2.0.10]: https://github.com/JakeTheRabbit/grabbit/compare/v2.0.9...v2.0.10
[2.0.9]: https://github.com/JakeTheRabbit/grabbit/compare/v2.0.8...v2.0.9
[2.0.8]: https://github.com/JakeTheRabbit/grabbit/compare/v2.0.7...v2.0.8
[2.0.7]: https://github.com/JakeTheRabbit/grabbit/compare/v2.0.6...v2.0.7
[2.0.6]: https://github.com/JakeTheRabbit/grabbit/compare/v2.0.5...v2.0.6
[2.0.5]: https://github.com/JakeTheRabbit/grabbit/compare/v2.0.4...v2.0.5
[2.0.4]: https://github.com/JakeTheRabbit/grabbit/compare/v2.0.2...v2.0.4
[2.0.2]: https://github.com/JakeTheRabbit/grabbit/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/JakeTheRabbit/grabbit/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/JakeTheRabbit/grabbit/releases/tag/v2.0.0
