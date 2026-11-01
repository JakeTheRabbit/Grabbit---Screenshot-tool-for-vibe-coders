// Picture editor end to end on a known picture (app/src-tauri/tests/fixtures/ocr.png: a line of text, an email, an IP).
// Start the app with: pwsh spikes/run2.ps1 -Test
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const exe = fileURLToPath(new URL("../app/src-tauri/target/debug/grabbit.exe", import.meta.url));
const fixture = fileURLToPath(new URL("../app/src-tauri/tests/fixtures/ocr.png", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (n, ok, x = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${n} ${x}`); if (!ok) failed++; };
const targets = async () => { try { return await (await fetch("http://127.0.0.1:9333/json")).json(); } catch { return []; } };
async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); } return null; }

const before = new Set((await targets()).map((t) => t.id));
execFile(exe, ["--open", fixture]);
const t = await waitFor(async () => (await targets()).find((x) => !before.has(x.id) && /tauri\.localhost\/(index\.html)?$/.test(x.url)), 15000);
check("editor opens the file", !!t);
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); pend.get(m.id)?.(m); pend.delete(m.id); });
const ev = (expr) => new Promise((r) => { const i = ++id; pend.set(i, (m) => r(m.result?.result?.value ?? m.result?.exceptionDetails?.exception?.description)); ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } })); });
const click = (label) => ev(`(() => { const b = [...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)})); if (!b) return false; b.click(); return true; })()`);
const elements = () => ev("window.grabbit.api.getSceneElements().map((e) => ({ type: e.type, hidden: e.customData?.grabbitHidden }))");

check("picture loaded", await waitFor(async () => (await elements())?.length === 1, 10000));

// Auto-hide private details
check("Hide menu opens", await click("Hide"));
await sleep(150);
check("auto-hide item", await click("Hide private details automatically"));
const hidden = await waitFor(async () => { const e = await elements(); const h = e.filter((x) => x.hidden); return h.length >= 2 ? h : null; }, 15000);
check("email and IP pixelated", !!hidden && hidden.some((h) => h.hidden === "email") && hidden.some((h) => h.hidden === "ip"), JSON.stringify(hidden?.map((h) => h.hidden)));

// Copy text
execFileSync("pwsh", ["-NoProfile", "-Command", "Set-Clipboard -Value 'x'"]);
await ev(`(() => { [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "▾")?.click(); })()`);
await sleep(150);
check("copy-text item", await click("Copy text in the picture"));
const text = await waitFor(() => { const t = execFileSync("pwsh", ["-NoProfile", "-Command", "Get-Clipboard -Raw"], { encoding: "utf8" }).trim(); return t !== "x" ? t : null; }, 15000);
check("copied the picture's text", /Grabbit reads text/i.test(text ?? ""), JSON.stringify(text));

// Beautify grows the output and keeps it PNG
await click("Beautify");
await sleep(200);
const b = await ev(`(async () => {
  const box = document.querySelector('.panel input[type=checkbox]'); if (!box.checked) box.click();
  await new Promise((r) => setTimeout(r, 200));
  return !!document.querySelector('.panel') && box.checked;
})()`);
check("beautify panel turns on", b === true);
const dims = await ev(`(async () => { const u = await window.grabbitRender(); const i = new Image(); i.src = u; await i.decode(); return [i.width, i.height]; })()`);
check("beautified copy is padded", Array.isArray(dims) && dims[0] > 900 && dims[1] > 220, JSON.stringify(dims));
await ev(`document.querySelector('.panel input[type=checkbox]').click()`);

// Info panel: check watermark on a clean picture
await click("Info");
await sleep(200);
await click("Check this picture for a watermark");
const res = await waitFor(async () => { const t = await ev(`document.querySelector('.panel .result')?.textContent`); return t && t !== 'Reading…' ? t : null; }, 20000);
check("no watermark reported on a clean picture", /No Grabbit watermark/.test(res ?? ""), res);

await ev("window.close()");
ws.close();
console.log(failed ? `${failed} FAILED` : "ALL PASS");
process.exit(failed ? 1 : 0);
