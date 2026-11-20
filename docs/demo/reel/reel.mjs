// The README's feature tour: a narrated walk through Grabbit, one scene per feature, on one made-up desktop. Like the
// README pictures (../studio), every Grabbit window in it is the app's real page running in headless Chrome with a
// faked core; desk.html is the made-up desktop around them and stage.html lays the frames out with a pointer and
// captions. The whole screen is always in view: nothing zooms or pans.
//
// Needs what ../studio needs: Vite on 5173 (in app/) and headless Chrome on 9444, plus ffmpeg and uv (for the voices).
//   node reel.mjs            shoot, render and encode
//   node reel.mjs shoot      drive the pages, write out/reel/timeline.json, the raw pictures and the spoken lines
//   node reel.mjs render [from] [to] [every]   draw the frames (seconds, for a quick look at one part)
//   node reel.mjs encode     frames + voices → docs/screenshots/reel.mp4, a clip per feature, and the README's loops
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { demo, extra, fileUrl, open, root, sleep } from "../studio/lib.mjs";

const out = join(demo, "out/reel"), raw = join(out, "raw"), framesDir = join(out, "frames"), voDir = join(out, "vo"), walkDir = join(out, "walk");
const steps = process.argv.slice(2).filter((a) => /^[a-z]+$/.test(a));
const nums = process.argv.slice(2).filter((a) => /^[\d.]+$/.test(a)).map(Number);
const want = (s) => !steps.length || steps.includes(s);
const ff = (...a) => execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", ...a], { stdio: ["ignore", "inherit", "inherit"] });
const FPS = 30, F = 1 / FPS, K = 1.6, W = 2560, H = 1440;
const page = (n) => `http://studio.local/demo/reel/${n}`;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

// What each clip (and each README loop) is made of.
const CLIPS = [
  ["capture", ["grab"]],
  ["talk-to-ai", ["talk", "paste"]],
  ["more-menu", ["more"]],
  ["scrolling-capture", ["scroll"]],
  ["copy-text-and-pin", ["text", "pin"]],
  ["hide-private-details", ["hide"]],
  ["record", ["record"]],
  ["video-editor", ["video"]],
];

// ---------------------------------------------------------------------------------------------------------------
// The timeline: a list of beats. Each beat is what's on the stage (layers, pointer, caption, keys) for `dur` seconds.
// State carries over from beat to beat; `once` holds what belongs to one beat only (a click, a pointer glide).
// ---------------------------------------------------------------------------------------------------------------
const tl = [];
let T = 0;
const st = { layers: [], ptr: [800, 450], cursor: "arrow", down: false, cap: "", keys: null, keyT: 0, held: false, say: null, card: null, scene: "" };
// Pauses, glides and clicks run at PACE of their written length (the spoken lines set the rest of the pace).
const PACE = 0.75;
const beat = (dur, once = {}, exact = false) => { if (!exact) dur *= PACE; tl.push({ t: T, dur, ...JSON.parse(JSON.stringify(st)), ...once }); T += dur; if (once.ptrTo) st.ptr = once.ptrTo; };

// ---- the voices: a narrator, and the person talking to the AI. One line at a time, never over each other. ----
const NARRATOR = "en-US-AndrewNeural", SPEAKER = "en-NZ-MitchellNeural", RATE = "+22%";
const audio = [];
let audioEnd = 0;
function tts(text, voice) {
  mkdirSync(voDir, { recursive: true });
  const f = join(voDir, createHash("sha1").update(voice + "|" + RATE + "|" + text).digest("hex").slice(0, 16) + ".mp3");
  if (!existsSync(f) || statSync(f).size < 500) {
    for (let i = 0; ; i++) {
      try { execFileSync("uvx", ["--from", "edge-tts@latest", "edge-tts", "--voice", voice, `--rate=${RATE}`, "--text", text, "--write-media", f], { stdio: ["ignore", "ignore", "pipe"] }); if (statSync(f).size > 500) break; } catch (e) { if (i >= 8) throw e; }
      if (i >= 8) throw new Error(`no voice for: ${text}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500 * (i + 1));   // the service drops requests now and then
    }
  }
  return { f, dur: Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim()) };
}
/** Holds until the line being spoken is over (plus a breath). */
const wait = (extra = 0.3) => { extra *= PACE; if (T < audioEnd + extra) beat(audioEnd + extra - T, {}, true); };
/** Says a line from now; anything already being said finishes first. Returns how long it takes. */
function speak(text, voice = NARRATOR) {
  wait(0.3);
  const a = tts(text, voice);
  audio.push({ t: T, f: a.f, vol: voice === NARRATOR ? 1 : 0.95 });
  audioEnd = T + a.dur;
  return a.dur;
}
/** The caption under the screen, and the narrator's line that goes with it. */
const cap = (html, line) => { if (line) speak(line); st.cap = html; };
const keys = (...labels) => { st.keys = labels.length ? labels : null; st.keyT = T; st.held = false; };
/** The person's own words, heard and shown in the speech pill. */
const say = (text) => { if (!text) { st.say = null; return 0; } const d = speak(text, SPEAKER); st.say = { text, t0: T, t1: T + d }; return d; };
/** A new scene: the last line finishes, the caption and keys clear. */
const scene = (name) => { wait(0.5); st.scene = name; st.keys = null; st.say = null; };
const layer = (id, file, x, y, w, h, o = {}) => {
  const l = { id, src: file ? fileUrl(file) : undefined, x, y, w, h, ...o };
  const i = st.layers.findIndex((a) => a.id === id);
  if (i >= 0) st.layers[i] = l; else st.layers.push(l);
};
const drop = (...ids) => { st.layers = st.layers.filter((l) => !ids.includes(l.id)); };
const base = (file) => layer("base", file, 0, 0, 1600, 900);
const dim = () => layer("dim", null, 0, 0, 1600, 900, { fill: "rgb(8 10 22 / .5)" });
/** The pointer travels to `to` over `dur` (nothing under it reacts, so one picture does for the whole move). */
const glide = (to, dur, once = {}) => beat(dur, { ptrTo: to, ...once });
const click = (dur = 0.35) => beat(dur, { click: true });

let shots = 0;
/** A quick JPEG of a page as it is now. */
async function snap(p, tag, pause = 40) {
  await sleep(pause);
  const r = await p.send("Page.captureScreenshot", { format: "jpeg", quality: 93, optimizeForSpeed: true });
  const f = join(raw, `${tag}-${String(shots++).padStart(4, "0")}.jpg`);
  writeFileSync(f, Buffer.from(r.result.data, "base64"));
  return f;
}
const J = async (p, code) => JSON.parse(await p.ev(`JSON.stringify(${code})`));
/** Centre of the first button (in `scope`) whose text or title starts with `text`, in page pixels. */
const button = async (p, text, scope = "body") => {
  const c = await J(p, `(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope + " button")})].find((b) => (b.textContent.trim() || b.title).startsWith(${JSON.stringify(text)})); if (!b) return null; const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  if (!c) throw new Error(`no button "${text}" in ${scope}`);
  return c;
};
const keyDown = async (p, key, code, vk, modifiers = 0) => {
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, modifiers });
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers });
};

/** A window of the app shown on the desktop: where it sits, and the page-pixel → stage maths for the pointer. */
const win = (id, x, y, w, h) => ({
  id, x, y, w, h,
  show: (file) => layer(id, file, x, y, w, h, { sh: true, r: 12 }),
  at: (px, py) => [x + px, y + py],
});
const FULL = { id: "base", x: 0, y: 0, at: (x, y) => [x, y] };
const put = (w, f) => (w.id === "base" ? base(f) : w.show(f));
/** The page changes under a moving pointer (the picker's loupe, a drag's outline, a scrub): a picture for every frame. */
async function liveMove(p, w, to, dur, { down = false, tag, every = 1, pause = 25 } = {}) {
  const from = st.ptr.slice(), n = Math.max(1, Math.round((dur * FPS) / every));
  for (let i = 1; i <= n; i++) {
    const u = ease(i / n), x = from[0] + (to[0] - from[0]) * u, y = from[1] + (to[1] - from[1]) * u;
    await p.mouse("mouseMoved", x - w.x, y - w.y, down ? 1 : 0);
    const prev = st.ptr.slice();
    st.ptr = [x, y];
    put(w, await snap(p, tag, pause));
    tl.push({ t: T, dur: every * F, ...JSON.parse(JSON.stringify(st)), ptr: prev, ptrTo: [x, y], linear: true }); T += every * F;
  }
}
/** The page moves on its own (a level meter, a timer) while the pointer glides or rests: a picture every few frames. */
async function liveHold(p, w, dur, { to = null, tag, every = 3 } = {}) {
  const from = st.ptr.slice(), n = Math.max(1, Math.round((dur * FPS) / every));
  for (let i = 1; i <= n; i++) {
    put(w, await snap(p, tag, 30));
    const u = ease(i / n), next = to ? [from[0] + (to[0] - from[0]) * u, from[1] + (to[1] - from[1]) * u] : st.ptr;
    beat(every * F, to ? { ptrTo: next, linear: true } : {});
  }
}
/** Walks the pointer over a row of buttons: each lights up as it's reached, with its key, caption and spoken line. */
async function tour(p, w, scope, items, tag) {
  for (const [label, html, line, ...ks] of items) {
    const c = await button(p, label, scope);
    glide(w.at(...c), 0.45);
    await p.mouse("mouseMoved", ...c);
    put(w, await snap(p, tag, 90));
    cap(html, line); keys(...ks);
    wait(0.25);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Shooting
// ---------------------------------------------------------------------------------------------------------------
async function shoot() {
  rmSync(raw, { recursive: true, force: true });
  rmSync(walkDir, { recursive: true, force: true });
  mkdirSync(raw, { recursive: true });
  mkdirSync(walkDir, { recursive: true });

  // ---- the desktop in its states, and its frozen copies for the picker ----
  const desk = await open(page("desk.html"), { width: 1600, height: 900, dpr: K });
  await sleep(600);
  const R = async (sel) => { const r = await J(desk, `desk.rect(${JSON.stringify(sel)})`); return { x: r[0], y: r[1], w: r[2], h: r[3], cx: r[0] + r[2] / 2, cy: r[1] + r[3] / 2, r: r[0] + r[2], b: r[1] + r[3] }; };
  const freeze = async (name, idx) => {
    const png = join(out, `${name}.png`);
    await desk.shot(png);
    ff("-i", png, "-f", "rawvideo", "-pix_fmt", "rgba", join(out, `${name}.rgba`));
    extra.set(`grabbit/frame/${idx}`, { bytes: readFileSync(join(out, `${name}.rgba`)), type: "application/octet-stream" });
    return png;
  };
  const crop = (src, r, name) => { const f = join(out, name); ff("-i", src, "-vf", `crop=${Math.round(r.w * K)}:${Math.round(r.h * K)}:${Math.round(r.x * K)}:${Math.round(r.y * K)}`, f); return f; };
  await desk.ev("desk.fixed(true)");
  const fixedPng = await freeze("desk-fixed", 1);
  const deskFixed = await snap(desk, "desk");
  await desk.ev("desk.long(true)");
  await freeze("desk-long", 2);
  const deskLong = await snap(desk, "desk");
  await desk.ev("desk.long(false)");
  await desk.ev("desk.fixed(false)");
  const bugPng = await freeze("desk-bug", 0);
  const deskBug = await snap(desk, "desk");
  const app = await R("#app"), main = await R("#site main"), kpis = await R(".kpis"), rev = await R("#rev"), cta = await R("#cta"), toast = await R(".toast"), chat = await R("#chat"), exp = await R(".export");
  const sel = { x: Math.round(main.x + 8), y: Math.round(kpis.y - 14), r: Math.round(app.r - 6), b: Math.round(toast.b + 10) };
  sel.w = sel.r - sel.x; sel.h = sel.b - sel.y;
  const wins = [{ id: 1, title: "Fernhill admin – Orders", app: "Browser", ...app }, { id: 2, title: "AI chat", app: "Chat", ...chat }]
    .map((w) => ({ id: w.id, title: w.title, app: w.app, x: w.x * K, y: w.y * K, width: w.w * K, height: w.h * K }));
  const openPicker = async (frame) => {
    const p = await open("picker.html", { width: 1600, height: 900, dpr: K, setup: `__studio.handlers = {
      picker_info: { frame: ${frame}, x: 0, y: 0, width: ${W}, height: ${H}, mode: "Pick", last_rect: null, os: "windows", windows: ${JSON.stringify(wins)} },
      get_settings: { record_microphone: true, record_system_audio: true } };` });
    await sleep(300);
    await p.ev(`__studio.emit("open", ${frame})`);
    await p.waitFor(`document.body.classList.contains("ready")`);
    return p;
  };
  /** PrtScn, then a drag from one corner to the other; ends with the action bar up and the pointer where it let go. */
  const grab = async (p, a, b, tag) => {
    await p.mouse("mouseMoved", ...st.ptr);
    st.cursor = "cross";
    base(await snap(p, tag));
    beat(0.5);
    await liveMove(p, FULL, a, 0.6, { tag });
    await p.mouse("mousePressed", a[0], a[1], 1);
    st.down = true;
    await liveMove(p, FULL, b, 0.9, { down: true, tag });
    await p.mouse("mouseReleased", b[0], b[1]);
    st.down = false;
    await p.waitFor(`!document.getElementById("bar").hidden`);
    st.cursor = "arrow";
    base(await snap(p, tag, 120));
  };
  /** One of the small always-on-top windows (the quick card, the record bar), as a picture with a clear background. */
  const part = async (path, w, h, name, setup = "", fix = "") => {
    const p = await open(path, { width: w, height: h, dpr: K, transparent: true, setup });
    await sleep(700);
    await p.ev(`(() => { document.querySelectorAll("*").forEach((e) => (e.style.animation = "none")); ${fix} })()`);
    const f = join(raw, `part-${name}.png`);
    await p.shot(f);
    await p.close();
    return f;
  };
  const icon = fileUrl(join(demo, "icon.png"));

  // ================================= title =================================
  st.scene = "title";
  base(deskBug);
  st.ptr = [690, 610];
  st.card = { html: `<div class="logo"><img src="${icon}">Grabbit</div><h1>Grab it. Say it. <em>Paste it anywhere.</em></h1><p>A tour of what it does, one feature at a time.</p>`, out: true };
  beat(0.6);
  speak("This is Grabbit. A screenshot and screen recording tool, built for people who paste things into A.I.");
  wait(0.5);
  st.card = null;

  // ================================= 1. capture, and the menu that pops up =================================
  scene("grab");
  cap("Something's off in the app you're building.", "Say you're building an app, and something on the page looks wrong.");
  glide([rev.r + 26, rev.cy + 16], 1.1);
  wait();
  const pick = await openPicker(0);
  keys("PrtScn"); cap("Tap <em>PrtScn</em>. The screen freezes.", "Tap Print Screen. The whole screen freezes, so nothing moves while you choose.");
  await pick.mouse("mouseMoved", ...st.ptr);
  st.cursor = "cross";
  base(await snap(pick, "pick"));
  wait();
  keys(); cap("Drag over the part you want.", "Drag over the part you want.");
  await liveMove(pick, FULL, [sel.x, sel.y], 0.7, { tag: "pick" });
  await pick.mouse("mousePressed", sel.x, sel.y, 1);
  st.down = true;
  await liveMove(pick, FULL, [sel.r, sel.b], 1.3, { down: true, tag: "pick" });
  await pick.mouse("mouseReleased", sel.r, sel.b);
  st.down = false;
  await pick.waitFor(`!document.getElementById("bar").hidden`);
  st.cursor = "arrow";
  base(await snap(pick, "pick", 120));
  cap("A wheel pops up where you let go. <em>Every slice has a number, and most a letter.</em>", "A wheel pops up right where you let go. Point at a slice and the middle shows what it does. Click it, press its number, or press its letter.");
  wait(0.4);
  await tour(pick, FULL, "#bar", [
    ["Copy", "<em>Enter</em> copies the picture.", "Enter copies the picture at full size, ready to paste.", "Enter"],
    ["Copy smaller", "<em>Shift+Enter</em> copies a smaller one.", "Shift Enter copies a smaller one. Lighter for emails and documents.", "Shift", "Enter"],
    ["Copy for chat", "<em>Copy for chat</em>: small, uploads fast.", "Copy for chat makes a small picture that uploads fast in Slack, Teams or WhatsApp."],
    ["Mark up", "<em>E</em> opens the editor.", "E opens it in the editor, for arrows, boxes, text and blur.", "E"],
    ["Save as", "<em>Ctrl+S</em> saves it as a file.", "Control S saves it as a file.", "Ctrl", "S"],
    ["Record video", "<em>R</em> records this area as a video.", "R records this same area as a video.", "R"],
    ["Add another area", "<em>N</em> keeps this area and adds another.", "N keeps this area, so you can drag another one and take them together.", "N"],
    ["Talk to AI", "<em>V</em> is Talk to AI.", "And V is Talk to A.I. That's the one we want here.", "V"],
  ], "pick");
  beat(0.3);
  await pick.key("v", "KeyV", 86);
  await pick.close();

  // ================================= 2. talk to AI =================================
  scene("talk");
  const capBug = crop(bugPng, sel, "cap-bug.png");
  const ocr = ["Revenue today", "$NaN", "▲ 12.4% vs yesterday", "Orders", "128", "▲ 8.1%", "Avg. basket", "$24.83", "▼ 1.2%", "Latest orders",
    "#1046 9:41 Aroha T. Ridgeline Espresso 1 kg Pending –", "#1045 9:38 Sam K. Morning Fog 250 g × 2 Paid $37.00", "#1044 9:30 Mia J. Ember Dark 500 g Paid $26.50",
    "#1043 9:22 Café Rata Kāpiti Filter 5 kg Paid $184.00", "#1042 9:15 Tane W. Decaf Swiss 250 g Paid $19.50", "Export", "Everything from this week, one row per order.",
    "Download weekly report (CSV)", "TypeError: Cannot read properties of undefined (reading 'total')", "at RevenueCard (RevenueCard.tsx:42)"].map((text, line) => ({ text, line }));
  const V = win("voice", 150, 80, 1300, 740);
  const voice = await open(`voice.html?p=${encodeURIComponent(capBug)}&t=${encodeURIComponent("Fernhill admin – Orders")}&mic=${encodeURIComponent("Headset microphone")}`, { width: V.w, height: V.h, dpr: K, setup: `
    window.__cues = []; window.__ocr = ${JSON.stringify(ocr)};
    __studio.handlers = { voice_stop: () => window.__cues, voice_restart: null, copy_for_ai: (a) => { window.__copied = a; return null; },
      voice_level: () => { const t = performance.now(); return 0.004 + 0.3 * Math.abs(Math.sin(t / 97)) * Math.abs(Math.sin(t / 310)) ** 2; },
      editor_msg: ({ msg }) => (msg.type === "ocr" ? window.__ocr : null) };` });
  await voice.waitFor(`document.getElementById("pic").naturalWidth > 0`);
  await sleep(400);
  // Start listening afresh, so the marks' times count from a moment this script knows.
  await voice.ev(`document.getElementById("done").click()`);
  await voice.waitFor(`!document.body.classList.contains("listening")`);
  await voice.ev(`document.getElementById("redo").click()`);
  await voice.waitFor(`document.body.classList.contains("listening")`);
  const now = () => voice.ev(`performance.now() / 1000`);
  const t0 = await now();
  const m = await J(voice, `(() => { const c = document.getElementById("marks").getBoundingClientRect(); return [c.left, c.top, c.width, c.height]; })()`);
  const onPic = (x, y) => V.at(m[0] + ((x - sel.x) / sel.w) * m[2], m[1] + ((y - sel.y) / sel.h) * m[3]);   // a desktop point, on the picture in the window
  const aside = await J(voice, `(() => { const r = document.querySelector("aside").getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()`);
  const rest = (min = 0.4) => Math.max(min, audioEnd + 0.2 - T);

  base(deskBug); dim();
  V.show(await snap(voice, "voice"));
  st.ptr = V.at(m[0] + m[2] * 0.6, m[1] + m[3] * 0.55);
  cap("Press <em>V</em> and say what's wrong.", "Talk to A.I. opens with your picture, and it's already listening.");
  await liveHold(voice, V, rest(), { tag: "voice" });
  keys(); cap("Click to point. Drag to box. Just talk.", "Click to point at something. Drag to put a box around it. And just say what's wrong.");
  await liveHold(voice, V, rest(), { tag: "voice" });
  // [1] the figure
  const p1 = onPic(rev.x + rev.w * 0.5, rev.cy);
  say("The revenue here shows NaN.");
  await liveHold(voice, V, 0.8, { tag: "voice", to: p1 });
  await voice.click(p1[0] - V.x, p1[1] - V.y);
  const t1 = (await now()) - t0;
  V.show(await snap(voice, "voice"));
  click(0.3);
  await liveHold(voice, V, rest(0.6), { tag: "voice" });
  // [2] the button
  const b0 = onPic(cta.x - 10, cta.y - 10), b1 = onPic(Math.min(sel.r - 4, cta.r + 10), cta.b + 10);
  say("And this button sticks out of its card. Fix both.");
  await liveHold(voice, V, 0.7, { tag: "voice", to: b0 });
  await voice.mouse("mouseMoved", b0[0] - V.x, b0[1] - V.y);
  await voice.mouse("mousePressed", b0[0] - V.x, b0[1] - V.y, 1);
  st.down = true;
  await liveHold(voice, V, 0.6, { tag: "voice", to: b1 });
  await voice.mouse("mouseMoved", b1[0] - V.x, b1[1] - V.y, 1);
  await voice.mouse("mouseReleased", b1[0] - V.x, b1[1] - V.y);
  st.down = false;
  const t2 = (await now()) - t0;
  V.show(await snap(voice, "voice"));
  await liveHold(voice, V, rest(0.8), { tag: "voice" });
  say(null);
  // Enter: the words are typed out, each mark's number where it was made.
  const mid = (t1 + t2) / 2;
  await voice.ev(`window.__cues = ${JSON.stringify([{ start: 0.2, end: mid - 0.3, text: "The revenue here shows NaN." }, { start: mid, end: t2 + 30, text: "And this button sticks out of its card. Fix both." }])}`);
  cap("<em>Enter</em>: your words are typed out, numbers in place.", "Press Enter. Your words are typed out for you, with a number wherever you pointed."); keys("Enter");
  await keyDown(voice, "Enter", "Enter", 13);
  await voice.waitFor(`!document.body.classList.contains("listening") && document.getElementById("words").value.length > 10`);
  V.show(await snap(voice, "voice", 200));
  glide(V.at(aside[0] + 60, aside[1] + 420), 0.8);
  wait(0.5);
  cap("<em>Ctrl+Enter</em> copies the picture and the words together.", "Control Enter copies the picture and the words together, for one paste."); keys("Ctrl", "Enter");
  await keyDown(voice, "Enter", "Enter", 13, 2);
  await voice.waitFor(`document.body.classList.contains("copied")`);
  V.show(await snap(voice, "voice", 150));
  wait(0.5);
  const copied = await J(voice, `window.__copied`);
  const copiedPng = join(out, "copied.png");
  writeFileSync(copiedPng, Buffer.from(copied.images[0].split(",")[1], "base64"));
  writeFileSync(join(out, "copied.txt"), copied.text);
  console.log("words:", await voice.ev(`document.getElementById("words").value`), voice.errors.join("\n"));
  await voice.close();

  // ================================= 3. paste =================================
  scene("paste");
  drop("dim", "voice");
  base(deskBug);
  const box = await R("#compose");
  cap("Paste it into ChatGPT, Claude or Gemini.", "Now paste it into ChatGPT, Claude or Gemini.");
  glide([box.cx - 40, box.cy], 0.9);
  click(0.3);
  keys("Ctrl", "V");
  await desk.ev(`desk.paste(${JSON.stringify(fileUrl(copiedPng))}, ${JSON.stringify(copied.text)})`);
  base(await snap(desk, "desk", 150));
  wait(0.6);
  keys("Enter");
  await desk.ev("desk.send()");
  base(await snap(desk, "desk", 150));
  cap("It gets the picture, your words, the marks and the <em>text on screen.</em>", "The A.I. gets the marked picture, your words, and all the text that was on screen.");
  beat(0.6);
  keys();
  wait(0.4);
  await desk.ev("desk.thinking()");
  base(await snap(desk, "desk", 100));
  beat(0.6);
  const n = await desk.ev(`desk.reply(${JSON.stringify(`<p>Both fixed in <code>src/orders/</code>.</p>
    <p><b>[1] Revenue shows NaN.</b> The error on screen says <code>reading 'total'</code> at <code>RevenueCard.tsx:42</code>: pending orders have no summary yet.</p>
    <div class="diff"><div class="f">RevenueCard.tsx</div><div class="d">- sum + o.summary.total</div><div class="a">+ sum + (o.summary?.total ?? 0)</div></div>
    <p><b>[2] Button sticks out.</b> The label now wraps inside its card.</p><p>Saved. Your page should hot reload.</p>`)})`);
  cap("It read the exact error off your screenshot.", "So it can read the exact error off your screenshot, and it knows which thing each number points at.");
  for (let i = 1; i <= 60; i++) {
    await desk.ev(`desk.reveal(${Math.ceil((n * i) / 60)})`);
    base(await snap(desk, "desk", 20));
    beat(2 * F);
  }
  wait(0.5);
  await desk.ev("desk.fixed(true)");
  base(await snap(desk, "desk", 100));
  cap("Both fixed. You never typed a word.", "Both bugs fixed. And you never typed a word.");
  glide([rev.r + 30, rev.cy + 20], 1.0);
  wait(0.8);

  // ================================= 4. the More menu =================================
  scene("more");
  base(deskFixed);
  const table = await R("table");
  const pm = await openPicker(1);
  st.ptr = [rev.r + 30, rev.cy + 20];
  keys("PrtScn"); cap("There's more under <em>More</em>.", "The wheel has a second half. Grab an area again.");
  await grab(pm, [kpis.x - 8, kpis.y - 10], [table.r + 6, table.b - 60], "more");
  keys();
  wait(0.2);
  const moreBtn = await button(pm, "More", "#bar");
  glide(moreBtn, 0.7);
  await pm.click(...moreBtn);
  await sleep(150);
  base(await snap(pm, "more", 100));
  click(0.3);
  cap("<em>More</em>: a bigger wheel with the rest.", "Click More for a bigger wheel with the rest. Each of these has its own key too.");
  wait(0.3);
  await tour(pm, FULL, "#bar .menu", [
    ["Describe with AI", "<em>X</em> has AI describe the picture.", "X has A.I. write what's in the picture, and copies that text.", "X"],
    ["Start an AI batch", "<em>B</em> starts a batch of several screenshots.", "B starts a batch. Take several screenshots, talk about each one, and paste them all together.", "B"],
    ["Scrolling capture", "<em>S</em> captures a page longer than the screen.", "S is a scrolling capture, for pages longer than the screen.", "S"],
    ["Copy the text in it", "<em>T</em> copies the words in the picture.", "T copies the words in the picture, as text.", "T"],
    ["Read QR code", "<em>Q</em> reads a QR code or barcode.", "Q reads a Q.R. code or a barcode.", "Q"],
    ["Pin on top", "<em>I</em> pins it on top of every window.", "I pins the picture on top of every window.", "I"],
    ["Share as a link", "<em>Share</em> uploads it and copies a link.", "Share uploads it and copies a link."],
    ["Save and copy the file path", "<em>P</em> saves it and copies the file path.", "P saves it, and copies the path to the file.", "P"],
    ["Capture again in 10 s", "<em>D</em> captures again in 10 seconds.", "And D captures again after ten seconds, so you have time to open a menu first.", "D"],
  ], "more");
  cap("Next: three of these in action.", "Let's see three of those in action.");
  keys();
  wait(0.3);
  await pm.close();

  // ================================= 5. scrolling capture =================================
  scene("scroll");
  await desk.ev("desk.long(true)");
  base(deskLong);
  const ps = await openPicker(2);
  st.ptr = [app.cx + 150, app.cy + 120];
  await ps.mouse("mouseMoved", ...st.ptr);
  st.cursor = "cross";
  base(await snap(ps, "scroll"));
  keys("PrtScn"); cap("This page is longer than the window.", "This list of orders is far longer than the window.");
  beat(0.4, { cut: true });
  await liveMove(ps, FULL, [app.cx + 60, app.cy + 40], 0.8, { tag: "scroll" });
  wait(0.3);
  keys("S"); cap("Point at the window and press <em>S</em>.", "Point at the window and press S.");
  wait(0.3);
  await ps.key("s", "KeyS", 83);
  await ps.close();
  st.cursor = "arrow";
  st.ptr = [app.r - 12, app.cy];
  const maxY = await desk.ev("desk.scroll(0)");
  const sbar = [];
  for (const px of [0, 1, 2, 3, 4, 5]) sbar.push(await part("recbar.html?mode=scroll", 470, 44, `scrollbar${px}`, "", `document.querySelector(".status").textContent = ${JSON.stringify(`Scrolling… ${Math.round((maxY * px) / 5 / 10) * 10 * K} px · don't move the mouse`)};`));
  const sAt = [app.cx - 235, app.b + 14];
  base(await snap(desk, "desk"));
  layer("recbar", sbar[0], sAt[0], sAt[1], 470, 44);
  keys(); cap("Grabbit scrolls the page for you.", "Grabbit scrolls the page for you, and stitches the pieces into one picture as it goes.");
  beat(0.5);
  const NS = 72;
  for (let i = 1; i <= NS; i++) {
    await desk.ev(`desk.scroll(${Math.round(maxY * ease(i / NS))})`);
    const f = await snap(desk, "desk", 25);
    copyFileSync(f, join(walkDir, `w${String(i).padStart(3, "0")}.jpg`));
    base(f);
    layer("recbar", sbar[Math.min(5, Math.floor((i / NS) * 6))], sAt[0], sAt[1], 470, 44);
    if (i === 40) cap("The header that sticks to the top appears once.", "The header that sticks to the top of the page only appears once.");
    beat(3 * F);
  }
  wait(0.3);
  drop("recbar");
  // The stitched picture: the window grown to hold the whole page.
  const tallH = await desk.ev("desk.tall(true)");
  await desk.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: tallH + 120, deviceScaleFactor: K, mobile: false });
  const tallPng = join(out, "tall.png");
  await desk.shot(tallPng, { x: app.x, y: app.y, width: app.w, height: tallH });
  await desk.ev("desk.tall(false)");
  await desk.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: K, mobile: false });
  await desk.ev("desk.scroll(0)");
  const quickTall = await part(`quick.html?t=${encodeURIComponent(`Copied ${Math.round(app.w * K)}×${Math.round(tallH * K)}`)}&p=${encodeURIComponent(tallPng)}`, 300, 230, "quick-tall");
  base(await snap(desk, "desk", 100));
  dim();
  const th = 850, tw = Math.round((app.w / tallH) * th);
  layer("tall", tallPng, 800 - tw / 2, 25, tw, th, { sh: true, r: 8 });
  layer("quick", quickTall, 1276, 646, 300, 230);
  st.ptr = [800 + tw / 2 + 60, 500];
  cap(`One picture, <em>${Math.round(app.w * K)} × ${Math.round(tallH * K)}</em>, copied and saved.`, "One tall picture of the whole page. Copied to the clipboard, and saved.");
  wait(1.0);
  drop("dim", "tall", "quick");
  await desk.ev("desk.long(false)");

  // ================================= 6. copy the text in it =================================
  scene("text");
  base(deskFixed);
  const row4 = await R("table tr:nth-child(4)");
  const rowText = "#1043 9:22 Café Rata Kāpiti Filter 5 kg Paid $184.00";
  const pt = await openPicker(1);
  st.ptr = [row4.cx, row4.cy - 80];
  keys("PrtScn"); cap("Need the words, not the picture?", "Sometimes you want the words, not the picture.");
  beat(0.4, { cut: true });
  await grab(pt, [row4.x - 6, row4.y + 2], [row4.r + 6, row4.b - 2], "text");
  wait(0.2);
  keys("T"); cap("Drag over them and press <em>T</em>.", "Drag over them and press T.");
  wait(0.3);
  await pt.key("t", "KeyT", 84);
  await pt.close();
  const quickText = await part(`quick.html?t=${encodeURIComponent(`Copied text: ${rowText}`)}`, 470, 60, "quick-text");
  base(deskFixed);
  layer("quick", quickText, 1110, 826, 470, 60);
  keys(); cap("The words are on your clipboard, as text.", "Grabbit reads them, on your computer, and puts them on the clipboard as real text.");
  const box2 = await R("#compose");
  glide([box2.cx - 40, box2.cy], 1.0);
  wait(0.2);
  click(0.3);
  await desk.ev(`desk.type(${JSON.stringify(rowText)})`);
  base(await snap(desk, "desk", 100));
  keys("Ctrl", "V"); cap("Paste them anywhere.", "Paste them anywhere you like.");
  wait(0.8);
  drop("quick");

  // ================================= 7. pin on top =================================
  scene("pin");
  const pinPng = crop(fixedPng, { x: kpis.x - 6, y: kpis.y - 6, w: kpis.w + 12, h: kpis.h + 12 }, "pin.png");
  const pp = await openPicker(1);
  st.ptr = [kpis.cx, kpis.b + 80];
  keys("PrtScn"); cap("Want to keep some numbers in view?", "Want to keep some numbers in view while you work on something else?");
  beat(0.4, { cut: true });
  await grab(pp, [kpis.x - 6, kpis.y - 6], [kpis.r + 6, kpis.b + 6], "pin");
  wait(0.2);
  keys("I"); cap("Press <em>I</em> to pin it.", "Press I to pin it.");
  wait(0.3);
  await pp.key("i", "KeyI", 73);
  await pp.close();
  base(await snap(desk, "desk", 60));
  const pw = Math.round((kpis.w + 12) * 0.62), ph = Math.round((kpis.h + 12) * 0.62);
  layer("pin", pinPng, chat.cx - pw / 2, chat.y + 150, pw, ph, { sh: true, r: 8 });
  st.ptr = [chat.cx + 40, chat.y + 150 + ph / 2];
  keys(); cap("It floats on top of every window.", "The picture floats on top of every window. Drag it where you like, scroll to resize it, double click to close it.");
  wait(1.0);
  drop("pin");
  await desk.ev("desk.type('Message the assistant')");
  await desk.ev(`document.getElementById("compose").classList.remove("has")`);

  // ================================= 8. hide private details =================================
  scene("hide");
  const sec = await open(page("secrets.html"), { width: 1100, height: 640, dpr: K });
  await sleep(400);
  const secPng = join(out, "secrets.png");
  await sec.shot(secPng);
  const secWords = await J(sec, `words(${K})`);
  await sec.close();
  const E = win("editor", 120, 20, 1360, 860);
  const recent = [["secrets", secPng, 21], ["orders", capBug, 16]].map(([name, path, mm]) => ({ path, url: fileUrl(path), name, time: `2026-11-02T09:${mm}:00`, kind: "capture" }));
  const ed = await open("index.html", { width: E.w, height: E.h, dpr: K, setup: `
    localStorage.setItem("editor", "markup"); ["markupStyle", "barPos", "library", "libraryDock", "libraryFolders", "tabsAt", "tabsSlim"].forEach((k) => localStorage.removeItem(k));
    window.__ocr = ${JSON.stringify(secWords)};
    __studio.handlers = { editor_msg: ({ msg }) => ({ ocr: window.__ocr, exportFile: "C:/tmp/out.png" })[msg.type] ?? null, copy_text: null, share_targets: [],
      get_settings: { metadata: { strip: true, author: "", copyright: "" }, branding: { invisible_mark: false, on_images: false, logo_path: "" } } };` });
  await ed.waitFor(`!!window.grabbit?.fabric && !!window.grabbit.receive`);
  await ed.ev(`(async () => { const b = await (await fetch(${JSON.stringify(fileUrl(secPng))})).blob();
    const d = await new Promise((ok) => { const f = new FileReader(); f.onload = () => ok(f.result); f.readAsDataURL(b); });
    window.grabbit.receive({ type: "load", name: "Settings", dataURL: d, width: ${1100 * K}, height: ${640 * K}, recent: ${JSON.stringify(recent)} }); })()`);
  await ed.waitFor(`!!window.grabbit.fabric.backgroundImage`);
  await sleep(500);
  base(deskFixed); dim();
  E.show(await snap(ed, "editor"));
  const hideBtn = await button(ed, "Hide", "header.bar");
  const stage = await J(ed, `(() => { const c = window.grabbit.fabric, v = c.viewportTransform, r = c.upperCanvasEl.getBoundingClientRect(); return [r.left + v[4], r.top + v[5], ${1100 * K} * v[0], ${640 * K} * v[3]]; })()`);
  st.ptr = E.at(stage[0] + stage[2] * 0.5, stage[1] + stage[3] * 0.42);
  cap("Sharing a screenshot? Check what's in it.", "Before you share a screenshot, check what's in it. This one, open in the editor, has a live key, an email address and a phone number.");
  beat(0.4, { cut: true });
  glide(E.at(stage[0] + stage[2] * 0.62, stage[1] + stage[3] * 0.5), 1.6);
  wait(0.3);
  cap("Open <em>Hide</em> and pick <em>Hide private details</em>.", "Open Hide, and pick Hide private details.");
  glide(E.at(...hideBtn), 0.9);
  await ed.click(...hideBtn);
  await sleep(250);
  E.show(await snap(ed, "editor"));
  click(0.5);
  const item = await button(ed, "Hide private details", ".dropdown");
  glide(E.at(...item), 0.6);
  wait(0.2);
  await ed.click(...item);
  await ed.waitFor(`window.grabbit.fabric.getObjects().filter((o) => o.gb?.kind === "redact").length >= 4`);
  await sleep(500);
  await ed.mouse("mouseMoved", 700, 700);
  E.show(await snap(ed, "editor"));
  click(0.3);
  cap("Keys, emails, IPs and phone numbers, pixelated for you.", "Grabbit finds the keys, emails, addresses and phone numbers, and pixelates each one. It all happens on your computer.");
  glide(E.at(stage[0] + stage[2] * 0.8, stage[1] + stage[3] * 0.9), 0.9);
  wait(0.8);
  console.log("editor:", ed.errors.join("\n"));
  await ed.close();

  // ================================= 9. record =================================
  scene("record");
  drop("dim", "editor");
  const rec = await openPicker(1);
  st.ptr = [app.cx + 120, app.cy + 40];
  await rec.mouse("mouseMoved", ...st.ptr);
  base(deskFixed);
  cap("Hold the same key and it records instead.", "For a video, hold the same key instead of tapping it.");
  beat(0.4, { cut: true });
  keys("PrtScn"); st.held = true;
  st.cursor = "cross";
  for (let i = 0; i <= 30; i++) {
    await rec.ev(`__studio.emit("hold", ${(i / 30).toFixed(3)})`);
    base(await snap(rec, "rec", 60));
    beat(i === 0 ? 0.5 : 2 * F);
  }
  await rec.ev(`__studio.emit("picker-mode", "Record")`);
  base(await snap(rec, "rec", 120));
  cap("The pill fills. Now it's the recording picker.", "The pill at the top fills up, and the picker turns into the recording picker.");
  wait(0.3);
  keys(); cap("Click a window, or drag any area.", "Click a window, or drag over any area.");
  await liveMove(rec, FULL, [app.cx - 60, app.cy + 90], 0.8, { tag: "rec" });
  await rec.click(app.cx - 60, app.cy + 90);
  await rec.waitFor(`!document.getElementById("bar").hidden`);
  st.cursor = "arrow";
  base(await snap(rec, "rec", 120));
  click(0.3);
  wait(0.2);
  const recBtn = await button(rec, "Record", "#bar");
  cap("<em>Enter</em> starts it. Sound and microphone are right there.", "System sound and the microphone are right there to switch on or off. Enter starts recording.");
  glide([recBtn[0] + 150, recBtn[1]], 0.8);
  beat(0.8);
  glide(recBtn, 0.6);
  wait(0.2);
  keys("Enter");
  beat(0.4);
  await rec.close();
  // Recording: the red frame and the Stop bar, laid over the live desktop (they're never in the video).
  const framePng = await part("recframe.html", app.w + 8, app.h + 8, "recframe");
  const bars = [];
  for (let s = 0; s <= 9; s++) bars.push(await part("recbar.html", 300, 44, `recbar${s}`, `__studio.handlers = { rec_status: { elapsed: ${s}, paused: false, recording: true } };`));
  const barAt = [app.cx - 150, app.b + 14];
  base(deskFixed);
  layer("recframe", framePng, app.x - 4, app.y - 4, app.w + 8, app.h + 8);
  keys(); cap("The red frame and Stop bar never show up in the video.", "A red frame shows what's being recorded. The frame and the Stop bar never show up in the video itself.");
  const row = await R("table tr:nth-child(2)");
  const stops = [[row.cx - 100, row.cy], [exp.cx, cta.cy], [rev.cx + 20, rev.cy], [row.cx + 60, row.cy + 70], [kpis.cx, kpis.cy], [exp.cx - 20, exp.cy], [row.cx, row.cy + 30]];
  let bi = 0;
  for (; bi < 7 || T < audioEnd; bi++) {
    layer("recbar", bars[Math.min(9, bi)], barAt[0], barAt[1], 300, 44);
    glide(stops[bi % stops.length], 1.0);
  }
  cap("Press <em>Stop</em> when you're done.", "Press Stop when you're done.");
  layer("recbar", bars[Math.min(9, bi)], barAt[0], barAt[1], 300, 44);
  glide([barAt[0] + 196, barAt[1] + 22], 0.9);
  wait(0.2);
  click(0.5);

  // ================================= 10. edit the video =================================
  scene("video");
  drop("recframe", "recbar");
  mkdirSync(join(root, "app/node_modules/.studio"), { recursive: true });
  const vid = join(root, "app/node_modules/.studio/reel-walk.mp4");
  const vw = Math.round((app.w * K) / 2) * 2, vh = Math.round((app.h * K) / 2) * 2;
  // The recording: the long Orders page being scrolled (the frames kept from the scrolling capture), 12 seconds.
  ff("-framerate", "12", "-i", join(walkDir, "w%03d.jpg"), "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=12,volume=0.08,tremolo=f=2:d=0.6",
    "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.01:sample_rate=48000:duration=12", "-map", "0:v", "-map", "1:a", "-map", "2:a", "-t", "12",
    "-vf", `crop=${vw}:${vh}:${Math.round(app.x * K)}:${Math.round(app.y * K)},tpad=start_mode=clone:start_duration=3:stop_mode=clone:stop_duration=3`, "-r", "30", "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
    "-metadata:s:a:0", "handler_name=System sound", "-metadata:s:a:1", "handler_name=Microphone", "-movflags", "+faststart", vid);
  const cues = [
    { start: 0.2, end: 2.6, text: "Here's the new Orders page." },
    { start: 2.6, end: 4.6, text: "Every order from today is in the list." },
    { start: 6.4, end: 8.8, text: "Right down to the first one." },
    { start: 9.6, end: 11.6, text: "Shipping it." },
  ];
  const VE = win("video", 100, 20, 1400, 860);
  const ve = await open("video.html", { width: VE.w, height: VE.h, dpr: K, setup: `__studio.handlers = { editor_msg: ({ msg }) => ({ silences: [[4.6, 6.4], [8.8, 9.6]], captionEngine: "local", captions: ${JSON.stringify(cues)} })[msg.type] ?? null };` });
  await sleep(500);
  await ve.ev(`__studio.emit("host", { type: "load", name: "Orders page walkthrough", path: ${JSON.stringify(vid)}, url: "/node_modules/.studio/reel-walk.mp4", duration: 12, fps: 30, width: ${vw}, height: ${vh}, hasAudio: true, bytes: 1830000, hasSystem: true, hasMic: true,
    cursor: { moves: [[1, 600, 300, 0], [1.4, 600, 300, 1], [1.5, 600, 300, 0], [6.5, 900, 500, 1], [6.6, 900, 500, 0]], keys: [[3, "LControl"], [3.1, "S"]] } })`);
  await ve.waitFor(`!!document.querySelector(".fx")`, 20000);
  await ve.waitFor(`document.querySelectorAll(".strip .thumb canvas").length >= 24`, 60000);
  await ve.ev("window.confirm = () => true");
  await ve.ev(`document.querySelector("video").currentTime = 0.5`);
  await sleep(900);
  base(deskFixed); dim();
  VE.show(await snap(ve, "video"));
  st.ptr = VE.at(700, 430);
  cap("Stop, and it opens in the video editor.", "The recording opens straight away in the video editor.");
  beat(0.4, { cut: true });
  wait(0.3);
  // Scrubbing: press on the timeline and drag; the picture follows.
  const tr = await J(ve, `(() => { const t = document.querySelector(".track"), r = t.getBoundingClientRect(), p = t.parentElement.getBoundingClientRect(); return [r.left, r.top, Math.min(r.width, p.right - r.left - 8), r.height]; })()`);
  const onTrack = (u) => VE.at(tr[0] + tr[2] * u, tr[1] + 52);
  cap("Drag along the timeline to <em>scrub</em>.", "Press anywhere on the timeline and drag to scrub. The picture follows your pointer, so you can find the exact moment.");
  glide(onTrack(0.06), 0.9);
  await ve.mouse("mouseMoved", ...onTrack(0.06).map((v, i) => v - [VE.x, VE.y][i]));
  await ve.mouse("mousePressed", ...onTrack(0.06).map((v, i) => v - [VE.x, VE.y][i]), 1);
  st.down = true;
  await liveMove(ve, VE, onTrack(0.86), 3.2, { down: true, tag: "video", every: 2, pause: 110 });
  await liveMove(ve, VE, onTrack(0.34), 2.4, { down: true, tag: "video", every: 2, pause: 110 });
  await liveMove(ve, VE, onTrack(0.55), 1.6, { down: true, tag: "video", every: 2, pause: 110 });
  { const e = onTrack(0.55); await ve.mouse("mouseReleased", e[0] - VE.x, e[1] - VE.y); }
  st.down = false;
  VE.show(await snap(ve, "video", 200));
  wait(0.4);
  const tools = async (label, html, line, ...ks) => { const c = await button(ve, label); glide(VE.at(...c), 0.6); await ve.mouse("mouseMoved", ...c); VE.show(await snap(ve, "video", 120)); cap(html, line); keys(...ks); wait(0.3); return c; };
  await tools("Split", "<em>S</em> splits at the playhead.", "S splits the video where the playhead is.", "S");
  await tools("Trim start", "<em>I</em> and <em>O</em> trim the start and the end.", "I cuts everything before it, and O cuts everything after.", "I");
  keys();
  const cut = await button(ve, "Cut silences");
  cap("<em>Cut silences</em> takes the dead air out in one click.", "Cut silences finds the dead air, and takes it out in one click.");
  glide(VE.at(...cut), 0.8);
  wait(0.2);
  await ve.click(...cut);
  await ve.waitFor(`document.querySelectorAll(".strip .seg").length >= 2`);
  await ve.mouse("mouseMoved", cut[0], cut[1] - 60);
  VE.show(await snap(ve, "video", 300));
  click(0.4);
  wait(0.6);
  const capBtn = await button(ve, "Captions");
  cap("<em>Captions</em> are made on your computer, ready to burn in.", "Captions are written from what you said, on your own computer. Edit a line, or burn them into the video.");
  glide(VE.at(...capBtn), 0.7);
  await ve.click(...capBtn);
  await ve.waitFor(`document.querySelectorAll(".cue").length > 0`);
  await ve.ev(`(() => { const c = document.querySelector(".captions header input"); if (c && !c.checked) c.click(); document.querySelector("video").currentTime = 3.2; })()`);
  await ve.mouse("mouseMoved", capBtn[0] + 40, capBtn[1] + 200);
  await sleep(900);
  VE.show(await snap(ve, "video", 200));
  click(0.4);
  wait(1.0);
  console.log("video:", ve.errors.join("\n"));
  await ve.close();
  await desk.close();

  // ================================= end =================================
  scene("end");
  cap("");
  st.card = { html: `<div class="logo"><img src="${icon}">Grabbit</div><h1>Grab it. Say it. <em>Paste it anywhere.</em></h1><p>Free and open source. No account, no watermark.<br>Windows, macOS and Linux.</p><div class="url">github.com/JakeTheRabbit/grabbit</div>`, in: true };
  beat(0.5);
  speak("Grabbit is free and open source, for Windows, Mac and Linux. No account, and no watermark.");
  wait(1.2);

  const clicks = tl.filter((b) => b.click).map((b) => b.t);
  writeFileSync(join(out, "timeline.json"), JSON.stringify({ total: T, icon, beats: tl, audio, clicks }));
  console.log(`shot ${shots} pictures, ${tl.length} beats, ${audio.length} lines, ${T.toFixed(1)} s`);
  for (const s of [...new Set(tl.map((b) => b.scene))]) { const bs = tl.filter((b) => b.scene === s); console.log(`  ${s.padEnd(8)} ${bs[0].t.toFixed(1).padStart(6)} – ${(bs.at(-1).t + bs.at(-1).dur).toFixed(1)} s`); }
}

const load = () => JSON.parse(readFileSync(join(out, "timeline.json"), "utf8"));
const spans = (beats) => { const m = new Map(); for (const b of beats) { const s = m.get(b.scene) ?? [b.t, 0]; s[1] = b.t + b.dur; m.set(b.scene, s); } return m; };

// ---------------------------------------------------------------------------------------------------------------
// Rendering: every frame's state worked out here (pointer, fades, key presses), drawn by stage.html, saved as JPEG.
// ---------------------------------------------------------------------------------------------------------------
async function render() {
  const { total, icon, beats } = load();
  const [from = 0, to = total, every = 1] = nums;   // `every` > 1 draws only each nth frame, for a contact sheet
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });
  const stage = await open(page("stage.html"), { width: 1920, height: 1080, dpr: 1 });
  const N = Math.round(total * FPS), sp = spans(beats);
  let bi = 0, capText = null, capT = 0, clickT = -9, clickAt = [0, 0], cardT = -9, saved = 0;
  const born = new Map();
  for (let i = 0; i < N; i++) {
    const t = i / FPS;
    while (bi < beats.length - 1 && beats[bi + 1].t <= t + 1e-6) bi++;
    const b = beats[bi], first = Math.abs(b.t - t) < F / 2, u = clamp((t - b.t) / b.dur);
    if (b.click && first) { clickT = t; clickAt = b.ptr; }
    if (b.cap !== capText) { capText = b.cap; capT = t; }
    const ptr = b.ptrTo ? b.ptr.map((v, k) => v + (b.ptrTo[k] - v) * (b.linear ? u : ease(u))) : b.ptr;
    for (const id of born.keys()) if (!b.layers.some((l) => l.id === id)) born.delete(id);
    for (const l of b.layers) if (!born.has(l.id)) born.set(l.id, t);
    if (b.card && !beats[bi - 1]?.card && first) cardT = t;
    const rip = (t - clickT) / 0.45;
    const sy = b.say && (() => { const ws = b.say.text.split(" "), k = clamp((t - b.say.t0) / Math.max(0.2, b.say.t1 - b.say.t0 - 0.3)); const n = Math.max(1, Math.ceil(ws.length * k)); const done = n >= ws.length;
      return { text: ws.slice(0, n).join(" "), done, bars: [0, 1, 2, 3, 4].map((j) => (done && k >= 1 ? 0.1 : 0.25 + 0.75 * Math.abs(Math.sin(t * (9 + j * 2.3) + j)))) }; })();
    const [s0, s1] = sp.get(b.scene);
    const state = {
      icon,
      layers: b.layers.map((l) => { const a = l.sh ? clamp((t - born.get(l.id)) / 0.28) : 1, e = 1 - (1 - a) ** 3; return { ...l, a: l.fill ? clamp((t - born.get(l.id)) / 0.25) : e, s: l.sh ? 0.965 + 0.035 * e : 1 }; }),
      cam: { x: 800, y: 450, z: 1 },
      fade: b.cut ? clamp((t - b.t) / b.dur) : 1,
      ptr: { x: ptr[0], y: ptr[1], kind: b.card ? "none" : b.cursor, down: b.down || rip < 0.3, ripple: rip >= 0 && rip < 1 ? rip : null, rx: clickAt[0], ry: clickAt[1] },
      cap: { html: b.cap, a: 1 - (1 - clamp((t - capT) / 0.3)) ** 2 },
      keys: b.keys?.map((label) => ({ label, p: b.held ? 1 : clamp(1 - (t - b.keyT) / 0.28) })),
      say: sy || null,
      prog: (t - s0) / (s1 - s0),   // the bar along the bottom fills once per feature
      card: b.card ? { html: b.card.html, a: Math.min(b.card.in ? clamp((t - cardT) / 0.45) : 1, b.card.out ? clamp((b.t + b.dur - t) / 0.4) : 1) } : null,
    };
    if (t < from || t > to || i % every) continue;
    await stage.ev(`draw(${JSON.stringify(state)})`);
    const r = await stage.send("Page.captureScreenshot", { format: "jpeg", quality: 96 });
    writeFileSync(join(framesDir, `f${String(saved++).padStart(5, "0")}.jpg`), Buffer.from(r.result.data, "base64"));
    if (saved % 300 === 0) console.log(`  ${saved} frames (${t.toFixed(1)} s)`);
  }
  console.log(`rendered ${saved} frames`, stage.errors.join("\n"));
  await stage.close();
}

// ---------------------------------------------------------------------------------------------------------------
// Encoding: the sound track (voices and clicks), the full tour and one clip per feature as MP4, and a silent animated
// WebP of each clip for the README (GitHub plays those inline; it won't play a repo's MP4).
// ---------------------------------------------------------------------------------------------------------------
function encode() {
  const dest = join(root, "docs/screenshots");
  const { total, beats, audio, clicks } = load();
  const tick = join(out, "click.wav"), wav = join(out, "audio.wav");
  ff("-f", "lavfi", "-i", "sine=frequency=1500:sample_rate=48000:duration=0.03", "-af", "afade=t=out:st=0.005:d=0.025,volume=0.22", tick);
  const ins = [...audio.map((a) => ({ f: a.f, t: a.t, vol: a.vol })), ...clicks.map((t) => ({ f: tick, t, vol: 1 }))];
  const graph = ins.map((a, i) => `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${a.vol},adelay=${Math.round(a.t * 1000)}:all=1[a${i}]`).join(";")
    + `;${ins.map((_, i) => `[a${i}]`).join("")}amix=inputs=${ins.length}:normalize=0:dropout_transition=0,apad=whole_dur=${total.toFixed(3)},alimiter=limit=0.95[out]`;
  writeFileSync(join(out, "audio.graph"), graph);
  ff(...ins.flatMap((a) => ["-i", a.f]), "-filter_complex_script", join(out, "audio.graph"), "-map", "[out]", "-t", total.toFixed(3), "-ar", "48000", wav);
  const x264 = ["-c:v", "libx264", "-preset", "slow", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"];
  const frames = join(framesDir, "f%05d.jpg");
  ff("-framerate", String(FPS), "-i", frames, "-i", wav, ...x264, "-shortest", join(dest, "reel.mp4"));
  console.log("saved reel.mp4");
  const sp = spans(beats);
  for (const [name, scenes] of CLIPS) {
    const a = sp.get(scenes[0])[0], b = sp.get(scenes.at(-1))[1], d = (b - a).toFixed(3);
    // Cut from the frames, not the MP4, so nothing is compressed twice.
    const input = ["-framerate", String(FPS), "-start_number", String(Math.round(a * FPS)), "-t", d, "-i", frames];
    ff(...input, "-ss", a.toFixed(3), "-t", d, "-i", wav, ...x264, "-shortest", join(dest, `clip-${name}.mp4`));
    ff(...input, "-vf", "fps=8,scale=960:-2:flags=lanczos", "-c:v", "libwebp_anim", "-lossless", "0", "-q:v", "45", "-compression_level", "4", "-loop", "0", "-an", join(dest, `clip-${name}.webp`));
    console.log(`saved clip-${name} (${d} s)`);
  }
}

mkdirSync(out, { recursive: true });
if (want("shoot")) await shoot();
if (want("render")) await render();
if (want("encode")) encode();
process.exit(0);
