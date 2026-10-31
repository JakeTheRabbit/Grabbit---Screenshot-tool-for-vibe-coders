// The video must stay inside its area and never cover the controls / timeline (tall recordings did). Screenshot saved.
import { writeFileSync } from "node:fs";
const port = 9333, out = process.argv[2] ?? "p8-layout.png", sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const ev = async (x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true })).result?.result?.value;
for (let i = 0; i < 40 && !(await ev(`document.querySelector("video")?.videoHeight > 0`)); i++) await sleep(250);
const r = await ev(`(() => { const v = document.querySelector("video").getBoundingClientRect(), m = document.querySelector("main").getBoundingClientRect(),
  c = document.querySelector(".controls").getBoundingClientRect(); return { video: [v.top, v.bottom], main: [m.top, m.bottom], controlsTop: c.top, vh: innerHeight }; })()`);
console.log(JSON.stringify(r));
const ok = r.video[1] <= r.controlsTop + 0.5 && r.main[1] <= r.controlsTop + 0.5;
console.log(ok ? "PASS video stays above the controls" : "FAIL video overlaps the controls");
writeFileSync(out, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
ws.close();
process.exit(ok ? 0 : 1);
