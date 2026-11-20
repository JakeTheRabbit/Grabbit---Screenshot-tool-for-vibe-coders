// Renders the recording bar and frame during the countdown, and the bar once recording, with Start over.
import { join } from "node:path";
import { demo, open, sleep } from "./lib.mjs";

const setup = `__studio.handlers = { rec_status: { recording: true, paused: false, elapsed: 7, area: null }, rec_control: null };`;
const bar = await open("recbar.html?count=3", { width: 340, height: 44, dpr: 2, setup });
await sleep(300);
console.log("bar, counting:", await bar.ev(`document.querySelector(".time").textContent`));
await bar.shot(join(demo, "out/recbar-count.png"));
await sleep(3300);
console.log("bar, recording:", await bar.ev(`document.querySelector(".time").textContent`), "| buttons:", await bar.ev(`[...document.querySelectorAll("button")].map((b) => b.title).join(" / ")`));
await bar.shot(join(demo, "out/recbar.png"));
const frame = await open("recframe.html?count=3", { width: 640, height: 360, dpr: 1, setup });
await sleep(1300);
console.log("frame:", await frame.ev(`document.querySelector(".count").textContent`));
await frame.shot(join(demo, "out/recframe-count.png"));
console.log([...bar.errors, ...frame.errors].join("\n") || "no errors");
await bar.close(); await frame.close();
process.exit(0);
