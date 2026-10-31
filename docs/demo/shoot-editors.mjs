// README shots of the real editors. Grabbit must run with GRABBIT_DEMO=<docs/demo/out> (clean recent strip) and
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333, with demo.png and demo.mp4 open.
// Writes out/editor.png, out/video-editor.png, out/video-draw.png.
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "out"), port = 9333, sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(match) {
  for (let i = 0; i < 80; i++) {
    try {
      const t = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.url.includes(match));
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r) => ws.addEventListener("open", r));
        let id = 0; const waiting = new Map();
        ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); waiting.get(m.id)?.(m); waiting.delete(m.id); });
        const send = (method, params = {}) => new Promise((r) => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
        const ev = async (x) => (await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;
        await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 940, deviceScaleFactor: 1.5, mobile: false });
        await sleep(800);
        const shot = async (name) => writeFileSync(join(out, name), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
        return { ws, send, ev, shot };
      }
    } catch {}
    await sleep(250);
  }
  throw new Error("no page " + match);
}

// ---- picture editor: annotations on the dashboard ----
{
  const p = await page("grabbit.app/index.html");
  for (let i = 0; i < 40 && !(await p.ev(`!!window.grabbit?.api?.getSceneElements().length`)); i++) await sleep(250);
  await p.ev(`Promise.all([document.fonts.load("34px Nunito"), document.fonts.load("30px Nunito")])`);   // measure text with the real font
  await p.ev(`(() => { const a = window.grabbit.api, c = window.grabbit.convert;
    const els = c([
      { type: "rectangle", x: 255, y: 98, width: 412, height: 146, strokeColor: "#e03131", strokeWidth: 4, roughness: 0, roundness: { type: 3 } },
      { type: "arrow", x: 690, y: 300, width: -110, height: -45, strokeColor: "#e03131", strokeWidth: 4, roughness: 0, endArrowhead: "triangle" },
      { type: "text", x: 700, y: 278, text: "Up 12.4% on last week", fontSize: 34, strokeColor: "#e03131", fontFamily: 6 },
      { type: "ellipse", x: 1037, y: 352, width: 110, height: 100, strokeColor: "#1971c2", strokeWidth: 4, roughness: 0 },
      { type: "text", x: 1005, y: 740, text: "Saturday peak", fontSize: 30, strokeColor: "#1971c2", fontFamily: 6 },
      { type: "arrow", x: 1092, y: 735, width: 0, height: -270, strokeColor: "#1971c2", strokeWidth: 3, roughness: 0, endArrowhead: "triangle" },
    ]);
    a.updateScene({ elements: [...a.getSceneElements(), ...els] });
    a.scrollToContent(undefined, { fitToContent: true }); })()`);
  await sleep(600);
  await p.ev(`[...document.querySelectorAll("button")].find(b => b.textContent.includes("Step"))?.click()`);   // a numbered badge
  await sleep(600);
  await p.ev(`window.grabbit.api.updateScene({ appState: { selectedElementIds: {} } })`);
  await sleep(400);
  await p.shot("editor.png");
  p.ws.close();
}

// ---- video editor: a cut part, a drawing on the video, sound picker ----
{
  const p = await page("grabbit.app/video.html");
  for (let i = 0; i < 60 && !(await p.ev(`document.querySelector("video")?.readyState >= 2 && !!window.grabbitDraw && document.querySelectorAll(".thumb canvas").length > 6`)); i++) await sleep(250);
  const seek = async (t) => { await p.ev(`(async () => { const v = document.querySelector("video"); v.currentTime = ${t}; await new Promise(r => v.addEventListener("seeked", r, { once: true })); })()`); await sleep(200); };
  const key = (k) => p.ev(`window.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)} }))`);
  // Cut 4.6–5.6 s out: split twice, cut the middle part.
  await seek(4.6); await key("s"); await seek(5.6); await key("s"); await key("Escape"); await seek(5.0); await key("Delete");
  // A drawing at 2 s: an arrow and a note on the chart.
  await p.ev(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Draw").click()`);
  await sleep(500);
  await seek(2.0);
  await p.ev(`document.fonts.load("40px Nunito")`);
  await p.ev(`(() => { const a = window.grabbitDraw.api, c = window.grabbitDraw.convert;
    a.updateScene({ elements: [...a.getSceneElements(), ...c([
      { type: "arrow", x: 760, y: 640, width: 150, height: -150, strokeColor: "#e03131", strokeWidth: 5, roughness: 0, endArrowhead: "triangle" },
      { type: "text", x: 430, y: 650, text: "Revenue climbing all week", fontSize: 40, strokeColor: "#e03131", fontFamily: 6 },
      { type: "rectangle", x: 1080, y: 230, width: 480, height: 330, strokeColor: "#1971c2", strokeWidth: 5, roughness: 0, roundness: { type: 3 } },
    ])] }); })()`);
  await sleep(500);
  await seek(2.6);
  await p.shot("video-draw.png");
  await p.ev(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Done drawing").click()`);
  await sleep(300);
  await p.ev(`(() => { const s = document.querySelector(".sound select"); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, "System"); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await seek(2.6);
  await sleep(300);
  await p.shot("video-editor.png");
  p.ws.close();
}
console.log("shots written to", out);
