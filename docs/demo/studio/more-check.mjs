// Opens the picker on the reel's frozen desktop, drags an area, opens More and saves a picture of the bar and menu.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { demo, extra, open, sleep } from "./lib.mjs";

const K = 1.6;
extra.set("grabbit/frame/0", { bytes: readFileSync(join(demo, "out/reel/desk-fixed.rgba")), type: "application/octet-stream" });
const p = await open("picker.html", { width: 1600, height: 900, dpr: K, setup: `__studio.handlers = {
  picker_info: { frame: 0, x: 0, y: 0, width: ${1600 * K}, height: ${900 * K}, mode: "Pick", last_rect: null, os: "windows", windows: [] },
  get_settings: { record_microphone: true, record_system_audio: true } };` });
await sleep(300);
await p.ev(`__studio.emit("open", 0)`);
await p.waitFor(`document.body.classList.contains("ready")`);
await p.drag(260, 150, 1040, 420);
await p.waitFor(`!document.getElementById("bar").hidden`);
await p.ev(`[...document.querySelectorAll("#bar button")].find((b) => b.textContent.trim() === "More").click()`);
await sleep(200);
console.log(await p.ev(`JSON.stringify([...document.querySelectorAll("#bar .menu button")].map((b) => b.textContent.trim()))`));
await p.shot(join(demo, "out/more-check.png"));
console.log(p.errors.join("\n") || "no errors");
await p.close();
process.exit(0);
