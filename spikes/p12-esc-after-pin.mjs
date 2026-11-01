// Repro: pin, then open the picker again and press Esc. Prints every picker page's state at each step.
import { execFile } from "node:child_process";
const exe = new URL("../app/src-tauri/target/debug/grabbit.exe", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pages() { return (await (await fetch("http://127.0.0.1:9333/json")).json()).filter((t) => t.url.includes("picker")); }
async function on(t, method, params) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  const v = await new Promise((r) => { ws.addEventListener("message", (m) => r(JSON.parse(m.data).result)); ws.send(JSON.stringify({ id: 1, method, params })); });
  ws.close();
  return v;
}
const ev = (t, e) => on(t, "Runtime.evaluate", { expression: e, returnByValue: true }).then((r) => r?.result?.value);
const states = async (label) => console.log(label, JSON.stringify(await Promise.all((await pages()).map((t) => ev(t, "document.body.className + '/' + innerWidth")))));

execFile(exe, ["capture"]); await sleep(1500); await states("open1");
const p = (await pages())[0];
await ev(p, "window.__TAURI_INTERNALS__.invoke('picked', { pick: { action: 'pin', x: 100, y: 100, width: 300, height: 200, windows: [], size: null } })");
await sleep(800); await states("after pin");
execFile(exe, ["capture"]); await sleep(1500); await states("open2");
const q = (await pages())[0];
await on(q, "Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await on(q, "Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(600); await states("after esc");
