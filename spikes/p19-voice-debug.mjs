// Step through the Talk-to-AI copy by hand and print what happens (mic recording discarded unheard).
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
const exe = fileURLToPath(new URL("../app/src-tauri/target/debug/grabbit.exe", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = async () => (await (await fetch("http://127.0.0.1:9333/json")).json());
async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0; const pend = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.method === "Runtime.consoleAPICalled" || m.method === "Runtime.exceptionThrown") console.log("PAGE", JSON.stringify(m.params).slice(0, 400)); pend.get(m.id)?.(m); pend.delete(m.id); });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }); return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description; };
  await send("Runtime.enable");
  return { ws, send, ev };
}
const host = await connect((await targets()).find((t) => t.url.includes("picker.html")));
execFile(exe, ["capture"]);
await sleep(2500);
console.log(await host.ev(`window.__TAURI_INTERNALS__.invoke('picked', { pick: { action: 'voice', x: 120, y: 120, width: 900, height: 560, windows: [], size: null, extra: [], layout: null } }).then(() => 'ok', (e) => 'err ' + e)`));
await sleep(3000);
console.log((await targets()).map((t) => t.url).join("\n"));
const t = (await targets()).find((x) => x.url.includes("voice.html"));
if (!t) process.exit(1);
const v = await connect(t);
console.log("stop", await v.ev("window.__TAURI_INTERNALS__.invoke('voice_stop', { keep: false }).then((r) => JSON.stringify(r), (e) => 'err ' + e)"));
console.log("state", await v.ev("JSON.stringify({ status: document.getElementById('status').textContent, w: document.getElementById('pic').naturalWidth })"));
await v.ev("document.getElementById('words').value = 'Test words'");
await v.ev("window.__closeWas = window.close; ");
await v.ev("document.getElementById('copy').click()");
for (let i = 0; i < 20; i++) { await sleep(500); const s = await v.ev("document.getElementById('status')?.textContent"); console.log(i, s); if (/Copied|Couldn/.test(s ?? "")) break; }
