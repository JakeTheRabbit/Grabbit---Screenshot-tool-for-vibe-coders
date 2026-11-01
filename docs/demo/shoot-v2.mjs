// README screenshots for Grabbit 2, from the made-up demo page only (nothing of the real desktop):
// a debug-build Grabbit window covers the primary monitor showing docs/demo/demo.html, and every shot is either a
// Grabbit page (DevTools screenshot) or a grab of that covered monitor.
//   pwsh spikes/run2.ps1 (with GRABBIT_CONFIG pointing at an empty demo config), then: node docs/demo/shoot-v2.mjs
import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const exe = join(root, "app/src-tauri/target/debug/grabbit.exe");
const out = join(root, "docs/screenshots");
const work = join(process.env.TEMP, "g2demo");
const shots = join(work, "shots"), videos = join(work, "videos");
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = async () => { try { return await (await fetch("http://127.0.0.1:9333/json")).json(); } catch { return []; } };
async function waitFor(fn, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(150); } throw new Error("timed out"); }

async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0; const pend = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); pend.get(m.id)?.(m); pend.delete(m.id); });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description; };
  const shot = async (file, w, h, dpr = 1.5) => {
    if (w) await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: dpr, mobile: false });
    await sleep(600);
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(file, Buffer.from(r.result.data, "base64"));
    if (w) await send("Emulation.clearDeviceMetricsOverride");
    console.log("saved", file);
  };
  const close = () => ws.close();
  return { send, ev, shot, close };
}
const invoke = (c, cmd, args) => c.ev(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})})`);
const downscale = (file, width = 1920) => execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", file, "-vf", `scale=${width}:-2:flags=lanczos`, file + ".tmp.png"]) && copyFileSync(file + ".tmp.png", file);

const host = await connect(await waitFor(async () => (await targets()).find((t) => t.url.includes("picker.html"))));

// 1. Cover the primary monitor (0,0, 150 %) with the demo page.
const rect = await invoke(host, "dev_window", { page: "demo.html?still", x: 0, y: 0, w: 2560, h: 1440, monitor: Number(process.env.DEMO_MONITOR ?? 1) });
console.log("demo window", rect);
if (JSON.stringify(rect) !== "[0,0,3840,2160]") { console.error("demo window doesn't cover the 0,0 monitor: stopping before any shot"); process.exit(1); }
await sleep(1500);

// 2. Picker with the action bar, and with the More menu open.
execFile(exe, ["capture"]);
await sleep(400);
let picker;
await waitFor(async () => {
  for (const t of (await targets()).filter((x) => x.url.includes("picker.html"))) {
    const c = await connect(t);
    if ((await c.ev("document.body.className + '|' + screenX + ',' + screenY + '|' + innerWidth")) === "ready|0,0|2560") { picker = c; return true; }
    c.close();
  }
  return false;
});
const drag = async (c, x0, y0, x1, y1) => {
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0 - 40, y: y0 - 40 });
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0, y: y0 });
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", clickCount: 1, buttons: 1 });
  for (let i = 1; i <= 14; i++) { await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0 + ((x1 - x0) * i) / 14, y: y0 + ((y1 - y0) * i) / 14, button: "left", buttons: 1 }); await sleep(16); }
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x1, y: y1, button: "left", clickCount: 1 });
};
// Safety: the frozen frame must be the demo page (light cards, dark sidebar), never the real desktop.
const looks = await picker.ev(`(() => {
  const c = document.getElementById('c'), g = c.getContext('2d'), k = devicePixelRatio;
  const lum = (x, y) => { const d = g.getImageData(x * k, y * k, 1, 1).data; return (d[0] + d[1] + d[2]) / 3; };
  return { card: lum(1500, 700), side: lum(60, 900) };
})()`);
console.log("frame check", looks);
if (!(looks.card > 200 && looks.side < 60)) { await invoke(host, "picker_cancel"); console.error("frozen frame isn't the demo page: stopping"); process.exit(1); }
// The loupe first: hover without clicking.
await picker.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 820, y: 330 });
await sleep(300);
await picker.shot(join(out, "picker-loupe.png"));
await drag(picker, 300, 150, 1650, 820);
await waitFor(() => picker.ev("!document.getElementById('bar').hidden"));
await picker.shot(join(out, "picker.png"));
await picker.ev(`[...document.querySelectorAll('#bar .btn')].find((b) => b.textContent.includes('More')).click()`);
await picker.shot(join(out, "picker-more.png"));
await picker.ev(`document.querySelector('.menu').hidden = true`);

// 3. Copy → the quick-access card in the corner, grabbed off the screen.
const before = existsSync(shots) ? Math.max(0, ...readdirSync(shots).map((f) => statSync(join(shots, f)).mtimeMs)) : 0;
await picker.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13 });
await picker.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
picker.close();
await waitFor(async () => (await targets()).some((t) => t.url.includes("quick.html")));
await sleep(900);
execFileSync("powershell", ["-NoProfile", "-File", join(root, "docs/demo/grab-screen.ps1"), "-X", "2200", "-Y", "1180", "-W", "1640", "-H", "980", "-Out", join(out, "quick.png")]);
const capture = await waitFor(() => readdirSync(shots).map((f) => join(shots, f)).find((f) => statSync(f).mtimeMs > before));

// 4. Picture editor: some annotations, then the Beautify panel.
execFile(exe, ["--open", capture]);
const edT = await waitFor(async () => (await targets()).find((t) => /tauri\.localhost\/(index\.html)?$/.test(t.url)));
const ed = await connect(edT);
await waitFor(() => ed.ev("(window.grabbit?.api?.getSceneElements?.().length ?? 0) > 0"));
await ed.ev(`(() => {
  const api = window.grabbit.api, conv = window.grabbit.convert;
  const els = conv([
    { type: "arrow", x: 1480, y: 190, width: -380, height: 200, strokeColor: "#e03131", strokeWidth: 5, roughness: 0 },
    { type: "rectangle", x: 380, y: 420, width: 900, height: 420, strokeColor: "#e03131", strokeWidth: 5, roughness: 0, backgroundColor: "transparent" },
    { type: "text", x: 1500, y: 120, text: "Revenue up 18 %", fontSize: 48, strokeColor: "#e03131" },
    { type: "ellipse", x: 1320, y: 440, width: 64, height: 64, backgroundColor: "#e03131", strokeColor: "#fff", fillStyle: "solid", roughness: 0, label: { text: "1", fontSize: 30, strokeColor: "#fff" } },
  ]);
  api.updateScene({ elements: [...api.getSceneElements(), ...els] });
  api.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.88, animate: false });
})()`);
await ed.ev(`[...document.querySelectorAll('header button')].find((b) => b.textContent.trim() === 'Beautify').click()`);
await sleep(300);
await ed.ev(`(() => { const c = document.querySelector('.panel input[type=checkbox]'); if (!c.checked) c.click(); })()`);
await ed.shot(join(out, "editor.png"), 1600, 960);
await ed.ev(`[...document.querySelectorAll('header button')].find((b) => b.textContent.trim() === 'AI').click()`);
await ed.shot(join(out, "editor-ai.png"), 1600, 960);
await ed.ev(`(() => { const c = document.querySelector('.panel'); })()`);
await ed.ev("window.close()");
ed.close();

// 5. Recording: the frame and bar around an area (overlays stay visible in demo mode), grabbed off the screen.
const demo = await connect(await waitFor(async () => (await targets()).find((t) => t.url.includes("demo.html"))));
await demo.ev("location.href = 'demo.html'");   // animated, so the recording has motion
demo.close();
await sleep(1500);
const before2 = existsSync(videos) ? Math.max(0, ...readdirSync(videos).map((f) => statSync(join(videos, f)).mtimeMs)) : 0;
await invoke(host, "picked", { pick: { action: "record", x: 600, y: 300, width: 2400, height: 1400, windows: [], size: null } });
await waitFor(async () => (await targets()).some((t) => t.url.includes("recbar.html")));
await sleep(2500);
execFileSync("powershell", ["-NoProfile", "-File", join(root, "docs/demo/grab-screen.ps1"), "-X", "0", "-Y", "0", "-W", "3840", "-H", "2160", "-Out", join(out, "recording.png")]);
await sleep(3000);
const bar = await connect((await targets()).find((t) => t.url.includes("recbar.html")));
await invoke(bar, "rec_control", { what: "stop" });
bar.close();
const rec = await waitFor(() => readdirSync(videos).filter((f) => f.endsWith(".mp4")).map((f) => join(videos, f)).find((f) => statSync(f).mtimeMs > before2), 60000);

// 6. Video editor: give the recording a voice (generated speech, spikes/make-speech-video.ps1), then cut silences,
//    captions, effects and a 2× part.
const speech = join(process.env.TEMP, "g2studio", "speech.wav");
const talk = join(videos, "Fernhill weekly walkthrough.mp4");
execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", rec, "-i", speech, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-metadata:s:a:0", "handler_name=Microphone", talk]);
copyFileSync(rec.replace(/\.mp4$/, ".cursor.json"), talk.replace(/\.mp4$/, ".cursor.json"));
execFile(exe, ["--open", talk]);
const vT = await waitFor(async () => (await targets()).find((t) => t.url.includes("video.html")));
const v = await connect(vT);
await waitFor(() => v.ev("!!document.querySelector('.fx')"));
await v.ev("window.confirm = () => true");
const clickText = (t) => v.ev(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(t)})?.click()`);
await clickText("Cut silences");
await waitFor(() => v.ev("document.querySelectorAll('.strip .seg').length >= 2"), 30000);
await v.ev(`[...document.querySelectorAll('.fx input')].forEach((i) => { if (!i.checked) i.click(); })`);
await clickText("Captions");
await waitFor(() => v.ev("document.querySelectorAll('.cue').length > 0"), 600000);
await v.ev(`document.querySelector('.captions header input').click()`);
await v.ev(`(() => { const vid = document.querySelector('video'); vid.currentTime = 1.2; })()`);
await sleep(800);
await v.shot(join(out, "video-editor.png"), 1600, 980);
await v.ev("window.close()");
v.close();

// 7. Settings (folders shown as a typical machine's).
await invoke(host, "open_settings_at", { section: "Recording" });
const sT = await waitFor(async () => (await targets()).find((t) => t.url.includes("settings.html")));
const st = await connect(sT);
await sleep(800);
await st.ev(`document.querySelectorAll('.path').forEach((p) => { p.textContent = p.textContent.includes('Video') || p.textContent.includes('videos') ? 'C:\\\\Users\\\\you\\\\Videos\\\\Grabbit' : 'C:\\\\Users\\\\you\\\\Pictures\\\\Grabbit'; })`);
await st.shot(join(out, "settings.png"), 1100, 760);
await st.ev("window.close()");
st.close();

// Tidy: close the demo window, shrink the full-monitor shots to 1920 wide.
const d2 = (await targets()).find((t) => t.url.includes("demo.html"));
if (d2) { const c = await connect(d2); await c.ev("window.close()"); c.close(); }
for (const f of ["picker-loupe.png", "picker.png", "picker-more.png", "recording.png"]) downscale(join(out, f));
for (const f of ["editor.png", "editor-ai.png", "video-editor.png"]) downscale(join(out, f), 2000);
host.close();
console.log("done");
