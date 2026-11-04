// Proportional scaling (Shift stretches), dragging a capture onto the picture, picture frames, and the Layers panel
// (order, show/hide, select, delete). Usage: node layers-check.mjs
import { join } from "node:path";
import { demo, open, sleep } from "./lib.mjs";
const pic = join(demo, "../screenshots/hero.webp"), small = join(demo, "../screenshots/quick.webp");
const asset = (f) => `http://studio.local/asset/${encodeURIComponent(f.replaceAll("\\", "/"))}`;
const setup = `localStorage.setItem("editor", "markup"); ["markupStyle", "beauty"].forEach((k) => localStorage.removeItem(k));
  __studio.handlers = { editor_msg: (a) => { if (a.msg.type === "getImage") { (async () => { const b = await (await fetch(${JSON.stringify(asset(small))})).blob();
    const d = await new Promise((ok) => { const f = new FileReader(); f.onload = () => ok(f.result); f.readAsDataURL(b); });
    const i = await new Promise((ok) => { const im = new Image(); im.onload = () => ok(im); im.src = d; });
    window.grabbit.receive({ type: "image", reqId: a.msg.reqId, dataURL: d, width: i.naturalWidth, height: i.naturalHeight }); })(); } return null; }, get_settings: { metadata: {}, branding: {} } };`;
const p = await open("index.html", { width: 1400, height: 860, dpr: 1, setup });
await p.waitFor(`!!window.grabbit?.receive`);
await p.ev(`(async () => { const b = await (await fetch(${JSON.stringify(asset(pic))})).blob();
  const d = await new Promise((ok) => { const f = new FileReader(); f.onload = () => ok(f.result); f.readAsDataURL(b); });
  const i = await new Promise((ok) => { const im = new Image(); im.onload = () => ok(im); im.src = d; });
  window.grabbit.receive({ type: "load", name: "Test", dataURL: d, width: i.naturalWidth, height: i.naturalHeight,
    recent: [{ path: ${JSON.stringify(small)}, url: ${JSON.stringify(asset(small))}, name: "quick.webp", time: "2026-11-04T10:00:00", kind: "capture", bytes: 1000 }] }); })()`);
await p.waitFor(`!!window.grabbit.fabric?.backgroundImage`);
await sleep(500);
let fails = 0;
const ok = (n, c, d = "") => { if (!c) fails++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };
const J = async (code) => JSON.parse(await p.ev(`JSON.stringify(${code})`));
const key = async (k, code, vk, mods = 0) => { for (const type of ["keyDown", "keyUp"]) await p.send("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }); await sleep(200); };
const scr = async (x, y) => J(`(() => { const c = window.grabbit.fabric, v = c.viewportTransform, r = c.upperCanvasEl.getBoundingClientRect(); return [r.left + v[4] + ${x} * v[0], r.top + v[5] + ${y} * v[3]]; })()`);
const drag = async (x0, y0, x1, y1, mods = 0) => {
  const m = (type, x, y, buttons) => p.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1, modifiers: mods });
  await m("mouseMoved", x0, y0, 0); await m("mousePressed", x0, y0, 1);
  for (let i = 1; i <= 12; i++) { await m("mouseMoved", x0 + (x1 - x0) * i / 12, y0 + (y1 - y0) * i / 12, 1); await sleep(10); }
  await m("mouseReleased", x1, y1, 0); await sleep(250);
};
const handle = (name) => J(`(() => { const c = window.grabbit.fabric, o = c.getActiveObject(), r = c.upperCanvasEl.getBoundingClientRect(); o.setCoords(); const h = o.oCoords.${name}; return [r.left + h.x, r.top + h.y]; })()`);
const scale = () => J(`(() => { const o = window.grabbit.fabric.getActiveObject(); return [+o.scaleX.toFixed(3), +o.scaleY.toFixed(3)]; })()`);

// 1. A box, scaled from its side handle: proportional; with Shift: stretched.
await key("r", "KeyR", 82);
let a = await scr(300, 300), b = await scr(700, 600); await drag(a[0], a[1], b[0], b[1]);
await key("Escape", "Escape", 27);
await p.ev(`(() => { const c = window.grabbit.fabric; c.setActiveObject(c.getObjects().find((o) => o.gb?.kind === "rect")); c.requestRenderAll(); })()`);
let h = await handle("mr"); await drag(h[0], h[1], h[0] + 120, h[1]);
let s1 = await scale();
ok("side handle keeps proportions", Math.abs(s1[0] - s1[1]) < 0.02 && s1[0] > 1.05, String(s1));
h = await handle("mr"); await drag(h[0], h[1], h[0] + 120, h[1], 8 /* Shift */);
let s2 = await scale();
ok("with Shift it stretches", s2[0] - s2[1] > 0.1, String(s2));
h = await handle("br"); await drag(h[0], h[1], h[0] + 80, h[1] + 10);
let s3 = await scale();
ok("corner keeps proportions", Math.abs(s3[0] / s2[0] - s3[1] / s2[1]) < 0.02, `${s2} → ${s3}`);

// 2. Drag a capture from the library onto the picture.
const at = await scr(1200, 300);
await p.ev(`(() => { const dt = new DataTransfer(); dt.setData("text/x-grabbit-path", ${JSON.stringify(small)});
  const st = document.querySelector(".mk-stage"); for (const t of ["dragover", "drop"]) st.dispatchEvent(new DragEvent(t, { dataTransfer: dt, clientX: ${at[0]}, clientY: ${at[1]}, bubbles: true, cancelable: true })); })()`);
await sleep(1200);
const img = await J(`(() => { const o = window.grabbit.fabric.getObjects().find((o) => o.gb?.kind === "image"); if (!o) return null; const c = o.getCenterPoint(); return { type: o.constructor.type, cx: Math.round(c.x), cy: Math.round(c.y) }; })()`);
ok("dropping a capture adds it where it was dropped", img && Math.abs(img.cx - 1200) < 5 && Math.abs(img.cy - 300) < 5, JSON.stringify(img));

// 3. Frame it.
await p.ev(`(() => { const c = window.grabbit.fabric; c.setActiveObject(c.getObjects().find((o) => o.gb?.kind === "image")); c.fire("selection:created", {}); c.requestRenderAll(); })()`); await sleep(300);
await p.ev(`[...document.querySelectorAll(".mk-tools button")].find((b) => b.textContent.trim() === "Frame").click()`); await sleep(200);
const setRange = (i, v) => p.ev(`(() => { const r = document.querySelectorAll(".mk-pop input[type=range]")[${i}]; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(r, "${v}"); r.dispatchEvent(new Event("input", { bubbles: true })); r.dispatchEvent(new Event("change", { bubbles: true })); })()`);
await setRange(0, 12); await setRange(1, 0.5); await setRange(2, 40); await setRange(3, 0.7);
await p.ev(`(() => { const r = document.querySelector(".mk-pop input[type=color]"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(r, "#2f9e44"); r.dispatchEvent(new Event("input", { bubbles: true })); r.dispatchEvent(new Event("change", { bubbles: true })); })()`);
await sleep(300);
const fr = await J(`window.grabbit.fabric.getObjects().find((o) => o.gb?.kind === "image").gb.frame`);
ok("frame: colour, width, border opacity, corners, picture opacity", fr && fr.color === "#2f9e44" && fr.width === 12 && fr.alpha === 0.5 && fr.radius === 40 && fr.opacity === 0.7, JSON.stringify(fr));
await p.shot(join(demo, "out", "layers-frame.png"));
await key("z", "KeyZ", 90, 2); await sleep(500);
const fr2 = await J(`window.grabbit.fabric.getObjects().find((o) => o.gb?.kind === "image")?.gb.frame ?? null`);
ok("Ctrl+Z undoes the last frame change (the frame survives undo/redo)", fr2 && fr2.color !== "#2f9e44" && fr2.width === 12, JSON.stringify(fr2));

// 4. Layers.
await p.ev(`[...document.querySelectorAll("header.bar button")].find((b) => b.textContent.trim() === "Layers").click()`); await sleep(300);
const rows = () => J(`[...document.querySelectorAll(".layer .lname")].map((n) => n.textContent)`);
const r0 = await rows();
ok("Layers lists everything, top first", r0.length === 2 && r0[0] === "Picture" && r0[1] === "Box", r0.join(" | "));
await p.ev(`document.querySelectorAll(".layer")[0].querySelector('[aria-label="Move down"]').click()`); await sleep(300);
const r1 = await rows();
ok("moving a layer down changes the order", r1[0] === "Box" && r1[1] === "Picture", r1.join(" | "));
await p.ev(`document.querySelectorAll(".layer")[0].querySelector('[aria-label="Hide"]').click()`); await sleep(300);
ok("hiding a layer hides it", await p.ev(`window.grabbit.fabric.getObjects().find((o) => o.gb?.kind === "rect").visible === false`));
await p.ev(`document.querySelectorAll(".layer")[0].querySelector('[aria-label="Show"]').click()`); await sleep(300);
ok("showing it again", await p.ev(`window.grabbit.fabric.getObjects().find((o) => o.gb?.kind === "rect").visible === true`));
await p.ev(`document.querySelectorAll(".layer")[1].click()`); await sleep(200);
ok("clicking a layer selects it", await p.ev(`window.grabbit.fabric.getActiveObject()?.gb?.kind === "image"`));
await p.ev(`document.querySelectorAll(".layer")[1].querySelector('[aria-label="Delete"]').click()`); await sleep(300);
ok("deleting a layer removes it", (await rows()).join() === "Box");
await key("z", "KeyZ", 90, 2); await sleep(600);
ok("Ctrl+Z brings it back", (await rows()).length === 2, (await rows()).join(" | "));
console.log(p.errors.length ? "PAGE ERRORS:\n" + p.errors.join("\n") : "no page errors");
console.log(fails ? `${fails} FAILED` : "ALL PASS");
await p.close();
process.exit(fails ? 1 : 0);
