// README screenshots for Grabbit 2, made entirely from the made-up demo page (docs/demo/demo.html):
// the app runs with GRABBIT_DEMO_FRAME, so the picker shows that page instead of the real screens, and every other
// shot is a Grabbit window captured over DevTools (overlays are composited onto the demo frame by compose.py).
// Works with the screen locked. Run: pwsh spikes/run2.ps1 -Demo, then node docs/demo/shoot-v3.mjs
import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const exe = join(root, "app/src-tauri/target/debug/grabbit.exe");
const out = join(root, "docs/screenshots");
const parts = join(root, "docs/demo/out/parts");
const work = join(process.env.TEMP, "g2demo");
const shots = join(work, "shots"), videos = join(work, "videos");
for (const d of [out, parts, videos]) mkdirSync(d, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = async () => { try { return await (await fetch("http://127.0.0.1:9333/json")).json(); } catch { return []; } };
async function waitFor(fn, ms = 15000, what = "") { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(150); } throw new Error(`timed out: ${what}`); }

async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0; const pend = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); pend.get(m.id)?.(m); pend.delete(m.id); });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description; };
  /** Screenshot at a CSS size and scale; `clear` keeps transparent parts transparent (overlays). */
  const shot = async (file, w, h, dpr = 1.5, clear = false) => {
    if (w) await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: dpr, mobile: false });
    if (clear) await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
    await sleep(700);
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(file, Buffer.from(r.result.data, "base64"));
    if (w) await send("Emulation.clearDeviceMetricsOverride");
    console.log("saved", file);
  };
  return { send, ev, shot, close: () => ws.close() };
}
const invoke = (c, cmd, args) => c.ev(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})}).then((r) => r, (e) => 'ERR ' + e)`);
const page = (match) => waitFor(async () => (await targets()).find((t) => t.url.includes(match)), 20000, match).then(connect);
const host = await connect(await waitFor(async () => (await targets()).find((t) => t.url.includes("picker.html")), 20000, "picker"));

// ONLY_EDITOR=1 redoes just the editor shots; ONLY_OVERLAYS=1 just the overlay parts and composites (step 7).
if (process.env.ONLY_EDITOR) { await editorShots(); process.exit(0); }
if (!process.env.ONLY_OVERLAYS) {
// ---- 1. Picker on the 0,0 monitor, showing the demo frame ----
execFile(exe, ["capture"]);
let picker;
await waitFor(async () => {
  for (const t of (await targets()).filter((x) => x.url.includes("picker.html"))) {
    const c = await connect(t);
    if ((await c.ev("document.body.className + '|' + screenX + ',' + screenY")) === "ready|0,0") { picker = c; return true; }
    c.close();
  }
  return false;
}, 20000, "picker on 0,0");
const looks = await picker.ev(`(() => { const c = document.getElementById('c'), g = c.getContext('2d'), k = devicePixelRatio;
  const lum = (x, y) => { const d = g.getImageData(x * k, y * k, 1, 1).data; return (d[0] + d[1] + d[2]) / 3; };
  return { card: lum(300, 85), side: lum(40, 1000) }; })()`);
// The picker dims everything until a selection: white cards read ~148, the dark sidebar ~12.
if (!(looks.card > 120 && looks.side < 40)) { await invoke(host, "picker_cancel"); throw new Error("the picker isn't showing the demo frame: " + JSON.stringify(looks)); }
const move = (x, y, buttons = 0) => picker.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: buttons ? "left" : "none", buttons });
await move(760, 290); await sleep(400);
await picker.shot(join(out, "picker-loupe.png"));
await move(140, 110);
await picker.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 140, y: 110, button: "left", clickCount: 1, buttons: 1 });
for (let i = 1; i <= 14; i++) { await move(140 + (870 - 140) * i / 14, 110 + (735 - 110) * i / 14, 1); await sleep(16); }
await picker.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 870, y: 735, button: "left", clickCount: 1 });
await waitFor(() => picker.ev("!document.getElementById('bar').hidden"), 5000, "bar");
await picker.shot(join(out, "picker.png"));
await picker.ev(`[...document.querySelectorAll('#bar .btn')].find((b) => b.textContent.includes('More')).click()`);
await picker.shot(join(out, "picker-more.png"));
await picker.ev(`document.querySelector('.menu').hidden = true`);
// Copy it: the capture becomes the editor's and the AI windows' picture.
const before = existsSync(shots) ? Math.max(0, ...readdirSync(shots).map((f) => statSync(join(shots, f)).mtimeMs)) : 0;
await picker.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13 });
await picker.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
picker.close();
const capture = await waitFor(() => readdirSync(shots).map((f) => join(shots, f)).find((f) => statSync(f).mtimeMs > before), 15000, "capture saved");
const quick = await page("quick.html");
await quick.ev("document.querySelector('.card').style.animation = 'none'");
await quick.shot(join(parts, "quick.png"), 300, 230, 1.5, true);
quick.close();

// ---- 2. Picture editor: annotations + Beautify, then the AI panel ----
await editorShots();
}

/** The editor on a large crop of the demo dashboard, with annotations sized for it. */
async function editorShots() {
const crop = join(work, "editor-demo.png");
execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", join(root, "docs/demo/out/demo-4k.png"), "-vf", "crop=2240:1000:355:30", crop]);
execFile(exe, ["--open", crop]);
const ed = await connect(await waitFor(async () => (await targets()).find((t) => /tauri\.localhost\/(index\.html)?$/.test(t.url)), 20000, "editor"));
await waitFor(() => ed.ev("(window.grabbit?.api?.getSceneElements?.().length ?? 0) > 0"), 15000, "editor loaded");
// Text is measured with the font it'll be drawn in, so load it first.
await ed.ev("Promise.all([document.fonts.load('64px Excalifont'), document.fonts.load('48px Nunito')]).then(() => true)");
await ed.ev(`(() => {
  const api = window.grabbit.api, conv = window.grabbit.convert;
  api.updateScene({ elements: [...api.getSceneElements(), ...conv([
    { type: "rectangle", x: 18, y: 120, width: 860, height: 230, strokeColor: "#e03131", strokeWidth: 9, roughness: 0, backgroundColor: "transparent" },
    { type: "ellipse", x: 840, y: 90, width: 96, height: 96, backgroundColor: "#e03131", strokeColor: "#fff", fillStyle: "solid", roughness: 0, label: { text: "1", fontSize: 48, strokeColor: "#fff" } },
    { type: "text", x: 1060, y: 420, text: "Best Saturday since June", fontSize: 64, fontFamily: 5, strokeColor: "#e03131" },
    { type: "arrow", x: 1600, y: 510, width: 160, height: 120, strokeColor: "#e03131", strokeWidth: 9, roughness: 0 },
  ])] });
  api.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.85, animate: false });
})()`);
const tab = (name) => ed.ev(`[...document.querySelectorAll('header button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(name)})).click()`);
await tab("Beautify");
await sleep(300);
await ed.ev(`(() => { const c = document.querySelector('.panel input[type=checkbox]'); if (!c.checked) c.click(); })()`);
await ed.shot(join(out, "editor.png"), 1600, 960);
await tab("AI");
await ed.shot(join(out, "editor-ai.png"), 1600, 960);
await ed.ev("window.close()");
ed.close();
}
if (!process.env.ONLY_OVERLAYS) {

// ---- 3. Talk to AI: the voice window with marks and words (the microphone recording is discarded unheard) ----
execFile(exe, ["capture"]);
await waitFor(async () => { for (const t of (await targets()).filter((x) => x.url.includes("picker.html"))) { const c = await connect(t); const r = await c.ev("document.body.className"); c.close(); if (r === "ready") return true; } return false; }, 20000, "picker");
await sleep(400);
await invoke(host, "picked", { pick: { action: "voice", x: 300, y: 120, width: 2700, height: 1560, windows: [], size: null, extra: [], layout: null } });
const v = await page("voice.html");
await waitFor(() => v.ev("document.getElementById('pic').naturalWidth > 0"), 15000, "voice picture");
await invoke(v, "voice_stop", { keep: false });
await v.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 920, deviceScaleFactor: 1.5, mobile: false });
await sleep(800);
const r = await v.ev(`(() => { const c = document.getElementById('marks').getBoundingClientRect(); return [c.left, c.top, c.width, c.height]; })()`);
const vclick = async (fx, fy) => { for (const type of ["mousePressed", "mouseReleased"]) await v.send("Input.dispatchMouseEvent", { type, x: r[0] + r[2] * fx, y: r[1] + r[3] * fy, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 }); };
await vclick(0.18, 0.1);
await v.send("Input.dispatchMouseEvent", { type: "mousePressed", x: r[0] + r[2] * 0.66, y: r[1] + r[3] * 0.14, button: "left", clickCount: 1, buttons: 1 });
for (let i = 1; i <= 8; i++) await v.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r[0] + r[2] * (0.66 + i * 0.04), y: r[1] + r[3] * (0.14 + i * 0.045), button: "left", buttons: 1 });
await v.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r[0] + r[2] * 0.98, y: r[1] + r[3] * 0.5, button: "left", clickCount: 1 });
await v.ev(`(() => {
  document.body.classList.remove('listening'); document.getElementById('done').hidden = true; document.getElementById('redo').hidden = false;
  document.getElementById('words').value = "Revenue at [1] looks too high compared to the orders. Can you check whether the blend shares at [2] add up, and draft a short note for the team?";
  document.getElementById('status').textContent = "Check your words, fix anything, then Copy for AI.";
  document.getElementById('time').textContent = "0:14";
})()`);
await v.shot(join(out, "talk-to-ai.png"));
await v.send("Emulation.clearDeviceMetricsOverride");
await v.ev("window.close()");
v.close();

// ---- 4. AI batch review: three pictures, each with its own words ----
const crops = [["Revenue card", 0.05, 0.07, 0.3, 0.1], ["Top blends", 0.66, 0.17, 0.33, 0.25], ["Daily revenue chart", 0.1, 0.17, 0.56, 0.8]];
const notes = ["The revenue card says up 12.4 % but last week's report said 9 %. Which is right?", "Kāpiti Filter dropped to 13 %. Suggest why and what we could try.", "Why is Sunday so low? Compare it with the last four Sundays if you can."];
for (const [i, [title, x, y, w, h]] of crops.entries()) {
  const f = join(work, `batch-${i}.png`);
  execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", join(root, "docs/demo/out/demo-4k.png"), "-vf", `crop=iw*${w}:ih*${h}:iw*${x}:ih*${y}`, f]);
  console.log(await invoke(host, "batch_add", { path: f, text: notes[i], title }));
}
await invoke(host, "batch_finish");
const b = await page("batch=1");
await waitFor(() => b.ev("document.querySelectorAll('.item').length === 3"), 15000, "batch items");
await b.ev(`document.getElementById('intro').value = 'Weekly check-in: answer each one, then give me three things to do this week.'`);
await b.shot(join(out, "ai-batch.png"), 1400, 900);
await invoke(b, "batch_clear");
b.close();
for (const t of (await targets()).filter((x) => x.url.includes("mode=batch"))) { const c = await connect(t); await c.ev("window.close()"); c.close(); }

// ---- 5. Video editor: a demo recording with a voice, silences cut, captions, effects, a 2× part ----
const talk = join(videos, "Fernhill weekly walkthrough.mp4");
execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-stream_loop", "1", "-i", join(root, "docs/demo/out/demo.mp4"), "-i", join(process.env.TEMP, "g2studio", "speech.wav"),
  "-map", "0:v", "-map", "0:a:0", "-map", "1:a", "-t", "10", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
  "-metadata:s:a:0", "handler_name=System sound", "-metadata:s:a:1", "handler_name=Microphone", talk]);
writeFileSync(talk.replace(/\.mp4$/, ".cursor.json"), JSON.stringify({ width: 1600, height: 900, moves: [[1, 600, 300, 0], [1.4, 600, 300, 1], [1.5, 600, 300, 0], [6.5, 1200, 500, 1], [6.6, 1200, 500, 0]], keys: [[3, "LControl"], [3.1, "S"]] }));
execFile(exe, ["--open", talk]);
const vid = await page("video.html");
await waitFor(() => vid.ev("!!document.querySelector('.fx')"), 20000, "video editor");
await vid.ev("window.confirm = () => true");
const vbtn = (t) => vid.ev(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(t)})?.click()`);
await vbtn("Cut silences");
await waitFor(() => vid.ev("document.querySelectorAll('.strip .seg').length >= 2"), 60000, "silences cut");
await vid.ev(`[...document.querySelectorAll('.fx input')].forEach((i) => { if (!i.checked) i.click(); })`);
await vid.ev(`(() => { const s = document.querySelectorAll('.strip .seg')[1]; const r = s.getBoundingClientRect(); const t = document.querySelector('.track');
  for (const type of ['pointerdown', 'pointerup']) t.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + 10, button: 0, pointerId: 1 })); })()`);
await sleep(200);
await vid.ev(`(() => { const s = document.querySelector('select.speed'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, '2'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await vbtn("Captions");
await waitFor(() => vid.ev("document.querySelectorAll('.cue').length > 0"), 600000, "captions");
await vid.ev(`document.querySelector('.captions header input').click(); document.querySelector('video').currentTime = 1.3`);
await vid.shot(join(out, "video-editor.png"), 1600, 980);
await vid.ev("window.close()");
vid.close();

// ---- 6. Settings ----
await invoke(host, "open_settings_at", { section: "Recording" });
const st = await page("settings.html");
await sleep(900);
const fixPaths = `document.querySelectorAll('.path').forEach((p) => { p.textContent = /video/i.test(p.textContent) ? 'C:\\\\Users\\\\you\\\\Videos\\\\Grabbit' : 'C:\\\\Users\\\\you\\\\Pictures\\\\Grabbit'; })`;
await st.ev(fixPaths);
await st.shot(join(out, "settings.png"), 1100, 780);
await st.ev(`[...document.querySelectorAll('#nav button')].find((b) => b.textContent === 'AI').click()`);
await sleep(400);
await st.shot(join(out, "settings-ai.png"), 1100, 780);
await st.ev("window.close()");
st.close();

}

// ---- 7. Overlay parts for compose.py: the recording bar and the hold-to-record pill ----
// The quick-access card as it looks after a copy (drawn from a demo capture; no clipboard involved).
const demoShot = join(work, "editor-demo.png");
await invoke(host, "dev_window", { page: `quick.html?t=Copied&p=${encodeURIComponent(demoShot)}`, x: 100, y: 100, w: 300, h: 230 });
const qc = await page("quick.html?t=Copied");
await sleep(900);
await qc.ev("document.querySelector('.card').style.animation = 'none'");
await qc.shot(join(parts, "quick.png"), 300, 230, 1.5, true);
await qc.ev("window.close()"); qc.close();
await invoke(host, "dev_window", { page: "recbar.html", x: 100, y: 100, w: 300, h: 44 });
const bar = await page("recbar.html");
await sleep(600);
await bar.ev(`document.querySelector('.time').textContent = '0:07'`);
await bar.shot(join(parts, "recbar.png"), 300, 44, 1.5, true);
await bar.ev("window.close()"); bar.close();
await invoke(host, "dev_window", { page: "hint.html", x: 100, y: 100, w: 240, h: 56 });
const hint = await page("hint.html");
await sleep(600);
await hint.ev(`document.querySelector('.fill').style.width = '70%'`);
await hint.shot(join(parts, "hint.png"), 240, 56, 1.5, true);
await hint.ev("window.close()"); hint.close();
host.close();

execFileSync(join(process.env.LOCALAPPDATA, "Programs/Python/Python312/python3.exe"), [join(root, "docs/demo/compose.py")], { stdio: "inherit" });
if (!process.env.ONLY_OVERLAYS) for (const f of ["picker-loupe.png", "picker.png", "picker-more.png"]) {
  execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", join(out, f), "-vf", "scale=1920:-2:flags=lanczos", join(out, f + ".tmp.png")]);
  copyFileSync(join(out, f + ".tmp.png"), join(out, f));
}
console.log("done");
