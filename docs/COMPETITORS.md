# Grabbit 2 — competitor feature-gap report

Researched 2026-11-01 against PLAN-v2.md (the planned feature list) and the Windows-only v1 README. Facts come from vendor pages and changelogs fetched that day. Where only third-party or conflicting sources exist, the line says so. Anything marked *(recall)* is general knowledge not re-checked this session.

## 1. Landscape

| App | Platforms | Price | Standout features |
|---|---|---|---|
| [CleanShot X](https://cleanshot.com/features) | macOS | $35 one-time incl. 1 yr updates, then $19/yr optional; Pro $10/user/mo ([pricing](https://cleanshot.com/pricing)) | Quick Access Overlay after every capture; Background tool (20 presets, auto-balance); scrolling capture (vertical+horizontal); v5.0 (1 Sep 2026) adds Smart Zooms, cursor smoothing, motion blur, video backgrounds ([changelog](https://cleanshot.com/changelog)) |
| [Shottr](https://shottr.cc/) | macOS | Pay-what-you-want, $0 allowed | 2.4 MB native app; OCR + QR; on-screen ruler; scrolling capture; backgrounds/shadows; S3 upload and hand-drawn annotation styles since 1.9 ([release notes](https://shottr.cc/newversion.html)) |
| [Xnapper](https://xnapper.com/) | macOS | Free with watermark; one-time to remove | Auto-balance + backgrounds in one step; one-click redaction of emails, cards, IPs, API keys; social-size ratios |
| [Screen Studio](https://screen.studio/) | macOS only; "no near-future plans" for Windows | $9/mo yearly, $29/mo monthly; no new one-time licences | Auto/manual zoom (classic + loupe), cursor smoothing, motion blur, click effects; transcript editing with filler/pause removal; camera layouts; privacy masks; 2-second autosave |
| [Kap](https://getkap.co/) | macOS 12+ | Free, MIT ([repo](https://github.com/wulkano/Kap)) | Region recording, GIF/MP4/WebM/APNG export, plugin system (Giphy, Streamable...). Maintenance status not stated on its pages |
| [ShareX](https://getsharex.com/) | Windows | Free, open source | Workflow engine (~22 after-capture tasks), scrolling capture, GIF/screen recording, OCR, QR, many upload destinations plus custom uploaders, built-in image editor |
| [Snagit](https://www.techsmith.com/snagit/features/) | Win + Mac | Subscription or perpetual; sources conflict, third parties say ~$39/yr or ~$63 one-time ([2026 version history](https://support.techsmith.com/hc/en-us/articles/42674936732685-Snagit-Windows-2026-Version-History) shows the OCR-focused 2026 releases; price itself unverified) | Step recorder, smart redact, smart move (reposition UI elements), background remover, library with tags/search, templates, AI captions and chapters (Pro) |
| [Greenshot](https://greenshot.org/) | Windows (free, GPL); Mac App Store build is a separate ~$1.99 app | Free / $1.99 | Tiny and fast; region/window/full/last-region; built-in editor; Windows OCR hook in 1.3; 1.3.315 (Mar 2026) was the last 1.3 stable ([post](https://getgreenshot.org/2026/03/20/greenshot-1.3.315-release/)) |
| [PicPick](https://picpick.app/en/) | Windows | Free for personal use; paid for commercial | Capture + recording, ribbon editor, pixel ruler, protractor, color picker, whiteboard |
| Windows Snipping Tool | Windows 11 | Bundled | Text Actions OCR, QR scanning, window-mode recording, single-cut video trim, quick markup, text and emoji in editor ([Windows Latest](https://windowslatest.com/2025/02/23/windows-11-is-getting-full-screen-ocr-video-editing-tools), [BetaNews](https://betanews.com/article/snipping-tool-gets-a-handy-window-recording-mode)) |
| [Flameshot](https://flameshot.org/) | Win/Mac/Linux, GPLv3 | Free | In-place annotation on the frozen screen, CLI for scripting, numbered counters. Wayland weak ([overview](https://www.debugpoint.com/screenshot-apps-linux/)) |
| [Ksnip](https://github.com/ksnip/ksnip) | Win/Mac/Linux, GPL-3.0 | Free | Many capture modes, stickers, watermark, slice-cut, imgur/FTP/custom upload scripts, OCR plugin. Maintainer says development is limited; global hotkeys only on Windows and X11 |
| Spectacle (KDE) | Linux | Free | Plasma 6.6 added OCR via Tesseract and "hide window from screencast"; audio recording slated for Plasma 6.8 ([Linuxiac](https://linuxiac.com/kde-plasma-6-6-to-bring-ocr-in-spectacle-screenshot-utility/), [UbuntuHandbook](https://ubuntuhandbook.org/index.php/2026/02/kde-plasma-6-6-released/)) |
| GNOME Shell UI | Linux | Built in | Screenshot/screencast toggle on PrtScn; old gnome-screenshot app broke in GNOME 49; no CLI or configurable delay ([OMG Ubuntu](https://omgubuntu.co.uk/2025/10/gnome-screenshot-app-no-longer-works-in-gnome-49)). Gradia (annotation) joined GNOME Circle in GNOME 50 |
| [Loom](https://www.loom.com/pricing) | Win/Mac/iOS/Android | Free (25 videos, 5 min); $18 or $24/user/mo | Instant share link, transcripts, AI titles/summaries/chapters, filler/silence removal, edit by transcript |
| [Cap](https://cap.so/) | Win/Mac/Linux | Free personal; $58 one-time desktop licence; Pro $12/user/mo | Open source (mostly AGPLv3 per [repo](https://github.com/CapSoftware/Cap)); Instant mode (uploads while recording, link on stop) and Studio mode (separate screen/cam/mic tracks, auto-zoom, captions); S3/self-host; CLI + MCP; Loom importer. **0.6.1 (Oct 2026) replaced its Tauri app with a native app on every platform** for lower CPU and memory ([changelog](https://cap.so/changelog)) |
| [Zight](https://zight.com/pricing/) | Win/Mac/iOS/Android/Chrome | Free (720p, 5 min); $9.95-$12/user/mo | Link-first sharing, 15/60 s GIFs, video requests, Slack/Teams/Jira integrations |
| OBS Studio | Win/Mac/Linux | Free | Replay buffer (RAM-capped at 8 GB; disk-backed option proposed in PR #13558), scenes, plugins; 32.1 added a new audio mixer and WebRTC simulcast ([GamingOnLinux](https://www.gamingonlinux.com/2026/01/obs-studio-32-1-beta-is-out-with-a-new-audio-mixer-webrtc-simulcast-support-and-more)). UX is heavy; Grabbit should not copy it |

**Read-across for Grabbit's Tauri decision:** Cap's own changelog says it left Tauri for lower CPU/memory in both recording and editing. Keep capture, encode and cursor-tracking in the Rust core and out of the webview. Use the webview only for editors and UI.

## 2. Features they have that PLAN-v2 lacks

Difficulty: S = days, M = 1-3 weeks, L = a month or more. Items are ordered by value, not by app.

### Capture and editing

1. **Post-capture Quick Access thumbnail (corner overlay)**
   - Who: CleanShot ([features](https://cleanshot.com/features): copy, save, annotate, drag the file into any app, auto-close, swipe gestures, restore closed overlays), Snipping Tool (toast), Snagit.
   - Why: it gives a place for "I took it, now what?" without opening an editor. Drag-out into Slack, mail or a browser upload is the most-loved single trick.
   - Difficulty: M (a frameless always-on-top window, a native file-drag-out per OS, and a stack of several thumbnails).
   - Recommendation: **ADD.** PLAN's action bar only exists before the capture is final. Make the thumbnail the standard result of every capture and recording, and keep the bar as the pre-capture step.

2. **Beautify / background tool (padding, gradient or image background, shadow, corner radius, auto-balance, saved presets)**
   - Who: CleanShot, Shottr, Xnapper (its whole pitch), ksnip (drop shadow).
   - Why: makes screenshots look finished for docs, tweets and tickets. It is the main reason people pay for Xnapper.
   - Difficulty: S-M (canvas compositing, preset storage, one toggle in the editor's Adjust tab). Windows/Linux window shots also need the soft-shadow and rounded-corner mask.
   - Recommendation: **ADD** as an "Adjust" tab item with a "beautify by default" toggle. Reuse it for video (item 5).

3. **Exact-size and fixed-ratio capture entered by typing (W x H), plus "remember last size"**
   - Who: CleanShot All-in-One (set sizes, locked aspect, remembers selection), Snagit (exact dimension), ksnip.
   - Why: repeatable sizes for docs and store listings.
   - Difficulty: S (PLAN already has aspect locks for social presets).
   - Recommendation: **ADD** (a text field in the picker).

4. **Horizontal scrolling capture**
   - Who: CleanShot 4.8 ([changelog](https://cleanshot.com/changelog)); Snagit panoramic.
   - Why: wide tables and timelines.
   - Difficulty: M (the stitcher is already 1-D; it needs a second axis and a scroll-by-wheel-tilt path).
   - Recommendation: **ADD later**, after vertical scrolling is solid on all three OSes.

5. **Combine multiple captures on one canvas (side by side, before/after)**
   - Who: CleanShot, Shottr.
   - Why: comparison shots for bug reports.
   - Difficulty: M.
   - Recommendation: **SKIP for now.** Excalidraw can already take several images. Revisit if users ask.

6. **Drag-out of the editor result and "Open image from clipboard/file"**
   - Who: CleanShot, Xnapper.
   - Why: lets the editor double as a general annotate tool.
   - Difficulty: S.
   - Recommendation: **ADD** (comes free with item 1's drag-out code).

7. **Table OCR to CSV/Excel**
   - Who: Snipping Tool (announced, not shipped per [Windows Latest](https://windowslatest.com/2025/02/23/windows-11-is-getting-full-screen-ocr-video-editing-tools)).
   - Why: copying tables out of screenshots.
   - Difficulty: M-L.
   - Recommendation: **SKIP.** It is not shipped even at Microsoft.

### Recording and video

8. **"Studio" layer for recordings: cursor-event track, click-driven auto-zoom, cursor smoothing, click effects, motion blur, restyled cursor**
   - Who: Screen Studio, CleanShot 5.0, Cap Studio mode.
   - Why: this is the reason people pay $9-29/mo. A raw capture of a jittery cursor looks amateur; smoothed, zoomed output looks professional with zero editing.
   - Difficulty: L. The key design choice is to record cursor position, clicks and keys as a sidecar timeline next to the raw video, then re-render with zoom/smoothing in the editor. A zoom that only follows the mouse at capture time (as PLAN says) cannot be re-edited.
   - Recommendation: **ADD, and change PLAN's "zoom that follows the mouse" to "sidecar cursor track + editable auto-zoom segments".** Ship auto-zoom first, then smoothing, then motion blur.

9. **Video backgrounds: padding, gradient/wallpaper, rounded corners, shadow, output aspect ratios (16:9, 1:1, 9:16)**
   - Who: Screen Studio, Cap, CleanShot 5.0.
   - Why: demo videos look designed. It also overlaps with PLAN's social presets.
   - Difficulty: M (an ffmpeg filter graph, or the same compositor as item 2).
   - Recommendation: **ADD** after item 8.

10. **Transcript-based editing (delete words to cut video), filler-word and pause removal**
    - Who: Screen Studio, Loom (Business + AI), Cap.
    - Why: the fastest way to tidy a talking-head or narrated demo.
    - Difficulty: M (PLAN already ships whisper.cpp captions and auto silence cut; add word-level timestamps and a transcript pane).
    - Recommendation: **ADD.** It is cheap once word timestamps exist.

11. **Crash-safe recording: fragmented MP4 or segment files, autosave, disk-space guard, pause/resume**
    - Who: Screen Studio (autosave every 2 s), Cap (0.5.9 disk-space protection), OBS.
    - Why: a lost 40-minute take is the worst thing a recorder can do. Pause/resume is already in PLAN.
    - Difficulty: S (ffmpeg `-movflags frag_keyframe+empty_moov` or MKV, remux on stop; a free-space check).
    - Recommendation: **ADD.** Cheap trust builder.

12. **Privacy masks that stay on a region during playback, and "hide this window from the recording"**
    - Who: Screen Studio (privacy masks); Spectacle 6.6 (hide window from screencast); Cap Focus mode (single-window recording).
    - Why: stops secrets showing during live demos.
    - Difficulty: M for masks (Excalidraw drawings per time span already exist, so add a blur type with keyframes). L for true window exclusion on Windows/macOS, because it needs per-OS capture-exclusion APIs.
    - Recommendation: **ADD masks. SKIP window exclusion** for now. Single-window recording is already planned.

13. **Do Not Disturb during recording, recording timer in the tray**
    - Who: CleanShot ([features](https://cleanshot.com/features)).
    - Why: no notification popping up mid-take.
    - Difficulty: S-M (Windows Focus Assist and macOS Focus have limited public APIs; Linux varies by desktop).
    - Recommendation: **ADD tray timer (S). DND best-effort per OS.**

14. **Hide desktop icons for the duration of a capture or recording**
    - Who: CleanShot.
    - Why: clean demo and marketing shots.
    - Difficulty: S-M (Windows: toggle the desktop ListView; macOS: `defaults write com.apple.finder CreateDesktop` plus a Finder restart; Linux depends on desktop).
    - Recommendation: **ADD as a "Clean desktop" toggle** in Record and in More. Mark N/A on desktops without a way.

15. **High-quality GIF/animated WebP (palette generation, dithering choice, dedupe frames)**
    - Who: Kap (GIF/APNG/WebM), CleanShot (GIF), ShareX *(recall)*.
    - Why: GIFs from naive encoders look banded and huge.
    - Difficulty: S (ffmpeg `palettegen`/`paletteuse`, or gifski).
    - Recommendation: **ADD** inside the existing GIF export preset.

16. **Camera layouts and background removal (full, split, overlay, cut-out)**
    - Who: Screen Studio.
    - Why: presenter-style videos.
    - Difficulty: L.
    - Recommendation: **SKIP.** The webcam bubble in PLAN is enough.

17. **AI voiceover, background music, camera colour grade, AI titles/chapters/summaries**
    - Who: Screen Studio, Loom Business + AI, Cap Pro.
    - Why: save polish time.
    - Difficulty: M-L.
    - Recommendation: **SKIP.** It is off-brand for a capture tool. Revisit "auto title and chapters" only if captions ship cleanly.

### Sharing and workflow

18. **Customisable per-mode global shortcuts, CLI and URL scheme (`grabbit://capture?mode=area`)**
    - Who: CleanShot (URL scheme API, Raycast extension), Flameshot and ksnip (CLI), Cap (CLI + MCP server).
    - Why: lets power users bind any mode to any key and script it. PLAN has only one tap/hold key.
    - Difficulty: S-M.
    - Recommendation: **ADD**, hidden under Settings > Shortcuts so the default flow stays one key. An MCP server for capture-and-describe also fits agent workflows.

19. **S3-compatible upload (R2, B2, MinIO, AWS) and custom HTTP uploader**
    - Who: Shottr 1.9, Cap, ShareX, ksnip (custom scripts).
    - Why: one generic destination covers every host; a custom uploader covers the rest.
    - Difficulty: S for S3 (a signed PUT), M for a ShareX-style custom uploader.
    - Recommendation: **ADD S3-compatible. SKIP the custom uploader.** Do not let the destination list grow past what the UX rules allow.

20. **Instant link: copy the share URL immediately, upload in the background**
    - Who: Cap Instant mode, Loom, Zight, CleanShot Cloud.
    - Why: a link ready the moment you stop is the "magic" moment of cloud tools.
    - Difficulty: S-M for the image/short-clip case: pre-allocate the object key, paste the URL, finish the upload after. L for true upload-while-recording.
    - Recommendation: **ADD the pre-allocated link** for OneDrive/Immich/S3 where the API allows. **SKIP upload-while-recording.**

21. **Comments, reactions, viewer analytics, password-protected or expiring links, custom domains**
    - Who: Loom, Cap, CleanShot Cloud, Zight.
    - Why: team review and tracking.
    - Difficulty: L (needs a backend).
    - Recommendation: **SKIP.** It contradicts the no-server design.

22. **Style presets and stamps, batch processing, printing/PDF export**
    - Who: Snagit (templates, batch), ksnip (print/PDF), PicPick.
    - Why: corporate documentation.
    - Difficulty: M.
    - Recommendation: **SKIP.**

## 3. Where Grabbit already beats them

- **Multi-window capture of covered windows.** Windows are grabbed whole and laid out as on screen. No competitor reviewed advertises this.
- **Chat-ready clipboard in one click.** *Smaller*, *Chat (JPEG <= 2 MB)* and *Copy for chat (<94 MB)* copy a real file with a name. Nobody else sizes for the destination.
- **Lossless WebP storage** at about 41 % of PNG with pixel-exact output (README table).
- **Excalidraw drawings on the video timeline**, each with its own bar and time span. Snipping Tool's trim supports a single cut only, and Kap trims only.
- **Separate system-sound and mic tracks** with a post-hoc choice. Among the apps checked only Cap Studio documents separate tracks.
- **Invisible watermark with a "Check image" reader, metadata stripping on by default, step recorder to markdown and .docx, Obsidian hand-off.** None of the apps checked offers an equivalent.
- **Replay buffer** (last 30-120 s on a hotkey) without OBS's scene setup.
- **One-key tap-to-capture, hold-to-record flow.** Most rivals need separate shortcuts or a mode menu first.
- **Price and licence.** Free and MIT, against paid licences or subscriptions for CleanShot, Snagit, Screen Studio, Loom and Zight.
- **Real cross-platform parity.** Only Cap, Flameshot and ksnip run on all three desktops; none of the polished screenshot apps (CleanShot, Shottr, Xnapper, Snagit) run on Linux. Wayland done through portals would beat Flameshot (weak) and ksnip (hotkeys only on Windows/X11).

## 4. Top 10 to add to be the best

1. **Post-capture Quick Access thumbnail with drag-out** (copy, save, edit, pin, share; auto-dismiss).
2. **Studio recording layer:** cursor-event sidecar, click-driven auto-zoom, cursor smoothing, click effects, motion blur. This replaces PLAN's "zoom follows the mouse".
3. **Beautify / background tool for screenshots** with presets, auto-balance, shadow and rounded corners.
4. **Video backgrounds, padding and output aspect ratios** sharing the beautify compositor.
5. **Transcript-based editing:** word-level whisper timestamps, delete-to-cut, filler and pause removal.
6. **Crash-safe recording:** fragmented MP4, disk-space guard, tray timer.
7. **Per-mode custom hotkeys plus CLI/URL scheme (and an MCP server)** under Settings.
8. **"Clean desktop" mode:** hide desktop icons and best-effort Do Not Disturb while capturing or recording.
9. **Instant link plus S3-compatible destination:** copy the URL first and finish the upload in the background.
10. **High-quality GIF/animated WebP export** and **video privacy masks** that follow a region on the timeline.

## 5. Caveats

- Snagit pricing and the Snipping Tool's 2026 state come from third-party summaries and 2025 news. Neither vendor's own page gave a price or dated changelog this session.
- Kap's maintenance status is not stated on its site or repo page. Verify before treating it as active.
- CleanShot's feature page does not mention Studio Mode or v5. The v5.0 details above come from its changelog only.
- Screen Studio price listings conflict across comparison sites. The $9/$29 figures come from [screen.studio](https://screen.studio/).
- ShareX licence and Windows 11 OCR behaviour were not re-checked. ShareX's own page confirms free, Windows-only, open source.
