// Opens Excalidraw's help dialog in the real Grabbit editor and clicks its first web link; the caller checks
// that the default browser was launched with that URL (and that no WebView2 popup appeared).
const port = 9333, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 80 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.url.includes("grabbit.app/index.html")); } catch {}
  if (!target) await sleep(250);
}
if (!target) { console.log("FAIL no editor page"); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const waiting = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); waiting.get(m.id)?.(m); waiting.delete(m.id); });
const ev = (expr) => new Promise((r) => { const i = ++id; waiting.set(i, (m) => r(m.result?.result?.value)); ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } })); });
await sleep(2500);
await ev(`document.querySelector(".excalidraw")?.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }))`);
await sleep(600);
const links = await ev(`[...document.querySelectorAll(".HelpDialog a, .HelpDialog__btn")].map(a => a.href + " target=" + a.target)`);
console.log("help links:", JSON.stringify(links));
const href = await ev(`(() => { const a = document.querySelector(".HelpDialog a[href^='http']"); a?.click(); return a?.href; })()`);
console.log("clicked:", href);
console.log("page still on:", await ev("location.href"));
ws.close();
