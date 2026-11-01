// Beautify: put a screenshot on a background with padding, rounded corners and a soft shadow, optionally at an exact
// social-media size. Pure canvas, applied when copying or saving.

export type Beauty = {
  on: boolean;
  background: string;      // key of BACKGROUNDS, or "#rrggbb", or "transparent"
  padding: number;         // fraction of the picture's long edge
  radius: number;          // px at the picture's own scale
  shadow: number;          // 0..1
  size: [number, number] | null;   // exact output size, picture fitted inside
};

export const BACKGROUNDS: Record<string, [string, string]> = {
  Sunset: ["#ff7a45", "#e8396d"],
  Ocean: ["#2193b0", "#6dd5ed"],
  Grape: ["#7f53ac", "#647dee"],
  Mint: ["#43e97b", "#38f9d7"],
  Peach: ["#ffecd2", "#fcb69f"],
  Slate: ["#434343", "#1f1f1f"],
  Sky: ["#e0eafc", "#cfdef3"],
  Lemon: ["#f6d365", "#fda085"],
};

export const SIZES: [string, [number, number] | null][] = [
  ["Fit the picture", null],
  ["Instagram post · 1080×1080", [1080, 1080]],
  ["Instagram portrait · 1080×1350", [1080, 1350]],
  ["Story / Reel / TikTok · 1080×1920", [1080, 1920]],
  ["YouTube thumbnail · 1280×720", [1280, 720]],
  ["X / Twitter · 1600×900", [1600, 900]],
  ["LinkedIn · 1200×627", [1200, 627]],
  ["Facebook · 1200×630", [1200, 630]],
  ["Pinterest · 1000×1500", [1000, 1500]],
];

export const DEFAULT_BEAUTY: Beauty = { on: false, background: "Sunset", padding: 0.08, radius: 14, shadow: 0.5, size: null };

function load(src: string) {
  return new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = src; });
}

export async function beautify(dataURL: string, b: Beauty): Promise<string> {
  const img = await load(dataURL);
  const pad = Math.round(Math.max(img.width, img.height) * b.padding);
  let W = img.width + pad * 2, H = img.height + pad * 2;
  let scale = 1;
  if (b.size) {
    [W, H] = b.size;
    // Fit picture + padding inside the target, keeping the padding proportional.
    scale = Math.min((W * (1 - 2 * b.padding)) / img.width, (H * (1 - 2 * b.padding)) / img.height);
  }
  const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
  const x = Math.round((W - w) / 2), y = Math.round((H - h) / 2);
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d")!;
  if (b.background !== "transparent") {
    if (b.background.startsWith("#")) g.fillStyle = b.background;
    else {
      const [a, z] = BACKGROUNDS[b.background] ?? BACKGROUNDS.Sunset;
      const grad = g.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, a); grad.addColorStop(1, z);
      g.fillStyle = grad;
    }
    g.fillRect(0, 0, W, H);
  }
  const r = b.radius * scale;
  const path = () => { g.beginPath(); g.roundRect(x, y, w, h, r); };
  if (b.shadow > 0) {
    g.save();
    g.shadowColor = `rgba(0,0,0,${0.45 * b.shadow})`;
    g.shadowBlur = Math.max(W, H) * 0.035 * b.shadow;
    g.shadowOffsetY = Math.max(W, H) * 0.012 * b.shadow;
    path(); g.fillStyle = "#000"; g.fill();
    g.restore();
  }
  g.save(); path(); g.clip();
  g.imageSmoothingQuality = "high";
  g.drawImage(img, x, y, w, h);
  g.restore();
  return c.toDataURL("image/png");
}
