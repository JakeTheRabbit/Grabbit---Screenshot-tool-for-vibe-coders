# README pictures

Every picture in the README is Grabbit's real UI (the app's own pages) running in headless Chrome with Tauri's IPC replaced by [mock.js](mock.js) and fed made-up data, so nothing opens on your desktop and no real screen is ever captured.

1. In `app/`: `node node_modules/vite/bin/vite.js --host 127.0.0.1` (port 5173).
2. Headless Chrome on port 9444: `chrome --headless=new --remote-debugging-port=9444 --user-data-dir=<temp> --hide-scrollbars --force-color-profile=srgb about:blank`.
3. `node ../record-demo.mjs` once (the demo recording for the video editor).
4. `node frame.mjs` renders [../desktop.html](../desktop.html) into the frozen "screen".
5. `node shoot.mjs` shoots the raw states into `../out/raw` and writes the animated `docs/screenshots/demo.webp`.
6. `node posters.mjs` frames them with headlines into `docs/screenshots/*.webp` and `social-preview.png`.

Both scripts take names to redo just some, e.g. `node shoot.mjs picker voice` or `node posters.mjs hero`.

`node markup-sweep.mjs` does the same for the new editor (the default, [../../markup-editor.md](../../markup-editor.md)): every tool, Hide modes, crop, undo, export size, panels and tabs.

`node editor-sweep.mjs` (after steps 1, 2 and 4) clicks through the picture editor's buttons, menus and panels with a faked core and prints PASS/FAIL per check: steps, Hide modes and undo, Spotlight, Copy/Save, stickers, Beautify, AI edits, tabs and the sidebar.
