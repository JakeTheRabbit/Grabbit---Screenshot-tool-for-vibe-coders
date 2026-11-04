// Every Grabbit screen in light and dark: a picture of each, and checks for text under 11 px, contrast under 3:1,
// text spilling out of or cut off by its box, and anything pushed off the window. Usage: node audit.mjs [only…]
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { demo, extra, open, sleep } from "./lib.mjs";
const out = join(demo, "out", "audit");
mkdirSync(out, { recursive: true });
const want = process.argv.slice(2);
const shotsDir = join(demo, "../screenshots");
const pic = (f) => join(shotsDir, f);
const asset = (f) => `http://studio.local/asset/${encodeURIComponent(f.replaceAll("\\", "/"))}`;
extra.set("grabbit/frame/0", { bytes: readFileSync(join(demo, "out/desktop.rgba")), type: "application/octet-stream" });

const CHECK = `(() => {
  const out = [];
  const rgba = (c) => { const m = c.match(/[\\d.]+/g); if (!m || m.length < 3) return null; const [r, g, b, a = 1] = m.map(Number); return { r, g, b, a }; };
  const L = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.backgroundImage !== "none" && !s.backgroundImage.startsWith("url")) return null; const c = rgba(s.backgroundColor); if (c && c.a > 0.6) return c; } return null; };
  const clipped = (el) => { for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) { const s = getComputedStyle(e); if (s.overflowX !== "visible" || s.overflowY !== "visible") return true; } return false; };
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) continue;
    if (el.closest("svg, canvas, .excalidraw, [aria-hidden=true]")) continue;
    const name = el.tagName.toLowerCase() + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\\s+/)[0] : "") + ' "' + (el.textContent || el.value || "").trim().replace(/\\s+/g, " ").slice(0, 28) + '"';
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) || ((el.tagName === "INPUT" || el.tagName === "SELECT") && !/checkbox|radio|range|color/.test(el.type));
    if (own) {
      const fs = parseFloat(cs.fontSize);
      if (fs > 0 && fs < 11) out.push("tiny " + fs + "px: " + name);
      const fg = rgba(cs.color), bg = bgOf(el);
      if (fg && bg && fg.a > 0.5) { const a = L(fg), b = L(bg), k = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); if (k < 3) out.push("contrast " + k.toFixed(2) + ": " + name); }
      if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && cs.display !== "inline" && cs.textOverflow !== "ellipsis" && cs.overflowX !== "auto" && cs.overflowX !== "scroll")
        out.push((cs.overflowX === "visible" ? "spills " : "cut off ") + el.scrollWidth + ">" + el.clientWidth + ": " + name);
    }
    if ((r.right > innerWidth + 1 || r.left < -1 || r.bottom > innerHeight + 1) && !clipped(el) && cs.position !== "fixed") out.push("off-window " + Math.round(r.left) + ".." + Math.round(r.right) + " x " + Math.round(r.bottom) + ": " + name);
  }
  return [...new Set(out)].slice(0, 30);
})()`;

const loadEditor = `(async () => { const b = await (await fetch(${JSON.stringify(asset(pic("hero.webp")))})).blob();
  const d = await new Promise((ok) => { const f = new FileReader(); f.onload = () => ok(f.result); f.readAsDataURL(b); });
  const recent = ${JSON.stringify(["hero.webp", "editor.webp", "ai.webp", "talk.webp", "tools.webp", "quick.webp"].map((f, i) => ({ path: pic(f), url: asset(pic(f)), name: `Grabbit 2026-11-0${4 - (i % 2)} 1${i}.00.webp`, time: `2026-11-0${4 - (i % 2)}T1${i}:00:00`, kind: "capture", bytes: 120000 + i * 9000 })))};
  window.grabbit.receive({ type: "load", name: "Weekly overview", dataURL: d, width: 1600, height: 900, recent });
  window.grabbit.receive({ type: "addTab", name: "Second capture", dataURL: d, width: 1600, height: 900 }); })()`;
const editorHandlers = `__studio.handlers = { editor_msg: () => null, share_targets: [], get_settings: { metadata: { strip: true, author: "", copyright: "" }, branding: { invisible_mark: false, on_images: false, logo_path: "" }, ai: {} } };`;
const click = (sel) => `document.querySelector(${JSON.stringify(sel)})?.click()`;
const btn = (text, scope = "") => `[...document.querySelectorAll(${JSON.stringify(scope + " button")})].find((b) => (b.textContent.trim() || b.title || b.dataset.tip || "").startsWith(${JSON.stringify(text)}))?.click()`;

const pickerSetup = `__studio.handlers = { picker_info: { frame: 0, x: 0, y: 0, width: 2560, height: 1440, mode: "Pick", last_rect: null, os: "windows", windows: [] }, get_settings: { record_microphone: true, record_system_audio: false } };`;
const settingsSetup = `__studio.handlers = { get_settings: { after_capture: "Ask", auto_save: true, save_folder: "C:/Users/you/Pictures/Grabbit", save_format: "WebpLossless", copy_as_file: true, reduced_long_edge: 1920, chat_max_kb: 300, chat_long_edge: 2560,
  video_folder: "C:/Users/you/Videos/Grabbit", record_microphone: true, record_system_audio: true, hotkeys: { capture: "PrintScreen", record: "Shift+PrintScreen" }, metadata: { strip: true, author: "", copyright: "" },
  branding: { invisible_mark: true, on_images: false, logo_path: "", owner: "" }, ai: { provider: "openai", openai_key: "", openai_base: "", auto_describe: false }, share: {}, index_text: true }, autostart_get: true, history_search: [] };`;

const S = [
  { name: "picker-bar", page: "picker.html", w: 1600, h: 900, dpr: 1.6, setup: pickerSetup, run: async (p) => { await p.ev(`__studio.emit("open", 0)`); await p.waitFor(`document.body.classList.contains("ready")`); await p.drag(200, 200, 900, 600); await sleep(300); } },
  { name: "picker-more", page: "picker.html", w: 1600, h: 900, dpr: 1.6, setup: pickerSetup, run: async (p) => { await p.ev(`__studio.emit("open", 0)`); await p.waitFor(`document.body.classList.contains("ready")`); await p.drag(200, 120, 900, 420); await sleep(200); await p.ev(btn("More", "#bar")); await sleep(200); } },
  { name: "quick", page: `quick.html?t=Copied&p=${encodeURIComponent(pic("hero.webp"))}`, w: 300, h: 230, dpr: 1.5, transparent: true },
  { name: "describe", page: `quick.html?mode=describe&t=${encodeURIComponent("A weekly sales dashboard: revenue $46,238 (up 12.4%), orders 1,785, and a daily revenue chart with a Saturday spike.")}&p=${encodeURIComponent(pic("hero.webp"))}`, w: 420, h: 420, dpr: 1.5, transparent: true },
  { name: "recbar", page: "recbar.html", w: 300, h: 44, dpr: 1.5, transparent: true, setup: `__studio.handlers = { rec_status: { elapsed: 7, paused: false, recording: true } };` },
  { name: "scrollbar", page: "recbar.html?mode=scroll", w: 360, h: 44, dpr: 1.5, transparent: true },
  { name: "batchbar", page: "recbar.html?mode=batch", w: 420, h: 44, dpr: 1.5, transparent: true, setup: `__studio.handlers = { batch_items: [{}, {}] };` },
  { name: "hint", page: "hint.html", w: 240, h: 56, dpr: 1.5, transparent: true },
  { name: "talk", page: `voice.html?p=${encodeURIComponent(pic("hero.webp"))}&mic=${encodeURIComponent("Microphone (Sennheiser Profile)")}`, w: 980, h: 720, dpr: 1, setup: `__studio.handlers = { voice_level: 0.2, voice_stop: [], voice_restart: null };` },
  { name: "talk-batch", page: "voice.html?batch=1", w: 1040, h: 760, dpr: 1, setup: `__studio.handlers = { batch_items: ${JSON.stringify([{ path: pic("hero.webp"), title: "Hero", text: "Why is Saturday so high?" }, { path: pic("ai.webp"), title: "AI panel", text: "" }])} };` },
  { name: "editor", page: "index.html", w: 1280, h: 820, dpr: 1, setup: `localStorage.setItem("editor", "markup"); ${editorHandlers}`, run: async (p) => { await p.waitFor(`!!window.grabbit?.receive`); await p.ev(loadEditor); await sleep(1200); } },
  { name: "editor-small", page: "index.html", w: 900, h: 620, dpr: 1, setup: `localStorage.setItem("editor", "markup"); ${editorHandlers}`, run: async (p) => { await p.waitFor(`!!window.grabbit?.receive`); await p.ev(loadEditor); await sleep(1200); } },
  ...["Beautify", "Share", "AI", "Info"].map((panel) => ({ name: `editor-${panel.toLowerCase()}`, page: "index.html", w: 1280, h: 820, dpr: 1, setup: `localStorage.setItem("editor", "markup"); ${editorHandlers}`,
    run: async (p) => { await p.waitFor(`!!window.grabbit?.receive`); await p.ev(loadEditor); await sleep(1000); await p.ev(btn(panel, "header.bar")); await sleep(500); } })),
  { name: "editor-stickers", page: "index.html", w: 1280, h: 820, dpr: 1, setup: `localStorage.setItem("editor", "markup"); ${editorHandlers}`, run: async (p) => { await p.waitFor(`!!window.grabbit?.receive`); await p.ev(loadEditor); await sleep(1000); await p.ev(btn("Stickers", "header.bar")); await sleep(300); } },
  { name: "editor-menu", page: "index.html", w: 1280, h: 820, dpr: 1, setup: `localStorage.setItem("editor", "markup"); ${editorHandlers}`, run: async (p) => { await p.waitFor(`!!window.grabbit?.receive`); await p.ev(loadEditor); await sleep(1000); await p.ev(click('header.bar [title="Move the toolbar"], header.bar [data-tip="Move the toolbar"]')); await sleep(300); } },
  { name: "editor-empty", page: "index.html", w: 1280, h: 820, dpr: 1, setup: `localStorage.setItem("editor", "markup"); ${editorHandlers}`, run: async () => { await sleep(1200); } },
  { name: "classic", page: "index.html#classic", w: 1280, h: 820, dpr: 1, setup: editorHandlers, run: async (p) => { await p.waitFor(`!!window.grabbit?.receive`, 20000).catch(() => {}); await sleep(800); await p.ev(loadEditor).catch(() => {}); await sleep(2500); } },
  { name: "video", page: "video.html", w: 1280, h: 800, dpr: 1, setup: `__studio.handlers = { editor_msg: () => null };`,
    run: async (p) => { await sleep(500); await p.ev(`__studio.emit("host", { type: "load", name: "Fernhill weekly walkthrough", path: "x.mp4", url: "/node_modules/.studio/walkthrough.mp4", duration: 12, fps: 30, width: 1600, height: 900, hasAudio: true, bytes: 1830000, hasSystem: true, hasMic: true, cursor: { moves: [], keys: [] } })`); await sleep(1500); } },
  ...["General", "Keys", "Recording", "Branding", "Metadata", "Sharing", "AI", "Obsidian", "History"].map((sec) => ({ name: `settings-${sec.toLowerCase()}`, page: `settings.html#${sec}`, w: 820, h: 620, dpr: 1, setup: settingsSetup, run: async () => { await sleep(700); } })),
];

let total = 0;
for (const s of S) {
  if (want.length && !want.some((w) => s.name.startsWith(w))) continue;
  for (const theme of ["light", "dark"]) {
    const p = await open(s.page, { width: s.w, height: s.h, dpr: s.dpr, transparent: s.transparent, setup: `localStorage.setItem("theme", "${theme}"); ${s.setup ?? ""}` });
    await sleep(500);
    try { await s.run?.(p); } catch (e) { console.log(`  ${s.name}: setup failed: ${e.message.split("\n")[0]}`); }
    await p.ev(`document.querySelectorAll("*").forEach((e) => (e.style.animation = "none"))`);
    await p.mouse("mouseMoved", 2, 2);
    const issues = JSON.parse(await p.ev(`JSON.stringify(${CHECK})`));
    const errs = p.errors.filter((e) => !/favicon|studio: 404/.test(e));
    await p.shot(join(out, `${s.name}-${theme}.png`));
    console.log(`${issues.length || errs.length ? "!!" : "ok"} ${s.name} (${theme})${issues.map((i) => "\n     " + i).join("")}${errs.map((e) => "\n     ERROR " + e.split("\n")[0]).join("")}`);
    total += issues.length + errs.length;
    await p.close();
  }
}
console.log(total ? `${total} issues` : "NO ISSUES");
process.exit(0);
