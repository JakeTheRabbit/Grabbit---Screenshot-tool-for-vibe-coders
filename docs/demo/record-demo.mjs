// Makes docs/demo/out/demo.mp4 for the README: headless Edge plays demo.html, frames are grabbed over CDP, ffmpeg
// turns them into 30 fps H.264 with two titled audio tracks ("System sound" tone, quiet "Microphone") like a Grabbit
// recording, so the video editor shows its Sound picker. Usage: node record-demo.mjs [seconds]
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)), out = join(here, "out"), frames = join(out, "frames");
const seconds = Number(process.argv[2] ?? 7), port = 9444, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });

const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const browser = spawn(edge, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=1600,900",
  `--remote-debugging-port=${port}`, `--user-data-dir=${join(process.env.TEMP, "grabbit-edge-rec")}`, "about:blank"]);
let target;
for (let i = 0; i < 60 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch {}
  if (!target) await sleep(250);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const waiting = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); waiting.get(m.id)?.(m); waiting.delete(m.id); });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "file:///" + join(here, "demo.html").replaceAll("\\", "/") });
// Grab as fast as Edge renders; each frame keeps its real timestamp, so the video plays at true speed.
const list = [];
const t0 = Date.now();
for (let n = 0; Date.now() - t0 < seconds * 1000; n++) {
  const at = Date.now();
  const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 92 });
  if (!shot.result) { if (n === 0) console.log("waiting for the page:", shot.error?.message); n--; await sleep(30); continue; }   // still navigating
  const file = join(frames, `f${String(n).padStart(5, "0")}.jpg`);
  writeFileSync(file, Buffer.from(shot.result.data, "base64"));
  list.push({ file, at: (at - t0) / 1000 });
}
ws.close();
browser.kill();

// ffconcat with per-frame durations → constant 30 fps.
const lines = ["ffconcat version 1.0"];
list.forEach((f, i) => lines.push(`file '${f.file.replaceAll("\\", "/")}'`, `duration ${((list[i + 1]?.at ?? seconds) - f.at).toFixed(4)}`));
lines.push(`file '${list.at(-1).file.replaceAll("\\", "/")}'`);
writeFileSync(join(frames, "list.ffconcat"), lines.join("\n"));
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(frames, "list.ffconcat"),
  "-f", "lavfi", "-i", `sine=frequency=330:sample_rate=48000:duration=${seconds},volume=0.08,tremolo=f=2:d=0.6`,
  "-f", "lavfi", "-i", `anoisesrc=color=pink:amplitude=0.01:sample_rate=48000:duration=${seconds}`,
  "-map", "0:v", "-map", "1:a", "-map", "2:a", "-r", "30", "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "128k", "-metadata:s:a:0", "handler_name=System sound", "-metadata:s:a:1", "handler_name=Microphone",
  "-shortest", "-movflags", "+faststart", join(out, "demo.mp4")], { stdio: "inherit" });
rmSync(frames, { recursive: true, force: true });
console.log(`demo.mp4: ${list.length} frames over ${seconds} s`);
