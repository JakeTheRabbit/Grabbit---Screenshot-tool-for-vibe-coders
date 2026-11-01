// Repro: the first drag after the pickers were reset is read as a click. Logs pointer events in the page.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
const exe = fileURLToPath(new URL("../app/src-tauri/target/debug/grabbit.exe", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = async () => (await (await fetch("http://127.0.0.1:9333/json")).json()).filter((t) => t.url.includes("picker.html"));
async function conn(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0; const pend = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); pend.get(m.id)?.(m); pend.delete(m.id); });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (e) => (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
  return { ws, send, ev };
}
for (const t of await targets()) { const c = await conn(t); await c.ev("window.__TAURI_INTERNALS__.invoke('picker_cancel')"); c.ws.close(); }
await sleep(500);
execFile(exe, ["capture"]);
await sleep(Number(process.env.WAIT ?? 2500));
const c = await conn((await targets())[0]);
await c.ev(`window.__log = []; for (const t of ['pointerdown','pointermove','pointerup','mousedown','mousemove']) document.getElementById('c').addEventListener(t, (e) => window.__log.push(t + ':' + e.clientX + ',' + e.clientY + ',' + e.buttons), true)`);
console.log("state", await c.ev("document.body.className + ' ' + document.hasFocus()"));
await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 100, y: 100 });
await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 100, y: 100, button: "left", clickCount: 1, buttons: 1 });
for (let i = 1; i <= 5; i++) { await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 100 + i * 40, y: 100 + i * 30, button: "left", buttons: 1 }); await sleep(16); }
await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 300, y: 250, button: "left", clickCount: 1 });
await sleep(300);
console.log(JSON.stringify(await c.ev("window.__log")));
console.log("bar", await c.ev("!document.getElementById('bar').hidden"), await c.ev("document.getElementById('size').textContent"));
c.ws.close();
