// How long from "grabbit capture" until every picker page is ready. Run with the app started by run2.ps1.
import { execFile } from "node:child_process";
const exe = new URL("../app/src-tauri/target/debug/grabbit.exe", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pages() { try { return (await (await fetch("http://127.0.0.1:9333/json")).json()).filter((t) => t.url.includes("picker.html")); } catch { return []; } }
async function evalIn(t, expr) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  const v = await new Promise((r) => { ws.addEventListener("message", (e) => r(JSON.parse(e.data).result?.result?.value)); ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } })); });
  ws.close();
  return v;
}

for (let run = 0; run < 3; run++) {
  for (const t of await pages()) await evalIn(t, "window.__TAURI_INTERNALS__.invoke('picker_cancel')").catch(() => {});
  await sleep(800);
  const t0 = Date.now();
  execFile(exe, ["capture"]);
  let ready = [];
  while (Date.now() - t0 < 10000) {
    const ps = await pages();
    ready = await Promise.all(ps.map((p) => evalIn(p, "document.body.className").catch(() => "")));
    if (ps.length >= 2 && ready.every((c) => c === "ready")) break;
    await sleep(25);
  }
  console.log(`run ${run}: ${Date.now() - t0} ms`, ready);
}
for (const t of await pages()) await evalIn(t, "window.__TAURI_INTERNALS__.invoke('picker_cancel')").catch(() => {});
