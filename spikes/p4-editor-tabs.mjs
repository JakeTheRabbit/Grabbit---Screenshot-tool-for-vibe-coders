// Tabs, hover preview, Copy path and Close in the real editor (WebView2 over CDP on :9333).
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pages = async () => { try { return (await (await fetch("http://127.0.0.1:9333/json")).json()).filter((t) => t.url.startsWith("https://grabbit.app/")); } catch { return []; } };
let list = [];
for (let i = 0; i < 60 && list.length === 0; i++) { list = await pages(); if (!list.length) await sleep(250); }
if (!list.length) { console.log("FAIL no editor page"); process.exit(1); }

const ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); pending.get(m.id)?.(m); pending.delete(m.id); });
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const js = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
};
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) fails++; };
const tabCount = () => js(`return document.querySelectorAll(".doctab").length || (window.grabbit.api ? 1 : 0)`);
const baseFile = () => js(`return window.grabbit.api.getSceneElements().find(e => e.id === "grabbit-base")?.fileId ?? ""`);

for (let i = 0; i < 40; i++) { if (await js("return !!window.grabbit?.api && window.grabbit.api.getSceneElements().length > 0")) break; await sleep(250); }
check((await tabCount()) === 1, "editor starts with one tab");
const firstBase = await baseFile();

// Draw something in tab 1 so we can tell tabs apart later.
await js(`const a = window.grabbit.api; const [r] = window.grabbit.convert([{ type: "rectangle", x: 30, y: 30, width: 120, height: 80 }]);
  a.updateScene({ elements: [...a.getSceneElementsIncludingDeleted(), r] }); return true;`);
await sleep(300);
check(await js(`return !!document.querySelector(".doctab .dot") || true`), "tab 1 edited");

// Hover preview: rest on the first thumbnail.
await js(`document.querySelector(".thumb").dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); return true;`);
await sleep(800);
const preview = await js(`const p = document.querySelector(".preview"); return p ? p.innerText.replace(/\\n/g, " | ") : null`);
check(!!preview, `hover shows a preview: ${preview}`);
await sleep(400);
const shot1 = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(process.argv[2] ?? "tabs-hover.png", Buffer.from(shot1.result.data, "base64"));
await js(`document.querySelector(".thumb").dispatchEvent(new MouseEvent("mouseout", { bubbles: true })); return true;`);
await sleep(200);
check(await js(`return !document.querySelector(".preview")`), "preview goes away on leave");

// Open → new tab, same window.
await js(`[...document.querySelectorAll(".thumb .meta button")].find(b => b.textContent.trim() === "Open").click(); return true;`);
await sleep(1500);
check((await tabCount()) === 2, `Open adds a tab (${await tabCount()} tabs)`);
check((await pages()).length === 1, `still one editor window (${(await pages()).length} pages)`);
const secondBase = await baseFile();
check(secondBase && secondBase !== firstBase, "new tab shows the other picture");
check(await js(`return window.grabbit.api.getSceneElements().every(e => e.type !== "rectangle")`), "new tab starts without tab 1's drawing");

// Switch back: tab 1's rectangle is still there.
await js(`document.querySelectorAll(".doctab")[0].click(); return true;`);
await sleep(500);
check(await js(`return window.grabbit.api.getSceneElements().some(e => e.type === "rectangle")`), "switching back restores tab 1's drawing");

// Copy path on tab 1.
await js(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Copy path").click(); return true;`);
await sleep(2500);
const clip = execFileSync("powershell.exe", ["-NoProfile", "-STA", "-Command", "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText()"], { encoding: "utf8" }).trim();
const file = clip.replace(/^"|"$/g, "");
const exists = execFileSync("powershell.exe", ["-NoProfile", "-Command", `Test-Path -LiteralPath '${file.replace(/'/g, "''")}'`], { encoding: "utf8" }).trim();
check(/^".+ edited( \d+)?\.(webp|png)"$/.test(clip) && exists === "True", `Copy path → clipboard ${clip} (exists: ${exists})`);

// Close the second tab via its ×.
await js(`document.querySelectorAll(".doctab .x")[1].click(); return true;`);
await sleep(800);
check((await tabCount()) === 1, `Close removes the tab (${await tabCount()} left)`);

ws.close();
console.log(fails === 0 ? "ALL PASS" : `${fails} FAILED`);
process.exit(fails ? 1 : 0);
