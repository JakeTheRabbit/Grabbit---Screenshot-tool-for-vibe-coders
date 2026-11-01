// Describe & tag on the OCR fixture picture through whatever AI the running app is set up with.
// Start the app with: pwsh spikes/run2.ps1 -Test (its settings.json carrying an ai section).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const pic = readFileSync(fileURLToPath(new URL("../app/src-tauri/tests/fixtures/ocr.png", import.meta.url))).toString("base64");
const t = (await (await fetch("http://127.0.0.1:9333/json")).json()).find((x) => x.url.includes("picker"));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
const r = await new Promise((res) => {
  ws.addEventListener("message", (e) => res(JSON.parse(e.data).result?.result?.value));
  ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: `window.__TAURI_INTERNALS__.invoke('ai_describe', { dataUrl: 'data:image/png;base64,${pic}' }).then((r) => r, (e) => 'ERR ' + e)`, awaitPromise: true, returnByValue: true } }));
});
console.log(JSON.stringify(r, null, 1));
const ok = r && typeof r === "object" && r.summary.length > 40 && r.tags.length >= 3;
console.log(ok ? "PASS describe returned a paragraph and tags" : "FAIL describe");
process.exit(ok ? 0 : 1);
