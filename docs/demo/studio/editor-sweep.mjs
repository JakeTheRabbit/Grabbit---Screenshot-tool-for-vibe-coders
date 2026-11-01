// Drives the picture editor's own buttons with real mouse clicks (studio headless Chrome, faked Grabbit core) and
// checks the scene after each. Prints PASS/FAIL per check. Usage: node editor-sweep.mjs [outdir]
import { join } from "node:path";
import { demo, open, sleep } from "./lib.mjs";
const out = process.argv[2] ?? join(demo, "out");
const img = join(demo, "out/desktop.png").replaceAll("\\", "/");   // node frame.mjs makes it
const asset = (f) => `http://studio.local/asset/${encodeURIComponent(f)}`;

// Fake core: OCR finds one email at picture px (200,100); exports/AI recorded; AI edit returns a solid red picture.
const setup = `
  window.__red = (() => { const c = document.createElement("canvas"); c.width = 2560; c.height = 1440; const g = c.getContext("2d"); g.fillStyle = "#f00"; g.fillRect(0, 0, 2560, 1440); return c.toDataURL(); });
  __studio.handlers = {
    editor_msg: ({ msg }) => ({
      ocr: [{ text: "ben@example.com", x: 200, y: 100, width: 300, height: 40, line: 0 }, { text: "hello", x: 200, y: 200, width: 100, height: 40, line: 1 }],
      exportFile: "C:/tmp/out.png", qr: ["https://example.com"], checkMark: { found: false },
    })[msg.type] ?? null,
    ai_edit: () => window.__red(), ai_ask: "An answer", ai_describe: { summary: "A desktop", tags: ["demo"] },
    get_settings: { metadata: { strip: true, author: "", copyright: "" }, branding: { invisible_mark: false, on_images: false, logo_path: "" } },
    share_targets: [], copy_text: null, set_settings: null,
  };`;

let fails = 0;
const ok = (name, cond, detail = "") => { if (!cond) fails++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

const p = await open("index.html", { width: 1360, height: 860, dpr: 1, setup });
await p.waitFor(`window.grabbit?.api && window.grabbit.receive`);
await p.ev(`(async () => { const b = await (await fetch(${JSON.stringify(asset(img))})).blob();
  window.__d = await new Promise((ok) => { const f = new FileReader(); f.onload = () => ok(f.result); f.readAsDataURL(b); });
  window.grabbit.receive({ type: "load", name: "Sweep", dataURL: __d, width: 2560, height: 1440,
    recent: [{ path: ${JSON.stringify(img)}, url: ${JSON.stringify(asset(img))}, name: "desktop.png", time: "2026-11-02T08:00:00", kind: "capture" },
             { path: ${JSON.stringify(img + "2")}, url: ${JSON.stringify(asset(img))}, name: "copy.png", time: "2026-11-02T08:01:00", kind: "copied" }] }); })()`);
await p.waitFor(`window.grabbit.api.getSceneElements().length > 0`);
await sleep(500);

const J = async (code) => JSON.parse(await p.ev(`JSON.stringify(${code})`));
const els = () => J(`window.grabbit.api.getSceneElements().map((e) => ({ id: e.id, type: e.type, x: e.x, y: e.y, w: e.width, h: e.height, bg: e.backgroundColor, cd: e.customData ?? null, locked: e.locked, text: e.text, fileId: e.fileId }))`);
const sel = () => J(`Object.keys(window.grabbit.api.getAppState().selectedElementIds)`);
const toScreen = async (e) => J(`(() => { const s = window.grabbit.api.getAppState(), z = s.zoom.value; return [(${e.x + e.w / 2} + s.scrollX) * z + s.offsetLeft, (${e.y + e.h / 2} + s.scrollY) * z + s.offsetTop]; })()`);
const clickEl = async (e) => { const [x, y] = await toScreen(e); await p.click(x, y); await sleep(150); };
const btnAt = async (text, scope = "body") => J(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope + " button")})].find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)})); if (!b) return null; const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
const clickBtn = async (text, scope) => { const c = await btnAt(text, scope); if (!c) throw new Error(`no button "${text}"`); await p.click(c[0], c[1]); await sleep(200); };
const menu = async (label, item) => { await clickBtn(label, "header.bar"); await clickBtn(item, ".dropdown"); await sleep(300); };
const toast = () => p.ev(`document.querySelector(".Toast")?.textContent ?? ""`);
const deselect = () => p.ev(`window.grabbit.api.updateScene({ appState: { selectedElementIds: {} } })`);
const base = async () => (await els()).find((e) => e.id === "grabbit-base");
/** A box drawn in picture coordinates, left selected — like drawing it with the rectangle tool. */
const box = async (x, y, w, h, select = true) => J(`(() => { const api = window.grabbit.api, b = api.getSceneElements().find((e) => e.id === "grabbit-base");
  const [el] = window.grabbit.convert([{ type: "rectangle", x: b.x + ${x}, y: b.y + ${y}, width: ${w}, height: ${h}, strokeColor: "#e03131" }]);
  api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), el], appState: { selectedElementIds: ${select} ? { [el.id]: true } : {} }, captureUpdate: "IMMEDIATELY" });
  return el.id; })()`);
const undo = async () => { await p.key("z", "KeyZ", 90); }; // with ctrl below
const ctrlKey = async (key, code, vk, shift = false) => {
  const mod = 2 | (shift ? 8 : 0);
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, modifiers: mod });
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers: mod });
  await sleep(200);
};

const step = async (name, f) => { try { await f(); } catch (e) { fails++; console.log(`FAIL  ${name} threw: ${e.message}`); } };

await step("fit", async () => {
  await p.ev(`window.grabbit.api.setActiveTool({ type: "rectangle" })`); await sleep(200);
  const r = await J(`(() => { const s = window.grabbit.api.getAppState(), e = window.grabbit.api.getSceneElements()[0]; return [(e.x + s.scrollX) * s.zoom.value + s.offsetLeft, document.querySelector(".App-menu__left")?.getBoundingClientRect().right ?? 0]; })()`);
  ok("picture clear of style panel", r[0] > r[1], `img left ${r[0].toFixed(0)} vs panel ${r[1].toFixed(0)}`);
  await p.ev(`window.grabbit.api.setActiveTool({ type: "selection" })`);
});

await step("steps", async () => {
  for (let i = 0; i < 3; i++) { await deselect(); await clickBtn("Step", "header.bar"); }
  const s = (await els()).filter((e) => e.cd?.grabbitStep);
  ok("3 step badges numbered 1..3", s.map((e) => e.cd.grabbitStep).join() === "1,2,3", s.map((e) => e.cd.grabbitStep).join());
  const zoom = await p.ev(`window.grabbit.api.getAppState().zoom.value`);
  ok("step badge ≥ 40px on screen", s[0].w * zoom >= 40, `${(s[0].w * zoom).toFixed(0)}px`);
  let each = true;
  for (const e of s) { await deselect(); await clickEl(e); const sl = await sel(); if (!sl.includes(e.id)) each = false; }
  ok("each step badge selectable by click", each);
  // delete step 2, next should be 4
  await p.ev(`(() => { const api = window.grabbit.api; api.updateScene({ elements: api.getSceneElementsIncludingDeleted().map((e) => e.customData?.grabbitStep === 2 ? { ...e, isDeleted: true } : e) }); })()`);
  await deselect(); await clickBtn("Step", "header.bar");
  const s2 = (await els()).filter((e) => e.cd?.grabbitStep).map((e) => e.cd.grabbitStep);
  ok("after deleting #2 next step is 4", s2.includes(4) && s2.filter((n) => n === 3).length === 1, s2.join());
});

await step("hide", async () => {
  await deselect();
  // Pixelate via the real menu
  const id = await box(100, 1100, 300, 150);
  await menu("Hide", "Pixelate");
  let e = await els();
  const patch = e.find((x) => x.type === "image" && x.cd?.redact);
  ok("Pixelate: box replaced by patch", !!patch && !e.find((x) => x.id === id));
  // select the patch by clicking it, then Black out
  await deselect(); await clickEl(patch);
  ok("patch selectable by click", (await sel()).includes(patch.id));
  await menu("Hide", "Black out");
  e = await els();
  const blk = e.find((x) => x.type === "rectangle" && x.bg === "#000000" && Math.abs(x.x - patch.x) < 1);
  ok("Black out on a patch → black box, patch gone", !!blk && !e.find((x) => x.id === patch.id));
  // black box → Blur
  await deselect(); await clickEl(blk);
  await menu("Hide", "Blur");
  e = await els();
  ok("Blur on a black box → patch", !!e.find((x) => x.type === "image" && x.cd?.redact && Math.abs(x.x - blk.x) < 1) && !e.find((x) => x.id === blk.id));
  // undo restores the black box
  await ctrlKey("z", "KeyZ", 90);
  e = await els();
  ok("Ctrl+Z after Blur brings the black box back", !!e.find((x) => x.id === blk.id));
  // nothing selected → tip toast, no crash
  await deselect();
  await menu("Hide", "Pixelate");
  ok("Pixelate with nothing selected shows the tip", /Draw a box/.test(await toast()), await toast());
  // Auto-hide then Black out the result
  await menu("Hide", "Hide private details");
  e = await els();
  const auto = e.find((x) => x.cd?.grabbitHidden);
  ok("Auto-hide pixelates the email", !!auto, (await toast()).slice(0, 60));
  if (auto) { await deselect(); await clickEl(auto); await menu("Hide", "Black out"); ok("Black out on an auto-hide patch", !(await els()).find((x) => x.id === auto.id)); }
});

await step("spotlight", async () => {
  await deselect();
  const before = (await els()).length;
  await box(300, 300, 400, 300);
  await menu("Hide", "Spotlight");
  const e = await els();
  const i = e.findIndex((x) => x.locked && x.type === "image" && x.id !== "grabbit-base");
  ok("Spotlight adds a dimming layer right above the picture", i === 1, `index ${i}`);
  ok("Spotlight removes its box", e.length === before + 1 - 0, `${before} → ${e.length}`);
  // things drawn earlier are still clickable on top
  const step1 = e.find((x) => x.cd?.grabbitStep === 1);
  await deselect(); await clickEl(step1);
  ok("earlier step still selectable after Spotlight", (await sel()).includes(step1.id));
  await ctrlKey("z", "KeyZ", 90);
});

await step("menus", async () => {
  await clickBtn("Hide", "header.bar");
  ok("Hide menu opens", await p.ev(`!!document.querySelector(".dropdown")`));
  await p.click(900, 780); await sleep(200);
  ok("clicking the canvas closes it", !(await p.ev(`!!document.querySelector(".dropdown")`)));
  await clickBtn("Hide", "header.bar"); await clickBtn("▾", ".split:has(.primary)").catch(() => {});
  ok("opening Copy's menu closes Hide's", (await p.ev(`document.querySelectorAll(".dropdown").length`)) <= 1);
  await p.click(900, 780); await sleep(200);
});

await step("copy/save", async () => {
  const sent = () => J(`(window.grabbitOutbox ?? []).filter((m) => m.type === "export").map((m) => [m.action, m.size, m.dataURL.length > 1000])`);
  await p.ev(`window.grabbitOutbox = []`);
  await clickBtn("Copy", "header.bar"); await sleep(800);
  await menu("▾", "Copy smaller");  await sleep(800);
  await clickBtn("Save", "header.bar"); await sleep(800);
  const s = await sent();
  ok("Copy / Copy smaller / Save send exports", JSON.stringify(s) === JSON.stringify([["copy", "Full", true], ["copy", "Reduced", true], ["saveQuick", "Full", true]]), JSON.stringify(s));
  await p.ev(`window.grabbitOutbox = []`);
  await ctrlKey("s", "KeyS", 83);
  await sleep(800);
  ok("Ctrl+S saves", JSON.stringify(await sent()) === JSON.stringify([["saveQuick", "Full", true]]), JSON.stringify(await sent()));
  await p.ev(`__studio.calls.length = 0`);
  await menu("▾", "Copy text"); await sleep(500);
  const ct = await J(`__studio.calls.filter(([c]) => c === "copy_text").map(([, a]) => a.text)`);
  ok("Copy text in the picture → clipboard", ct[0] === "ben@example.com\nhello", JSON.stringify(ct));
});

await step("stickers", async () => {
  await clickBtn("Stickers", "header.bar");
  const n0 = (await els()).length;
  const c = await J(`(() => { const r = document.querySelector(".stickers .emoji button").getBoundingClientRect(); return [r.left + 5, r.top + 5]; })()`);
  await p.click(c[0], c[1]); await sleep(300);
  ok("emoji added and picker closed", (await els()).length === n0 + 1 && !(await p.ev(`!!document.querySelector(".stickers")`)));
});

await step("beautify", async () => {
  await clickBtn("Beautify", "header.bar");
  ok("Beautify panel opens", await p.ev(`!!document.querySelector(".panel")`));
  const c = await J(`(() => { const r = document.querySelector(".swatches button").getBoundingClientRect(); return [r.left + 8, r.top + 8]; })()`);
  await p.click(c[0], c[1]);
  await p.waitFor(`!!document.querySelector(".bpreview")?.naturalWidth`, 8000).catch(() => {});
  ok("picking a background turns it on and shows a preview", await p.ev(`!!document.querySelector(".bpreview")?.naturalWidth && document.querySelector(".panel input[type=checkbox]").checked`));
  const dims = JSON.parse(await p.ev(`(async () => { const u = await window.grabbitRender(); const i = new Image(); await new Promise((r) => { i.onload = r; i.src = u; }); return JSON.stringify([i.width, i.height]); })()`));
  const b = await base();
  ok("copies come out beautified (bigger than the picture)", dims[0] > b.w && dims[1] > b.h, `${dims} vs ${b.w}×${b.h}`);
  await p.shot(`${out}/sweep-beautify.png`);
  const cb = await J(`(() => { const r = document.querySelector(".panel input[type=checkbox]").getBoundingClientRect(); return [r.left + 8, r.top + 8]; })()`);
  await p.click(cb[0], cb[1]); await sleep(400);
  ok("unticking removes the preview", !(await p.ev(`!!document.querySelector(".bpreview")`)));
  await clickBtn("×", ".panel");
});

await step("ai", async () => {
  await clickBtn("AI", "header.bar");
  const b0 = (await base()).fileId;
  await clickBtn("Remove background", ".panel"); await sleep(600);
  ok("Remove background swaps the picture", (await base()).fileId !== b0);
  await ctrlKey("z", "KeyZ", 90);
  ok("Ctrl+Z restores the picture", (await base()).fileId === b0);
  await deselect();
  const id = await box(600, 400, 200, 100);
  await clickBtn("Remove what's in the box", ".panel"); await sleep(600);
  ok("Remove in box: picture swapped and marking box removed", (await base()).fileId !== b0 && !(await els()).find((x) => x.id === id));
  await deselect();
  await clickBtn("Remove what's in the box", ".panel"); await sleep(300);
  ok("no box → tip", /Draw a box/.test(await toast()), await toast());
  await ctrlKey("z", "KeyZ", 90);
  await clickBtn("×", ".panel");
});

await step("info", async () => {
  await clickBtn("Info", "header.bar"); await sleep(300);
  ok("Info panel shows size", /2560 × 1440/.test(await p.ev(`document.querySelector(".panel")?.textContent ?? ""`)));
  await clickBtn("×", ".panel");
});

await step("sidebar", async () => {
  await clickBtn("Copied", ".strip");
  ok("thumbnails have Insert and New tab buttons", !!(await btnAt("Insert", ".thumbs")) && !!(await btnAt("New tab", ".thumbs")));
  ok("Copied tab lists copied items", (await p.ev(`document.querySelectorAll(".thumbs .thumb").length`)) === 1);
  await clickBtn("Captures", ".strip");
  ok("Captures tab lists captures", (await p.ev(`document.querySelectorAll(".thumbs .thumb").length`)) === 1);
  // Open as a new tab (core answers getImage with the same picture)
  await p.ev(`__studio.handlers.editor_msg = ((orig) => (a) => { if (a.msg.type === "getImage") { setTimeout(() => window.grabbit.receive({ type: "image", reqId: a.msg.reqId, dataURL: __d, width: 2560, height: 1440 }), 10); return null; } return orig(a); })(__studio.handlers.editor_msg)`);
  const n0 = (await els()).length;
  await clickBtn("New tab", ".thumbs"); await sleep(800);
  ok("Open makes a second tab", (await p.ev(`document.querySelectorAll(".doctab").length`)) === 2);
  ok("new tab starts with just its picture", (await els()).length === 1);
  await p.ev(`document.querySelectorAll(".doctab")[0].click()`); await sleep(400);
  ok("switching back keeps the first tab's drawings", (await els()).length === n0, `${n0} vs ${(await els()).length}`);
  await p.shot(`${out}/sweep-tabs.png`);
});

await step("talk", async () => {
  await p.ev(`__studio.calls.length = 0`);
  await clickBtn("Talk", "header.bar"); await sleep(800);
  const v = await J(`__studio.calls.filter(([c]) => c === "voice_open").map(([, a]) => a.path)`);
  ok("Talk button opens Talk to AI with the edited picture", v[0] === "C:/tmp/out.png", JSON.stringify(v));
});
await step("close tabs", async () => {
  // close both tabs with their ×
  for (let i = 0; i < 2; i++) { await p.ev(`document.querySelector(".doctab .x").click()`); await sleep(600); }
  ok("closing every tab leaves a blank editor", (await p.ev(`document.querySelectorAll(".doctab").length`)) === 0 && (await p.ev(`!!document.querySelector(".blank")`)) && (await els()).length === 0);
  ok("window not closed", !(await J(`(window.grabbitOutbox ?? []).some((m) => m.type === "close")`)));
  await clickBtn("Insert", ".thumbs"); await sleep(800);
  ok("Insert with nothing open opens it as a tab", (await p.ev(`document.querySelectorAll(".doctab").length`)) === 1 && !(await p.ev(`!!document.querySelector(".blank")`)));
  await p.shot(`${out}/sweep-reopen.png`);
});
console.log(p.errors.length ? "PAGE ERRORS:\n" + p.errors.join("\n") : "no page errors");
console.log(fails ? `${fails} FAILED` : "ALL PASS");
await p.close();

