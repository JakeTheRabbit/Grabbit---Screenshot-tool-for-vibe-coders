// Scrolling capture on a real window: opens the long test page in a Grabbit window (debug builds only, always in
// front, nothing else on screen is touched), runs Scroll over it, and checks the stitched picture with OCR.
// Start the app with: pwsh spikes/run2.ps1 -Test
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const exe = fileURLToPath(new URL("../app/src-tauri/target/debug/grabbit.exe", import.meta.url));
const shots = join(process.env.TEMP, "g2cfg", "shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (n, ok, x = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${n} ${x}`); if (!ok) failed++; };
const targets = async () => { try { return await (await fetch("http://127.0.0.1:9333/json")).json(); } catch { return []; } };
async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(150); } return null; }
async function ev(t, expr) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  const v = await new Promise((r) => { ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); r(d.result?.result?.value ?? d.result?.exceptionDetails?.exception?.description); }); ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } })); });
  ws.close();
  return v;
}

// Any Grabbit page can call commands; the picker windows are always loaded.
const host = await waitFor(async () => (await targets()).find((t) => t.url.includes("picker.html")), 10000);
const rect = await ev(host, `window.__TAURI_INTERNALS__.invoke('dev_window', { page: 'test-long-page.html', x: 220, y: 160, w: 860, h: 640 })`);
check("test window opens in front", Array.isArray(rect), JSON.stringify(rect));
const [x, y, w, h] = rect;
const before = Math.max(0, ...readdirSync(shots).map((f) => statSync(join(shots, f)).mtimeMs));
// Below the sticky header? No: include it, it must appear once in the result.
const pick = { action: "scroll", x: x + 4, y: y + 4, width: w - 8, height: h - 8, windows: [], size: null };
await ev(host, `window.__TAURI_INTERNALS__.invoke('picked', { pick: ${JSON.stringify(pick)} })`);
check("scroll status bar", !!(await waitFor(async () => (await targets()).find((t) => t.url.includes("mode=scroll")), 5000)));
check("stops by itself at the end of the page", !!(await waitFor(async () => !(await targets()).some((t) => t.url.includes("mode=scroll")), 120000)));
const out = await waitFor(() => readdirSync(shots).filter((f) => f.startsWith("Grabbit scroll")).map((f) => join(shots, f)).find((f) => statSync(f).mtimeMs > before), 10000);
check("stitched picture saved", !!out, out);
if (out) {
  const words = await ev(host, `window.__TAURI_INTERNALS__.invoke('editor_msg', { msg: { type: 'ocr', dataURL: 'data:image/webp;base64,${readFileSync(out).toString("base64")}' } })`);
  const text = (Array.isArray(words) ? words : []).map((w) => w.text).join(" ");
  check("first row in the stitch", /Row 1\b/.test(text));
  check("last row in the stitch", /Row 120\b/.test(text), `${text.length} chars`);
  check("sticky header once", (text.match(/Sticky header/g) ?? []).length === 1, `${(text.match(/Sticky header/g) ?? []).length}×`);
}
const dev = (await targets()).find((t) => t.url.includes("test-long-page"));
if (dev) await ev(dev, "window.close()");
console.log(failed ? `${failed} FAILED` : "ALL PASS");
process.exit(failed ? 1 : 0);
