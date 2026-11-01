// README shots from Grabbit's real pages in the studio (see lib.mjs). Raw shots land in out/raw; poster.mjs frames them.
// Usage: node shoot.mjs [name…]   (no names = all)
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { demo, extra, fileUrl, open, root, sleep } from "./lib.mjs";

const raw = join(demo, "out/raw");
mkdirSync(raw, { recursive: true });
const want = process.argv.slice(2);
const run = async (name, f) => { if (!want.length || want.includes(name)) { console.log("--", name); await f(); } };

// The demo desktop (frame.mjs) as the picker's frozen screen: 1600×900 CSS at 1.6 = 2560×1440.
const K = 1.6, W = 2560, H = 1440;
extra.set("grabbit/frame/0", { bytes: readFileSync(join(demo, "out/desktop.rgba")), type: "application/octet-stream" });
const win = (id, title, app, x, y, w, h) => ({ id, title, app, x: x * K, y: y * K, width: w * K, height: h * K });
const pickerSetup = `__studio.handlers = {
  picker_info: { frame: 0, x: 0, y: 0, width: ${W}, height: ${H}, mode: "Pick", last_rect: null, os: "windows",
    windows: ${JSON.stringify([win(1, "Fernhill — Weekly overview", "Browser", 70, 64, 1010, 660), win(2, "# team-fernhill", "Chat", 1110, 150, 420, 640)])} },
  get_settings: { record_microphone: true, record_system_audio: true },
};`;
async function picker() {
  const p = await open("picker.html", { width: 1600, height: 900, dpr: K, setup: pickerSetup });
  await sleep(300);
  await p.ev(`__studio.emit("open", 0)`);
  await p.waitFor(`document.body.classList.contains("ready")`);
  return p;
}

await run("picker", async () => {
  const p = await picker();
  // Loupe over the Saturday peak.
  await p.mouse("mouseMoved", 654, 362); await sleep(300);
  await p.shot(join(raw, "picker-loupe.png"));
  // Hover the chat window: the whole window lights up.
  await p.mouse("mouseMoved", 1320, 520); await sleep(300);
  await p.shot(join(raw, "picker-window.png"));
  // Drag the chart and the blends.
  await p.drag(228, 256, 1068, 716);
  await p.waitFor(`!document.getElementById("bar").hidden`);
  await p.mouse("mouseMoved", 700, 820);
  await p.shot(join(raw, "picker.png"));
  await p.ev(`[...document.querySelectorAll("#bar .btn")].find((b) => b.textContent.includes("More")).click()`);
  await p.shot(join(raw, "picker-more.png"));
  console.log(p.errors.join("\n"));
  await p.close();
});

// Demo "captures": crops of the desktop frame, in physical pixels.
const caps = join(demo, "out/caps");
mkdirSync(caps, { recursive: true });
const crop = (name, x, y, w, h) => {
  const f = join(caps, name + ".png");
  execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", join(demo, "out/desktop.png"), "-vf", `crop=${w}:${h}:${x}:${y}`, f]);
  return f;
};
const cap = {
  dash: crop("dash", 345, 165, 1380, 985),        // the dashboard's page area
  charts: crop("charts", 365, 410, 1344, 736),     // what the hero picker selected
  revenue: crop("revenue", 378, 270, 316, 132),
  blends: crop("blends", 1213, 424, 482, 340),
  chart: crop("chart", 378, 424, 820, 708),
};

await run("voice", async () => {
  const p = await open(`voice.html?p=${encodeURIComponent(cap.dash)}`, { width: 1300, height: 740, dpr: 1.6, setup: `__studio.handlers = { voice_stop: [], voice_restart: null };` });
  await p.waitFor(`document.getElementById("pic").naturalWidth > 0`);
  await sleep(400);
  const r = await p.ev(`(() => { const c = document.getElementById("marks").getBoundingClientRect(); return [c.left, c.top, c.width, c.height]; })()`);
  const at = (fx, fy) => [r[0] + r[2] * fx, r[1] + r[3] * fy];
  await p.click(...at(0.2, 0.135));                       // [1] the revenue figure
  await p.drag(...at(0.655, 0.25), ...at(0.985, 0.6));    // [2] the blends
  await p.ev(`document.getElementById("done").click()`);
  await p.waitFor(`!document.body.classList.contains("listening")`);
  await p.ev(`(() => {
    document.getElementById("words").value = "Revenue at [1] is up 12% but orders only 8%. Do the blend shares at [2] explain it? Draft a two-line note for the team.";
    document.getElementById("status").textContent = "Check your words, fix anything, then Copy for AI.";
    document.getElementById("time").textContent = "0:11";
  })()`);
  await p.ev(`document.activeElement.blur()`);
  await p.mouse("mouseMoved", 5, 5);
  await p.shot(join(raw, "talk-to-ai.png"));
  console.log(p.errors.join("\n"));
  await p.close();
});

await run("batch", async () => {
  const items = [
    { path: cap.revenue, title: "Revenue card", text: "Says up 12.4 % but last week's report said 9 %. Which one is right?" },
    { path: cap.blends, title: "Top blends", text: "Kāpiti Filter dropped to 13 %. Why, and what could we try?" },
    { path: cap.chart, title: "Daily revenue", text: "Saturday doubled. Was it the farmers market? Compare with the last four Saturdays." },
  ];
  const p = await open("voice.html?batch=1", { width: 1180, height: 640, dpr: 1.6, setup: `__studio.handlers = { batch_items: ${JSON.stringify(items)} };` });
  await p.waitFor(`document.querySelectorAll(".item img").length === 3 && [...document.querySelectorAll(".item img")].every((i) => i.naturalWidth)`);
  await p.ev(`document.getElementById("intro").value = "Weekly check-in: answer each one, then give me three things to do this week."`);
  await p.shot(join(raw, "ai-batch.png"));
  console.log(p.errors.join("\n"));
  await p.close();
});

// The picture editor (Excalidraw) on the hero capture, with annotations and Beautify on.
await run("editor", async () => {
  const recent = [["charts", 16], ["blends", 15], ["dash", 14], ["chart", 12]].map(([n, m]) => ({ path: cap[n], url: "", name: n, time: `2026-11-02T09:${m}:00`, kind: "capture" }));
  const p = await open("index.html", { width: 1360, height: 860, dpr: 1.6 });
  await p.waitFor(`window.grabbit?.api && window.grabbit.receive`);
  await p.ev(`(async () => { const b = await (await fetch(${JSON.stringify(`http://studio.local/asset/${encodeURIComponent(cap.charts)}`)})).blob();
    const d = await new Promise((ok) => { const f = new FileReader(); f.onload = () => ok(f.result); f.readAsDataURL(b); });
    window.grabbit.receive({ type: "load", name: "Weekly overview", dataURL: d, width: 1344, height: 736, recent: ${JSON.stringify(recent)} }); })()`);
  await p.waitFor(`window.grabbit.api.getSceneElements().length > 0`);
  await p.ev(`Promise.all([document.fonts.load("64px Excalifont"), document.fonts.load("48px Nunito")]).then(() => true)`);
  await p.ev(`(() => {
    const api = window.grabbit.api, conv = window.grabbit.convert, img = api.getSceneElements()[0], X = img.x, Y = img.y;
    api.updateScene({ elements: [...api.getSceneElements(), ...conv([
      { type: "ellipse", x: X + 600, y: Y + 118, width: 150, height: 110, strokeColor: "#e03131", strokeWidth: 6, roughness: 1, backgroundColor: "transparent" },
      { type: "text", x: X + 230, y: Y + 66, text: "Best Saturday since June!", fontSize: 44, fontFamily: 5, strokeColor: "#e03131" },
      { type: "arrow", x: X + 560, y: Y + 125, width: 60, height: 45, strokeColor: "#e03131", strokeWidth: 5, roughness: 1 },
      { type: "rectangle", x: X + 858, y: Y + 60, width: 470, height: 58, strokeColor: "#1971c2", strokeWidth: 5, roughness: 0, backgroundColor: "transparent" },
      { type: "ellipse", x: X + 1300, y: Y + 34, width: 56, height: 56, backgroundColor: "#1971c2", strokeColor: "#fff", fillStyle: "solid", roughness: 0, label: { text: "1", fontSize: 30, strokeColor: "#fff" } },
    ])] });
  })()`);
  const tab = (name) => p.ev(`[...document.querySelectorAll("header button")].find((b) => b.textContent.trim().startsWith(${JSON.stringify(name)})).click()`);
  await tab("Beautify");
  await sleep(300);
  // Fit the picture into the canvas left of the side panel.
  await p.ev(`(() => { const api = window.grabbit.api, st = api.getAppState(), img = api.getSceneElements()[0];
    const right = document.querySelector(".panel").getBoundingClientRect().left - st.offsetLeft - 24, z = 0.62;
    api.updateScene({ appState: { zoom: { value: z }, scrollX: right / 2 / z - (img.x + img.width / 2), scrollY: (st.height / 2 + 40) / z - (img.y + img.height / 2) } }); })()`);
  await p.ev(`(() => { const c = document.querySelector(".panel input[type=checkbox]"); if (!c.checked) c.click(); })()`);
  await sleep(500);
  await p.shot(join(raw, "editor.png"));
  await tab("AI");
  await p.shot(join(raw, "editor-ai.png"));
  console.log(p.errors.join("\n"));
  await p.close();
});

// Overlay windows, transparent, for scene.mjs to place on the desktop: the quick-access card, the record bar, the hold pill.
await run("parts", async () => {
  const shoot = async (page, w, h, name, fix = "", setup = "") => {
    const p = await open(page, { width: w, height: h, dpr: K, transparent: true, setup });
    await sleep(700);
    await p.ev(`(() => { document.querySelectorAll("*").forEach((e) => (e.style.animation = "none")); ${fix} })()`);
    await p.shot(join(raw, `part-${name}.png`));
    console.log(p.errors.join("\n"));
    await p.close();
  };
  await shoot(`quick.html?t=Copied&p=${encodeURIComponent(cap.charts)}`, 300, 230, "quick");
  await shoot("recbar.html", 300, 44, "recbar", `document.querySelector(".time").textContent = "0:07"`, `__studio.handlers = { rec_status: { elapsed: 7, paused: false, recording: true } };`);
  await shoot("hint.html", 240, 56, "hint", `document.querySelector(".fill").style.width = "70%"`);
});

// The README's animated demo: the picker opens, a drag picks the chart, the bar appears, Enter → the Copied card.
// Frames are real picker screenshots with a drawn pointer (headless Chrome draws none).
await run("anim", async () => {
  const dir = join(demo, "out/anim");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const list = [];
  let n = 0;
  const frame = async (p, secs) => { const f = join(dir, `f${String(n++).padStart(3, "0")}.png`); await p.shot(f); list.push([f, secs]); };
  const pointer = `(() => { const d = document.createElement("div"); d.id = "ptr"; d.style.cssText = "position:fixed;left:0;top:0;z-index:99999;pointer-events:none;filter:drop-shadow(0 1px 2px rgb(0 0 0 / .5))";
    d.innerHTML = '<svg width="22" height="30" viewBox="0 0 18 26"><path d="M1 1v20l5-5 4 9 3-1.4-4-8.6h7z" fill="#fff" stroke="#000" stroke-width="1.3" stroke-linejoin="round"/></svg>'; document.body.append(d); })()`;
  const at = (p, x, y) => p.ev(`document.getElementById("ptr").style.transform = "translate(${x}px, ${y}px)"`);
  const p = await picker();
  await p.ev(pointer);
  let [x, y] = [520, 560];
  await p.mouse("mouseMoved", x, y); await at(p, x, y); await frame(p, 0.9);
  for (let i = 1; i <= 8; i++) { const t = i / 8; x = 520 + (228 - 520) * t; y = 560 + (256 - 560) * t; await p.mouse("mouseMoved", x, y); await at(p, x, y); await frame(p, 0.05); }
  await p.mouse("mousePressed", 228, 256, 1);
  for (let i = 1; i <= 16; i++) { const t = 1 - (1 - i / 16) ** 2; x = 228 + 840 * t; y = 256 + 460 * t; await p.mouse("mouseMoved", x, y, 1); await at(p, x, y); await frame(p, 0.05); }
  await p.mouse("mouseReleased", x, y);
  await p.waitFor(`!document.getElementById("bar").hidden`);
  await frame(p, 0.5);
  for (let i = 1; i <= 6; i++) { const t = i / 6; await at(p, x + (195 - x) * t, y + (785 - y) * t); await frame(p, 0.05); }
  await frame(p, 1.0);
  await p.close();
  // After Enter: the desktop with the Copied card in the corner.
  const scene = join(dir, "copied.html");
  writeFileSync(scene, `<!doctype html><body style="margin:0;width:1600px;height:900px;overflow:hidden;position:relative">
    <img src="${fileUrl(join(demo, "out/desktop.png"))}" style="position:absolute;width:1600px;height:900px">
    <img src="${fileUrl(join(raw, "part-quick.png"))}" style="position:absolute;left:1276px;top:646px;width:300px;height:230px"></body>`);
  const c = await open(fileUrl(scene), { width: 1600, height: 900, dpr: K });
  await c.waitFor(`[...document.images].every((i) => i.complete && i.naturalWidth)`);
  await c.ev(pointer); await at(c, 195, 785);
  await frame(c, 2.2);
  await c.close();
  writeFileSync(join(dir, "frames.json"), JSON.stringify(list));
  // Pillow keeps each frame's own duration (ffmpeg's animated WebP output loses them).
  execFileSync(join(process.env.LOCALAPPDATA, "Programs/Python/Python312/python3.exe"), ["-c", `
import json, sys
from PIL import Image
fr = json.load(open(sys.argv[1]))
ims = [Image.open(f).convert("RGB").resize((1280, 720), Image.LANCZOS) for f, _ in fr]
ims[0].save(sys.argv[2], save_all=True, append_images=ims[1:], duration=[round(s * 1000) for _, s in fr], loop=0, quality=82, method=6)`,
    join(dir, "frames.json"), join(root, "docs/screenshots/demo.webp")]);
  console.log("saved docs/screenshots/demo.webp");
});

// The video editor: silences cut, a 2× part, captions burned in, click/zoom/keys effects.
await run("video", async () => {
  // Served by Vite (which answers range requests, so the player can seek).
  mkdirSync(join(root, "app/node_modules/.studio"), { recursive: true });
  const vid = join(root, "app/node_modules/.studio/walkthrough.mp4");
  execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-stream_loop", "1", "-i", join(demo, "out/demo.mp4"), "-map", "0", "-t", "12", "-c", "copy", vid]);
  const cues = [
    { start: 0.2, end: 2.0, text: "Here's this week at Fernhill." },
    { start: 2.0, end: 4.6, text: "Revenue is up twelve percent." },
    { start: 6.4, end: 8.8, text: "Saturday: best day since June." },
    { start: 9.6, end: 11.6, text: "Ridgeline is still on top." },
  ];
  const setup = `__studio.handlers = { editor_msg: ({ msg }) => ({ silences: [[4.6, 6.4], [8.8, 9.6]], captionEngine: "local", captions: ${JSON.stringify(cues)} })[msg.type] ?? null };`;
  const p = await open("video.html", { width: 1400, height: 860, dpr: 1.6, setup });
  await sleep(500);
  await p.ev(`__studio.emit("host", { type: "load", name: "Fernhill weekly walkthrough", path: ${JSON.stringify(vid)}, url: "/node_modules/.studio/walkthrough.mp4", duration: 12, fps: 30, width: 1600, height: 900, hasAudio: true, bytes: 1830000, hasSystem: true, hasMic: true,
    cursor: { moves: [[1, 600, 300, 0], [1.4, 600, 300, 1], [1.5, 600, 300, 0], [6.5, 1200, 500, 1], [6.6, 1200, 500, 0]], keys: [[3, "LControl"], [3.1, "S"]] } })`);
  await p.waitFor(`!!document.querySelector(".fx")`, 20000);
  await p.ev("window.confirm = () => true");
  const btn = (t) => p.ev(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(t)})?.click()`);
  await btn("Cut silences");
  await p.waitFor(`document.querySelectorAll(".strip .seg").length >= 2`);
  await p.ev(`[...document.querySelectorAll(".fx input")].forEach((i) => { if (!i.checked) i.click(); })`);
  await p.ev(`(() => { const s = [...document.querySelectorAll(".strip .seg")].at(-1); const r = s.getBoundingClientRect(); const t = document.querySelector(".track");
    for (const type of ["pointerdown", "pointerup"]) t.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + 10, button: 0, pointerId: 1 })); })()`);
  await sleep(200);
  await p.ev(`(() => { const s = document.querySelector("select.speed"); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, "2"); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await btn("Captions");
  await p.waitFor(`document.querySelectorAll(".cue").length > 0`);
  await p.ev(`(() => { const c = document.querySelector(".captions header input"); if (c && !c.checked) c.click(); document.querySelector("video").currentTime = 6.7; })()`);
  await sleep(800);
  await p.shot(join(raw, "video-editor.png"));
  console.log(p.errors.join("\n"));
  await p.close();
});
