// The picker's action bar and multi-area capture: labels and tooltips, the shape/size list, Add another area,
// Ctrl+drag, an area kept on another screen, and what Copy sends to the core. Usage: node picker-check.mjs [outdir]
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { demo, extra, open, sleep } from "./lib.mjs";
const out = process.argv[2] ?? join(demo, "out", "picker");
mkdirSync(out, { recursive: true });
const K = 1.6, W = 2560, H = 1440;
extra.set("grabbit/frame/0", { bytes: readFileSync(join(demo, "out/desktop.rgba")), type: "application/octet-stream" });
const setup = `__studio.handlers = { picker_info: { frame: 0, x: 0, y: 0, width: ${W}, height: ${H}, mode: "Pick", last_rect: null, os: "windows", windows: [] },
  get_settings: { record_microphone: true, record_system_audio: true } };`;
const p = await open("picker.html", { width: 1600, height: 900, dpr: K, setup });
await sleep(300);
await p.ev(`__studio.emit("open", 0)`);
await p.waitFor(`document.body.classList.contains("ready")`);
let fails = 0;
const ok = (name, cond, detail = "") => { if (!cond) fails++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const J = async (code) => JSON.parse(await p.ev(`JSON.stringify(${code})`));
const ctrlDrag = async (x0, y0, x1, y1) => {
  const m = (type, x, y, buttons) => p.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1, modifiers: 2 });
  await m("mouseMoved", x0, y0, 0); await m("mousePressed", x0, y0, 1);
  for (let i = 1; i <= 10; i++) { await m("mouseMoved", x0 + (x1 - x0) * i / 10, y0 + (y1 - y0) * i / 10, 1); await sleep(12); }
  await m("mouseReleased", x1, y1, 0);
};

await p.drag(120, 120, 520, 400);
await p.waitFor(`!document.getElementById("bar").hidden`);
const labels = await J(`[...document.querySelectorAll("#bar > .btn")].map((b) => b.textContent.trim()).filter(Boolean)`);
ok("bar says what each button does", ["Copy", "Copy smaller", "Copy for chat", "Mark up", "Save as…", "Record video", "Add another area", "Talk to AI"].every((l) => labels.includes(l)), labels.join(" | "));
ok("every bar button has a tooltip", await p.ev(`[...document.querySelectorAll("#bar button, #bar select, #bar .menu button")].every((b) => (b.title || b.dataset.tip || "").length > 10)`));
const sel = await J(`(() => { const s = document.querySelector('#bar select[title^="Shape"]'); const o = getComputedStyle(s.options[1]); return { text: s.options[0].text, fg: o.color, bg: o.backgroundColor }; })()`);
ok("size list reads 'Any size' and its options aren't white on white", sel.text === "Any size" && sel.fg !== sel.bg, JSON.stringify(sel));
await p.mouse("mouseMoved", 0, 0);
await p.mouse("mouseMoved", await p.ev(`(() => { const r = [...document.querySelectorAll("#bar .btn")].find((b) => b.textContent.includes("Add another")).getBoundingClientRect(); return r.x + r.width / 2; })()`), await p.ev(`(() => { const r = [...document.querySelectorAll("#bar .btn")].find((b) => b.textContent.includes("Add another")).getBoundingClientRect(); return r.y + r.height / 2; })()`));
await sleep(700);
ok("hovering shows an in-page tooltip", await p.ev(`!!document.querySelector(".gb-tip:not([hidden])")?.textContent.includes("any screen")`));
await p.shot(join(out, "1-bar.png"));

await p.ev(`[...document.querySelectorAll("#bar .btn")].find((b) => b.textContent.includes("Add another")).click()`);
await sleep(200);
ok("Add another area keeps the first", (await J(`document.getElementById("hint").textContent`)).includes("1 area kept"));
await p.drag(700, 150, 1000, 420);
await sleep(200);
await ctrlDrag(1100, 500, 1450, 800);
await sleep(300);
ok("Ctrl+drag adds a third area (no jump to the editor)", (await J(`document.getElementById("hint").textContent`)).includes("2 areas kept") || (await J(`__studio.calls.filter((c) => c[0] === "picked").length`)) === 0);
// An area kept on another screen arrives as an event.
await p.ev(`(() => { const last = __studio.calls.filter((c) => c[0] === "plugin:event|emit" && c[1].event === "picker-kept").at(-1)[1].payload;
  __studio.emit("picker-kept", [...last, [3000, 200, 400, 300]]); })()`);
await sleep(200);
const layout = await J(`document.querySelector('#bar select[title^="What to do"]')?.value`);
ok("several areas default to separate pictures", layout === "separate", String(layout));
await p.shot(join(out, "2-three-areas.png"));
await p.key("Enter", "Enter", 13);
await sleep(300);
const picked = await J(`__studio.calls.find((c) => c[0] === "picked")?.[1]?.pick`);
ok("Copy sends every area, including the one on the other screen", picked?.action === "copy" && picked.extra.length === 3 && picked.extra.some((r) => r[0] === 3000) && picked.layout === "separate", JSON.stringify(picked));
console.log(p.errors.length ? "PAGE ERRORS:\n" + p.errors.join("\n") : "no page errors");
console.log(fails ? `${fails} FAILED` : "ALL PASS");
await p.close();
process.exit(fails ? 1 : 0);
