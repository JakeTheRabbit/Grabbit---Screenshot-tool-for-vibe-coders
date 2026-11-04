// Drives the new picture editor (markup, Fabric.js) with real mouse and keys in the studio's headless Chrome, with a
// faked Grabbit core, and checks the drawing after each step. Prints PASS/FAIL per check. Usage: node markup-sweep.mjs [outdir]
import { join } from "node:path";
import { demo, open, sleep } from "./lib.mjs";
const out = process.argv[2] ?? join(demo, "out");
const img = join(demo, "out/desktop.png").replaceAll("\\", "/");   // node frame.mjs makes it
const asset = (f) => `http://studio.local/asset/${encodeURIComponent(f)}`;

const setup = `
  localStorage.setItem("editor", "markup"); localStorage.removeItem("markupStyle"); localStorage.removeItem("barPos"); ["library", "libraryDock", "libraryFolders", "tabsAt", "tabsSlim"].forEach((k) => localStorage.removeItem(k));
  window.__red = () => { const c = document.createElement("canvas"); c.width = 2560; c.height = 1440; const g = c.getContext("2d"); g.fillStyle = "#f00"; g.fillRect(0, 0, 2560, 1440); return c.toDataURL(); };
  __studio.handlers = {
    editor_msg: ({ msg }) => ({
      ocr: [{ text: "ben@example.com", x: 200, y: 100, width: 300, height: 40, line: 0 }, { text: "hello", x: 200, y: 200, width: 100, height: 40, line: 1 }],
      exportFile: "C:/tmp/out.png", qr: ["https://example.com"], checkMark: { found: false },
    })[msg.type] ?? null,
    ai_edit: () => window.__red(), copy_text: null, voice_open: null, share_targets: [],
    get_settings: { metadata: { strip: true, author: "", copyright: "" }, branding: { invisible_mark: false, on_images: false, logo_path: "" } },
  };`;

let fails = 0;
const ok = (name, cond, detail = "") => { if (!cond) fails++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const p = await open("index.html", { width: 1360, height: 860, dpr: 1, setup });
const J = async (code) => JSON.parse(await p.ev(`JSON.stringify(${code})`));
await p.waitFor(`!!window.grabbit?.fabric && !!window.grabbit.receive`);
const load = (name, recent = []) => p.ev(`(async () => { const b = await (await fetch(${JSON.stringify(asset(img))})).blob();
  window.__d = await new Promise((ok) => { const f = new FileReader(); f.onload = () => ok(f.result); f.readAsDataURL(b); });
  window.grabbit.receive({ type: "load", name: ${JSON.stringify(name)}, dataURL: __d, width: 2560, height: 1440, recent: ${JSON.stringify(recent)} }); })()`);
await load("Sweep", [
  { path: img, url: asset(img), name: "desktop.png", time: "2026-11-02T08:00:00", kind: "capture" },
  { path: img + "2", url: asset(img), name: "copy.png", time: "2026-11-02T08:01:00", kind: "copied" },
]);
await p.waitFor(`!!window.grabbit.fabric.backgroundImage`);
await sleep(400);

const objs = () => J(`window.grabbit.fabric.getObjects().map((o) => ({ kind: o.gb?.kind, mode: o.gb?.mode, n: o.gb?.n, type: o.type, stroke: o.stroke, text: o.text, bb: o.getBoundingRect() }))`);
const kinds = async () => (await objs()).map((o) => o.kind);
const active = () => J(`window.grabbit.fabric.getActiveObjects().map((o) => o.gb?.kind)`);
const scr = (x, y) => J(`(() => { const c = window.grabbit.fabric, v = c.viewportTransform, r = c.upperCanvasEl.getBoundingClientRect(); return [r.left + v[4] + ${x} * v[0], r.top + v[5] + ${y} * v[3]]; })()`);
const dragScene = async (x0, y0, x1, y1) => { const a = await scr(x0, y0), b = await scr(x1, y1); await p.drag(a[0], a[1], b[0], b[1]); await sleep(250); };
const clickScene = async (x, y) => { const a = await scr(x, y); await p.click(a[0], a[1]); await sleep(200); };
const key = async (k, code, vk, mods = 0, text) => {
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods, text });
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await sleep(200);
};
const tool = (k) => key(k.toLowerCase(), "Key" + k.toUpperCase(), k.toUpperCase().charCodeAt(0));
const esc = () => key("Escape", "Escape", 27);
const ctrl = (k, shift = false) => key(k, "Key" + k.toUpperCase(), k.toUpperCase().charCodeAt(0), 2 | (shift ? 8 : 0));
const btn = async (text, scope) => { const c = await J(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope + " button")})].find((b) => (b.textContent.trim() || b.title).startsWith(${JSON.stringify(text)})); if (!b) return null; const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`); if (!c) throw new Error(`no button "${text}" in ${scope}`); await p.click(c[0], c[1]); await sleep(250); };
const menu = async (label, item) => { await btn(label, "header.bar"); await btn(item, ".dropdown"); await sleep(400); };
const deselect = () => p.ev(`(() => { const c = window.grabbit.fabric; c.discardActiveObject(); c.requestRenderAll(); })()`);
const step = async (name, f) => { try { await f(); } catch (e) { fails++; console.log(`FAIL  ${name} threw: ${e.message}`); } };

await step("layout", async () => {
  const r = await J(`(() => { const s = document.querySelector(".mk-stage").getBoundingClientRect(), t = document.querySelector(".mk-tools").getBoundingClientRect(), c = window.grabbit.fabric, v = c.viewportTransform;
    return { picTop: s.top + v[5], toolsBottom: t.bottom, picLeft: s.left + v[4], picRight: s.left + v[4] + 2560 * v[0], stageRight: s.right, zoom: v[0] }; })()`);
  ok("picture fits below the tools, inside the stage", r.picTop >= r.toolsBottom && r.picRight <= r.stageRight + 0.5, JSON.stringify(r));
});

await step("arrow", async () => {
  await tool("a");
  await dragScene(400, 300, 1200, 700);
  let o = await objs();
  ok("arrow drawn, back to Select", o.at(-1)?.kind === "arrow" && (await J(`document.querySelector(".mk-tools button.on")?.title`)).startsWith("Select"));
  await deselect();
  const z = await p.ev(`window.grabbit.fabric.getZoom()`);
  // 8 screen px off the middle of the line, perpendicular-ish
  const mid = await scr(800, 500), nx = -400 / Math.hypot(800, 400), ny = 800 / Math.hypot(800, 400);
  await p.click(mid[0] + nx * 8, mid[1] + ny * 8); await sleep(200);
  ok("arrow selects from a click 8 px away", (await active())[0] === "arrow", `zoom ${z.toFixed(2)}`);
  // drag its end point
  const end = await scr(1200, 700);
  await p.drag(end[0], end[1], end[0] + 60, end[1] - 80); await sleep(250);
  o = await objs();
  ok("dragging an end re-aims the arrow", Math.abs(o.at(-1).bb.left + o.at(-1).bb.width - (1200 + 60 / z)) < 30, JSON.stringify(o.at(-1).bb));
  await p.shot(`${out}/markup-arrow.png`);
});

await step("shapes", async () => {
  await tool("r"); await dragScene(200, 900, 500, 1100);
  await tool("o"); await dragScene(600, 900, 900, 1100);
  await tool("l"); await dragScene(1000, 900, 1300, 1100);
  await tool("p"); await dragScene(1400, 900, 1600, 1050); await esc();
  await tool("h"); await dragScene(300, 200, 700, 200); await esc();
  const k = await kinds();
  ok("box, ellipse, line, pen, highlighter all drawn", ["rect", "ellipse", "line", "pen", "highlight"].every((x) => k.includes(x)), k.join(","));
});

await step("text", async () => {
  await tool("t"); await clickScene(1500, 300);
  await p.send("Input.insertText", { text: "Best Saturday" }); await sleep(150);
  await esc(); await sleep(200);
  const t = (await objs()).find((o) => o.kind === "text");
  ok("text placed and typed", t?.text === "Best Saturday", JSON.stringify(t?.text));
  await tool("t"); await clickScene(1500, 500); await esc(); await sleep(200);
  ok("empty text is dropped", (await objs()).filter((o) => o.kind === "text").length === 1);
});

await step("steps", async () => {
  await tool("n");
  for (const [x, y] of [[300, 600], [500, 600], [700, 600]]) await clickScene(x, y);
  await esc();
  const n = (await objs()).filter((o) => o.kind === "step").map((o) => o.n);
  ok("steps number 1, 2, 3", n.join() === "1,2,3", n.join());
});

await step("hide", async () => {
  await tool("x"); await dragScene(100, 1200, 400, 1350);
  await tool("b"); await dragScene(500, 1200, 800, 1350);
  await tool("k"); await dragScene(900, 1200, 1200, 1350);
  const h = (await objs()).filter((o) => o.kind === "redact").map((o) => o.mode);
  ok("pixelate, blur, black out drawn", h.join() === "pixelate,blur,black", h.join());
  // switch the pixelated one to black out
  await deselect(); await clickScene(250, 1275);
  ok("hidden area selectable", (await active())[0] === "redact");
  await menu("Hide", "Black out the selected");
  const h2 = (await objs()).filter((o) => o.kind === "redact").map((o) => o.mode);
  ok("switch pixelate → black out", h2.filter((m) => m === "black").length === 2 && !h2.includes("pixelate"), h2.join());
  await menu("Hide", "Hide private details");
  ok("auto-hide pixelates the email", (await objs()).some((o) => o.kind === "redact" && o.mode === "pixelate" && Math.abs(o.bb.left - 200) < 10));
});

await step("spotlight + magnify", async () => {
  await tool("s"); await dragScene(1700, 200, 2100, 500);
  let o = await objs();
  ok("spotlight goes right above the picture", o[0].kind === "spot");
  await tool("m"); await dragScene(1800, 800, 1950, 900);
  o = await objs();
  const mag = o.find((x) => x.kind === "magnify");
  ok("magnifier at 2×", mag && Math.abs(mag.bb.width - 300) < 8, JSON.stringify(mag?.bb));
  await menu("Hide", "Remove the spotlight");
  ok("spotlight removed", !(await kinds()).includes("spot"));
});

await step("style", async () => {
  await deselect();
  const a = (await objs()).findIndex((o) => o.kind === "arrow");
  await p.ev(`(() => { const c = window.grabbit.fabric; c.setActiveObject(c.getObjects()[${a}]); c.requestRenderAll(); })()`);
  await p.ev(`window.dispatchEvent(new Event("noop"))`); await sleep(150);
  await btn("#1971c2", ".mk-colors");
  ok("colour applies to the selected arrow", (await objs())[a].stroke === "#1971c2", (await objs())[a].stroke);
  await btn("Extra thick", ".mk-tools");
  const w = await p.ev(`window.grabbit.fabric.getObjects()[${a}].strokeWidth`);
  ok("width applies to the selected arrow", w > 10, String(w));
});

await step("edit ops", async () => {
  const n0 = (await objs()).length;
  await ctrl("d"); ok("Ctrl+D duplicates", (await objs()).length === n0 + 1);
  await key("Delete", "Delete", 46); ok("Delete removes", (await objs()).length === n0);
  await ctrl("z"); ok("Ctrl+Z brings it back", (await objs()).length === n0 + 1);
  await ctrl("y"); ok("Ctrl+Y redoes the delete", (await objs()).length === n0);
});

await step("eyedropper", async () => {
  await tool("i"); await clickScene(1250, 900);
  const c = await J(`JSON.parse(localStorage.getItem("markupStyle")).color`);
  ok("eyedropper picks a colour from the picture", /^#[0-9a-f]{6}$/.test(c) && c !== "#1971c2", c);
});

await step("export", async () => {
  await p.ev(`window.grabbitOutbox = []`);
  await btn("Copy", "header.bar"); await sleep(800);
  const dims = JSON.parse(await p.ev(`(async () => { const m = window.grabbitOutbox.find((x) => x.type === "export"); const i = new Image(); await new Promise((r) => { i.onload = r; i.src = m.dataURL; }); return JSON.stringify([m.action, i.width, i.height]); })()`));
  ok("Copy exports at the capture's own size", dims.join() === "copy,2560,1440", dims.join());
  await ctrl("s"); await sleep(600);
  ok("Ctrl+S saves", await p.ev(`window.grabbitOutbox.some((m) => m.type === "export" && m.action === "saveQuick")`));
  await p.shot(`${out}/markup-full.png`);
});

await step("crop", async () => {
  await tool("c"); await dragScene(100, 100, 1300, 800);
  ok("crop box waits for Enter", await p.ev(`!!document.querySelector(".mk-tools .primary")`));
  await key("Enter", "Enter", 13); await sleep(600);
  const s = await J(`(() => { const b = window.grabbit.fabric.backgroundImage; return [Math.round(b.width), Math.round(b.height)]; })()`);
  ok("crop makes the picture 1200×700 (±3: one screen px is ~2 picture px here)", Math.abs(s[0] - 1200) <= 3 && Math.abs(s[1] - 700) <= 3, s.join());
  await ctrl("z"); await sleep(500);
  const s2 = await J(`(() => { const b = window.grabbit.fabric.backgroundImage; return [Math.round(b.width), Math.round(b.height)]; })()`);
  ok("Ctrl+Z undoes the crop", s2.join() === "2560,1440", s2.join());
});

await step("stickers", async () => {
  const n0 = (await objs()).length;
  await btn("Stickers", "header.bar"); await btn("", ".stickers .emoji");
  ok("emoji added, picker closed", (await objs()).length === n0 + 1 && !(await p.ev(`!!document.querySelector(".stickers")`)));
});

await step("panels", async () => {
  await btn("Beautify", "header.bar");
  const c = await J(`(() => { const r = document.querySelector(".swatches button").getBoundingClientRect(); return [r.left + 8, r.top + 8]; })()`);
  await p.click(c[0], c[1]);
  await p.waitFor(`!!document.querySelector(".bpreview")?.naturalWidth`, 8000).catch(() => {});
  ok("Beautify preview", await p.ev(`!!document.querySelector(".bpreview")?.naturalWidth`));
  const cb = await J(`(() => { const r = document.querySelector(".panel input[type=checkbox]").getBoundingClientRect(); return [r.left + 8, r.top + 8]; })()`);
  await p.click(cb[0], cb[1]); await sleep(300);
  await btn("×", ".panel");
  await btn("AI", "header.bar");
  const b0 = await p.ev(`window.grabbit.fabric.backgroundImage.getSrc().length`);
  await btn("Remove background", ".panel"); await sleep(800);
  const b1 = await p.ev(`window.grabbit.fabric.backgroundImage.getSrc().length`);
  ok("AI remove background swaps the picture", b1 !== b0);
  await ctrl("z"); await sleep(500);
  ok("Ctrl+Z restores it", (await p.ev(`window.grabbit.fabric.backgroundImage.getSrc().length`)) === b0);
  await btn("×", ".panel");
  await btn("Info", "header.bar"); await sleep(300);
  ok("Info shows the size", /2560 × 1440/.test(await p.ev(`document.querySelector(".panel")?.textContent ?? ""`)));
  await btn("×", ".panel");
});

await step("tabs", async () => {
  await p.ev(`__studio.handlers.editor_msg = ((orig) => (a) => { if (a.msg.type === "getImage") { setTimeout(() => window.grabbit.receive({ type: "image", reqId: a.msg.reqId, dataURL: __d, width: 2560, height: 1440 }), 10); return null; } return orig(a); })(__studio.handlers.editor_msg)`);
  const n0 = (await objs()).length;
  await btn("Insert", ".lib-items"); await sleep(800);
  ok("Insert adds the capture on top", (await objs()).length === n0 + 1 && (await kinds()).at(-1) === "image");
  await btn("Open", ".lib-items"); await sleep(800);
  ok("New tab opens a clean second tab", (await p.ev(`document.querySelectorAll(".vtab").length`)) === 2 && (await objs()).length === 0);
  await p.ev(`document.querySelectorAll(".vtab")[0].click()`); await sleep(600);
  ok("switching back keeps the drawing", (await objs()).length === n0 + 1, `${(await objs()).length} vs ${n0 + 1}`);
  for (let i = 0; i < 2; i++) { await p.ev(`document.querySelector(".vtab .x").click()`); await sleep(800); }
  ok("closing every tab leaves a blank editor", (await p.ev(`document.querySelectorAll(".vtab").length`)) === 0 && (await p.ev(`!!document.querySelector(".blank")`)));
});

console.log(p.errors.length ? "PAGE ERRORS:\n" + p.errors.join("\n") : "no page errors");
console.log(fails ? `${fails} FAILED` : "ALL PASS");
await p.close();
