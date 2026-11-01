// Renders desktop.html into the studio's frozen "screen": out/desktop.png (2560×1440) and its raw RGBA bytes for the picker.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { demo, open, sleep } from "./lib.mjs";

const out = join(demo, "out");
mkdirSync(out, { recursive: true });
const p = await open("http://studio.local/demo/desktop.html", { width: 1600, height: 900, dpr: 1.6 });
await sleep(1200);
await p.shot(join(out, "desktop.png"));
await p.close();
execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", join(out, "desktop.png"), "-f", "rawvideo", "-pix_fmt", "rgba", join(out, "desktop.rgba")]);
console.log("frame ready");
