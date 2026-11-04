// The new editor's library and vertical tabs in each layout (docks, views, toolbar sides), with made-up captures over
// three days, recordings and folders. Saves one picture per layout and checks the library keeps its size.
// Usage: node library-check.mjs [outdir]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { demo, open, sleep } from "./lib.mjs";
const out = process.argv[2] ?? join(demo, "out", "library");
mkdirSync(out, { recursive: true });
const asset = (f) => `http://studio.local/asset/${encodeURIComponent(f.replaceAll("\\", "/"))}`;
const shots = ["hero.webp", "editor.webp", "ai.webp", "talk.webp", "tools.webp", "settings.png", "quick.webp", "batch.webp"].map((f) => join(demo, "../screenshots", f));
const day = (d, h, m) => `2026-11-0${d}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
const recent = [
  ...shots.map((f, i) => ({ path: f, url: asset(f), name: `Grabbit 2026-11-0${4 - (i % 3)} ${10 + i}.0${i}.webp`, time: day(4 - (i % 3), 10 + i, i), kind: "capture", bytes: 90000 + i * 31000 })),
  { path: join(demo, "out/demo.mp4"), url: "", name: "Grabbit 2026-11-03 21.10.mp4", time: day(3, 21, 10), kind: "video", bytes: 4200000 },
  { path: join(demo, "out/walkthrough.mp4"), url: "", name: "Grabbit 2026-11-02 09.30.mp4", time: day(2, 9, 30), kind: "video", bytes: 8100000 },
];
const folders = [{ name: "Bug reports", paths: [shots[0], shots[3]] }, { name: "Docs", paths: [shots[1]] }];
const setup = `localStorage.setItem("editor", "markup"); ["library", "libraryDock", "tabsAt", "tabsSlim", "barPos"].forEach((k) => localStorage.removeItem(k));
  localStorage.setItem("libraryFolders", ${JSON.stringify(JSON.stringify(folders))});
  __studio.handlers = { editor_msg: () => null, get_settings: { metadata: {}, branding: {} } };`;

const p = await open("index.html", { width: 1440, height: 880, dpr: 1, setup });
await p.waitFor(`!!window.grabbit?.receive`);
await p.ev(`(async () => { const b = await (await fetch(${JSON.stringify(asset(shots[0]))})).blob();
  const d = await new Promise((ok) => { const f = new FileReader(); f.onload = () => ok(f.result); f.readAsDataURL(b); });
  window.grabbit.receive({ type: "load", name: "Grabbit 2026-11-04 10.00", dataURL: d, width: 1600, height: 900, recent: ${JSON.stringify(recent)} });
  window.grabbit.receive({ type: "addTab", name: "Second capture", dataURL: d, width: 1600, height: 900 });
  window.grabbit.receive({ type: "addTab", name: "Third one with a long name", dataURL: d, width: 1600, height: 900 }); })()`);
await sleep(1500);
let fails = 0;
const ok = (name, cond, detail = "") => { if (!cond) fails++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const rect = (sel) => p.ev(`JSON.stringify(document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect())`).then((r) => r && JSON.parse(r));
const clickSel = (sel) => p.ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
const pick = async (label) => { await p.ev(`[...document.querySelectorAll(".dropdown button")].find((b) => b.textContent.startsWith(${JSON.stringify(label)})).click()`); await sleep(500); };
const layoutMenu = async (label) => { await p.ev(`document.querySelector('header.bar [title="Move the toolbar"], header.bar [data-tip="Move the toolbar"]').click()`); await sleep(200); await pick(label); };

ok("days are grouped with the weekday", /Tuesday|Monday|Wednesday/.test(await p.ev(`document.querySelector(".lib-group h4")?.textContent ?? ""`)));
ok("recordings are listed", (await p.ev(`document.querySelectorAll(".lib-item.video").length`)) === 2);
ok("vertical tabs show every open picture", (await p.ev(`document.querySelectorAll(".vtab").length`)) === 3);
await p.shot(join(out, "1-left-small.png"));

const w0 = (await rect(".lib")).width;
const h = await rect(".lib-resize");
await p.drag(h.x + h.width / 2, h.y + 200, h.x + h.width / 2 + 180, h.y + 200);
await sleep(300);
const w1 = (await rect(".lib")).width;
ok("dragging the edge widens the library", w1 > w0 + 150, `${w0} → ${w1}`);
const t1 = (await rect(".lib-pic")).width;
await p.ev(`document.querySelector('.lib-seg button[aria-label="Big pictures"]').click()`); await sleep(300);
ok("big pictures are bigger", (await rect(".lib-pic")).width > t1 + 20);
await p.shot(join(out, "2-left-large-wide.png"));
await p.ev(`document.querySelector('.lib-seg button[aria-label^="List"]').click()`); await sleep(300);
await p.shot(join(out, "3-list.png"));

await p.ev(`document.querySelector('.lib-seg button[aria-label="Recordings only"]').click()`); await sleep(300);
ok("Recordings only shows just videos", (await p.ev(`document.querySelectorAll(".lib-item").length`)) === 2 && (await p.ev(`document.querySelectorAll(".lib-item:not(.video)").length`)) === 0);
await p.ev(`document.querySelector('.lib-seg button[aria-label="Pictures and recordings"]').click()`); await sleep(200);
await p.ev(`[...document.querySelectorAll(".lib-folders .chip")].find((b) => b.textContent.includes("Bug reports")).click()`); await sleep(300);
ok("a folder shows only its pictures", (await p.ev(`document.querySelectorAll(".lib-item").length`)) === 2);
await p.ev(`[...document.querySelectorAll(".lib-folders .chip")][0].click()`); await sleep(200);
await p.ev(`(() => { const i = document.querySelector(".lib-day input"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, "2026-11-03"); i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new Event("change", { bubbles: true })); })()`); await sleep(300);
ok("the calendar shows one day", (await p.ev(`[...document.querySelectorAll(".lib-group h4")].map((h) => h.textContent).join("|")`)).split("|").length === 1);
await p.shot(join(out, "4-one-day.png"));
await p.ev(`document.querySelector(".lib-day button").click()`); await sleep(200);
await p.ev(`document.querySelector('.lib-seg button[aria-label="Small pictures"]').click()`); await sleep(200);

// Toolbar on other sides must leave the library alone.
for (const side of ["right", "bottom", "left", "top"]) {
  await layoutMenu(`Toolbar on the ${side}`);
  const r = await rect(".lib");
  const c = await rect(".canvas.mk");
  ok(`toolbar on the ${side}: library keeps its size, stays on screen, picture beside it`, Math.abs(r.width - w1) < 2 && r.height > 500 && r.left >= 0 && c.left >= r.right && c.right <= 1440, `${Math.round(r.left)}..${Math.round(r.right)} × ${Math.round(r.height)}, picture ${Math.round(c.left)}..${Math.round(c.right)}`);
  if (side !== "top") await p.shot(join(out, `5-toolbar-${side}.png`));
}
for (const d of ["right", "bottom", "top", "left"]) {
  await layoutMenu(`Captures on the ${d}`);
  const r = await rect(".lib"), c = await rect(".canvas.mk");
  ok(`captures on the ${d}: library and picture side by side`, r && c && (d === "right" ? r.left >= c.right - 1 : d === "left" ? r.right <= c.left + 1 : d === "top" ? r.bottom <= c.top + 1 : r.top >= c.bottom - 1));
  if (d !== "left") await p.shot(join(out, `6-captures-${d}.png`));
}
await layoutMenu("Tabs across the top"); await sleep(300);
ok("tabs across the top", (await p.ev(`document.querySelectorAll(".doctab").length`)) === 3 && !(await p.ev(`!!document.querySelector(".vtabs")`)));
await layoutMenu("Tabs down the side");
await clickSel(".vtabs-head button"); await sleep(300);
await p.shot(join(out, "7-slim-tabs.png"));
console.log(p.errors.length ? "PAGE ERRORS:\n" + p.errors.join("\n") : "no page errors");
console.log(fails ? `${fails} FAILED` : "ALL PASS");
await p.close();
process.exit(fails ? 1 : 0);
