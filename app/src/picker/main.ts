// The picker: frozen screen, drag a region / click a window / F for the whole screen, loupe with coordinates and
// colour, then the action bar. Plain canvas + DOM so it opens instantly.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "../native.css";
import "./picker.css";
import { os } from "../bridge";
import { icon, type Icon } from "../ui/icons";

type Win = { id: number; title: string; app: string; x: number; y: number; width: number; height: number };
type Info = { frame: number; x: number; y: number; width: number; height: number; mode: "Pick" | "Screen" | "Record"; windows: Win[]; last_rect: [number, number, number, number] | null; os: string };
type R = { x: number; y: number; w: number; h: number };
type Preset = { name: string; ratio: number | null; size?: [number, number] };

const PRESETS: Preset[] = [
  { name: "Free", ratio: null },
  { name: "1:1", ratio: 1 }, { name: "4:3", ratio: 4 / 3 }, { name: "16:9", ratio: 16 / 9 }, { name: "9:16", ratio: 9 / 16 },
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
let img!: ImageBitmap;
const px = document.createElement("canvas"); // frame at 1:1 for the loupe and colour reads
const pctx = px.getContext("2d", { willReadFrequently: true })!;
let mouse = { x: -1, y: -1 };
let sel: R | null = null;
let hoverWin: Win | null = null;
let picked: number[] = []; // multi-window
let drag: { kind: "new" | "move" | "edge"; x0: number; y0: number; start: R; edge?: string; moved: boolean } | null = null;
let preset: Preset = PRESETS[0];
let measuring = false;
/** Earlier areas of a multi-area capture (up to 3, plus the current one), combined with `layout`. */
let kept: R[] = [];
let layout = "row";
let loupeFlip = { left: false, up: false };

const local = (w: Win): R => ({ x: (w.x - info.x) / k, y: (w.y - info.y) / k, w: w.width / k, h: w.height / k });
const clampR = (r: R): R => {
  const x = Math.max(0, r.x), y = Math.max(0, r.y);
  return { x, y, w: Math.min(innerWidth, r.x + r.w) - x, h: Math.min(innerHeight, r.y + r.h) - y };
};
const norm = (r: R): R => ({ x: Math.min(r.x, r.x + r.w), y: Math.min(r.y, r.y + r.h), w: Math.abs(r.w), h: Math.abs(r.h) });
const phys = (r: R) => ({ x: Math.round(info.x + r.x * k), y: Math.round(info.y + r.y * k), width: Math.max(1, Math.round(r.w * k)), height: Math.max(1, Math.round(r.h * k)) });

function winAt(x: number, y: number) {
  const gx = info.x + x * k, gy = info.y + y * k;
  return info.windows.find((w) => gx >= w.x && gy >= w.y && gx < w.x + w.width && gy < w.y + w.height) ?? null;
}

async function start() {
  info = (await invoke<Info>("picker_info", { frame: frameIdx }))!;
  if (!info) return;
  k = info.width / innerWidth;
  const buf = await (await fetch(convertFileSrc(`frame/${frameIdx}`, "grabbit"))).arrayBuffer();
  const data = new ImageData(new Uint8ClampedArray(buf), info.width, info.height);
  img = await createImageBitmap(data);
  px.width = info.width; px.height = info.height;
  pctx.putImageData(data, 0, 0);
  resize();
  if (info.mode === "Record") hint.innerHTML = `Drag the area to record, click a window, or press <kbd>F</kbd> for the whole screen`;
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
  const dpr = devicePixelRatio;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
  const d = pctx.getImageData(Math.min(px.width - 1, Math.max(0, Math.floor(x * k))), Math.min(px.height - 1, Math.max(0, Math.floor(y * k))), 1, 1).data;
  return "#" + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
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
  lctx.drawImage(px, cx - (N >> 1), cy - (N >> 1), N, N, 0, 0, loupe.width, loupe.height);
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

type Item = { id: string; label: string; icon: Icon; key?: string; primary?: boolean };
const MAIN: Item[] = [
  { id: "copy", label: "Copy", icon: "copy", key: "Enter", primary: true },
  { id: "reduced", label: "Smaller", icon: "smaller" },
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "edit", label: "Edit", icon: "edit", key: "E" },
  { id: "save", label: "Save", icon: "save", key: `${MOD}S` },
  { id: "record", label: "Record", icon: "record", key: "R" },
  { id: "add", label: "Add area", icon: "plus", key: "N" },
  { id: "voice", label: "Talk to AI", icon: "mic", key: "V" },
];
const MORE: Item[] = [
  { id: "describe", label: "Describe with AI", icon: "sparkles", key: "X" },
  { id: "batch", label: "Start an AI batch (talk through several)", icon: "mic", key: "B" },
  { id: "scroll", label: "Scrolling capture", icon: "scroll", key: "S" },
  { id: "ocr", label: "Copy text", icon: "text", key: "T" },
  { id: "qr", label: "Read QR code", icon: "qr", key: "Q" },
  { id: "pin", label: "Pin to screen", icon: "pin", key: "I" },
  { id: "share", label: "Share…", icon: "share" },
  { id: "path", label: "Copy file path", icon: "link", key: "P" },
  { id: "delay3", label: "Capture again in 3 s", icon: "timer" },
  { id: "delay10", label: "Capture again in 10 s", icon: "timer", key: "D" },
];
const REC: Item[] = [{ id: "record", label: "Record", icon: "record", key: "Enter", primary: true }];

function button(it: Item) {
  const b = document.createElement("button");
  b.className = "btn" + (it.primary ? " primary" : "");
  b.innerHTML = `${icon(it.icon)}<span>${it.label}</span>`;
  b.title = it.key ? `${it.label} (${it.key})` : it.label;
  b.onclick = (e) => { e.stopPropagation(); act(it.id); };
  return b;
}

async function showBar() {
  bar.innerHTML = "";
  const rec = info.mode === "Record";
  for (const it of rec ? REC : MAIN) if (it.id !== "add" || kept.length < 3) bar.append(button(it));
  if (rec) {
    const s = await invoke<{ record_microphone: boolean; record_system_audio: boolean }>("get_settings");
    for (const [key, ic, label] of [["record_system_audio", "sound", "System sound"], ["record_microphone", "mic", "Microphone"]] as const) {
      const t = document.createElement("button");
      t.className = "btn toggle" + (s[key] ? " on" : "");
      t.innerHTML = icon(ic);
      t.title = `${label}: ${s[key] ? "on" : "off"}`;
      t.onclick = async (e) => {
        e.stopPropagation();
        const all = await invoke<Record<string, unknown>>("get_settings");
        all[key] = !all[key];
        await invoke("set_settings", { settings: all });
        t.classList.toggle("on", !!all[key]);
        t.title = `${label}: ${all[key] ? "on" : "off"}`;
      };
      bar.append(t);
    }
  }
  if (kept.length) {
    const lay = document.createElement("select");
    lay.className = "btn";
    lay.title = "How the areas are combined";
    for (const [v, t] of [["row", "Side by side"], ["column", "Stacked"], ["grid", "Grid"], ["screen", "As on screen"]]) lay.add(new Option(t, v, false, v === layout));
    lay.onchange = () => { layout = lay.value; };
    lay.onpointerdown = (e) => e.stopPropagation();
    bar.append(lay);
  }
  const aspect = document.createElement("select");
  aspect.className = "btn";
  aspect.title = "Size preset (A)";
  for (const [i, p] of PRESETS.entries()) aspect.add(new Option(p.name, String(i), false, p === preset));
  aspect.onchange = () => { preset = PRESETS[Number(aspect.value)]; if (sel) { sel = fitRatio(sel, "se"); draw(); placeBar(); } };
  aspect.onpointerdown = (e) => e.stopPropagation();
  bar.append(aspect);
  if (!rec) {
    const more = document.createElement("button");
    more.className = "btn";
    more.innerHTML = `${icon("more")}<span>More</span>`;
    const menu = document.createElement("div");
    menu.className = "menu";
    menu.hidden = true;
    for (const it of MORE) {
      const m = document.createElement("button");
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

function placeBar() {
  if (!sel || bar.hidden) return;
  const r = bar.getBoundingClientRect();
  let x = Math.min(innerWidth - r.width - 8, Math.max(8, sel.x + sel.w - r.width));
  let y = sel.y + sel.h + 10;
  if (y + r.height > innerHeight - 8) y = sel.y - r.height - 10;
  if (y < 8) { y = sel.y + sel.h - r.height - 10; x = Math.min(innerWidth - r.width - 8, Math.max(8, sel.x + sel.w - r.width - 10)); }
  bar.style.left = `${x}px`; bar.style.top = `${y}px`;
  const menu = bar.querySelector(".menu") as HTMLElement | null;
  if (menu) menu.classList.toggle("up", y + r.height + 280 > innerHeight);
}

async function act(id: string) {
  if (id === "batch") { await invoke("picker_cancel"); await invoke("batch_start"); return; }
  if (id === "add") {
    if (!sel || kept.length >= 3) return;
    kept.push(sel); sel = null; fromWindow = null; bar.hidden = true;
    hint.hidden = false; hint.innerHTML = `${kept.length} area${kept.length > 1 ? "s" : ""} kept · drag area ${kept.length + 1}, then Copy or Edit combines them · <kbd>Esc</kbd> drops the last`;
    draw();
    return;
  }
  if (id.startsWith("delay")) { await invoke("picker_delay", { secs: Number(id.slice(5)) }); return; }
  const target: R | null = sel ?? (hoverWin ? clampR(local(hoverWin)) : null);
  if (!target && !picked.length) return;
  const ids = sel ? (fromWindow ?? []) : hoverWin ? [hoverWin.id] : [];
  const r = phys(target ?? clampR(local(info.windows.find((w) => w.id === picked[0])!)));
  document.body.classList.add("leaving");
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await invoke("picked", { pick: { action: id, ...r, windows: kept.length ? [] : ids, size: kept.length ? null : preset.size ?? null, extra: kept.map(phys).map((p) => [p.x, p.y, p.width, p.height]), layout } });
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
  if (drag.kind === "new") { bar.hidden = true; if (!(e.ctrlKey || e.metaKey)) { sel = null; picked = []; } }
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
    if (d.kind === "new" && sel) quickAction(e);
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
  if (e.key === "Escape" && !sel && kept.length) { sel = kept.pop()!; void showBar(); draw(); return; }
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
  const target = sel || picked.length || hoverWin;
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
  sel = null; hoverWin = null; picked = []; drag = null; measuring = false; fromWindow = null; preset = PRESETS[0]; kept = []; layout = "row";
  bar.hidden = true; sizeTag.hidden = true; loupeBox.hidden = true;
  hint.hidden = false; hint.innerHTML = HINT;
  document.body.className = "";
}
const HINT = hint.innerHTML;
void listen<number>("open", (e) => {
  reset();
  frameIdx = e.payload;
  start().catch((err) => { document.body.classList.add("ready"); hint.hidden = false; hint.textContent = "Couldn't open the picker: " + err; void invoke("picker_shown"); });
});
void listen("reset", reset);
