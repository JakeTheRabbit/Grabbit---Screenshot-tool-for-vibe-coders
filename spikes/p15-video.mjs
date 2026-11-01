// Video editor end to end on spikes/make-speech-video.ps1's output: cut silences, part speed, studio effects,
// captions (local whisper, downloads the model once), burnt-in save, GIF copy. Start the app with: pwsh spikes/run2.ps1 -Test
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const exe = new URL("../app/src-tauri/target/debug/grabbit.exe", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const dir = join(process.env.TEMP, "g2studio");
const video = join(dir, "speech.mp4");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (n, ok, x = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${n} ${x}`); if (!ok) failed++; };
const targets = async () => { try { return await (await fetch("http://127.0.0.1:9333/json")).json(); } catch { return []; } };
async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(150); } return null; }

const before = new Set((await targets()).map((t) => t.id));
execFile(exe, ["--open", video]);
const t = await waitFor(async () => (await targets()).find((x) => !before.has(x.id) && x.url.includes("video.html")), 15000);
check("video editor opens", !!t);
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); pend.get(m.id)?.(m); pend.delete(m.id); });
const ev = (expr) => new Promise((r) => { const i = ++id; pend.set(i, (m) => r(m.result?.result?.value ?? m.result?.exceptionDetails?.exception?.description)); ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } })); });
const click = (label) => ev(`(() => { const b = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
const parts = () => ev(`document.querySelectorAll(".strip .seg").length`);
const note = () => ev(`document.querySelector("footer .note, footer span")?.textContent ?? ""`);

check("loaded with effects", await waitFor(() => ev(`!!document.querySelector(".fx")`), 15000));
await ev("window.confirm = () => true");

// Cut silences
check("cut silences button", await click("Cut silences"));
const p1 = await waitFor(async () => ((await parts()) >= 2 ? await parts() : null), 20000);
check("the 3 s pause was cut", (p1 ?? 0) >= 2, `${p1} parts · ${await note()}`);
const kept = await ev(`document.querySelector(".kept")?.textContent`);
check("kept time shrank", /Keeps/.test(kept ?? ""), kept);

// Speed on part 1
await ev(`document.querySelectorAll(".strip .seg")[0].dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: document.querySelectorAll(".strip .seg")[0].getBoundingClientRect().left + 10, button: 0, pointerId: 1 }))`);
await ev(`document.querySelector(".track").dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: document.querySelectorAll(".strip .seg")[0].getBoundingClientRect().left + 10, button: 0, pointerId: 1 }))`);
await sleep(200);
await ev(`(() => { const s = document.querySelector("select.speed"); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; set.call(s, "2"); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
check("part speed 2×", await waitFor(() => ev(`document.querySelector(".speedtag")?.textContent === "2×"`), 3000));

// Effects
await ev(`[...document.querySelectorAll(".fx input")].forEach((i) => { if (!i.checked) i.click(); })`);
check("effects on", await ev(`[...document.querySelectorAll(".fx input")].every((i) => i.checked)`));

// Captions (may download the speech model the first time)
check("captions button", await click("Captions"));
const cueText = await waitFor(() => ev(`[...document.querySelectorAll(".cue input")].map((i) => i.value).join(" ")`), 600000);
check("captions transcribed", /grabbit|caption/i.test(cueText ?? ""), JSON.stringify(cueText));
check(".srt written next to the video", existsSync(join(dir, "speech.srt")));
await ev(`document.querySelector(".captions header input").click()`);

// Save with everything burnt in
const t0 = Date.now();
await click("Save");
const saved = await waitFor(async () => { const n = await note(); return /Saved|Failed/.test(n) ? n : null; }, 120000);
check("saved the edited video", /Saved/.test(saved ?? ""), saved);
const out = readdirSync(dir).filter((f) => f.startsWith("speech edited") && f.endsWith(".mp4")).map((f) => join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
if (out && statSync(out).mtimeMs > t0 - 1000) {
  const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out], { encoding: "utf8" }));
  check("edited video is shorter (silence cut, part sped up)", dur < 8.5, dur.toFixed(2));
} else check("edited video file", false);

// GIF copy
await ev(`[...document.querySelectorAll(".drop .caret")][0].click()`);
await sleep(150);
await click("Copy as GIF");
const gif = await waitFor(async () => { const n = await note(); return /Copied|Failed/.test(n) ? n : null; }, 120000);
check("GIF copied", /Copied/.test(gif ?? ""), gif);

ws.close();
console.log(failed ? `${failed} FAILED` : "ALL PASS");
process.exit(failed ? 1 : 0);
