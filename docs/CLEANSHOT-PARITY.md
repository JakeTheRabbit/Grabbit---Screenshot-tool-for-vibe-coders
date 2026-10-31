# CleanShot X parity checklist

Source: cleanshot.com/screenshots and cleanshot.com/features (read 2026-11-01). CleanShot X is macOS-only, so this is
feature parity from its published feature list, not code. Grabbit implements each item its own way on Windows.

Status: ✅ done · 🔨 in progress · ⏳ planned · ➖ out of scope (say if you want it)

## Capture
| Feature | Status | Grabbit approach |
|---|---|---|
| Capture area / window / fullscreen | ✅ | Picker: drag, click window, F |
| All-in-one mode (one shortcut for every mode) | ✅ | PrtScn picker does area + window + screen |
| Freeze screen while selecting | ✅ | Always frozen frame |
| Choose action after capture | ✅ | Bar: Copy · Smaller · Chat · Edit |
| Multi-window capture | ✅ | Ctrl+click windows; PrintWindow each (even covered), composed at screen positions on transparent |
| Scrolling capture (vertical + horizontal), "works in every app" | 🔨 | Vertical ✅ (UIA % steps → posted wheel → manual stitch; tolerant row matcher; sticky bands once). Horizontal ⏳ |
| Full scrollable window (everything you could scroll to) | ✅ | Click a window in scroll mode: jumps to top, scrolls to the end |
| Self-timer | ⏳ | 3 / 5 / 10 s, tray + picker key |
| Crosshair + magnifier | ✅ | Loupe with crosshair, position, size, colour |
| Specify size / lock aspect ratio | ⏳ | Type W×H, aspect presets, Shift-lock |
| Retake / remember last selection | ⏳ | Hotkey + picker key R |
| Window capture with background / padding / shadow, or transparent | ⏳ | Background tool + DWM-based transparent capture |

## Quick Access Overlay
| Feature | Status | Grabbit approach |
|---|---|---|
| Floating thumbnail after capture (copy, save, annotate, pin, share) | ⏳ | Corner card with buttons, stacked for several captures |
| Drag & drop the capture into any app | ⏳ | Drag from the card, or from the editor's "Drag me" handle |
| Restore recently closed overlay, auto-close, position/size, multi-display, hide temporarily | ⏳ | Settings |

## Annotate (editor)
| Feature | Status | Grabbit approach |
|---|---|---|
| Arrows (incl. curved), shapes (rect, filled rect, ellipse, line), text, pencil, highlighter | ✅ | Embedded Excalidraw |
| Text styles, fonts, size, alignment, fill, line colour, opacity, send to back/front, group, align | ✅ | Excalidraw |
| Counter (numbered steps) | ✅ | Custom tool |
| Blur / pixelate / solid-fill redaction | ✅ | Custom tool: bakes the redaction into an image layer |
| Spotlight | ✅ | Dim everything outside a selected box |
| Colour picker (eyedropper), favourite colours | ✅ | Excalidraw eyedropper + custom swatches |
| Emojis and icons | ✅ | Picker panel (emoji + Lucide icons) |
| Combine images: drop another screenshot in | ✅ | Recent-captures strip, click to layer on top; paste/drag images |
| Crop, resize, rotate, flip | 🔨 | Crop + rotate via Excalidraw (unlock base); flip/resize ⏳ |
| Saved style presets | ⏳ | |
| Editable project file | ✅ | Save editable → `.excalidraw`; `--open` reopens it |
| Export format choice / save as | ✅ | PNG / JPEG; copy full, smaller, chat |
| Background tool (20 backgrounds, padding, alignment, aspect, auto-balance, shadow, presets) | ⏳ | |

## After capture
| Feature | Status | Grabbit approach |
|---|---|---|
| Copy / save | ✅ | Multi-format clipboard, auto-save |
| Capture history (1 month, restore, filter, delete, copy) | 🔨 | Editor strip (captures / copied) ✅; history window with filter/delete ⏳ |
| Pin screenshot (always on top, size, opacity, arrow-key move, click-through lock) | ⏳ | |
| OCR: copy text from any image, 30+ languages, on device | ⏳ | Windows.Media.Ocr (on device) |
| Read QR codes | ⏳ | ZXing.Net |
| URL scheme API | ⏳ | `grabbit://` protocol + existing CLI flags |

## Recording (Grabbit phases 3–5)
| Feature | Status | Notes |
|---|---|---|
| Record area / window / fullscreen, MP4 (H.264) or GIF, quality/FPS/resolution | ⏳ | Spike S2 proved the pipeline |
| Mic + system audio | ⏳ | |
| Do Not Disturb while recording, hide desktop clutter, show/hide cursor, timer in tray | ⏳ | |
| Show clicks, show keystrokes, camera overlay | ⏳ | Added to the plan from CleanShot |
| Video editor: smart zooms, smooth cursor, backgrounds, aspect formats, motion blur | ⏳ | After phase 7 |

## Snagit extras (techsmith.com, read 2026-11-01; Snagit not installed, so no rea binary pass yet)
| Feature | Status | Grabbit approach |
|---|---|---|
| Magnifier loupe + crosshair while selecting (Greenshot-style) | ✅ | 21 px at 8×, pixel crosshair, position, size, hex colour |
| Action bar at the mouse after selecting | ✅ | Opens where the mouse let go |
| Scrolling: auto arrows only when the window can scroll, otherwise manual-scroll + stitch | ✅ | UIA `ScrollPattern` / `WS_VSCROLL` + `GetScrollInfo` probe; `WM_VSCROLL` fallback; settle delay; ignore sticky header/footer bands |
| Scrolling "entire" (both directions, 2D tiles) | ⏳ | |
| Multiple areas in one capture | ⏳ | Multi-window done; free-drawn multiple areas next |
| Menu capture, object capture (UI element under the cursor via UIA) | ⏳ | |
| Time-lapse capture | ⏳ | |
| Capture presets (mode + size + after-action) | ⏳ | |
| Capture metadata (app, window title, URL) saved with the capture | ⏳ | |
| Edit the cursor after capture (move / remove / swap) | ⏳ | Capture the cursor as a separate layer |
| **Step Capture**: numbered guide from your clicks → Word / PowerPoint / images | ⏳ | Global mouse hook during a session + per-click screenshot |
| Stamps / asset library | ✅ | Emoji + icon picker; user stamps later |
| Magnify callout | ⏳ | |
| Cut out (remove a strip, torn edge or wave) | ⏳ | |
| Magic wand / selection, eraser, fill | ⏳ | |
| Borders and edge effects; background remover | ⏳ | |
| Smart Move / Edit Text in screenshot / Simplify | ➖ | Heavy ML; maybe later |
| **Smart Redact**: auto-find emails, phones, card numbers | ⏳ | OCR word boxes + regex → pixelate |
| Themes (team colours and fonts), templates, batch processing, custom toolbar | ⏳ | |
| Library: search, tags, folders, filter by app/site/date | ⏳ | Grows out of capture history |
| Export PDF / WebP / TIFF / GIF / BMP / HEIF | ⏳ | |
| Share to Outlook / Teams / OneDrive / Word / PowerPoint / Slack / Drive | ⏳ | |
| Draw on screen while recording, video from images, trim/combine, grab frame, noise removal | ⏳ | Recording phases |

## Cloud
| Feature | Status | Notes |
|---|---|---|
| CleanShot Cloud (links, comments, passwords, expiry, transcription, teams) | ➖ | Not building a SaaS. Could upload to your own homelab target (Immich, Nextcloud, Cloudflare R2) for a link if wanted |
