// "Talk about it": a picture (or a recording) for an AI chat, with your voice note, editable before it goes.
// Click the picture to point at something, drag to box it — the marks are numbered, the numbers go into your words,
// and the AI sees the same numbers on the picture. Copy for AI puts everything on the clipboard for one paste.

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import "../native.css";
import "./voice.css";
import { corsUrl, fileUrl, os, send } from "../bridge";
import { icon } from "../ui/icons";

type Cue = { start: number; end: number; text: string };
type Mark = { n: number; x: number; y: number; w: number; h: number; t: number };   // picture pixels; w = h = 0 for a point
type Word = { text: string; line: number };

const q = new URLSearchParams(location.search);
const picPath = q.get("p") ?? "";
const videoPath = q.get("v");
const title = q.get("t") ?? "";
const win = getCurrentWebviewWindow();
const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
const stage = $<HTMLDivElement>("#stage"), cv = $<HTMLCanvasElement>("#marks"), img = $<HTMLImageElement>("#pic");
const words = $<HTMLTextAreaElement>("#words"), status = $<HTMLDivElement>("#status"), timeEl = $<HTMLSpanElement>("#time");
const done = $<HTMLButtonElement>("#done"), redo = $<HTMLButtonElement>("#redo"), copy = $<HTMLButtonElement>("#copy");
const optPanel = $<HTMLInputElement>("#opt-panel"), optOcr = $<HTMLInputElement>("#opt-ocr"), optVideo = $<HTMLInputElement>("#opt-video");
const MOD = os === "macos" ? "⌘" : "Ctrl";

let marks: Mark[] = [];
let listening = false;
let started = performance.now();
let cues: Cue[] = [];
let videoCues: Cue[] = [];
let frames: { t: number; canvas: HTMLCanvasElement }[] = [];
const ACCENT = "#e5484d";

// ---------- picture + marks ----------

const fit = () => {
  const r = img.getBoundingClientRect(), s = stage.getBoundingClientRect();
  cv.style.left = `${r.left - s.left}px`; cv.style.top = `${r.top - s.top}px`;
  cv.width = Math.round(r.width * devicePixelRatio); cv.height = Math.round(r.height * devicePixelRatio);
  cv.style.width = `${r.width}px`; cv.style.height = `${r.height}px`;
  drawMarks();
};
const k = () => img.naturalWidth / img.getBoundingClientRect().width;   // picture px per CSS px

function drawMarksOn(g: CanvasRenderingContext2D, scale: number) {
  const r = Math.max(13, 15 * scale);
  for (const m of marks) {
    g.lineWidth = Math.max(3, 3 * scale);
    g.strokeStyle = ACCENT;
    if (m.w > 0) g.strokeRect(m.x, m.y, m.w, m.h);
    const cx = m.w > 0 ? m.x : m.x, cy = m.w > 0 ? m.y : m.y;
    g.fillStyle = ACCENT; g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fill();
    g.strokeStyle = "#fff"; g.lineWidth = Math.max(2, 2 * scale); g.stroke();
    g.fillStyle = "#fff"; g.font = `700 ${Math.round(r * 1.1)}px system-ui, sans-serif`; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(String(m.n), cx, cy + 1);
  }
}
function drawMarks() {
  const g = cv.getContext("2d")!;
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cv.width, cv.height);
  const s = cv.width / Math.max(1, img.naturalWidth);
  g.setTransform(s, 0, 0, s, 0, 0);
  drawMarksOn(g, k());   // marks look the same size on screen whatever the picture's size
}

let dragFrom: { x: number; y: number } | null = null;
cv.addEventListener("pointerdown", (e) => { if (e.button === 0) { cv.setPointerCapture(e.pointerId); dragFrom = { x: e.offsetX * k(), y: e.offsetY * k() }; } });
cv.addEventListener("pointerup", (e) => {
  if (!dragFrom) return;
  const x = e.offsetX * k(), y = e.offsetY * k();
  const box = Math.abs(x - dragFrom.x) > 8 && Math.abs(y - dragFrom.y) > 8;
  const m: Mark = { n: marks.length + 1, x: Math.min(x, dragFrom.x), y: Math.min(y, dragFrom.y), w: box ? Math.abs(x - dragFrom.x) : 0, h: box ? Math.abs(y - dragFrom.y) : 0, t: (performance.now() - started) / 1000 };
  if (!box) { m.x = x; m.y = y; }
  dragFrom = null;
  marks.push(m);
  drawMarks();
  // After the words are in, a new mark goes where the text cursor is.
  if (!listening && words.value) insertAtCaret(`[${m.n}] `);
});
cv.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const x = e.offsetX * k(), y = e.offsetY * k();
  const hit = [...marks].reverse().find((m) => (m.w ? x >= m.x - 20 && x <= m.x + m.w && y >= m.y - 20 && y <= m.y + m.h : Math.hypot(m.x - x, m.y - y) < 30 * k()));
  if (!hit) return;
  marks = marks.filter((m) => m !== hit);
  words.value = words.value.replaceAll(`[${hit.n}] `, "").replaceAll(`[${hit.n}]`, "");
  drawMarks();
});
function insertAtCaret(t: string) {
  const a = words.selectionStart ?? words.value.length;
  words.value = words.value.slice(0, a) + t + words.value.slice(words.selectionEnd ?? a);
  words.selectionStart = words.selectionEnd = a + t.length;
  words.focus();
}

// ---------- listening ----------

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
setInterval(() => { if (listening) timeEl.textContent = fmt((performance.now() - started) / 1000); }, 250);

function setListening(on: boolean) {
  listening = on;
  document.body.classList.toggle("listening", on);
  done.hidden = !on;
  redo.hidden = on;
  // Copy stays available: pressing it while talking finishes, transcribes, then copies.
}

/** Words from the timed lines, with each mark's number put in front of what was being said when it was made. */
function compose(cs: Cue[]) {
  if (!cs.length) return "";
  const parts = cs.map((c) => ({ ...c, refs: [] as number[] }));
  const late: number[] = [];
  for (const m of marks) {
    const i = parts.findIndex((p) => m.t < p.end + 0.3);
    if (i >= 0) parts[i].refs.push(m.n); else late.push(m.n);
  }
  let out = parts.map((p) => (p.refs.length ? p.refs.map((n) => `[${n}]`).join(" ") + " " : "") + p.text.trim()).join(" ");
  if (late.length) out += " " + late.map((n) => `[${n}]`).join(" ");
  return out.trim();
}

async function stopAndTranscribe() {
  if (!listening) return;
  setListening(false);
  status.textContent = "Turning your words into text…";
  try {
    cues = await invoke<Cue[]>("voice_stop", { keep: true });
    const text = compose(cues);
    words.value = text ? text + (words.value ? "\n" + words.value : "") : words.value;
    status.textContent = text ? "Check your words, fix anything, then Copy for AI." : "Nothing heard. Type what you want instead, or Talk again.";
  } catch (e) {
    const msg = String(e);
    if (/speech model/.test(msg) && confirm("Turning speech into text runs on this computer with a speech model (148 MB, downloaded once). Download it now?")) {
      status.textContent = "Downloading the speech model…";
      try { await send({ type: "downloadModel" }); status.textContent = "Model ready. Press Talk again and say it once more."; } catch (e2) { status.textContent = String(e2); }
    } else status.textContent = `${msg} — type what you want instead.`;
  }
  words.focus();
}

async function startListening() {
  try { await invoke("voice_restart"); } catch (e) { status.textContent = `Microphone: ${e}. Type what you want instead.`; return; }
  started = performance.now();
  setListening(true);
  status.textContent = "Listening… say what you want. Click the picture to point, drag to box something.";
}

done.onclick = () => void stopAndTranscribe();
redo.onclick = () => void startListening();
$<HTMLButtonElement>("#close").onclick = async () => { if (listening) await invoke("voice_stop", { keep: false }); void win.close(); };

// ---------- video: key frames at the moments something was said ----------

async function videoFrames(dur: number) {
  const times = [...new Set(videoCues.map((c) => Math.round(Math.min(dur - 0.05, c.start + 0.4) * 2) / 2))].filter((t, i, a) => i === 0 || t - a[i - 1] >= 2);
  const pick = (times.length ? times : Array.from({ length: 6 }, (_, i) => ((i + 0.5) * dur) / 6)).slice(0, 8);
  const v = document.createElement("video");
  v.muted = true; v.preload = "auto"; v.crossOrigin = "anonymous"; v.src = corsUrl(videoPath!);
  await new Promise((r) => v.addEventListener("loadeddata", r, { once: true }));
  const out: { t: number; canvas: HTMLCanvasElement }[] = [];
  for (const t of pick) {
    v.currentTime = t;
    await new Promise((r) => v.addEventListener("seeked", r, { once: true }));
    const s = Math.min(1, 1600 / v.videoWidth);
    const c = document.createElement("canvas");
    c.width = Math.round(v.videoWidth * s); c.height = Math.round(v.videoHeight * s);
    c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
    out.push({ t, canvas: c });
  }
  return out;
}

// ---------- output ----------

/** Wrap text into lines that fit `width` at the canvas's current font. */
function wrap(g: CanvasRenderingContext2D, text: string, width: number) {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const w of para.split(/\s+/)) {
      const next = line ? `${line} ${w}` : w;
      if (g.measureText(next).width > width && line) { lines.push(line); line = w; } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

/** The picture (or frame) with marks, and optionally a panel underneath carrying `caption`. */
function panelled(src: CanvasImageSource, w: number, h: number, caption: string, withMarks: boolean) {
  const W = Math.max(w, 900), font = Math.round(Math.max(20, W / 55)), pad = Math.round(font * 1.1);
  const c = document.createElement("canvas");
  const g = c.getContext("2d")!;
  g.font = `500 ${font}px "Segoe UI", -apple-system, system-ui, sans-serif`;
  const lines = caption ? wrap(g, caption, W - pad * 2) : [];
  const ph = caption ? pad * 2 + lines.length * font * 1.4 : 0;
  c.width = W; c.height = h + ph;
  g.fillStyle = "#ffffff"; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(src, Math.round((W - w) / 2), 0, w, h);
  if (withMarks) { g.save(); g.translate(Math.round((W - w) / 2), 0); drawMarksOn(g, Math.max(1, w / 1400)); g.restore(); }
  if (caption) {
    g.fillStyle = "#f4f5f7"; g.fillRect(0, h, W, ph);
    g.fillStyle = "#1b1d22"; g.font = `500 ${font}px "Segoe UI", -apple-system, system-ui, sans-serif`; g.textBaseline = "top";
    lines.forEach((l, i) => g.fillText(l, pad, h + pad + i * font * 1.4));
  }
  return c.toDataURL("image/png");
}

async function screenText() {
  if (!optOcr.checked || videoPath) return "";
  try {
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext("2d")!.drawImage(img, 0, 0);
    const ws = (await send<Word[]>({ type: "ocr", dataURL: c.toDataURL("image/png") })) ?? [];
    const lines: string[] = [];
    let cur = -1;
    for (const w of ws) { if (w.line !== cur) { lines.push(w.text); cur = w.line; } else lines[lines.length - 1] += " " + w.text; }
    const t = lines.join("\n");
    return t.length > 4000 ? t.slice(0, 4000) + "\n…" : t;
  } catch { return ""; }
}

copy.onclick = () => void copyForAi().catch((e) => { status.textContent = `Couldn't copy: ${e}`; copy.disabled = false; });

async function copyForAi() {
  if (listening) await stopAndTranscribe();
  const mine = words.value.trim();
  copy.disabled = true; status.textContent = "Putting it together…";
  const when = new Date().toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  const ctx: string[] = [];
  let images: string[] = [];
  const files: string[] = [];
  if (!videoPath) {
    images = [panelled(img, img.naturalWidth, img.naturalHeight, optPanel.checked && mine ? `What I want: ${mine}` : "", true)];
    ctx.push(`- Screenshot attached: ${img.naturalWidth}×${img.naturalHeight} px${title ? `, of the window "${title}"` : ""}, taken ${when}.`);
    if (marks.length) ctx.push(`- The numbered marks on the picture ([1]${marks.length > 1 ? `–[${marks.length}]` : ""}) show what I'm referring to: ${marks.map((m) => `[${m.n}] ${m.w ? "box" : "point"}`).join(", ")}.`);
    if (optPanel.checked && mine) ctx.push("- My words are also printed under the picture.");
    const ocr = await screenText();
    if (ocr) ctx.push(`- Text visible in the screenshot (read automatically, may have small errors):\n"""\n${ocr}\n"""`);
  } else {
    for (const f of frames) {
      const said = videoCues.filter((c) => c.start <= f.t + 0.5 && c.end >= f.t - 1.5).map((c) => c.text.trim()).join(" ");
      images.push(panelled(f.canvas, f.canvas.width, f.canvas.height, `${fmt(f.t)}${said ? ` — “${said}”` : ""}`, false));
    }
    if (optVideo.checked) files.push(videoPath);
    ctx.push(`- ${frames.length} frames from a ${fmt(Number(q.get("d") ?? 0) || frames.at(-1)?.t || 0)} screen recording are attached in order, each labelled with its time${optVideo.checked ? "; the video file itself is attached too" : ""}.`);
    if (videoCues.length) ctx.push(`- What was said in the recording, with times:\n${videoCues.map((c) => `${fmt(c.start)} ${c.text.trim()}`).join("\n")}`);
  }
  const text = `${mine || "(Have a look at what's attached.)"}\n\n---\nContext from Grabbit:\n${ctx.join("\n")}`;
  try {
    await invoke("copy_for_ai", { images, text, files });
    status.textContent = `Copied. Paste into ChatGPT, Claude or Gemini with ${MOD}+V.`;
    document.body.classList.add("copied");
    setTimeout(() => void win.close(), 1600);
  } catch (e) { status.textContent = `Couldn't copy: ${e}`; copy.disabled = false; }
}

/** Keep this picture and its words in the AI batch, and close (another capture can follow). */
const addBatch = $<HTMLButtonElement>("#addbatch");
addBatch.onclick = async () => {
  if (listening) await stopAndTranscribe();
  addBatch.disabled = true;
  try {
    const path = await send<string>({ type: "exportFile", name: "batch", dataURL: panelled(img, img.naturalWidth, img.naturalHeight, "", true) });
    const n = await invoke<number>("batch_add", { path, text: words.value.trim(), title });
    status.textContent = `Added to the AI batch (${n} so far). Capture the next one, or press Done on the batch bar.`;
    setTimeout(() => void win.close(), 1200);
  } catch (e) { status.textContent = String(e); addBatch.disabled = false; }
};

addEventListener("keydown", (e) => {
  if (e.key === "Escape") { $<HTMLButtonElement>("#close").click(); return; }
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); copy.click(); return; }
  if (e.key === "Enter" && listening) { e.preventDefault(); void stopAndTranscribe(); }
});

// ---------- start ----------

done.innerHTML = `${icon("check")}<span>Done talking</span><kbd>Enter</kbd>`;
addBatch.innerHTML = `${icon("plus")}<span>Add to AI batch</span>`;
addBatch.hidden = !!videoPath;
redo.innerHTML = `${icon("mic")}<span>Talk again</span>`;
copy.innerHTML = `${icon("sparkles")}<span>Copy for AI</span><kbd>${MOD}+Enter</kbd>`;
$<HTMLButtonElement>("#close").innerHTML = icon("close");
optVideo.closest("label")!.toggleAttribute("hidden", !videoPath);
optOcr.closest("label")!.toggleAttribute("hidden", !!videoPath);

// ---------- batch review: every picture with its own words ----------

type Item = { path: string; text: string; title: string };
async function batchReview() {
  document.body.className = "batch";
  const items = await invoke<Item[]>("batch_items");
  document.body.innerHTML = `<main id="list"></main><aside>
    <header><b>AI batch · ${items.length} picture${items.length === 1 ? "" : "s"}</b><button id="bclose" class="btn" title="Close">${icon("close")}</button></header>
    <div id="status">Each picture keeps its own words. Fix anything, then copy them all for one paste.</div>
    <label class="small" for="intro">What you want overall (optional)</label>
    <textarea id="intro" placeholder="e.g. Turn these into a bug report. Suggest fixes for each."></textarea>
    <div class="opts"><label><input type="checkbox" id="b-panel" checked /> Print each picture's words under it</label></div>
    <button id="bcopy" class="btn primary">${icon("sparkles")}<span>Copy all for AI</span></button>
    <button id="bclear" class="btn">Start over</button></aside>`;
  const list = document.getElementById("list")!;
  const rows = items.map((it, i) => {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `<div class="n">${i + 1}</div><img crossorigin="anonymous" src="${corsUrl(it.path)}"><div class="col"><div class="t">${it.title ? it.title.replace(/</g, "&lt;") : `Picture ${i + 1}`}</div><textarea placeholder="What about this one?"></textarea></div><button class="ic rm" title="Leave this one out">${icon("close")}</button>`;
    (row.querySelector("textarea") as HTMLTextAreaElement).value = it.text;
    row.querySelector<HTMLButtonElement>(".rm")!.onclick = () => { row.remove(); };
    list.append(row);
    return { row, it };
  });
  const st = document.getElementById("status")!;
  document.getElementById("bclose")!.onclick = () => void win.close();
  document.getElementById("bclear")!.onclick = async () => { await invoke("batch_clear"); void win.close(); };
  document.getElementById("bcopy")!.onclick = async () => {
    const kept = rows.filter((r) => r.row.isConnected);
    const panel = (document.getElementById("b-panel") as HTMLInputElement).checked;
    st.textContent = "Putting it together…";
    const images: string[] = [];
    const lines: string[] = [];
    for (const [i, { row, it }] of kept.entries()) {
      const text = (row.querySelector("textarea") as HTMLTextAreaElement).value.trim();
      const im = row.querySelector("img") as HTMLImageElement;
      images.push(panelled(im, im.naturalWidth, im.naturalHeight, panel && text ? `Picture ${i + 1}: ${text}` : `Picture ${i + 1}`, false));
      lines.push(`Picture ${i + 1}${it.title ? ` ("${it.title}")` : ""}: ${text || "(no note)"}`);
    }
    const intro = (document.getElementById("intro") as HTMLTextAreaElement).value.trim();
    const text = `${intro ? `${intro}\n\n` : ""}I've attached ${kept.length} pictures, in order. Each one is labelled "Picture N" and has my note about it printed underneath:\n\n${lines.join("\n\n")}`;
    try {
      await invoke("copy_for_ai", { images, text, files: [] });
      await invoke("batch_clear");
      st.textContent = `Copied ${kept.length} pictures with their notes. Paste into ChatGPT, Claude or Gemini with ${MOD}+V.`;
      setTimeout(() => void win.close(), 1800);
    } catch (e) { st.textContent = `Couldn't copy: ${e}`; }
  };
}

if (q.get("batch")) void batchReview();
else if (videoPath) {
  document.body.classList.add("video");
  status.textContent = "Reading what was said in the recording…";
  img.hidden = true; cv.hidden = true;
  const grid = $<HTMLDivElement>("#frames");
  (async () => {
    try { videoCues = (await send<Cue[]>({ type: "captions", path: videoPath })) ?? []; } catch { videoCues = []; }
    const v = document.createElement("video"); v.src = fileUrl(videoPath); v.preload = "metadata";
    await new Promise((r) => v.addEventListener("loadedmetadata", r, { once: true }));
    q.set("d", String(v.duration));
    frames = await videoFrames(v.duration);
    for (const f of frames) { const fig = document.createElement("figure"); f.canvas.style.width = "100%"; fig.append(f.canvas, Object.assign(document.createElement("figcaption"), { textContent: fmt(f.t) })); grid.append(fig); }
    status.textContent = "Listening… add your note, or press Done talking.";
  })();
} else {
  img.crossOrigin = "anonymous";
  img.src = corsUrl(picPath);
  img.onload = () => { fit(); };
  new ResizeObserver(fit).observe(stage);
}
const err = q.get("err");
if (err) { status.textContent = `Microphone: ${err}. Type what you want instead.`; setListening(false); }
else setListening(true);
