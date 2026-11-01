# Grabbit — hybrid capture / annotate / clip tool (plan)

Snipping Tool's capture + video engine, Greenshot's annotation object model, PowerPoint-style editing,
and a clipboard layer built for pasting into chat apps (Signal first).

Status: **plan only** (2026-10-31). Nothing built. Working name "Grabbit". Proposed path: `C:\Github\apps\grabbit\`.

---

## 1. What the reverse engineering found (rea 6.8.0)

Raw evidence JSON: `%TEMP%\claude\...\scratchpad\rea\*.json` (session scratch; key facts copied below).

### Microsoft Snipping Tool 11.2608.41.0 (`Microsoft.ScreenSketch`)
Native C++/WinRT (`SnippingTool.exe`, `SnippingToolUI.dll`) and a 23.5 MB native-AOT .NET part (`SnippingTool.Net.RuntimeComponent.dll`, rea: "not-managed" PE, so no CLI metadata). Bundles OpenCV 4.8, ONNX Runtime and `oneocr.dll` for OCR and AI.

| Concern | How it does it (evidence) |
|---|---|
| Frame capture | `Windows.Graphics.Capture.GraphicsCaptureItem` + `Direct3D11CaptureFramePool`, `GraphicsCaptureAccess`; imports `D3D11CreateDevice`, `CreateDirect3D11DeviceFromDXGIDevice`, `CreateDXGIFactory1`. Log strings `IsBorderRequired: false`, `IsCursorCaptureEnabled` → hides the yellow WGC border and toggles the cursor. |
| Hide its own UI from capture | `SetWindowDisplayAffinity` import (WDA_EXCLUDEFROMCAPTURE). |
| Window picking | `EnumWindows`, `SetWinEventHook`, `DwmGetWindowAttribute` (extended frame bounds), `QueryDisplayConfig` / `EnumDisplayMonitors`. |
| Video encode | Frames → `Windows.Media.Core.MediaStreamSource` (`VideoStreamDescriptor`, `MediaStreamSample`) → `Windows.Media.Transcoding.MediaTranscoder` with `MediaEncodingProfile` → `{:%Y%m%d-%H%M-%S}.mp4`. Log line "Set video bitrate", `m_minFrameRateMs` (variable frame rate). |
| Audio | `MMDevAPI` ordinal 17 = `ActivateAudioInterfaceAsync` (WASAPI loopback, process-loopback capable) + `Windows.Media.Audio.AudioGraph` for the mic; `AudioFrameGenerator::GenerateLoopbackAudioFrame`. MF work queues (`MFPutWorkItem2`, `MFLockSharedWorkQueue`). |
| Trim / playback | `Windows.Media.Editing.MediaComposition` + `MediaClip`, `MediaPlayer`. GIF export (`.gif`). |
| Clipboard | `ClipboardCopyService` with **delayed rendering** (`OnPasteDataRequested(DataProviderRequest)`) so PNG encoding only runs on paste; `Flush` so the data outlives the app; retry modes (`CannotOpenClipboard`, `NotClipboardOwner`). Video copy = `DataPackage` holding `IStorageItem` (a file drop). |
| Settings | `AutoCopyScreenshotToClipboard`, `AutoCopyRecordingToClipboard`; 3/5/10 s timers. |

### Greenshot (`%LOCALAPPDATA%\Programs\Greenshot`, .NET Framework, GPL-3)
Managed, so rea pulled full type and member inventories.

| Concern | How it does it (evidence) |
|---|---|
| Capture | `CaptureHelper`, `CaptureForm` (region overlay), `WindowCapture`, `WindowDetails`; `WindowCaptureMode {Screen, GDI, Aero, AeroTransparent, Auto}` → BitBlt/PrintWindow, DWM thumbnails for transparent windows. No video. |
| Editor model | `Surface` holding a `DrawableContainerList` of `DrawableContainer` subclasses: `Arrow, Line, Rectangle, Ellipse, Freehand, Text, Speechbubble, StepLabel, Highlight, Obfuscate, Crop, Image, Icon, Svg, Metafile, Cursor`. |
| Filters | `Blur, Pixelization, Highlight, Grayscale, Brightness, Magnifier` applied inside a container's bounds. |
| Undo | Memento pattern: `DrawableContainerBoundsChangeMemento`, `TextChangeMemento`, `SurfaceBackgroundChangeMemento`. |
| Handles | `Adorners.ResizeAdorner`; `Animator` classes for overlay transitions. |
| Clipboard | `ClipboardHelper` writes **several formats at once**: `PNG`, `DIB`, `DIBV5` (alpha), `HTML` / HTML data-URL, `"PNG+Office Art"`, `"JFIF+Office Art"`, `FileGroupDescriptorW`, `Format17`. Gives the best paste result in every target app. |
| Resize | `ResizeSettingsForm` (manual, before export). |

### Signal Desktop (the paste target, checked in its `app.asar`)
- Composer paste handler: `if (e.clipboardData.files?.length > 0) return;` hands any **pasted file** on to the attachment pipeline. Chromium fills `clipboardData.files` from `CF_HDROP`, so **a file drop on the clipboard = attachment**.
- Size limit: `global.attachments.maxBytes` (server flag), falling back to `100 * 1024 * 1024` = **104,857,600 bytes**. It is compared against the *encrypted, padded* size (`unpaddedPlaintextSize … mediaTier`), so the plaintext target has to sit below that. **Target ≤ 94 MiB.**

### Reuse from Team Screen (`C:\Github\apps\team-screen`, .NET 10 WPF)
Already has: `AreaPicker` (drag-select overlay), `AreaFrame` + `AreaToolbar` (movable/resizable live frame), `InkLayer`, `HotkeyManager`, `TrayIcon`, `Monitors`, `Settings`, and `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`. Capture there is GDI copy into a WriteableBitmap. Grabbit swaps that for WGC + D3D11.

---

## 2. Hybrid: what comes from where

| Feature | Taken from | Improvement |
|---|---|---|
| Region / window / screen capture | Snipping Tool (WGC, border off, overlay excluded) | + Greenshot-style window-under-cursor highlight with child-element drill-down |
| Screenshot to clipboard | Greenshot (multi-format) + Snipping Tool (delayed render + flush) | + size presets on a modifier key |
| Annotation | Greenshot object model + filters + memento undo | + PowerPoint editing (below) |
| Recording | Snipping Tool pipeline (WGC → encoder, loopback + mic) | + **live resize**, + **extra areas of interest**, + live annotations burned in |
| Trim / export | Snipping Tool (MediaComposition, GIF) | + "fit to N MB" export |
| Copy video | Snipping Tool (storage-item drop) | + auto-compress under the Signal limit |
| Copy web video | — (new) | YouTube / Immich / Google Photos → file → clipboard |

---

## 3. Architecture

**Stack:** .NET 10 WPF (same as Team Screen), CsWinRT for WGC, **Vortice.Windows** (D3D11/DXGI/MF bindings, MIT) for the GPU compositor and the Media Foundation SinkWriter, **NAudio** for WASAPI loopback + mic, **ffmpeg 8.1** (already on the box, NVENC via the RTX 5060) for transcode/compress, **yt-dlp** (installed) for web video.

```
 Hotkeys/Tray ─► Capture Controller
                   │
   ┌───────────────┼──────────────────────────┐
   ▼               ▼                          ▼
 Selection      WGC Sources                Overlay windows
 overlay        (1 per monitor/window)      (frame, toolbar, ink —
 (AreaPicker)       │                        WDA_EXCLUDEFROMCAPTURE)
                    ▼
            D3D11 Compositor  ◄── Scene (areas of interest + layout + live annotations)
              │         │
     still frame       frame stream (BGRA texture, VFR)
              │         ▼
              │    MF SinkWriter (H.264 HW MFT / NVENC) + AAC  ◄── WASAPI loopback + mic
              ▼         ▼
          Editor (WPF vector canvas, shared shape model)   .mp4
              │         │
              ▼         ▼
          Export / Fit-to-size (ffmpeg)  ──►  Clipboard Service  ──►  paste anywhere
                                                ▲
                          Web Video Resolver ───┘ (yt-dlp / Immich API / browser ext)
```

### 3.1 Capture
- One `GraphicsCaptureItem` **per monitor** (or per window in window mode). Regions are crop rects into that texture, so several areas of interest on one monitor cost a single capture session.
- `IsBorderRequired = false`, `IsCursorCaptureEnabled` setting, frame pool `CreateFreeThreaded`, BGRA8.
- All Grabbit UI (frame, toolbar, ink chrome) gets `WDA_EXCLUDEFROMCAPTURE` so monitor capture never records it.
- Window mode: `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` to drop the invisible resize border; follow the window when it moves.

### 3.2 Compositor + scene (core of "resize on the fly" and "add another area")
- **Scene** = output canvas (W×H, fixed for the whole recording because encoders need a fixed size) + a list of **AreaOfInterest** `{source, cropRect (live), layoutSlot}` + live annotation layer.
- **Live resize:** dragging the frame changes `cropRect` on the next frame. The crop is scaled into its slot (aspect-fit, letterbox colour from settings). The encoder never restarts.
- **Add area mid-record:** hotkey → AreaPicker → new AoI. Layout switches automatically: 1 = full, 2 = side-by-side or PiP (setting), 3–4 = grid. Animated transition between layouts over ~250 ms (Greenshot's `RectangleAnimator` idea).
- Canvas size policy at record start: the larger of the first selection and 1920×1080, rounded to even numbers (H.264 needs even dimensions). **Open decision, see §7.**

### 3.3 Encoding
- MF SinkWriter fed D3D11 textures (DXGI device manager, zero-copy) → hardware H.264 (NVENC MFT). VFR timestamps from `Direct3D11CaptureFrame.SystemRelativeTime`; duplicate the last frame at ≥ 1 fps when the screen is static.
- Audio: WASAPI loopback (system, or a single process via process loopback, as Snipping Tool does) + optional mic, mixed to 48 kHz stereo AAC.
- Output: `%USERPROFILE%\Videos\Grabbit\yyyyMMdd-HHmm-ss.mp4`, `+faststart` (remux after stop) so chat apps can preview it.

### 3.4 Editor: one shape model for stills and video
Shape model ported conceptually from Greenshot (clean-room in C#/WPF, no GPL code copied):
`Shape { id, kind, bounds, rotation, style{stroke, fill, opacity, shadow, font}, z, groupId, tIn?, tOut? }`
Kinds: rect, rounded rect, ellipse, line, arrow (head combos), freehand, highlighter, text box, callout/speech bubble, step number (auto-increment), image/icon, blur, pixelate, magnifier, spotlight (dim everything else), crop.

PowerPoint behaviour (the part Greenshot lacks):
- 8 resize handles + rotation handle; Shift = constrain aspect / 15° snap; Ctrl-drag = duplicate; Alt = resize from centre.
- Smart guides: snap to other shapes' edges/centres and to the image centre, with equal-spacing hints.
- Multi-select (marquee + Shift-click), group/ungroup (Ctrl+G), align/distribute, z-order (Ctrl+[ / ]).
- Format strip: theme colour row, line weight, dash, arrowheads, fill/transparency, text styles; format painter.
- Ctrl+D duplicate, arrow-key nudge (Shift = 10 px), copy/paste shapes between captures.
- Undo/redo = command stack (memento per command, Greenshot pattern).
- **Canvas resize on the fly:** drag the canvas edge to extend it (adds padding for callouts), or crop to shrink. Image scale (%) and "fit long edge" are separate commands.

Video: the same canvas over a timeline. Each shape has `tIn/tOut` bars; trim handles on the clip; render = compositor replays the video and burns the shapes in, then the encoder. **Live annotation during recording:** the ink/shape tools draw into the compositor scene (not a captured window), so strokes stay sharp and the toolbar never shows up in the video.

### 3.5 Clipboard service
One service, two payload kinds. Delayed rendering + flush on exit (from Snipping Tool), retry on `CLIPBRD_E_CANT_OPEN` up to 10 × 50 ms.

**Image** (formats written in one go, from Greenshot):
`PNG` (registered format), `CF_DIBV5` (alpha), `CF_DIB`, `HTML Format` (data-URL `<img>`), `CF_HDROP` → temp PNG file, `Preferred DropEffect = COPY`.
Size presets:

| Key | Result |
|---|---|
| Ctrl+C / auto-copy | Full resolution PNG |
| Ctrl+Shift+C | Reduced: long edge 1920 (setting) |
| Ctrl+Alt+C | "Fit chat": JPEG q85, long edge 2560, binary-search quality to ≤ 2 MB |

**Video:** `CF_HDROP` (temp `.mp4` in `%LOCALAPPDATA%\Grabbit\clip\`, kept 24 h) + `Preferred DropEffect = COPY` + `FileGroupDescriptorW`/`FileContents` as a fallback for apps that ignore HDROP. Signal attaches it on Ctrl+V (verified in Signal's code, still to be checked by hand: spike S1).

| Key | Result |
|---|---|
| Copy | Original file |
| Copy for Signal (default when > 94 MiB) | Compressed to ≤ 94 MiB |
| Copy reduced | 720p30, CRF-style "small" preset |

### 3.6 Fit-to-size (≤ 94 MiB)
1. `ffprobe` → duration *d*, resolution, fps.
2. Budget: `video_kbps = (94 × 1024 × 1024 × 8 × 0.97 / d − 128 000) / 1000` (3 % mux overhead, 128 kbps AAC).
3. Pick a ladder rung with an acceptable bits-per-pixel (≥ 0.04 bpp for screen content, ≥ 0.07 for camera video): 1080p60 → 1080p30 → 720p30 → 540p30 → 480p24.
4. `ffmpeg -c:v h264_nvenc -preset p6 -rc vbr -b:v {kbps}k -maxrate {1.5×} -bufsize {2×} -c:a aac -b:a 128k -pix_fmt yuv420p -movflags +faststart`. H.264/AAC/MP4 is what Signal plays inline on every platform.
5. Check the real size; if it's over, retry at 0.92 × bitrate (two tries max), then step down one rung.
6. Toast: "Copied 91.8 MB (from 312 MB, 720p30)". Very long clips: warn when the budget lands under 480p24 instead of producing mush.

### 3.7 Copy video from the web (YouTube / Google Photos / Immich / others)
Trigger: hotkey **Ctrl+Alt+V "copy video from page"**, or tray → "Copy video from URL".
URL source: clipboard URL if present, otherwise the active Chrome/Edge tab URL via UI Automation (address bar).

| Site | Resolver |
|---|---|
| Immich (`/photos/<uuid>`, self-hosted) | `GET /api/assets/{id}/original` with the Immich API key. Original file, no re-encode unless it's over the limit. |
| YouTube + ~1800 sites | `yt-dlp -f "bv*[vcodec^=avc1][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b" --merge-output-format mp4`; `--cookies-from-browser chrome` for private or age-gated videos. Optional section download (`--download-sections "*1:00-2:30"`) when the user typed a range. |
| Google Photos | yt-dlp has no extractor. Companion **MV3 browser extension**: right-click a video → "Grabbit: copy video". It reads the media item's download URL (`=dv` variant of the `googleusercontent` URL) inside the signed-in page and passes URL + cookies to Grabbit over **native messaging**. Same path works for any `<video>` with a direct `src` (blob/MSE streams fall back to yt-dlp on the page URL). |

Then: download → fit-to-size if needed → clipboard (HDROP) → toast. Progress shown in a small tray flyout; cancellable.

### 3.8 Hotkeys (defaults; G HUB G-keys can map to them)
| Action | Key |
|---|---|
| Region screenshot | PrtScn |
| Window screenshot | Alt+PrtScn (hooked only when Grabbit is set as handler) |
| Record region / window / screen | Ctrl+Alt+R (picker remembers last mode) |
| Add area of interest (while recording) | Ctrl+Alt+A |
| Pause / stop | Ctrl+Alt+P / Ctrl+Alt+S |
| Live draw toggle | Ctrl+Alt+D |
| Copy video from page | Ctrl+Alt+V |

Win+Shift+S / Win+Shift+R stay with Snipping Tool unless the user rebinds. Ctrl+Alt+R clashes with **Team Screen's share-an-area hotkey (G3)**, so one of them has to move (see §7).

---

## 4. Phases (each ends on a check that proves it)

| # | Scope | Done when |
|---|---|---|
| **S** | Spikes (de-risk first) | **S1** a `.mp4` placed as CF_HDROP pastes as an attachment in Signal Note-to-Self (pasting only attaches, nothing gets sent); **S2** WGC → crop changes mid-stream → SinkWriter NVENC gives a valid mp4 at a fixed canvas; **S3** Immich + yt-dlp resolvers return an mp4 path. |
| 1 | Shell: tray, hotkeys, settings, region/window/screen screenshot, multi-format clipboard + size presets | Paste a full and a reduced screenshot into Signal, Word and Paint; alpha survives in Word (DIBV5). |
| 2 | Editor core: shapes, handles, rotation, snapping, undo, filters, canvas resize | Annotate → Ctrl+C → paste shows the annotations; 50-step undo round-trips. |
| 3 | Recorder: WGC + compositor + MF encode + loopback/mic audio, auto-copy | 5-minute 1440p recording, A/V drift < 50 ms, file plays in Signal preview. |
| 4 | Live resize + extra areas of interest + live draw | Resize and add an area mid-recording; output has no dropped segments; toolbar never appears in the video. |
| 5 | Fit-to-94 MiB + copy-video variants | 10-minute 1080p60 clip → ≤ 94 MiB, Signal accepts it; ten-sample size-hit test. |
| 6 | Web video: URL/tab resolver, Immich, yt-dlp, browser extension + native host | YouTube, Immich and Google Photos videos each paste into Signal. |
| 7 | Video timeline annotations, trim, GIF export, OCR (`Windows.Media.Ocr`), capture history | — |

Rough size: S + 1–3 is the usable core (Snipping Tool parity + better clipboard); 4–6 are the bits nobody else has.

---

## 4a. Spike results (2026-11-01)

Code lives in `C:\Github\apps\grabbit\spikes\{s1,s2,s3}`.

| Spike | Result | Evidence |
|---|---|---|
| **S1** file-drop video paste | **Pass at the Chromium layer; still needs one manual check in Signal.** `set-filedrop.ps1` writes `FileDrop` + `Preferred DropEffect=COPY` (flushed). A real OS-clipboard paste into Chrome via CDP (`cdp-paste.mjs`) gave `clipboardData.files = [{name:"grabbit-s1-test.mp4", type:"video/mp4", size:2377781}]`. That is exactly what Signal's composer checks. Driving Signal itself was blocked because computer-use masked every monitor (LockApp window). | `spikes/s1` |
| **S2** live crop → fixed canvas → HW H.264 | **Pass.** 3840×2160 monitor via WGC; crop animated full → 50 % → tall strip → wide strip; `ID3D11VideoProcessor` scales and converts to NV12 with letterbox/pillarbox; MF SinkWriter (D3D manager + hardware transforms). Output: H.264 1920×1080, 30/1, **240/240 frames**, 8.00 s, 12.2 MB. The screen was mostly static, so only 86 new WGC frames arrived; reusing the last frame keeps the output at a steady 30 fps. | `spikes/s2/s2-live-crop.mp4`, `s2-contact.png` |
| **S3** URL → mp4 resolvers | **Pass.** Immich `/photos/<uuid>` → `/api/assets/{id}/original` (1080p **HEVC**, 16.2 MB); YouTube via yt-dlp (H.264/AAC). yt-dlp 2026.07.04 got **HTTP 403**; 2026.10.26 works. | `spikes/s3/resolve.mjs` |

Lessons for the build:
- The video processor's **input texture needs `RenderTarget | ShaderResource`** bind flags. ShaderResource alone makes `CreateVideoProcessorInputView` fail with `E_INVALIDARG`.
- The MF H.264 default is **Constrained Baseline**. Set `MF_MT_MPEG2_PROFILE` = High for better quality per byte.
- NVENC use by the MFT is not yet confirmed (the nvidia-smi sample landed on a failed run). Check encoder sessions during the next run.
- **Re-encode HEVC to H.264 for Signal** even when the file is under 94 MiB (phone/Immich originals are HEVC).
- **Grabbit must keep yt-dlp current** (`pip install -U yt-dlp` weekly, or on a 403 retry).
- Immich: the spike used a temporary key minted in the DB and then deleted it. The real app needs a scoped key (`asset.read`, `asset.view`, `asset.download`) created in Immich → Account Settings → API Keys.
- Clipboard can be clobbered between copy and paste (seen once in S1). Re-assert the payload if the user pastes within N seconds and the sequence number changed.

## 4b. Phase 1 status (2026-11-01)

Code: `C:\Github\apps\grabbit\src\Grabbit\` (.NET 10 WPF, tray app). Build: `dotnet build`; check: `Grabbit.exe --selftest <dir>`.

**Done and verified**
- Freeze-frame grab of all 4 monitors (11040×2560 virtual desktop) in ~230 ms; picker up in ~600 ms.
- Picker: drag = region, click = window under the cursor (DWM frame bounds), click on the desktop = that screen, F = whole screen, Esc / right-click = cancel. Shift at release = smaller copy, Alt = chat-sized.
- Picker windows sized exactly per monitor in physical px (fixed a WPF DPI re-layout that shrank them to 2560×1440 on 150 % screens).
- Ghost overlays are skipped when hit-testing windows: NVIDIA overlay, LogiOverlay and the computer-use cursor overlay. Rule: `WS_EX_TRANSPARENT`, or layered at alpha 0.
- Clipboard written via Win32 in one go: `PNG` (or `JFIF` for chat-sized), `CF_DIBV5` (32-bit + alpha mask), `CF_DIB` (24-bit), `CF_HDROP` temp file + `Preferred DropEffect = COPY`. Self-test reads every format back and decodes it: **24/24 pass**.
- Sizes: Full = original PNG; Reduced = long edge ≤ 1920 PNG; Chat = long edge ≤ 2560 JPEG, highest quality that fits ≤ 2 MB (a 4K screen came out at 261 KB).
- Click-a-window path end to end with real mouse input: picked the Edge window 3840×2088 → saved PNG + clipboard + file drop.
- Second launch of `Grabbit.exe` = capture (relayed to the tray app, which takes the foreground for the picker).
- Diagnostics log: `%APPDATA%\Grabbit\log.txt`.

**Not verified**
- Drag-to-select with *injected* input: on this box, input injected from the agent shell never reached the picker in some runs (not even `WM_NCHITTEST`), most likely a low-level mouse hook (G HUB, PowerToys, AHK, computer-use driver). The drag code shares the click path, but a real drag still needs a hand test.
- Pasting into Signal / Word / Paint by hand (phase 1 done-check).

**Found along the way**
- **Greenshot holds PrtScn** (it registers first at login), so Grabbit's 4 PrtScn hotkeys fail while Greenshot runs. Grabbit falls back to **Ctrl+Alt+G** and shows a toast listing the taken keys. A synthetic PrtScn during testing opened Greenshot's capture form, which ignored Esc/WM_CLOSE, so Greenshot was restarted.
- Pictures can be redirected to a synced folder (OneDrive), so the default save folder may sync to the cloud. Change `SaveFolder` if that matters.
- Start-with-Windows is off by default until there's an installed (published) build.

## 4c. Phase 2, first cut (2026-11-01)

- **Choose after you pick:** the picker shows a bar by the selection (Copy · Smaller · Chat size · Edit…). Ctrl as you let go = edit, Shift = smaller, Alt = chat. The tray's *After PrtScn* switches between Ask, Copy and Edit.
- **Editor** (`src/Grabbit/Editor/`): immutable `Mark` records, so undo/redo is a stack of lists. Tools: arrow, box, ellipse, line, pen, marker, text, numbered steps and pixelate blur. Includes select/move, 8-handle resize (endpoints for lines), restyling the selection, duplicate, nudge, zoom/fit, and copy at three sizes / save as. Unsaved edits are auto-saved on close.
- **Verified:** self-test renders a box, step, blur, text and arrow onto a real capture and checks pixel colours (7/7 pass, 31/31 overall). Screenshot of the editor window on a 4K capture: layout, fit at 78 %, status bar. Your own 01:36 capture confirms real drag-select works.
- **Not verified:** interactive drawing and handles with real mouse input (injected input is unreliable on this box), and the picker bar on screen.
- **Still to come for PowerPoint parity:** rotation handle, smart guides/snapping, multi-select + group, z-order, format painter, crop/canvas resize.

## 4d. Recording + video timeline, first cut (2026-11-01)

- **Recorder** (`Recorder.cs`): ffmpeg `ddagrab` + NVENC instead of the planned WGC + MF SinkWriter. Far less code, and the GPU crops the area. `Dxgi.cs` maps a desktop rect to ddagrab's `output_idx`; DXGI order differs from Screen.AllScreens, and two monitors here are both 3840×2160. System sound and mic come from NAudio WASAPI, with a silent keep-alive so loopback doesn't drop quiet parts. Muxed to AAC/mp4 with faststart on stop.
- **Overlay** (`RecordingBar.cs`): red frame + timer/Stop/discard bar, both `WDA_EXCLUDEFROMCAPTURE`. Verified: 0 red pixels at the video's edges.
- **Video editor** (`VideoEditorWindow.cs` + `editor-web/video.html`): filmstrip timeline, scrub, edge-drag trim, split, cut part, I/O, undo, zoom. Renders kept ranges with ffmpeg trim/concat: Copy (file drop), Copy for chat (≤ 94 MB, ≤ 1920 px), GIF, Save / Save as / Copy path.
- **Hotkey:** Ctrl+Alt+PrtScn. Ctrl+Alt+Shift+R is held by another app on this box.
- **Verified:** `--record-test` (10/10) and `spikes/p7-video-cdp.mjs` (7/7: load, range seek, filmstrip, split/cut, a real mouse edge drag, undo, Copy → 4.093 s file on the clipboard).
- **Not verified:** the hotkey → picker → Record flow by hand, the mic path (off by default), and long recordings (A/V drift).
- **Not built yet:** pause, live resize, extra areas, drawing on the video.

Also fixed the same day:
- **Picker loupe:** it flipped sides when its text width changed, and at 150 % each zoomed pixel was 12.57 screen px, so pixels and grid drifted. The lens is now whole-pixel cells, has a fixed width and only changes side when it runs out of room, and its shadow is on its own layer.
- **Editor links:** Excalidraw's help links were swallowed by `NewWindowRequested`. Web links now open in the default browser.

## 5. Risks

- **Signal paste of HDROP** depends on Chromium mapping CF_HDROP into `clipboardData.files`. Code path confirmed, behaviour not yet tested by hand (S1). Fallback: `FileGroupDescriptorW` + `FileContents` stream.
- **Encrypted-size margin:** if 94 MiB is still rejected, drop the target to 90 MiB. One constant.
- **WGC on DRM content** (Netflix etc.) gives black frames. Expected, can't be fixed.
- **Google Photos URLs** change shape now and then; the extension isolates that breakage from the app.
- **NVENC session limit** on GeForce (8 concurrent) won't matter for one recording plus one transcode.
- **Clean-room:** Greenshot is GPL-3, so take its model and behaviour, not its code, unless Grabbit ships GPL too.

## 6. Out of scope (for now)
Cloud upload/share links, webcam overlay, cross-platform, scrolling capture (could come after phase 7, since Greenshot's IE capture is dead tech anyway).

## 7. Open decisions
1. **Canvas policy when a region is resized mid-record:** fixed canvas + aspect-fit letterbox (recommended, no re-encode) vs canvas tracks the region (needs segment-and-concat).
2. **Two areas:** side-by-side vs picture-in-picture as the default.
3. **Hotkey clash:** Ctrl+Alt+R is Team Screen's share-area key (G3). Move Team Screen, or pick another key for recording.
4. **Licence:** MIT clean-room (recommended) vs GPL-3 so Greenshot code can be borrowed.
