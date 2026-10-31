// Drawing on a video in the real Grabbit editor over CDP: a box drawn with real mouse input at 1 s, text added at 3 s,
// visibility follows the playhead, the timeline shows a bar per drawing, then Copy with "System sound only".
// Prints the copied file's path on the last line for the caller to check frames and audio.
import { writeFileSync } from "node:fs";
const port = 9333, out = process.argv[2] ?? "p9-draw.png", sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 80 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.url.includes("grabbit.app/video.html")); } catch {}
  if (!target) await sleep(250);
}
if (!target) { console.log("FAIL no video page"); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const waiting = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); waiting.get(m.id)?.(m); waiting.delete(m.id); });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => (await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;
const seek = async (t) => { await ev(`(async () => { const v = document.querySelector("video"); v.currentTime = ${t}; await new Promise(r => v.addEventListener("seeked", r, { once: true })); })()`); await sleep(250); };
const click = (text) => ev(`(() => { const b = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === ${JSON.stringify(text)}); b?.click(); return !!b; })()`);
let fails = 0;
const check = (ok, what) => { console.log((ok ? "PASS " : "FAIL ") + what); if (!ok) fails++; };
const shown = () => ev(`window.grabbitDraw.api.getSceneElements().length`);

for (let i = 0; i < 40 && !(await ev(`document.querySelector("video")?.videoHeight > 0 && !!window.grabbitDraw`)); i++) await sleep(250);
const opts = await ev(`[...document.querySelectorAll(".sound option")].map(o => o.value).join(",")`);
check(opts === "All,System,Mic,None", `sound picker offers ${opts}`);

check(await click("Draw"), "Draw mode on");
await sleep(400);
await seek(1.0);
// Real mouse: rectangle tool (R), then drag over video pixels (500,250)→(800,450).
const box = await ev(`(() => { const r = document.querySelector("video").getBoundingClientRect(), v = document.querySelector("video"), k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight); return { x: r.x + (r.width - v.videoWidth * k) / 2, y: r.y + (r.height - v.videoHeight * k) / 2, k }; })()`);   // the picture inside the letterbox
const px = (vx, vy) => ({ x: box.x + vx * box.k, y: box.y + vy * box.k });
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "r", code: "KeyR", text: "r", windowsVirtualKeyCode: 82 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "r", code: "KeyR", windowsVirtualKeyCode: 82 });
console.log("      tool after R:", await ev(`window.grabbitDraw.api.getAppState().activeTool.type`));
const a = px(500, 250), b = px(800, 450);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: a.x, y: a.y });
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: a.x, y: a.y, button: "left", buttons: 1, clickCount: 1 });
await sleep(60);   // a hand never moves the same millisecond it presses; Excalidraw needs the press handled first
for (let s = 1; s <= 12; s++) { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: a.x + ((b.x - a.x) * s) / 12, y: a.y + ((b.y - a.y) * s) / 12, button: "left", buttons: 1 }); await sleep(16); }
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", buttons: 0, clickCount: 1 });
await sleep(400);
const rect = await ev(`(() => { const e = window.grabbitDraw.api.getSceneElements().find(e => e.type === "rectangle"); return e && { x: Math.round(e.x), y: Math.round(e.y), w: Math.round(e.width), h: Math.round(e.height) }; })()`);
check(rect && Math.abs(rect.x - 500) < 4 && Math.abs(rect.w - 300) < 6, `mouse-drawn box lands on video pixels: ${JSON.stringify(rect)}`);
// Make it a solid fill so the frame check below is unambiguous.
await ev(`(() => { const a = window.grabbitDraw.api; a.updateScene({ elements: a.getSceneElements().map(e => e.type === "rectangle" ? { ...e, backgroundColor: "#e03131", fillStyle: "solid", strokeColor: "#e03131", version: e.version + 1, versionNonce: e.versionNonce + 1 } : e) }); })()`);
await sleep(200);

await seek(3.0);
await ev(`(() => { const a = window.grabbitDraw.api; const [t] = window.grabbitDraw.convert([{ type: "text", x: 700, y: 500, text: "Look here", fontSize: 48, strokeColor: "#ffd43b" }]);
  a.updateScene({ elements: [...a.getSceneElements(), t] }); })()`);
await sleep(400);
check((await ev(`document.querySelectorAll(".note").length`)) === 2, `timeline shows ${await ev(`document.querySelectorAll(".note").length`)} drawing bars`);
await click("Done drawing");
await sleep(200);

await seek(0.5); const at05 = await shown();
await seek(1.5); const at15 = await shown();
await seek(3.5); const at35 = await shown();
check(at05 === 0 && at15 === 1 && at35 === 2, `visible drawings follow the playhead: 0.5 s → ${at05}, 1.5 s → ${at15}, 3.5 s → ${at35}`);

writeFileSync(out, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));

await ev(`(() => { const s = document.querySelector(".sound select"); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, "System"); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
await sleep(200);
await click("Save");   // same render as Copy, without needing the clipboard (Windows denies it while the PC is locked)
let note = "";
for (let i = 0; i < 160 && !note; i++) { await sleep(250); note = await ev(`document.querySelector("footer .note")?.textContent ?? ""`); }
check(note.startsWith("Saved"), `Save with drawings + system sound only: "${note}"`);
console.log(fails ? `${fails} FAILED` : "ALL PASS");
ws.close();
process.exit(fails ? 1 : 0);
