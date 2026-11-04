// The studio: Grabbit's real pages (served by Vite) in headless Chrome, with Tauri's IPC replaced by mock.js, so README
// shots come from the actual UI with made-up demo data and nothing ever opens on the desktop.
// Needs `node node_modules/vite/bin/vite.js` running in app/ (port 5173) and headless Chrome on port 9444.
import { readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const here = fileURLToPath(new URL(".", import.meta.url));
export const demo = join(here, "..");
export const root = join(demo, "../..");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mock = readFileSync(join(here, "mock.js"), "utf8");
const types = { ".html": "text/html", ".png": "image/png", ".webp": "image/webp", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".mp4": "video/mp4", ".woff2": "font/woff2" };

/** Files the pages may load through http://studio.local/…: `asset/<path>` and `grabbit/file/<path>` are local files,
 *  `demo/<name>` is docs/demo, and anything in `extra` (e.g. the picker's raw frame) wins. */
export const extra = new Map();
function resolve(url) {
  const p = decodeURIComponent(new URL(url).pathname.slice(1));
  if (extra.has(p)) return extra.get(p);
  if (p.startsWith("demo/")) return { file: join(demo, p.slice(5)) };
  if (p.startsWith("asset/")) return { file: p.slice(6) };
  if (p.startsWith("grabbit/file/")) return { file: p.slice(13) };
  if (p.startsWith("grabbit/thumb/")) return { file: p.slice(14) };
  return null;
}

/** Opens a page in a new headless tab. `setup` is JS run before the page's own scripts (set __studio.handlers there). */
export async function open(path, { width = 1600, height = 900, dpr = 2, setup = "", transparent = false } = {}) {
  const t = await (await fetch("http://127.0.0.1:9444/json/new?about:blank", { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0; const pend = new Map(); const errors = [];
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  ws.addEventListener("message", async (e) => {
    const m = JSON.parse(e.data);
    if (m.id) { pend.get(m.id)?.(m); pend.delete(m.id); return; }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
    if (m.method === "Fetch.requestPaused") {
      const { requestId, request } = m.params, hit = resolve(request.url);
      let body, type;
      try {
        body = hit?.bytes ?? (hit ? readFileSync(hit.file) : null);
        type = hit?.type ?? types[extname(hit?.file ?? "").toLowerCase()] ?? "application/octet-stream";
      } catch { body = null; }
      if (!body) { console.warn("studio: 404", request.url); return send("Fetch.fulfillRequest", { requestId, responseCode: 404, body: "" }); }
      send("Fetch.fulfillRequest", { requestId, responseCode: 200, body: Buffer.from(body).toString("base64"),
        responseHeaders: [{ name: "Content-Type", value: type }, { name: "Access-Control-Allow-Origin", value: "*" }] });
    }
  });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "http://studio.local/*" }] });
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false });
  if (transparent) await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: mock + "\n" + setup });
  const url = path.startsWith("http") ? path : `http://127.0.0.1:5173/${path}`;
  await send("Page.navigate", { url });
  await new Promise((r) => { const f = (e) => { const m = JSON.parse(e.data); if (m.method === "Page.loadEventFired") { ws.removeEventListener("message", f); r(); } }; ws.addEventListener("message", f); });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(`${expr.slice(0, 80)}… → ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`);
    return r.result?.result?.value;
  };
  const waitFor = async (expr, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr).catch(() => false)) return; await sleep(100); } throw new Error(`timed out: ${expr}\n${errors.join("\n")}`); };
  const shot = async (file, clip) => {
    await sleep(400);
    const r = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    writeFileSync(file, Buffer.from(r.result.data, "base64"));
    console.log("saved", file);
  };
  const mouse = (type, x, y, buttons = 0) => send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
  const drag = async (x0, y0, x1, y1, steps = 14) => {
    await mouse("mouseMoved", x0, y0); await mouse("mousePressed", x0, y0, 1);
    for (let i = 1; i <= steps; i++) { await mouse("mouseMoved", x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps, 1); await sleep(12); }
    await mouse("mouseReleased", x1, y1);
  };
  const click = async (x, y) => { await mouse("mouseMoved", x, y); await mouse("mousePressed", x, y, 1); await mouse("mouseReleased", x, y); };
  const key = async (key, code = key, vk = 0, text) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, text });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk });
  };
  const close = async () => { ws.close(); await fetch(`http://127.0.0.1:9444/json/close/${t.id}`); };
  return { send, ev, waitFor, shot, mouse, drag, click, key, close, errors };
}

export const fileUrl = (p) => `http://studio.local/asset/${encodeURIComponent(p)}`;
