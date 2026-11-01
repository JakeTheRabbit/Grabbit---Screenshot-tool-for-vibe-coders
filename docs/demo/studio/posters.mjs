// Frames the studio's raw shots (shoot.mjs) as README posters: a headline over a crop of the real UI, rendered in
// headless Chrome and saved as WebP in docs/screenshots. Usage: node posters.mjs [name…]
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { demo, open, root } from "./lib.mjs";

const raw = join(demo, "out/raw"), html = join(demo, "out/posters"), dest = join(root, "docs/screenshots");
mkdirSync(html, { recursive: true });
const src = (f) => `http://studio.local/asset/${encodeURIComponent(f)}`;
const want = process.argv.slice(2);

const css = `
* { box-sizing: border-box; }
html, body { margin: 0; }
body { width: var(--w); height: var(--h); overflow: hidden; position: relative; color: #fff; background: #0b0d17;
  font-family: "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
.glow { position: absolute; inset: 0; background:
  radial-gradient(700px 480px at 0% 0%, rgb(251 124 72 / .30), transparent 70%),
  radial-gradient(800px 600px at 100% 100%, rgb(124 77 255 / .32), transparent 70%),
  radial-gradient(600px 400px at 85% 0%, rgb(46 197 206 / .16), transparent 70%); }
.head { position: absolute; left: 80px; top: 62px; right: 80px; }
.eyebrow { font: 600 19px/1 "Segoe UI Variable Text", "Segoe UI", sans-serif; letter-spacing: .16em; text-transform: uppercase; color: #ff9466; }
h1 { font-size: 58px; line-height: 1.06; margin: 14px 0 0; font-weight: 700; letter-spacing: -.02em; }
h1 em, .grad { font-style: normal; background: linear-gradient(90deg, #ff9a5a, #ff4f8b); -webkit-background-clip: text; background-clip: text; color: transparent; }
p { font: 400 25px/1.4 "Segoe UI Variable Text", "Segoe UI", sans-serif; color: #b3b8cc; margin: 14px 0 0; max-width: 1180px; }
.frame { position: absolute; overflow: hidden; border-radius: 16px; background: #15171f;
  box-shadow: 0 40px 100px rgb(0 0 0 / .6), 0 0 0 1px rgb(255 255 255 / .1); }
.stage { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.stage > img { position: absolute; display: block; }
.cap { position: absolute; font: 600 18px/1 "Segoe UI Variable Text", "Segoe UI", sans-serif; color: #fff; background: rgb(11 13 23 / .78);
  border: 1px solid rgb(255 255 255 / .14); padding: 10px 14px; border-radius: 999px; backdrop-filter: blur(8px); }
`;

/** A crop of a base picture (CSS size bw×bh), region starting at x,y and w wide, scaled into a box; extra = absolutely placed HTML in base coords. */
const frame = ({ base, bw, bh, x = 0, y = 0, w = bw, extra = "" }, box) => {
  const s = box.w / w;
  return `<div class="frame" style="left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px">
    <div class="stage" style="width:${bw}px;height:${bh}px;transform:scale(${s}) translate(${-x}px,${-y}px)">
      <img src="${src(base)}" style="left:0;top:0;width:${bw}px;height:${bh}px">${extra}</div></div>`;
};
const head = (eyebrow, h1, p) => `<div class="head"><div class="eyebrow">${eyebrow}</div><h1>${h1}</h1><p>${p}</p></div>`;
const page = (w, h, body) => `<!doctype html><meta charset="utf-8"><style>:root{--w:${w}px;--h:${h}px}${css}</style><body><div class="glow"></div>${body}</body>`;
const W = 1600, H = 1000, BOX = { x: 80, y: 290, w: 1440, h: 780 }; // the frame bleeds off the bottom

const desktop = join(demo, "out/desktop.png");
const part = (n) => join(raw, `part-${n}.png`);
const posters = {
  hero: () => page(W, 1060, `
    <div class="head" style="text-align:center;top:58px">
      <div style="display:inline-flex;align-items:center;gap:16px;font:700 34px/1 'Segoe UI Variable Display',sans-serif">
        <img src="${src(join(demo, "icon.png"))}" style="width:64px;height:64px">Grabbit</div>
      <h1 style="font-size:70px;margin-top:22px">Grab it. Say it. <em>Paste it anywhere.</em></h1>
      <p style="margin:16px auto 0;max-width:1400px">Screenshots, recordings and AI-ready captures for Windows, macOS and Linux. Free and open source.</p>
    </div>
    ${frame({ base: join(raw, "picker.png"), bw: 1600, bh: 900, x: 60, y: 40, w: 1500 }, { x: 80, y: 340, w: 1440, h: 800 })}`),

  talk: () => page(W, H, head("Talk to AI", "Point at it, say what you want, <em>paste it into any AI.</em>",
    "Click to mark things, talk naturally. Your words, the numbered marks and every word of text on screen go into ChatGPT, Claude or Gemini in one paste.")
    + frame({ base: join(raw, "talk-to-ai.png"), bw: 1300, bh: 740, x: 0, y: 100, w: 1300 }, BOX)),

  batch: () => page(W, H, head("AI batch", "Ten screenshots. <em>One paste.</em>",
    "Start a batch and keep talking while you capture. Every picture keeps its own explanation, and they all go to the AI together.")
    + frame({ base: join(raw, "ai-batch.png"), bw: 1180, bh: 640, x: 0, y: 0, w: 1180 }, BOX)),

  editor: () => page(W, H, head("Picture editor", "Mark it up like a <em>whiteboard.</em>",
    "The full Excalidraw editor, offline: arrows, numbered steps, text, blur, stickers, and one-click Beautify backgrounds.")
    + frame({ base: join(raw, "editor.png"), bw: 1360, bh: 860, x: 0, y: 0, w: 1360 }, BOX)),

  ai: () => page(W, H, head("AI in the editor", "Ask your screenshot <em>anything.</em>",
    "Remove a background, change what's in a box, swap text, or describe and tag it. Uses your own key or a local model.")
    + frame({ base: join(raw, "editor-ai.png"), bw: 1360, bh: 860, x: 400, y: 50, w: 960 }, BOX)),

  video: () => page(W, 1180, head("Video editor", "Record it. <em>Cut the silences.</em> Caption it.",
    "Trim, split, speed up, blur, burn in captions, zoom on clicks and show keys, all in one window. Copy straight to the clipboard.")
    + frame({ base: join(raw, "video-editor.png"), bw: 1400, bh: 860, x: 0, y: 0, w: 1400 }, { ...BOX, h: 960 })),

  record: () => page(W, H, head("Screen recording", "Hold the key. <em>You're recording.</em>",
    "System sound and microphone on separate tracks, a webcam bubble, a replay buffer, and controls that never show up in the video.")
    + frame({ base: desktop, bw: 1600, bh: 900, x: 100, y: 170, w: 1400, extra: `
      <svg style="position:absolute;left:0;top:0" width="1600" height="900"><path fill="rgb(0 0 0 / .45)" fill-rule="evenodd" d="M0 0H1600V900H0Z M228 256V716H1068V256Z"/>
        <rect x="226.5" y="254.5" width="843" height="463" fill="none" stroke="#ff3b30" stroke-width="3"/></svg>
      <img src="${src(part("recbar"))}" style="left:498px;top:728px;width:300px;height:44px">` }, BOX)),

  quick: () => page(W, H, head("After every capture", "Copied. <em>Ready to paste anywhere.</em>",
    "A picture and a file on the clipboard, a lossless WebP saved, and a card to drag into any app, edit, pin, share or send to AI.")
    + frame({ base: desktop, bw: 1600, bh: 900, x: 700, y: 440, w: 900, extra: `
      <img src="${src(part("quick"))}" style="left:1276px;top:646px;width:300px;height:230px">` }, BOX)),

  tools: () => page(W, H, head("Capture", "Everything is <em>one key away.</em>",
    "Regions, windows, up to four areas at once, scrolling pages, text (OCR), QR codes, colours, measurements and social sizes.")
    + frame({ base: join(raw, "picker-more.png"), bw: 1600, bh: 900, x: 90, y: 300, w: 1000 }, { x: 80, y: 290, w: 930, h: 780 })
    + frame({ base: join(raw, "picker-loupe.png"), bw: 1600, bh: 900, x: 520, y: 290, w: 420 }, { x: 1040, y: 290, w: 480, h: 360 })
    + frame({ base: join(raw, "picker-window.png"), bw: 1600, bh: 900, x: 1080, y: 110, w: 480 }, { x: 1040, y: 680, w: 480, h: 420 })),

  social: () => page(1280, 640, `
    <div class="head" style="left:64px;top:84px;width:520px">
      <div style="display:flex;align-items:center;gap:14px;font:700 30px/1 'Segoe UI Variable Display',sans-serif">
        <img src="${src(join(demo, "icon.png"))}" style="width:56px;height:56px">Grabbit</div>
      <h1 style="font-size:54px;margin-top:30px">Grab it. Say it.<br><em>Paste it anywhere.</em></h1>
      <p style="font-size:22px">Screenshots, recordings and AI-ready captures. Free for Windows, macOS and Linux.</p>
    </div>
    ${frame({ base: join(raw, "picker.png"), bw: 1600, bh: 900, x: 200, y: 220, w: 900 }, { x: 640, y: 70, w: 700, h: 600 })}`),
};

for (const [name, make] of Object.entries(posters)) {
  if (want.length && !want.includes(name)) continue;
  const f = join(html, `${name}.html`);
  writeFileSync(f, make());
  const [w, h] = { social: [1280, 640], hero: [W, 1060], video: [W, 1180] }[name] ?? [W, H];
  const p = await open(src(f), { width: w, height: h, dpr: name === "social" ? 1 : 1.25 });
  await p.waitFor(`[...document.images].every((i) => i.complete && i.naturalWidth)`);
  await p.ev(`document.fonts.ready.then(() => true)`);
  const png = join(html, `${name}.png`);
  await p.shot(png);
  await p.close();
  if (name === "social") execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", png, join(dest, "social-preview.png")]);
  else execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", png, "-c:v", "libwebp", "-quality", "90", "-compression_level", "6", join(dest, `${name}.webp`)]);
}
