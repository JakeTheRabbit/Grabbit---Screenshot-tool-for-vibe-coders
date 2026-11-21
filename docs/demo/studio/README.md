# README pictures

Every picture in the README is Grabbit's real UI (the app's own pages) running in headless Chrome with Tauri's IPC replaced by [mock.js](mock.js) and fed made-up data, so nothing opens on your desktop and no real screen is ever captured.

1. In `app/`: `node node_modules/vite/bin/vite.js --host 127.0.0.1` (port 5173).
2. Headless Chrome on port 9444: `chrome --headless=new --remote-debugging-port=9444 --user-data-dir=<temp> --hide-scrollbars --force-color-profile=srgb about:blank`.
3. `node ../record-demo.mjs` once (the demo recording for the video editor).
4. `node frame.mjs` renders [../desktop.html](../desktop.html) into the frozen "screen".
5. `node shoot.mjs` shoots the raw states into `../out/raw` and writes the animated `docs/screenshots/demo.webp`.
6. `node posters.mjs` frames them with headlines into `docs/screenshots/*.webp` and `social-preview.png`.

Both scripts take names to redo just some, e.g. `node shoot.mjs picker voice` or `node posters.mjs hero`.

## The workflow reel

`node ../reel/reel.mjs` (after steps 1 and 2, with ffmpeg and uv installed) makes the narrated tour: `docs/screenshots/reel.mp4` (about 6 minutes, with sound and a chapter per feature), a narrated `clip-<feature>.mp4` per feature, and a silent `clip-<feature>.webp` loop of each for the README (GitHub plays WebP inline, not a repo's MP4). It follows one made-up bug from "something's off" to fixed, then walks through the wheel's keys, the More wheel, scrolling capture, copy text, pin, a capture over a capture, hiding private details, the markup tools, recording (countdown, Start over) and the video editor (scrubbing, split, trim, cut silences, captions, every tool's tooltip, speed, click effects, copy), then History and Automations. The whole screen stays in view: nothing zooms or pans.

- [../reel/desk.html](../reel/desk.html) is the made-up desktop: a half-built app with two bugs, a long Orders page for the scrolling capture, and an AI chat. [../reel/secrets.html](../reel/secrets.html) is the screenshot with private details in it.
- `shoot` drives the real picker, Talk to AI window, picture editor and video editor with mouse and keys, and writes a timeline of beats: what's on screen, where the pointer is, the caption, the keys and the spoken lines. What the chat receives is what Talk to AI really put on the clipboard. The voices come from `edge-tts` (run through `uvx`) and are cached in `out/reel/vo`, so a second shoot doesn't fetch them again.
- `render` works out every frame (pointer, fades, key presses) and has [../reel/stage.html](../reel/stage.html) draw it; `encode` mixes the voices and click sounds and turns the frames into the videos and the WebPs. `CLIPS` at the top of `reel.mjs` says which scenes make each clip.
- `node ../reel/reel.mjs render 10 20` draws only seconds 10 to 20; a third number draws every nth frame, for a contact sheet.

To change the story, edit the beats in `shoot()`: `cap(html, line)` sets the caption and the narrator's line, `say()` the person's own words, `keys()` the key caps, `glide()` moves the pointer, `wait()` holds until the line being spoken is over, `beat(seconds)` holds.

## Checks

`node markup-sweep.mjs` does the same for the new editor (the default, [../../markup-editor.md](../../markup-editor.md)): every tool, Hide modes, crop, undo, export size, panels and tabs.

`node editor-sweep.mjs` (after steps 1, 2 and 4) clicks through the picture editor's buttons, menus and panels with a faked core and prints PASS/FAIL per check: steps, Hide modes and undo, Spotlight, Copy/Save, stickers, Beautify, AI edits, tabs and the sidebar.

`node loupe-check.mjs` hands the picker its frame the way WebView2 does on Windows (shared memory, with the picker details) and checks the loupe, the colour read and that the frame is released when the picker closes.

`node video-check.mjs` checks the video editor's icon tools (each has a name and a tooltip), the A1 waveform and the timecode.

`node hold-check.mjs` checks holding the capture key: the "Keep holding to record" pill, letting go in time, and the picker turning into the recording picker.
