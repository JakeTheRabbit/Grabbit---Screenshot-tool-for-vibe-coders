// Recording end to end: pick → record 3 s → pause 1 s → resume 2 s → stop. Checks the bar/frame windows, the .mp4
// (duration ≈ 5 s, even size, named sound tracks) and the cursor track. Start the app with: pwsh spikes/run2.ps1 -Test
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const exe = new URL("../app/src-tauri/target/debug/grabbit.exe", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const videos = join(process.env.TEMP, "g2cfg", "videos");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (n, ok, x = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${n} ${x}`); if (!ok) failed++; };
const targets = async () => { try { return await (await fetch("http://127.0.0.1:9333/json")).json(); } catch { return []; } };
async function ev(t, expr) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  const v = await new Promise((r) => { ws.addEventListener("message", (m) => r(JSON.parse(m.data).result?.result?.value)); ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } })); });
  ws.close();
  return v;
}
async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); } return null; }
const latest = () => existsSync(videos) ? readdirSync(videos).filter((f) => f.endsWith(".mp4")).map((f) => ({ f, t: statSync(join(videos, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0] : undefined;

const before = latest()?.t ?? 0;
execFile(exe, ["capture"]);
const picker = await waitFor(async () => (await targets()).find((t) => t.url.includes("picker.html")), 5000);
await sleep(1200);
const err = await ev(picker, "window.__TAURI_INTERNALS__.invoke('picked', { pick: { action: 'record', x: 101, y: 101, width: 641, height: 361, windows: [], size: null } }).then(() => '', e => String(e))");
check("recording starts", err === "", err);
const bar = await waitFor(async () => (await targets()).find((t) => t.url.includes("recbar.html")), 8000);
check("Stop bar shows", !!bar);
check("red frame shows", !!(await targets()).find((t) => t.url.includes("recframe.html")));
await sleep(3000);
const s1 = await ev(bar, "window.__TAURI_INTERNALS__.invoke('rec_status')");
check("timer runs", s1?.elapsed > 2, JSON.stringify(s1));
await ev(bar, "window.__TAURI_INTERNALS__.invoke('rec_control', { what: 'pause' })");
await sleep(1000);
const s2 = await ev(bar, "window.__TAURI_INTERNALS__.invoke('rec_status')");
check("pause", s2?.paused === true);
await sleep(1000);
const s3 = await ev(bar, "window.__TAURI_INTERNALS__.invoke('rec_status')");
check("timer stops while paused", Math.abs(s3.elapsed - s2.elapsed) < 0.2, `${s2.elapsed.toFixed(2)} → ${s3.elapsed.toFixed(2)}`);
await ev(bar, "window.__TAURI_INTERNALS__.invoke('rec_control', { what: 'pause' })");
await sleep(2000);
await ev(bar, "window.__TAURI_INTERNALS__.invoke('rec_control', { what: 'stop' })");
const out = await waitFor(() => { const l = latest(); return l && l.t > before ? l : null; }, 30000);
check("video written", !!out, out?.f);
if (out) {
  const path = join(videos, out.f);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], { encoding: "utf8" }));
  const v = probe.streams.find((s) => s.codec_type === "video");
  const dur = Number(probe.format.duration);
  check("even size, clipped to the area", v.width % 2 === 0 && v.height % 2 === 0 && v.width <= 641 && v.width >= 638, `${v.width}x${v.height}`);
  check("duration ≈ 5 s (pause left out)", dur > 4.2 && dur < 6.2, dur.toFixed(2));
  const titles = probe.streams.filter((s) => s.codec_type === "audio").map((s) => s.tags?.handler_name);
  check("named sound tracks", titles.every((t) => t === "System sound" || t === "Microphone"), JSON.stringify(titles));
  check("cursor track saved", existsSync(path.replace(/\.mp4$/, ".cursor.json")));
}
check("bar and frame gone", !(await targets()).some((t) => /rec(bar|frame)\.html/.test(t.url)));
console.log(failed ? `${failed} FAILED` : "ALL PASS");
process.exit(failed ? 1 : 0);
