// Drive Grabbit's webviews over DevTools. Run Grabbit with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333.
//   node spikes/cdp.mjs list
//   node spikes/cdp.mjs eval <url-substring> "<js expression>"
//   node spikes/cdp.mjs shot <url-substring> out.png
//   node spikes/cdp.mjs key <url-substring> <key>        (e.g. Escape, Enter, f)
//   node spikes/cdp.mjs drag <url-substring> x0 y0 x1 y1
import { writeFileSync } from "node:fs";

const port = process.env.CDP_PORT ?? 9333;
const [cmd, match, ...rest] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
if (cmd === "list") { for (const t of targets) console.log(t.type, t.url, t.title); process.exit(0); }
const t = targets.find((x) => x.type === "page" && x.url.includes(match));
if (!t) { console.error("no page matching", match); process.exit(2); }

const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
export const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}

if (cmd === "eval") console.log(JSON.stringify(await evaluate(rest[0]), null, 1));
if (cmd === "shot") {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(rest[0], Buffer.from(r.result.data, "base64"));
  console.log("saved", rest[0]);
}
if (cmd === "key") {
  const key = rest[0];
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
  const text = key.length === 1 ? key : key === "Enter" ? "\r" : undefined;
  await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, text, windowsVirtualKeyCode: key === "Enter" ? 13 : key === "Escape" ? 27 : key.toUpperCase().charCodeAt(0) });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key, code });
  console.log("key", key);
}
if (cmd === "drag") {
  const [x0, y0, x1, y1] = rest.map(Number);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0, y: y0 });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", clickCount: 1, buttons: 1 });
  for (let i = 1; i <= 12; i++) { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0 + ((x1 - x0) * i) / 12, y: y0 + ((y1 - y0) * i) / 12, button: "left", buttons: 1 }); await sleep(16); }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x1, y: y1, button: "left", clickCount: 1 });
  console.log("dragged");
}
if (cmd === "click") {
  const [x, y] = rest.map(Number);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  console.log("clicked");
}
ws.close();
