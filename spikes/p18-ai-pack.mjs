// Talk-to-AI and AI batch end to end. The microphone recording is always thrown away unheard (stop with keep=false);
// the words are typed. Start the app with: pwsh spikes/run2.ps1 -Test
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const exe = fileURLToPath(new URL("../app/src-tauri/target/debug/grabbit.exe", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (n, ok, x = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${n} ${x}`); if (!ok) failed++; };
const targets = async () => { try { return await (await fetch("http://127.0.0.1:9333/json")).json(); } catch { return []; } };
async function waitFor(fn, ms = 10000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(150); } return null; }
async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0; const pend = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); pend.get(m.id)?.(m); pend.delete(m.id); });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }); return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description; };
  return { ws, send, ev };
}
const ps = (cmd) => execFileSync("powershell", ["-NoProfile", "-STA", "-Command", `[Console]::OutputEncoding = [Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; ${cmd}`], { encoding: "utf8" }).trim();
const host = await connect(await waitFor(async () => (await targets()).find((t) => t.url.includes("picker.html"))));

async function talkWindow() {
  execFile(exe, ["capture"]);
  await waitFor(async () => { for (const t of (await targets()).filter((x) => x.url.includes("picker.html"))) { const c = await connect(t); const r = await c.ev("document.body.className"); c.ws.close(); if (r === "ready") return true; } return false; });
  await sleep(500);
  await host.ev(`window.__TAURI_INTERNALS__.invoke('picked', { pick: { action: 'voice', x: 120, y: 120, width: 900, height: 560, windows: [], size: null, extra: [], layout: null } })`);
  const t = await waitFor(async () => (await targets()).find((x) => x.url.includes("voice.html") && !x.url.includes("batch")), 10000);
  const v = await connect(t);
  await waitFor(() => v.ev("document.getElementById('pic').naturalWidth > 0"), 10000);
  // Throw the microphone recording away unheard; type the words instead.
  await v.ev("window.__TAURI_INTERNALS__.invoke('voice_stop', { keep: false })");
  await v.ev("document.body.classList.remove('listening'); document.getElementById('copy').disabled = false; document.getElementById('done').hidden = true");
  return v;
}

// 1. One picture, two marks, typed words → Copy for AI
let v = await talkWindow();
check("Talk window opens with the picture", true);
const r = await v.ev(`(() => { const c = document.getElementById('marks').getBoundingClientRect(); return [c.left, c.top, c.width, c.height]; })()`);
const click = async (x, y) => { for (const type of ["mousePressed", "mouseReleased"]) await v.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 }); };
await click(r[0] + r[2] * 0.3, r[1] + r[3] * 0.3);
await v.send("Input.dispatchMouseEvent", { type: "mousePressed", x: r[0] + r[2] * 0.55, y: r[1] + r[3] * 0.5, button: "left", clickCount: 1, buttons: 1 });
for (let i = 1; i <= 6; i++) await v.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r[0] + r[2] * (0.55 + i * 0.03), y: r[1] + r[3] * (0.5 + i * 0.03), button: "left", buttons: 1 });
await v.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r[0] + r[2] * 0.73, y: r[1] + r[3] * 0.68, button: "left", clickCount: 1 });
await v.ev(`(() => { const w = document.getElementById('words'); w.value = 'Make [1] green and remove the box at [2]'; })()`);
await v.ev(`document.getElementById('copy').click()`);
const copied = await waitFor(() => v.ev(`document.body.classList.contains('copied') || /Couldn/.test(document.getElementById('status').textContent) ? document.getElementById('status').textContent : null`), 20000);
check("Copy for AI finished", /Copied/.test(copied ?? ""), copied);
v.ws.close();
const files = ps("[Windows.Forms.Clipboard]::GetFileDropList() -join '|'");
check("clipboard: picture as a file", /Grabbit for AI.*\.png$/.test(files), files);
const text = ps("[Windows.Forms.Clipboard]::GetText()");
check("clipboard: words first, then context", text.startsWith("Make [1] green") && /Context from Grabbit/.test(text) && /\[1\]–\[2\]/.test(text), JSON.stringify(text.slice(0, 160)));
const html = ps("[Windows.Forms.Clipboard]::GetText([Windows.Forms.TextDataFormat]::Html).Length");
check("clipboard: HTML with the picture", Number(html) > 1000, `${html} chars`);
const img = ps("$i = [Windows.Forms.Clipboard]::GetImage(); if ($i) { \"$($i.Width)x$($i.Height)\" }");
const [iw, ih] = img.split("x").map(Number);
check("picture has the words panel under it", ih > 560 && iw >= 900, img);

// 2. Two pictures into an AI batch, then copy them all
for (const words of ["First one: the header is cut off", "Second: totals don't add up"]) {
  v = await talkWindow();
  await v.ev(`document.getElementById('words').value = ${JSON.stringify(words)}`);
  await v.ev(`document.getElementById('addbatch').click()`);
  check(`added to batch: ${words.slice(0, 12)}…`, !!(await waitFor(() => v.ev(`/Added to the AI batch/.test(document.getElementById('status').textContent)`), 10000)));
  v.ws.close();
  await sleep(1500);
}
check("batch bar shows the count", await waitFor(async () => { const t = (await targets()).find((x) => x.url.includes("mode=batch")); if (!t) return false; const c = await connect(t); const n = await c.ev("document.querySelector('.n').textContent"); c.ws.close(); return n === "2"; }));
await host.ev("window.__TAURI_INTERNALS__.invoke('batch_finish')");
const rv = await connect(await waitFor(async () => (await targets()).find((x) => x.url.includes("batch=1")), 15000));
await waitFor(() => rv.ev("document.querySelectorAll('.item').length === 2"), 10000);
check("review lists both with their words", await rv.ev(`[...document.querySelectorAll('.item textarea')].map((t) => t.value).join('|') === "First one: the header is cut off|Second: totals don't add up"`));
await rv.ev(`document.getElementById('intro').value = 'Make a bug report from these.'`);
await rv.ev(`document.getElementById('bcopy').click()`);
check("batch copied", !!(await waitFor(() => rv.ev(`/Copied 2 pictures/.test(document.getElementById('status').textContent)`), 20000)));
rv.ws.close();
const bfiles = ps("[Windows.Forms.Clipboard]::GetFileDropList().Count");
check("clipboard: both pictures as files", bfiles === "2", bfiles);
const btext = ps("[Windows.Forms.Clipboard]::GetText()");
check("clipboard: each picture tied to its note", /Picture 1: First one/.test(btext) && /Picture 2: Second/.test(btext) && btext.startsWith("Make a bug report"), JSON.stringify(btext.slice(0, 200)));
host.ws.close();
console.log(failed ? `${failed} FAILED` : "ALL PASS");
process.exit(failed ? 1 : 0);
