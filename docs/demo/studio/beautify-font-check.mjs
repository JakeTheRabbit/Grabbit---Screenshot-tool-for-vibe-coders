// Beautify → "Apply to the picture" (the picture gets the background, the drawings merge in, Ctrl+Z restores both)
// and the text font menu (system fonts; new text and the selected text take the font). Usage: node beautify-font-check.mjs
import { join } from "node:path";
import { demo, open, sleep } from "./lib.mjs";
const pic = join(demo, "../screenshots/hero.webp");
const asset = (f) => `http://studio.local/asset/${encodeURIComponent(f.replaceAll("\\", "/"))}`;
const setup = `localStorage.setItem("editor", "markup"); ["markupStyle", "beauty"].forEach((k) => localStorage.removeItem(k));
  __studio.handlers = { editor_msg: () => null, system_fonts: ["Arial", "Comic Sans MS", "Consolas", "Georgia", "Impact"], get_settings: { metadata: {}, branding: {} } };`;
const p = await open("index.html", { width: 1280, height: 820, dpr: 1, setup });
await p.waitFor(`!!window.grabbit?.receive`);
await p.ev(`(async () => { const b = await (await fetch(${JSON.stringify(asset(pic))})).blob();
  const d = await new Promise((ok) => { const f = new FileReader(); f.onload = () => ok(f.result); f.readAsDataURL(b); });
  const i = await new Promise((ok) => { const im = new Image(); im.onload = () => ok(im); im.src = d; });
  window.grabbit.receive({ type: "load", name: "Test", dataURL: d, width: i.naturalWidth, height: i.naturalHeight, recent: [] }); })()`);
await p.waitFor(`!!window.grabbit.fabric?.backgroundImage`);
await sleep(500);
let fails = 0;
const ok = (n, c, d = "") => { if (!c) fails++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };
const J = async (code) => JSON.parse(await p.ev(`JSON.stringify(${code})`));
const btn = (text, scope = "") => p.ev(`[...document.querySelectorAll(${JSON.stringify(scope + " button")})].find((b) => (b.textContent.trim() || b.title || b.dataset.tip || "").startsWith(${JSON.stringify(text)})).click()`);
const size = () => J(`(() => { const i = window.grabbit.fabric.backgroundImage; return [Math.round(i.width * i.scaleX), Math.round(i.height * i.scaleY)]; })()`);
const objs = () => J(`window.grabbit.fabric.getObjects().length`);
const key = async (k, code, vk, mods = 0) => { for (const type of ["keyDown", "keyUp"]) await p.send("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }); await sleep(250); };

// A drawing to merge in.
const scr = async (x, y) => J(`(() => { const c = window.grabbit.fabric, v = c.viewportTransform, r = c.upperCanvasEl.getBoundingClientRect(); return [r.left + v[4] + ${x} * v[0], r.top + v[5] + ${y} * v[3]]; })()`);
await key("r", "KeyR", 82);
const a = await scr(200, 200), b = await scr(600, 500);
await p.drag(a[0], a[1], b[0], b[1]); await sleep(300);
await key("Escape", "Escape", 27);
const before = await size(), n0 = await objs();

await btn("Beautify", "header.bar"); await sleep(300);
await p.ev(`document.querySelector(".swatches button").click()`); await sleep(600);
ok("Apply to the picture appears once a look is picked", await p.ev(`!!document.querySelector(".pbody button.primary")`));
await btn("Apply to the picture", ".pbody"); await sleep(1500);
const after = await size();
ok("the picture now has the background (it grew)", after[0] > before[0] && after[1] > before[1], `${before} → ${after}`);
ok("the drawing is part of the picture now", (await objs()) === 0, `${n0} → ${await objs()}`);
ok("the look is switched off (so copies don't get it twice)", !(await p.ev(`document.querySelector(".pbody input[type=checkbox]").checked`)));
await key("z", "KeyZ", 90, 2);
await sleep(800);
ok("Ctrl+Z brings back the plain picture and the drawing", JSON.stringify(await size()) === JSON.stringify(before) && (await objs()) === n0, `${await size()} / ${await objs()} objects`);
await btn("Beautify", "header.bar"); await sleep(200);

// Fonts.
await key("t", "KeyT", 84);
await p.ev(`document.querySelector(".mk-font").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`); await sleep(300);
const options = await J(`[...document.querySelectorAll(".mk-font option")].map((o) => o.value)`);
ok("the font menu lists the computer's fonts", options.includes("Georgia") && options[0] === "", options.join(", "));
await p.ev(`(() => { const s = document.querySelector(".mk-font"); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, "Georgia"); s.dispatchEvent(new Event("change", { bubbles: true })); })()`); await sleep(200);
const t = await scr(300, 700); await p.click(t[0], t[1]); await sleep(300);
await p.send("Input.insertText", { text: "Hello" }); await sleep(200);
await key("Escape", "Escape", 27);
const texts = await J(`window.grabbit.fabric.getObjects().filter((o) => o.gb?.kind === "text").map((o) => o.fontFamily)`);
ok("new text uses the picked font", texts.length === 1 && texts[0].startsWith('"Georgia"'), texts.join(" | "));
await p.ev(`(() => { const c = window.grabbit.fabric; c.setActiveObject(c.getObjects().find((o) => o.gb?.kind === "text")); c.requestRenderAll(); })()`); await sleep(200);
await p.ev(`(() => { const s = document.querySelector(".mk-font"); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, "Impact"); s.dispatchEvent(new Event("change", { bubbles: true })); })()`); await sleep(300);
ok("changing the font restyles the selected text", (await J(`window.grabbit.fabric.getObjects().find((o) => o.gb?.kind === "text").fontFamily`)).startsWith('"Impact"'));
await p.shot(join(demo, "out", "beautify-font.png"));
console.log(p.errors.length ? "PAGE ERRORS:\n" + p.errors.join("\n") : "no page errors");
console.log(fails ? `${fails} FAILED` : "ALL PASS");
await p.close();
process.exit(fails ? 1 : 0);
