// Drive the real Grabbit video editor (WebView2) over CDP: load, filmstrip, split / cut / edge-drag trim with real
// mouse events, then Copy -> host renders with ffmpeg and puts the file on the clipboard. Screenshot saved for review.
// Grabbit must run with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 and a video open.
import { writeFileSync } from "node:fs";

const port = 9333, out = process.argv[2] ?? "p7-video.png";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 80 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.url.includes("grabbit.app/video.html")); } catch {}
  if (!target) await sleep(250);
}
if (!target) { console.log("FAIL no video page on CDP"); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const waiting = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); waiting.get(m.id)?.(m); waiting.delete(m.id); });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const key = (k) => ev(`window.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)} }))`);
const seek = async (t) => { await ev(`(async () => { const v = document.querySelector("video"); v.currentTime = ${t}; await new Promise(r => v.addEventListener("seeked", r, { once: true })); })()`); await sleep(120); };
let fails = 0;
const check = (ok, what) => { console.log((ok ? "PASS " : "FAIL ") + what); if (!ok) fails++; };

for (let i = 0; i < 40 && !(await ev(`!!document.querySelector(".title strong")`)); i++) await sleep(250);
const info = await ev(`({ title: document.querySelector(".title strong")?.textContent, meta: document.querySelector(".title span")?.textContent,
  dur: document.querySelector("video").duration, seekable: document.querySelector("video").seekable.length })`);
check(info?.dur > 3, `loaded ${info?.title} — ${info?.meta}, duration ${info?.dur?.toFixed(2)}`);
check(info?.seekable > 0, "video is seekable (range requests work through the virtual host)");
await sleep(2500);
check((await ev(`document.querySelectorAll(".thumb canvas").length`)) > 4, `filmstrip frames: ${await ev(`document.querySelectorAll(".thumb canvas").length`)}`);

await seek(1.0); await key("s");
await seek(2.0); await key("s");
await key("Escape");
await seek(1.5); await key("Delete");
const parts = await ev(`document.querySelectorAll(".seg").length`);
check(parts === 2, `split twice + cut middle → ${parts} parts, gaps ${await ev(`document.querySelectorAll(".gap").length`)}`);

// Real mouse drag of the first part's left edge to the right (trim the start).
const edge = await ev(`(() => { const r = document.querySelector(".seg .edge.l").getBoundingClientRect(); const t = document.querySelector(".track").getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, pps: t.width / document.querySelector("video").duration }; })()`);
const mouse = (type, x) => send("Input.dispatchMouseEvent", { type, x, y: edge.y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
await mouse("mousePressed", edge.x);
for (let s = 1; s <= 10; s++) await mouse("mouseMoved", edge.x + (edge.pps * 0.5 * s) / 10);
await mouse("mouseReleased", edge.x + edge.pps * 0.5);
await sleep(200);
const kept = await ev(`document.querySelector(".kept").textContent`);
check(/Keeps 0:03\.[45]/.test(kept), `edge drag trimmed the start: "${kept}"`);
await key("z"); // plain z does nothing; Ctrl+Z checked below
await ev(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true }))`);
await sleep(100);
check(/Keeps 0:04\.0/.test(await ev(`document.querySelector(".kept").textContent`)), `undo restores: "${await ev(`document.querySelector(".kept").textContent`)}"`);

const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(shot.result.data, "base64"));

await ev(`[...document.querySelectorAll("button")].find(b => b.textContent === "Copy").click()`);
let note = "";
for (let i = 0; i < 120 && !note; i++) { await sleep(250); note = await ev(`document.querySelector("footer .note")?.textContent ?? ""`); }
check(note.startsWith("Copied"), `Copy rendered + copied: "${note}"`);

// A web link the page tries to open must leave WebView2 for the default browser (help-page fix).
await ev(`window.open("https://example.com/?grabbit-link-test=1")`);
console.log(fails ? `${fails} FAILED` : "ALL PASS");
ws.close();
process.exit(fails ? 1 : 0);
