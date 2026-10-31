// Redaction and spotlight are baked into pixels (an image layer), never a live filter,
// so the hidden content can't be recovered from the exported picture.

export type Box = { x: number; y: number; width: number; height: number };

function load(dataURL: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataURL;
  });
}

/** Pixelate or blur the part of the base picture under `box` (scene coords; the base sits at its own x/y). */
export async function redact(baseDataURL: string, base: Box, box: Box, mode: "pixelate" | "blur"): Promise<{ dataURL: string; box: Box } | null> {
  const img = await load(baseDataURL);
  const sx = base.width / img.naturalWidth, sy = base.height / img.naturalHeight;
  const x0 = Math.max(box.x, base.x), y0 = Math.max(box.y, base.y);
  const x1 = Math.min(box.x + box.width, base.x + base.width), y1 = Math.min(box.y + box.height, base.y + base.height);
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  const px = { x: (x0 - base.x) / sx, y: (y0 - base.y) / sy, w: (x1 - x0) / sx, h: (y1 - y0) / sy };

  const out = document.createElement("canvas");
  out.width = Math.round(px.w);
  out.height = Math.round(px.h);
  const ctx = out.getContext("2d")!;
  if (mode === "pixelate") {
    const block = Math.max(8, Math.round(Math.max(px.w, px.h) / 30));
    const small = document.createElement("canvas");
    small.width = Math.max(1, Math.round(px.w / block));
    small.height = Math.max(1, Math.round(px.h / block));
    small.getContext("2d")!.drawImage(img, px.x, px.y, px.w, px.h, 0, 0, small.width, small.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, out.width, out.height);
  } else {
    // Blur a margin around the box too, so edges are as smeared as the middle; then draw the middle.
    const pad = 24;
    ctx.filter = "blur(14px)";
    ctx.drawImage(img, px.x - pad, px.y - pad, px.w + pad * 2, px.h + pad * 2, -pad, -pad, out.width + pad * 2, out.height + pad * 2);
    ctx.filter = "blur(14px)";   // second pass: strong enough that text is unreadable
    ctx.drawImage(out, 0, 0);
  }
  return { dataURL: out.toDataURL("image/png"), box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } };
}

/** Full-size overlay that dims everything except `box`. */
export function spotlight(base: Box, box: Box, opacity = 0.6) {
  const c = document.createElement("canvas");
  c.width = Math.round(base.width);
  c.height = Math.round(base.height);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = `rgba(0,0,0,${opacity})`;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.clearRect(box.x - base.x, box.y - base.y, box.width, box.height);
  return c.toDataURL("image/png");
}
