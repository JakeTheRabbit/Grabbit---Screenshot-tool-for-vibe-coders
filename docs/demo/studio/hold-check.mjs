// Holding the capture key: the picker opens on the press, shows a filling "Keep holding to record" pill, goes back
// to normal when the key is let go in time, and turns into the recording picker when it's held long enough.
// Usage: node hold-check.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { demo, extra, open, sleep } from "./lib.mjs";
const W = 2560, H = 1440;
extra.set("grabbit/frame/0", { bytes: readFileSync(join(demo, "out/desktop.rgba")), type: "application/octet-stream" });
const setup = `__studio.handlers = { picker_info: { frame: 0, x: 0, y: 0, width: ${W}, height: ${H}, mode: "Pick", last_rect: null, os: "windows", windows: [] },
  get_settings: { record_microphone: true, record_system_audio: true } };`;
const p = await open("picker.html", { width: 1600, height: 900, dpr: 1.6, setup });
await sleep(300);
await p.ev(`__studio.emit("open", 0)`);
await p.waitFor(`document.body.classList.contains("ready")`);
let fails = 0;
const ok = (name, cond, detail = "") => { if (!cond) fails++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const hint = () => p.ev(`document.getElementById("hint").textContent`);
const normal = await hint();

await p.ev(`__studio.emit("hold", 0.5)`); await sleep(100);
ok("holding shows the record pill", (await hint()).includes("Keep holding to record"));
ok("the pill fills with the hold", (await p.ev(`document.querySelector("#hint .fill").style.width`)) === "50%");
await p.ev(`__studio.emit("hold", -1)`); await sleep(100);
ok("letting go in time puts the normal hint back", (await hint()) === normal);

await p.ev(`__studio.emit("hold", 0.9)`); await sleep(50);
await p.ev(`__studio.emit("picker-mode", "Record")`); await sleep(100);
ok("held long enough: the picker asks for the area to record", (await hint()).startsWith("Drag the area to record"));
await p.drag(200, 200, 700, 500);
await p.waitFor(`!document.getElementById("bar").hidden`);
const main = await p.ev(`document.querySelector("#bar > .btn")?.textContent.trim()`);
ok("the bar's main button records", main === "Record", main);
await p.shot(join(demo, "out", "hold-record.png"));

// A picker switched to Record while an area is already selected rebuilds its bar.
await p.ev(`__studio.emit("picker-mode", "Pick")`); await sleep(200);
const back = await p.ev(`document.querySelector("#bar > .btn")?.textContent.trim()`);
ok("switching mode with an area selected rebuilds the bar", back === "Copy", back);
console.log(p.errors.length ? "PAGE ERRORS:\n" + p.errors.join("\n") : "no page errors");
console.log(fails ? `${fails} FAILED` : "ALL PASS");
await p.close();
process.exit(fails ? 1 : 0);
