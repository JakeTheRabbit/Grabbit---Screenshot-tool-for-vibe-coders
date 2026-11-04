// The picker's frame arriving in shared memory (as WebView2 delivers it on Windows), the loupe and the colour read
// that now come straight from the frame's pixels, and the frame being let go when the picker closes.
// Usage: node loupe-check.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { demo, extra, open, sleep } from "./lib.mjs";
const K = 1.6, W = 2560, H = 1440;
const rgba = readFileSync(join(demo, "out/desktop.rgba"));
extra.set("grabbit/frame/0", { bytes: rgba, type: "application/octet-stream" });
const info = { frame: 0, x: 0, y: 0, width: W, height: H, mode: "Pick", last_rect: null, os: "windows", windows: [] };
// A stand-in for WebView2's chrome.webview: the page listens for "sharedbufferreceived" and releases what it got.
const setup = `__studio.handlers = { get_settings: {} };
  window.__released = 0;
  window.chrome = { webview: { _l: [], addEventListener(t, f) { if (t === "sharedbufferreceived") this._l.push(f); }, releaseBuffer() { window.__released++; } } };`;
const p = await open("picker.html", { width: 1600, height: 900, dpr: K, setup });
await sleep(300);
// Hand the frame over the way the core does on Windows: details and pixels together, no picker_info, no fetch.
await p.ev(`(async () => { const r = await fetch(window.__TAURI_INTERNALS__.convertFileSrc("frame/0", "grabbit")); const buf = await r.arrayBuffer();
  for (const f of chrome.webview._l) f({ additionalData: ${JSON.stringify(info)}, getBuffer: () => buf }); })()`);
await p.waitFor(`document.body.classList.contains("ready")`);
let fails = 0;
const ok = (name, cond, detail = "") => { if (!cond) fails++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
ok("the shared frame opens the picker without asking the core", await p.ev(`document.body.classList.contains("ready")`));
// A coloured pixel (not white, grey or black), so the check can't pass by accident.
let cx = 0, cy = 0;
for (let y = 200; y < 800 && !cx; y += 7) for (let x = 100; x < 1500; x += 7) {
  const j = (Math.floor(y * K) * W + Math.floor(x * K)) * 4;
  if (Math.abs(rgba[j] - rgba[j + 2]) > 60) { cx = x; cy = y; break; }
}
await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy, button: "none" });
await sleep(200);
const shown = await p.ev(`document.getElementById("loupe-text").textContent`);
const px = Math.floor(cx * K), py = Math.floor(cy * K), i = (py * W + px) * 4;
const want = "#" + [rgba[i], rgba[i + 1], rgba[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
ok("the loupe shows the colour under the pointer", shown.includes(want), `${shown} (want ${want})`);
const lit = await p.ev(`(() => { const c = document.getElementById("loupe"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let j = 0; j < d.length; j += 4) if (d[j] || d[j + 1] || d[j + 2]) n++; return n; })()`);
ok("the loupe draws the magnified pixels", lit > 1000, `${lit} lit pixels`);
await p.ev(`__studio.emit("reset")`);
await sleep(200);
ok("closing the picker releases the shared frame", (await p.ev(`window.__released`)) === 1);
console.log(p.errors.length ? "PAGE ERRORS:\n" + p.errors.join("\n") : "no page errors");
console.log(fails ? `${fails} FAILED` : "ALL PASS");
await p.close();
process.exit(fails ? 1 : 0);
