// End-to-end: capture → drag an area → Copy / Copy text / Edit / Pin. Start the app with: pwsh spikes/run2.ps1 -Test
// Checks files, windows and the clipboard, never the pictures' contents.
import { execFile, execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const exe = new URL("../app/src-tauri/target/debug/grabbit.exe", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const shots = join(process.env.TEMP, "g2cfg", "shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name} ${extra}`); if (!ok) failed++; };

async function targets() { try { return await (await fetch("http://127.0.0.1:9333/json")).json(); } catch { return []; } }
async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0; const pend = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); pend.get(m.id)?.(m); pend.delete(m.id); });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  return { ws, send, ev };
}
async function waitFor(fn, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(50); } return null; }

/** Open the picker and return a connection to the first monitor's picker once every picker is ready. */
async function openPicker() {
  execFile(exe, ["capture"]);
  const ok = await waitFor(async () => {
    const ps = (await targets()).filter((t) => t.url.includes("picker.html"));
    const cls = await Promise.all(ps.map(async (t) => { const c = await connect(t); const v = await c.ev("document.body.className"); c.ws.close(); return v; }));
    return ps.length && cls.every((c) => c === "ready") ? ps : null;
  });
  if (!ok) return null;
  await sleep(250);
  return connect(ok[0]);
}
async function closeAll() {
  for (const t of (await targets()).filter((t) => t.url.includes("picker.html"))) { const c = await connect(t); await c.ev("window.__TAURI_INTERNALS__.invoke('picker_cancel')"); c.ws.close(); }
  await sleep(300);
}
await closeAll();
async function drag(c, x0, y0, x1, y1) {
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0, y: y0 });
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", clickCount: 1, buttons: 1 });
  for (let i = 1; i <= 10; i++) { await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0 + ((x1 - x0) * i) / 10, y: y0 + ((y1 - y0) * i) / 10, button: "left", buttons: 1 }); await sleep(16); }
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x1, y: y1, button: "left", clickCount: 1 });
}
async function key(c, k) {
  const code = k.length === 1 ? `Key${k.toUpperCase()}` : k;
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, text: k === "Enter" ? "\r" : k.length === 1 ? k : undefined, windowsVirtualKeyCode: k === "Enter" ? 13 : k === "Escape" ? 27 : k.toUpperCase().charCodeAt(0) });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code });
}
// Windows PowerShell (5.1) for the picture: PowerShell 7's Get-Clipboard reads text only.
const clip = (fmt) => execFileSync(fmt === "image" ? "powershell" : "pwsh", ["-NoProfile", "-STA", "-Command", fmt === "image"
  ? "Add-Type -AssemblyName System.Windows.Forms; $i = [Windows.Forms.Clipboard]::GetImage(); if ($i) { \"$($i.Width)x$($i.Height)\" } else { 'none' }"
  : "Get-Clipboard -Raw"], { encoding: "utf8" }).trim();
const newest = () => readdirSync(shots).map((f) => ({ f, t: statSync(join(shots, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];

// 1. Copy
let c = await openPicker();
check("picker opens", !!c);
await drag(c, 200, 300, 700, 600);
check("bar shows after drag", await waitFor(() => c.ev("!document.getElementById('bar').hidden"), 2000));
await sleep(100);
const label = await c.ev("document.getElementById('size').textContent");
const k = await c.ev("devicePixelRatio");
check("size label matches the drag in physical pixels", label === `${Math.round(500 * k)} × ${Math.round(300 * k)}`, `${label} at dpr ${k}`);
const before = newest()?.t ?? 0;
await key(c, "Enter");
c.ws.close();
const saved = await waitFor(() => { const n = newest(); return n && n.t > before ? n : null; }, 5000);
check("saved full-size copy", !!saved && /\.webp$/.test(saved.f), saved?.f);
check("clipboard has the picture", /^\d+x\d+$/.test(clip("image")), clip("image"));
check("quick-access card", await waitFor(async () => (await targets()).some((t) => t.url.includes("quick.html")), 3000));

// 2. Copy text
c = await openPicker();
await drag(c, 150, 150, 1100, 900);
await waitFor(() => c.ev("!document.getElementById('bar').hidden"), 2000);
execFileSync("pwsh", ["-NoProfile", "-Command", "Set-Clipboard -Value 'before-ocr'"]);
await key(c, "t");
c.ws.close();
// The area's contents are unknown, so either outcome counts; the OCR engine itself is covered by ocr::tests.
const ocrDone = await waitFor(async () => {
  const t = clip("text");
  if (t !== "before-ocr") return `copied ${t.length} chars`;
  const log = readFileSync(join(process.env.LOCALAPPDATA, "app.grabbit", "logs", "grabbit.log"), "utf8").trimEnd().split(/\r?\n/).at(-1);
  return log.includes("No text found") ? "no text in that area" : null;
}, 8000);
check("copy text (OCR) finishes", !!ocrDone, ocrDone ?? "");

// 3. Edit
c = await openPicker();
await drag(c, 220, 260, 820, 700);
await waitFor(() => c.ev("!document.getElementById('bar').hidden"), 2000);
await key(c, "e");
c.ws.close();
const ed = await waitFor(async () => (await targets()).find((t) => /tauri\.localhost\/(index\.html)?$/.test(t.url)), 15000);
check("editor window opens", !!ed);
if (ed) {
  const e = await connect(ed);
  const loaded = await waitFor(() => e.ev("!!document.querySelector('.excalidraw') && (window.grabbit?.api?.getSceneElements?.().length ?? 0) > 0"), 10000);
  check("editor loaded the capture", !!loaded);
  await e.ev("window.close()");
  e.ws.close();
}

// 4. Pin
c = await openPicker();
await drag(c, 300, 300, 600, 500);
await waitFor(() => c.ev("!document.getElementById('bar').hidden"), 2000);
await key(c, "i");
c.ws.close();
const pin = await waitFor(async () => (await targets()).find((t) => t.url.includes("pin.html")), 5000);
check("pin window opens", !!pin);
if (pin) { const p = await connect(pin); check("pin shows the picture", await waitFor(() => p.ev("document.querySelector('img')?.naturalWidth > 0"), 3000)); await p.ev("window.close()"); p.ws.close(); }

// 5. Esc cancels
c = await openPicker();
await sleep(300);
await key(c, "Escape");
await sleep(400);
check("Esc hides the picker", (await c.ev("document.body.className")) === "", await c.ev("document.body.className"));
c.ws.close();

console.log(failed ? `${failed} FAILED` : "ALL PASS");
process.exit(failed ? 1 : 0);
