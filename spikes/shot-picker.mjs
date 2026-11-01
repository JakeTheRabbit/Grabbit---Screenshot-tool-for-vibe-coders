// Screenshot the picker on a given monitor position (default 0,0) to a file. Only for demo-frame runs.
import { writeFileSync } from "node:fs";
const [where = "0,0", file = "picker.png"] = process.argv.slice(2);
for (const t of (await (await fetch("http://127.0.0.1:9333/json")).json()).filter((x) => x.url.includes("picker"))) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; const h = (e) => { const d = JSON.parse(e.data); if (d.id === i) { ws.removeEventListener("message", h); r(d); } }; ws.addEventListener("message", h); ws.send(JSON.stringify({ id: i, method, params })); });
  const pos = (await send("Runtime.evaluate", { expression: "screenX + ',' + screenY", returnByValue: true })).result.result.value;
  if (pos === where) { const s = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(file, Buffer.from(s.result.data, "base64")); console.log("saved", file); }
  ws.close();
}
