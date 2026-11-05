// The picker: frozen screen, drag a region / click a window / F for the whole screen, loupe with coordinates and
// colour, then the action bar. Plain canvas + DOM so it opens instantly.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import "../ui/base";
import "./picker.css";
import { os } from "../bridge";
import { icon, type Icon } from "../ui/icons";

type Win = { id: number; title: string; app: string; x: number; y: number; width: number; height: number };
type Info = { frame: number; x: number; y: number; width: number; height: number; mode: "Pick" | "Screen" | "Record"; windows: Win[]; last_rect: [number, number, number, number] | null; os: string };
type R = { x: number; y: number; w: number; h: number };
type Preset = { name: string; ratio: number | null; size?: [number, number] };

const PRESETS: Preset[] = [
  { name: "Any size", ratio: null },
  { name: "Square 1:1", ratio: 1 }, { name: "4:3", ratio: 4 / 3 }, { name: "Widescreen 16:9", ratio: 16 / 9 }, { name: "Tall 9:16", ratio: 9 / 16 },
  { name: "Instagram post · 1080×1080", ratio: 1, size: [1080, 1080] },
  { name: "Instagram portrait · 1080×1350", ratio: 4 / 5, size: [1080, 1350] },
  { name: "Story / Reel / TikTok / Snapchat · 1080×1920", ratio: 9 / 16, size: [1080, 1920] },
  { name: "YouTube thumbnail · 1280×720", ratio: 16 / 9, size: [1280, 720] },
  { name: "Facebook post · 1200×630", ratio: 1200 / 630, size: [1200, 630] },
  { name: "X / Twitter · 1600×900", ratio: 16 / 9, size: [1600, 900] },
  { name: "LinkedIn · 1200×627", ratio: 1200 / 627, size: [1200, 627] },
  { name: "Pinterest · 1000×1500", ratio: 2 / 3, size: [1000, 1500] },
];

const MOD = os === "macos" ? "⌘" : "Ctrl+";
let frameIdx = 0;
const canvas = document.getElementById("c") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const loupe = document.getElementById("loupe") as HTMLCanvasElement;
const lctx = loupe.getContext("2d")!;
const loupeText = document.getElementById("loupe-text")!;
const loupeBox = document.getElementById("loupe-box")!;
const bar = document.getElementById("bar")!;
const sizeTag = document.getElementById("size")!;
const hint = document.getElementById("hint")!;

let info!: Info;
let k = 1; // physical pixels per CSS pixel
let img: ImageBitmap | null = null;
let raw: Uint8ClampedArray<ArrayBuffer> | null = null; // the frame's RGBA pixels, for colour reads
let shared: ArrayBuffer | null = null; // Windows: the frame arrives in shared memory, released when the picker closes
const webview = (window as any).chrome?.webview;
let mouse = { x: -1, y: -1 };
let sel: R | null = null;
let hoverWin: Win | null = null;
let picked: number[] = []; // multi-window
let drag: { kind: "new" | "move" | "edge"; x0: number; y0: number; start: R; edge?: string; moved: boolean } | null = null;
let preset: Preset = PRESETS[0];
let measuring = false;
/** Earlier areas of a multi-area capture, in physical pixels so they can be on any screen. Every screen's picker holds
 *  the same list (the "picker-kept" event); the current selection is the last area. */
let keptP: [number, number, number, number][] = [];
let layout = "separate";
const MAX_AREAS = 8;
let loupeFlip = { left: false, up: false };

const local = (w: Win): R => ({ x: (w.x - info.x) / k, y: (w.y - info.y) / k, w: w.width / k, h: w.height / k });
const clampR = (r: R): R => {
  const x = Math.max(0, r.x), y = Math.max(0, r.y);
  return { x, y, w: Math.min(innerWidth, r.x + r.w) - x, h: Math.min(innerHeight, r.y + r.h) - y };
};
const norm = (r: R): R => ({ x: Math.min(r.x, r.x + r.w), y: Math.min(r.y, r.y + r.h), w: Math.abs(r.w), h: Math.abs(r.h) });
const phys = (r: R) => ({ x: Math.round(info.x + r.x * k), y: Math.round(info.y + r.y * k), width: Math.max(1, Math.round(r.w * k)), height: Math.max(1, Math.round(r.h * k)) });
const physArr = (r: R): [number, number, number, number] => { const p = phys(r); return [p.x, p.y, p.width, p.height]; };
const toLocal = ([x, y, w, h]: number[]): R => ({ x: (x - info.x) / k, y: (y - info.y) / k, w: w / k, h: h / k });

function winAt(x: number, y: number) {
  const gx = info.x + x * k, gy = info.y + y * k;
  return info.windows.find((w) => gx >= w.x && gy >= w.y && gx < w.x + w.width && gy < w.y + w.height) ?? null;
}

/** `given`: the frame and its details already here (Windows posts them in shared memory); otherwise they're fetched. */
async function start(given?: { info: Info; buf: ArrayBuffer }) {
  info = given?.info ?? (await invoke<Info>("picker_info", { frame: frameIdx }))!;
  if (!info) return;
  k = info.width / innerWidth;
  const buf = given?.buf ?? await (await fetch(convertFileSrc(`frame/${frameIdx}`, "grabbit"))).arrayBuffer();
  raw = new Uint8ClampedArray(buf);
  img = await createImageBitmap(new ImageData(raw, info.width, info.height));
  resize();
  if (info.mode === "Record") hint.innerHTML = REC_HINT;
  document.body.classList.add("ready");
  requestAnimationFrame(() => void invoke("picker_shown"));
}

function resize() {
  const dpr = devicePixelRatio;
  canvas.width = Math.round(innerWidth * dpr); canvas.height = Math.round(innerHeight * dpr);
  draw();
}
addEventListener("resize", resize);

function draw() {
  if (!img) return;
  const dpr = devicePixelRatio;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const kept = keptP.map(toLocal);
  const regions: R[] = kept.length ? [...kept, ...(sel ? [sel] : [])] : picked.length ? picked.map((id) => clampR(local(info.windows.find((w) => w.id === id)!))) : sel ? [sel] : hoverWin && !drag ? [clampR(local(hoverWin))] : [];
  // Dim everything outside the highlighted regions.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, innerWidth, innerHeight);
  for (const r of regions) ctx.rect(r.x + r.w, r.y, -r.w, r.h);
  ctx.fillStyle = "rgba(0,0,0,0.42)";
  ctx.fill("evenodd");
  ctx.restore();
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#0a64d8";
  for (const r of regions) {
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(Math.round(r.x) - 1, Math.round(r.y) - 1, Math.round(r.w) + 2, Math.round(r.h) + 2);
  }
  // Number the areas of a multi-area capture.
  if (kept.length) [...kept, ...(sel ? [sel] : [])].forEach((r, i) => {
    ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(r.x + 16, r.y + 16, 13, 0, 7); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font = "600 14px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(String(i + 1), r.x + 16, r.y + 17);
  });
  if (sel && !drag && !picked.length) for (const [hx, hy] of handles(sel)) { ctx.fillStyle = "#fff"; ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(hx, hy, 4.5, 0, 7); ctx.fill(); ctx.stroke(); }
  if (measuring && drag?.moved && sel) {
    ctx.strokeStyle = "#ff3b30"; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(drag.x0, drag.y0); ctx.lineTo(mouse.x, mouse.y); ctx.stroke(); ctx.setLineDash([]);
  }
  const shown = regions[0];
  if (shown && shown.w > 0) {
    const p = phys(shown);
    const dist = measuring && drag ? ` · ${Math.round(Math.hypot((mouse.x - drag.x0) * k, (mouse.y - drag.y0) * k))} px` : "";
    sizeTag.textContent = `${p.width} × ${p.height}${dist}${picked.length > 1 ? ` · ${picked.length} windows` : ""}`;
    sizeTag.style.left = `${shown.x}px`;
    sizeTag.style.top = `${shown.y > 28 ? shown.y - 26 : shown.y + 6}px`;
    sizeTag.hidden = false;
  } else sizeTag.hidden = true;
  drawLoupe();
}

function handles(r: R): [number, number, string][] {
  const { x, y, w, h } = r;
  return [[x, y, "nw"], [x + w / 2, y, "n"], [x + w, y, "ne"], [x + w, y + h / 2, "e"], [x + w, y + h, "se"], [x + w / 2, y + h, "s"], [x, y + h, "sw"], [x, y + h / 2, "w"]];
}

function hex(x: number, y: number) {
  if (!raw) return "#000000";
  const i = (Math.min(info.height - 1, Math.max(0, Math.floor(y * k))) * info.width + Math.min(info.width - 1, Math.max(0, Math.floor(x * k)))) * 4;
  return "#" + [raw[i], raw[i + 1], raw[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function drawLoupe() {
  const show = mouse.x >= 0 && (!sel || drag) && bar.hidden;
  loupeBox.hidden = !show;
  if (!show) return;
  const N = 17, CELL = 8, S = N * CELL;
  const dpr = devicePixelRatio;
  loupe.width = S * dpr; loupe.height = S * dpr;
  lctx.imageSmoothingEnabled = false;
  const cx = Math.floor(mouse.x * k), cy = Math.floor(mouse.y * k);
  lctx.fillStyle = "#000"; lctx.fillRect(0, 0, loupe.width, loupe.height);
  if (img) lctx.drawImage(img, cx - (N >> 1), cy - (N >> 1), N, N, 0, 0, loupe.width, loupe.height);
  lctx.strokeStyle = "rgba(255,255,255,0.9)"; lctx.lineWidth = dpr;
  const c0 = (N >> 1) * CELL * dpr;
  lctx.strokeRect(c0 + 0.5, c0 + 0.5, CELL * dpr - 1, CELL * dpr - 1);
  const p = phys({ x: mouse.x, y: mouse.y, w: 0, h: 0 });
  loupeText.innerHTML = `<b>${p.x - info.x}, ${p.y - info.y}</b> <span class="swatch" style="background:${hex(mouse.x, mouse.y)}"></span>${hex(mouse.x, mouse.y)}<br><span>${measuring ? "Drag to measure" : "<kbd>C</kbd> copy colour"}</span>`;
  // Sticky flips: only change side once the loupe would actually go off-screen, so it doesn't jump around.
  const W = S + 16, H = S + 60, off = 22;
  if (!loupeFlip.left && mouse.x + off + W > innerWidth) loupeFlip.left = true;
  else if (loupeFlip.left && mouse.x - off - W < 0) loupeFlip.left = false;
  if (!loupeFlip.up && mouse.y + off + H > innerHeight) loupeFlip.up = true;
  else if (loupeFlip.up && mouse.y - off - H < 0) loupeFlip.up = false;
  loupeBox.style.left = `${Math.round(loupeFlip.left ? mouse.x - off - W : mouse.x + off)}px`;
  loupeBox.style.top = `${Math.round(loupeFlip.up ? mouse.y - off - H : mouse.y + off)}px`;
}

// ---- action bar ----

type Item = { id: string; label: string; icon: Icon; key?: string; primary?: boolean; tip: string };
const MAIN: Item[] = [
  { id: "copy", label: "Copy", icon: "copy", key: "Enter", primary: true, tip: "Copy the picture to the clipboard at full size, ready to paste anywhere." },
  { id: "reduced", label: "Copy smaller", icon: "smaller", key: "Shift+Enter", tip: "Copy it scaled down (longest side 1920 px by default): lighter for emails and documents." },
  { id: "chat", label: "Copy for chat", icon: "chat", tip: "Copy a small JPEG that uploads fast in Slack, Teams, WhatsApp and the like." },
  { id: "edit", label: "Mark up", icon: "edit", key: "E", tip: "Open it in the editor: arrows, boxes, text, numbered steps, blur, crop." },
  { id: "save", label: "Save as…", icon: "save", key: `${MOD}S`, tip: "Choose where to save it, and as PNG, WebP or JPEG." },
  { id: "record", label: "Record video", icon: "record", key: "R", tip: "Record this area of the screen as a video." },
  { id: "add", label: "Add another area", icon: "plus", key: "N", tip: "Keep this area and drag another one, on any screen (Ctrl+drag does the same). Then Copy or Mark up takes them all." },
  { id: "voice", label: "Talk to AI", icon: "mic", key: "V", tip: "Say what you want done with this picture. Your words are typed out for you, then picture + words paste into ChatGPT, Claude or Gemini in one go." },
];
const MORE: Item[] = [
  { id: "describe", label: "Describe with AI", icon: "sparkles", key: "X", tip: "Have AI write what's in the picture, and copy that text." },
  { id: "batch", label: "Start an AI batch (talk through several)", icon: "mic", key: "B", tip: "Take several screenshots and talk about each one; they all paste into an AI chat together." },
  { id: "scroll", label: "Scrolling capture", icon: "scroll", key: "S", tip: "Capture a page longer than the screen by scrolling it." },
  { id: "ocr", label: "Copy the text in it", icon: "text", key: "T", tip: "Read the words in the picture and copy them as text." },
  { id: "qr", label: "Read QR code", icon: "qr", key: "Q", tip: "Read a QR code or barcode in the area and copy what it says." },
  { id: "pin", label: "Pin on top of everything", icon: "pin", key: "I", tip: "Float the picture above all windows, to compare or copy from." },
  { id: "share", label: "Share as a link…", icon: "share", tip: "Upload it and copy a link to it." },
  { id: "path", label: "Save and copy the file path", icon: "link", key: "P", tip: "Save it to your Grabbit folder and copy where it was saved." },
  { id: "delay3", label: "Capture again in 3 s", icon: "timer", tip: "Close this, wait 3 seconds (open a menu meanwhile), then capture again." },
  { id: "delay10", label: "Capture again in 10 s", icon: "timer", key: "D", tip: "Close this, wait 10 seconds, then capture again." },
];
const REC: Item[] = [{ id: "record", label: "Record", icon: "record", key: "Enter", primary: true, tip: "Start recording this area." }];

function button(it: Item) {
  const b = document.createElement("button");
  b.className = "btn" + (it.primary ? " primary" : "");
  b.innerHTML = `${icon(it.icon)}<span>${it.label}</span>`;
  b.title = it.key ? `${it.tip}\nShortcut: ${it.key}` : it.tip;
  b.onclick = (e) => { e.stopPropagation(); act(it.id); };
  return b;
}

async function showBar() {
  bar.innerHTML = "";
  const rec = info.mode === "Record";
  for (const it of rec ? REC : MAIN) if (it.id !== "add" || keptP.length < MAX_AREAS - 1) bar.append(button(it));
  if (rec) {
    const s = await invoke<{ record_microphone: boolean; record_system_audio: boolean }>("get_settings");
    for (const [key, ic, label] of [["record_system_audio", "sound", "System sound"], ["record_microphone", "mic", "Microphone"]] as const) {
      const t = document.createElement("button");
      t.className = "btn toggle" + (s[key] ? " on" : "");
      t.innerHTML = icon(ic);
      const tip = (on: unknown) => `${label} is ${on ? "ON" : "OFF"} for the recording. Click to turn it ${on ? "off" : "on"}.`;
      t.title = tip(s[key]);
      t.onclick = async (e) => {
        e.stopPropagation();
        const all = await invoke<Record<string, unknown>>("get_settings");
        all[key] = !all[key];
        await invoke("set_settings", { settings: all });
        t.classList.toggle("on", !!all[key]);
        t.title = tip(all[key]);
      };
      bar.append(t);
    }
  }
  if (keptP.length) {
    const lay = document.createElement("select");
    lay.className = "btn";
    lay.title = `What to do with the ${keptP.length + 1} areas: keep them as separate pictures (Mark up opens each in its own tab, Copy puts them all on the clipboard as files), or join them into one picture.`;
    for (const [v, t] of [["separate", "Separate pictures"], ["row", "Join side by side"], ["column", "Join stacked"], ["grid", "Join in a grid"], ["screen", "Join as on screen"]]) lay.add(new Option(t, v, false, v === layout));
    lay.onchange = () => { layout = lay.value; };
    lay.onpointerdown = (e) => e.stopPropagation();
    bar.append(lay);
  }
  const aspect = document.createElement("select");
  aspect.className = "btn";
  aspect.title = "Shape and size: lock the area to a shape, or to the exact size a social network wants (the picture is resized to fit). Shortcut: A";
  for (const [i, p] of PRESETS.entries()) aspect.add(new Option(p.name, String(i), false, p === preset));
  aspect.onchange = () => { preset = PRESETS[Number(aspect.value)]; if (sel) { sel = fitRatio(sel, "se"); draw(); placeBar(); } };
  aspect.onpointerdown = (e) => e.stopPropagation();
  bar.append(aspect);
  if (!rec) {
    const more = document.createElement("button");
    more.className = "btn";
    more.innerHTML = `${icon("more")}<span>More</span>`;
    more.title = "More things to do with this area: copy its text, read a QR code, pin it, share a link, scrolling capture…";
    const menu = document.createElement("div");
    menu.className = "menu";
    menu.hidden = true;
    for (const it of MORE) {
      const m = document.createElement("button");
      m.title = it.tip;
      m.innerHTML = `${icon(it.icon)}<span>${it.label}</span>${it.key ? `<kbd>${it.key}</kbd>` : ""}`;
      m.onclick = (e) => { e.stopPropagation(); act(it.id); };
      menu.append(m);
    }
    more.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
    bar.append(more, menu);
  }
  bar.hidden = false;
  placeBar();
}

/** Bar under (or over) the area with its main button (Copy / Record) right by the pointer, which is where the drag
 *  ended. Too close to the screen's right edge for that, the bar runs leftwards instead (main button last). */
function placeBar() {
  if (!sel || bar.hidden) return;
  bar.classList.remove("rev");
  const r = bar.getBoundingClientRect();
  const main = bar.querySelector(".btn.primary") as HTMLElement | null;
  const off = main ? main.offsetLeft + main.offsetWidth / 2 : 0;   // main button's centre from the bar's left
  const px = Math.min(sel.x + sel.w, Math.max(sel.x, mouse.x));
  let x = px - off;
  if (x + r.width > innerWidth - 8) { bar.classList.add("rev"); x = px - (r.width - off); }
  x = Math.min(innerWidth - r.width - 8, Math.max(8, x));
  // Below the area, or above it when the drag ended at its top; whichever fits, else just inside the bottom.
  const below = sel.y + sel.h + 10, above = sel.y - r.height - 10;
  const fitsBelow = below + r.height <= innerHeight - 8, fitsAbove = above >= 8;
  const nearTop = Math.abs(mouse.y - sel.y) < Math.abs(mouse.y - sel.y - sel.h);
  const y = nearTop ? (fitsAbove ? above : fitsBelow ? below : sel.y + 10) : (fitsBelow ? below : fitsAbove ? above : sel.y + sel.h - r.height - 10);
  bar.style.left = `${x}px`; bar.style.top = `${y}px`;
  const menu = bar.querySelector(".menu") as HTMLElement | null;
  if (menu) menu.classList.toggle("up", y + r.height + 280 > innerHeight);
}

async function act(id: string) {
  if (id === "batch") { await invoke("picker_cancel"); await invoke("batch_start"); return; }
  if (id === "add") {
    if (sel && keptP.length < MAX_AREAS - 1) keepSel();
    return;
  }
  if (id.startsWith("delay")) { await invoke("picker_delay", { secs: Number(id.slice(5)) }); return; }
  // Finishing a multi-area capture with nothing selected: the last kept area is the current one.
  if (!sel && keptP.length) { sel = toLocal(keptP.pop()!); fromWindow = null; }
  const target: R | null = sel ?? (hoverWin ? clampR(local(hoverWin)) : null);
  if (!target && !picked.length) return;
  const ids = sel ? (fromWindow ?? []) : hoverWin ? [hoverWin.id] : [];
  const r = phys(target ?? clampR(local(info.windows.find((w) => w.id === picked[0])!)));
  document.body.classList.add("leaving");
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await invoke("picked", { pick: { action: id, ...r, windows: keptP.length ? [] : ids, size: keptP.length ? null : preset.size ?? null, extra: keptP, layout } });
}

/** The current area joins the kept ones, and every screen's picker hears about it. */
function keepSel() {
  if (!sel) return;
  keptP.push(physArr(sel)); sel = null; fromWindow = null; bar.hidden = true;
  showKeptHint();
  void emit("picker-kept", keptP);
  draw();
}
function showKeptHint() {
  hint.hidden = false;
  hint.innerHTML = `${keptP.length} area${keptP.length > 1 ? "s" : ""} kept · drag area ${keptP.length + 1} on any screen, then Copy or Mark up takes them all · <kbd>Enter</kbd> finishes · <kbd>Esc</kbd> drops the last`;
}

/** Set when the selection came from clicking a window, so the window is captured whole (even if covered). */
let fromWindow: number[] | null = null;

function fitRatio(r: R, edge: string): R {
  if (!preset.ratio) return r;
  const n = norm(r);
  const h = n.w / preset.ratio;
  return { x: n.x, y: edge.includes("n") ? n.y + n.h - h : n.y, w: n.w, h };
}

function select(r: R | null, win: number[] | null = null) {
  sel = r && r.w >= 3 && r.h >= 3 ? r : null;
  fromWindow = win;
  hint.hidden = true;
  if (sel) void showBar(); else bar.hidden = true;
  draw();
}

// ---- mouse ----

/** Input before the new frame is drawn belongs to nothing (the window is still hidden then). */
const live = () => document.body.classList.contains("ready") && !!img;

canvas.addEventListener("pointermove", (e) => {
  if (!live()) return;
  mouse = { x: e.clientX, y: e.clientY };
  if (drag) {
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (drag.kind === "new" && drag.moved) sel = fitRatio({ x: drag.x0, y: drag.y0, w: dx, h: preset.ratio ? Math.sign(dy || 1) * Math.abs(dx) / preset.ratio : dy }, dy < 0 ? "n" : "s");
    if (drag.kind === "move") sel = { ...drag.start, x: Math.min(innerWidth - drag.start.w, Math.max(0, drag.start.x + dx)), y: Math.min(innerHeight - drag.start.h, Math.max(0, drag.start.y + dy)) };
    if (drag.kind === "edge") {
      const s = { ...drag.start }, ed = drag.edge!;
      if (ed.includes("w")) { s.x += dx; s.w -= dx; }
      if (ed.includes("e")) s.w += dx;
      if (ed.includes("n")) { s.y += dy; s.h -= dy; }
      if (ed.includes("s")) s.h += dy;
      sel = fitRatio(norm(s), ed);
    }
    if (sel) sel = norm(sel);
  } else if (!sel) hoverWin = winAt(e.clientX, e.clientY);
  canvas.style.cursor = cursorFor(e.clientX, e.clientY);
  draw();
});

function edgeAt(x: number, y: number) {
  if (!sel) return null;
  const h = handles(sel).find(([hx, hy]) => Math.abs(hx - x) < 9 && Math.abs(hy - y) < 9);
  if (h) return h[2];
  const { x: sx, y: sy, w, h: sh } = sel, m = 5;
  const inX = x > sx - m && x < sx + w + m, inY = y > sy - m && y < sy + sh + m;
  if (inY && Math.abs(x - sx) < m) return "w";
  if (inY && Math.abs(x - sx - w) < m) return "e";
  if (inX && Math.abs(y - sy) < m) return "n";
  if (inX && Math.abs(y - sy - sh) < m) return "s";
  return null;
}
const inside = (x: number, y: number) => !!sel && x > sel.x && y > sel.y && x < sel.x + sel.w && y < sel.y + sel.h;
function cursorFor(x: number, y: number) {
  const ed = edgeAt(x, y);
  if (ed) return ({ n: "ns", s: "ns", e: "ew", w: "ew", nw: "nwse", se: "nwse", ne: "nesw", sw: "nesw" } as Record<string, string>)[ed] + "-resize";
  return inside(x, y) ? "move" : "crosshair";
}

canvas.addEventListener("pointerdown", (e) => {
  if (!live()) return;
  if (e.button === 2) { if (sel) select(null); else void invoke("picker_cancel"); return; }
  if (e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  (bar.querySelector(".menu") as HTMLElement | null)?.setAttribute("hidden", "");
  const ed = edgeAt(e.clientX, e.clientY);
  if (sel && ed) drag = { kind: "edge", x0: e.clientX, y0: e.clientY, start: { ...sel }, edge: ed, moved: false };
  else if (sel && inside(e.clientX, e.clientY)) drag = { kind: "move", x0: e.clientX, y0: e.clientY, start: { ...sel }, moved: false };
  else drag = { kind: "new", x0: e.clientX, y0: e.clientY, start: { x: e.clientX, y: e.clientY, w: 0, h: 0 }, moved: false };
  if (drag.kind === "new") {
    bar.hidden = true;
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+drag adds an area: the one selected now, on this screen or another, is kept.
      if (picked.length) { /* Ctrl+click picks several windows */ }
      else if (sel) { if (keptP.length < MAX_AREAS - 1) keepSel(); }
      else void emit("picker-collect", me.label);
    } else { sel = null; picked = []; void emit("picker-deselect", me.label); }
  }
  draw();
});

canvas.addEventListener("pointerup", (e) => {
  const d = drag;
  drag = null;
  if (!d) return;
  if (measuring) { draw(); return; }
  if (d.kind !== "new" || d.moved) {
    if (d.kind === "new") fromWindow = null;
    select(sel, fromWindow);
    if (d.kind === "new" && sel && !((e.ctrlKey || e.metaKey) && keptP.length)) quickAction(e);
    return;
  }
  // A click: a window (Ctrl/Cmd+click adds windows), or the whole screen when there's no window there.
  const w = winAt(e.clientX, e.clientY);
  if ((e.ctrlKey || e.metaKey) && w) {
    picked = picked.includes(w.id) ? picked.filter((i) => i !== w.id) : [...picked, w.id];
    hint.hidden = false; hint.innerHTML = `${picked.length} window${picked.length === 1 ? "" : "s"} picked · <kbd>Enter</kbd> to copy them together`;
    void showBarFor(picked);
    draw();
    return;
  }
  if (w) { select(clampR(local(w)), [w.id]); quickAction(e); }
  else { select({ x: 0, y: 0, w: innerWidth, h: innerHeight }); quickAction(e); }
});

async function showBarFor(ids: number[]) {
  if (!ids.length) { select(null); return; }
  const ws = ids.map((id) => clampR(local(info.windows.find((w) => w.id === id)!)));
  const x0 = Math.min(...ws.map((r) => r.x)), y0 = Math.min(...ws.map((r) => r.y));
  sel = { x: x0, y: y0, w: Math.max(...ws.map((r) => r.x + r.w)) - x0, h: Math.max(...ws.map((r) => r.y + r.h)) - y0 };
  fromWindow = ids;
  await showBar();
}

/** Holding a modifier as you let go skips the bar: Ctrl/Cmd = editor, Shift = smaller, Alt = chat size. */
function quickAction(e: PointerEvent) {
  if (info.mode === "Record") return;
  if (e.ctrlKey || e.metaKey) void act("edit");
  else if (e.shiftKey) void act("reduced");
  else if (e.altKey) void act("chat");
}

// ---- keys ----

addEventListener("keydown", (e) => {
  if (!live()) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (e.key === "Escape" && !sel && keptP.length) {
    const last = toLocal(keptP.pop()!);
    void emit("picker-kept", keptP);
    if (last.x + last.w > 0 && last.y + last.h > 0 && last.x < innerWidth && last.y < innerHeight) { sel = last; void showBar(); }
    else if (keptP.length) showKeptHint(); else hint.hidden = true;
    draw(); return;
  }
  if (e.key === "Escape") { if (sel || picked.length) { picked = []; select(null); } else void invoke("picker_cancel"); return; }
  if (e.key.startsWith("Arrow") && sel) {
    const s = e.shiftKey ? 10 : 1, r = { ...sel };
    const grow = e.altKey;
    if (e.key === "ArrowLeft") grow ? (r.w -= s) : (r.x -= s);
    if (e.key === "ArrowRight") grow ? (r.w += s) : (r.x += s);
    if (e.key === "ArrowUp") grow ? (r.h -= s) : (r.y -= s);
    if (e.key === "ArrowDown") grow ? (r.h += s) : (r.y += s);
    sel = norm(r); draw(); placeBar(); e.preventDefault(); return;
  }
  if (key === "c" && !mod && mouse.x >= 0) { void invoke("copy_text", { text: hex(mouse.x, mouse.y) }); flash(`Copied ${hex(mouse.x, mouse.y)}`); return; }
  if (key === "m" && !mod) { measuring = !measuring; flash(measuring ? "Measure: drag between two points" : "Measure off"); select(null); return; }
  if (key === "a" && !mod) { preset = PRESETS[(PRESETS.indexOf(preset) + 1) % PRESETS.length]; flash(`Size: ${preset.name}`); if (sel) { sel = fitRatio(sel, "se"); void showBar(); } draw(); return; }
  if (key === "f" && !mod) { select({ x: 0, y: 0, w: innerWidth, h: innerHeight }); return; }
  if (key === "l" && !mod && info.last_rect) {
    const [x, y, w, h] = info.last_rect;
    select({ x: (x - info.x) / k, y: (y - info.y) / k, w: w / k, h: h / k }); return;
  }
  const target = sel || picked.length || hoverWin || keptP.length;
  if (!target) return;
  const map: Record<string, string> = info.mode === "Record" ? { enter: "record", r: "record" } : { enter: "copy", e: "edit", v: "voice", x: "describe", b: "batch", n: "add", r: "record", s: "scroll", t: "ocr", q: "qr", i: "pin", p: "path", d: "delay10" };
  if (mod && key === "s") { e.preventDefault(); void act("save"); return; }
  if (key === "enter" && e.shiftKey && info.mode !== "Record") { void act("reduced"); return; }
  if (!mod && map[key]) { e.preventDefault(); void act(map[key]); }
});

let flashTimer = 0;
function flash(t: string) {
  hint.hidden = false; hint.textContent = t;
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => { hint.hidden = true; }, 1600);
}

canvas.addEventListener("pointerleave", () => { mouse = { x: -1, y: -1 }; draw(); });
addEventListener("contextmenu", (e) => e.preventDefault());
// The window stays loaded between captures; "open" brings a fresh frame, "reset" clears it for next time.
function reset() {
  // A closed picker stays loaded for speed, but lets go of its copies of the screen (a 4K frame is ~33 MB each).
  img?.close(); img = null; raw = null;
  if (shared) { webview?.releaseBuffer(shared); shared = null; }
  canvas.width = canvas.height = 1;
  sel = null; hoverWin = null; picked = []; drag = null; measuring = false; fromWindow = null; preset = PRESETS[0]; keptP = []; layout = "separate";
  bar.hidden = true; sizeTag.hidden = true; loupeBox.hidden = true;
  hint.hidden = false; hint.innerHTML = HINT;
  document.body.className = "";
}
const HINT = hint.innerHTML;
const REC_HINT = `Drag the area to record, click a window, or press <kbd>F</kbd> for the whole screen`;
// The capture key opens the picker as it goes down; held on, a progress pill fills (`hold` 0–1, or -1 when it was let
// go in time), and at the end the picker turns into the recording picker (`picker-mode`).
void listen<number>("hold", (e) => {
  if (!info || sel || keptP.length || info.mode === "Record") return;
  if (e.payload < 0) { hint.innerHTML = info.mode === "Record" ? REC_HINT : HINT; return; }
  hint.hidden = false;
  hint.innerHTML = `<span class="hold"><span class="dot"></span><b>Keep holding to record</b><span class="track"><span class="fill" style="width:${Math.min(100, e.payload * 100)}%"></span></span></span>`;
});
void listen<"Pick" | "Record">("picker-mode", (e) => {
  if (!info) return;
  info.mode = e.payload;
  if (sel) void showBar(); else if (!keptP.length) { hint.hidden = false; hint.innerHTML = e.payload === "Record" ? REC_HINT : HINT; }
});
// This window's events only: a global listen() would hear every monitor's "open" and show the last frame everywhere.
const me = getCurrentWebviewWindow();
function open(frame: number, given?: { info: Info; buf: ArrayBuffer }) {
  reset();
  frameIdx = frame;
  if (given) shared = given.buf;
  start(given).catch((err) => { document.body.classList.add("ready"); hint.hidden = false; hint.textContent = "Couldn't open the picker: " + err; void invoke("picker_shown"); });
}
// Windows are made when a capture starts, so a new one may load after its "open" was sent: once listening, it asks.
void me.listen<number>("open", (e) => open(e.payload)).then(() => invoke<number | null>("picker_pending")).then((f) => { if (f != null) open(f); });
void me.listen("reset", reset);
webview?.addEventListener("sharedbufferreceived", (e: { additionalData: Info; getBuffer(): ArrayBuffer }) => open(e.additionalData.frame, { info: e.additionalData, buf: e.getBuffer() }));
// A multi-area capture can span screens: every picker shares the kept areas, and a new drag on one screen clears the
// selection on the others (Ctrl+drag keeps it instead).
void listen<[number, number, number, number][]>("picker-kept", (e) => { if (!info) return; keptP = e.payload; if (!sel && keptP.length && !drag) showKeptHint(); draw(); });
void listen<string>("picker-collect", (e) => { if (e.payload !== me.label && sel && !picked.length && keptP.length < MAX_AREAS - 1) keepSel(); });
void listen<string>("picker-deselect", (e) => { if (e.payload !== me.label && (sel || picked.length)) { picked = []; select(null); } });
