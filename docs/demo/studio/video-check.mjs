// The video editor's tools: each is an icon with its name in a tooltip. Opens the editor on the reel's demo recording,
// cuts silences, hovers a tool, and saves out/video-check.png. Usage: node video-check.mjs (after reel.mjs shoot made it)
import { join } from "node:path";
import { demo, open, root, sleep } from "./lib.mjs";

const vid = join(root, "app/node_modules/.studio/reel-walk.mp4");
const p = await open("video.html", { width: 1400, height: 860, dpr: 1, setup: `__studio.handlers = { editor_msg: ({ msg }) => ({ silences: [[4.6, 6.4], [8.8, 9.6]] })[msg.type] ?? null };` });
await sleep(500);
await p.ev(`__studio.emit("host", { type: "load", name: "Orders page walkthrough", path: ${JSON.stringify(vid)}, url: "/node_modules/.studio/reel-walk.mp4", duration: 12, fps: 30, width: 1600, height: 900, hasAudio: true, bytes: 1830000, hasSystem: true, hasMic: true,
  cursor: { moves: [[1, 600, 300, 0]], keys: [[3, "S"]] } })`);
await p.waitFor(`!!document.querySelector(".fx")`, 20000);
const fails = [];
const ok = (name, v) => { console.log(`${v ? "PASS" : "FAIL"} ${name}`); if (!v) fails.push(name); };
const tools = JSON.parse(await p.ev(`JSON.stringify([...document.querySelectorAll("button.tool")].map((b) => [b.getAttribute("aria-label"), b.textContent.trim(), !!b.querySelector("svg")]))`));
ok("every tool is an icon with a name", tools.length >= 18 && tools.every(([l, t, svg]) => l && !t && svg));
await p.ev(`[...document.querySelectorAll("button.tool")].find((b) => b.getAttribute("aria-label") === "Cut silences").click()`);
await p.waitFor(`document.querySelectorAll(".strip .seg").length >= 2`);
ok("cut silences makes parts", true);
await p.waitFor(`!!document.querySelector(".alane svg path")`, 15000).then(() => ok("A1 shows the waveform", true), () => ok("A1 shows the waveform", false));
const c = JSON.parse(await p.ev(`JSON.stringify((() => { const r = [...document.querySelectorAll("button.tool")].find((b) => b.getAttribute("aria-label") === "Split").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })())`));
await p.mouse("mouseMoved", c[0], c[1]);
await sleep(600);
const tip = await p.ev(`document.querySelector(".gb-tip:not([hidden])")?.textContent ?? ""`);
ok(`hover shows the tool's name (${JSON.stringify(tip)})`, tip.startsWith("Split (S)"));
ok("timecode reads hh:mm:ss:ff", /^\d\d:\d\d:\d\d:\d\d$/.test(await p.ev(`document.querySelector(".tc").textContent`)));
await p.shot(join(demo, "out/video-check.png"));
console.log(p.errors.join("\n") || "no page errors");
await p.close();
process.exit(fails.length ? 1 : 0);
