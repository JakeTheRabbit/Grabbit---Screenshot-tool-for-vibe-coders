// Drive the real Grabbit editor (WebView2) over CDP: loaded capture, step badge, emoji, icon,
// pixelate redaction, insert-from-history, then Copy -> host clipboard. Screenshot saved for review.
// Grabbit must run with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 and an editor open.
import { writeFileSync } from "node:fs";

const port = 9333, out = process.argv[2] ?? "editor-cdp.png";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 60 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.url.startsWith("https://grabbit.app/")); } catch {}
  if (!target) await sleep(250);
}
if (!target) { console.log("FAIL no editor page on CDP"); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); pending.get(m.id)?.(m); pending.delete(m.id); });
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const js = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
};
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) fails++; };
const click = (text) => js(`const b=[...document.querySelectorAll("button")].find(b=>b.textContent.trim()===${JSON.stringify(text)}); if(!b) return false; b.click(); return true;`);

for (let i = 0; i < 40; i++) { if (await js("return !!window.grabbit?.api && window.grabbit.api.getSceneElements().length > 0")) break; await sleep(250); }
const base = await js(`const e = window.grabbit.api.getSceneElements()[0]; return { id: e.id, type: e.type, w: e.width, h: e.height, locked: e.locked }`);
check(base?.id === "grabbit-base" && base.type === "image" && base.locked, `capture loaded as locked base image ${base?.w}×${base?.h}`);
const fontsOk = await js(`await document.fonts.ready; return [...document.fonts].filter(f => f.status === "loaded").map(f => f.family).join(",")`);
console.log(`      fonts loaded: ${fontsOk || "(none yet)"}`);

check(await click("① Step"), "Step button");
check(await click("😀 Emoji & icons"), "Emoji & icons panel opens");
check(await js(`const b=document.querySelector(".stickers .emoji button"); b.click(); return true;`), "emoji inserted");
check(await js(`const b=document.querySelector(".stickers .icons button"); b.click(); return true;`), "icon inserted");
await click("😀 Emoji & icons");

// Redaction: a rectangle over the top-left of the capture, selected, then Pixelate.
await js(`const a = window.grabbit.api; const [r] = window.grabbit.convert([{ type: "rectangle", x: 20, y: 20, width: 300, height: 120 }]);
  a.updateScene({ elements: [...a.getSceneElementsIncludingDeleted(), r], appState: { selectedElementIds: { [r.id]: true } } }); return true;`);
await click("Pixelate");
await sleep(600);
const kinds = await js(`return window.grabbit.api.getSceneElements().map(e => e.type + (e.customData?.grabbitStep ? ":step" : "")).join(",")`);
check(!kinds.includes("rectangle") && (kinds.match(/image/g) ?? []).length >= 3, `pixelate replaced the box with a baked image layer (${kinds})`);

// Recent strip: insert the first capture on top.
const thumbs = await js(`return document.querySelectorAll(".thumb img").length`);
check(thumbs > 0, `recent strip shows ${thumbs} captures`);
if (thumbs > 0) {
  const before = await js(`return window.grabbit.api.getSceneElements().length`);
  await js(`document.querySelector(".thumb img").click(); return true;`);
  await sleep(1500);
  const after = await js(`return window.grabbit.api.getSceneElements().length`);
  check(after === before + 1, `clicking a recent capture adds it on top (${before} → ${after})`);
}

await sleep(400);
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(shot.result.data, "base64"));

check(await click("Copy"), "Copy pressed");
await sleep(2500);
const last = await js(`return JSON.stringify(window.grabbit.outbox.filter(m => m.type === "export").map(m => ({ action: m.action, size: m.size, bytes: m.dataURL.length })))`);
check(last.includes('"action":"copy"'), `export posted to host: ${last}`);
ws.close();
console.log(fails === 0 ? "ALL PASS" : `${fails} FAILED`);
process.exit(fails ? 1 : 0);
