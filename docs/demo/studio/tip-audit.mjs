// Lists controls without a tooltip on each page (buttons, selects, inputs). Usage: node tip-audit.mjs
import { open, sleep } from "./lib.mjs";
const pages = [
  ["index.html", `localStorage.setItem("editor", "markup"); __studio.handlers = { editor_msg: () => null, get_settings: { metadata: {}, branding: {} } };`],
  ["video.html", `__studio.handlers = { editor_msg: () => null, get_settings: {} };`],
  ["settings.html", `__studio.handlers = { get_settings: { hotkeys: {}, ai: {}, metadata: {}, branding: {}, share: {} }, autostart_get: false };`],
  ["voice.html?p=x&mic=Test", `__studio.handlers = { voice_level: 0 };`],
];
const audit = `[...document.querySelectorAll("button, select, input:not([type=hidden]), [role=tab]")].filter((b) => b.offsetParent && !(b.title || b.dataset.tip || b.closest("[title],[data-tip]"))).map((b) => (b.tagName + " " + (b.getAttribute("aria-label") || b.textContent.trim() || b.type || b.name || b.id)).slice(0, 60))`;
for (const [page, setup] of pages) {
  const p = await open(page, { width: 1360, height: 860, dpr: 1, setup });
  await sleep(1500);
  const missing = JSON.parse(await p.ev(`JSON.stringify(${audit})`));
  console.log(`== ${page}: ${missing.length} without a tooltip`);
  for (const m of missing) console.log("   ", m);
  await p.close();
}
process.exit(0);
