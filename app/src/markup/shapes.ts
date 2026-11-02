// Shapes for the markup editor. Scene units are the capture's own pixels (the picture sits at 0,0), so sizes scale
// with the picture: `unit(w, h)` is one "step" of stroke width or text size for a picture that big.

import {
  Circle, Ellipse, FabricImage, FabricText, Group, IText, Point, Polyline, Rect, Shadow, classRegistry, controlsUtils,
  type FabricObject,
} from "fabric";

export type Meta = { kind: "arrow" | "line" | "rect" | "ellipse" | "pen" | "highlight" | "text" | "step" | "redact" | "spot" | "magnify" | "sticker" | "image"; mode?: "pixelate" | "blur" | "black"; n?: number };
export type Style = { color: string; width: number; fill: "none" | "soft" | "solid"; font: number; textBg: boolean; shadow: boolean };

export const COLORS = ["#e03131", "#f08c00", "#ffd43b", "#2f9e44", "#1971c2", "#7048e8", "#000000", "#ffffff"];
export const WIDTHS = [1, 2, 3.5, 6];         // × unit
export const FONTS = [10, 14, 20, 30];        // × unit
export const DEFAULT_STYLE: Style = { color: "#e03131", width: 1, fill: "none", font: 1, textBg: false, shadow: true };

/** One size step for a picture w×h: ~2.5 px on a 2560-wide capture, never under 1.5. */
export const unit = (w: number, h: number) => Math.max(1.5, Math.max(w, h) / 1000);

export const meta = (o: object) => (o as { gb?: Meta }).gb;
export const setMeta = (o: FabricObject, m: Meta) => { (o as unknown as { gb: Meta }).gb = m; return o; };

/** Extra properties saved with each shape (undo, tabs). */
export const PROPS = ["gb", "perPixelTargetFind", "strokeUniform", "objectCaching", "hasBorders", "lockScalingFlip"];

/** Put an object's top-left corner at (x, y) (Fabric 7 positions by centre). */
export function place(o: FabricObject, x: number, y: number) {
  o.setPositionByOrigin(new Point(x, y), "left", "top");
  o.setCoords();
  return o;
}

const shadowFor = (on: boolean, u: number) => (on ? new Shadow({ color: "rgba(0,0,0,0.35)", blur: 4 * u, offsetX: 0, offsetY: u }) : null);
const soft = (hex: string) => hex + "40";
const contrast = (hex: string) => {
  const n = parseInt(hex.slice(1, 7), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#111111" : "#ffffff";
};

/** A polyline with a filled head at its last point. The shaft stops short of the tip so it doesn't poke through. */
export class Arrow extends Polyline {
  static type = "Arrow";
  _render(ctx: CanvasRenderingContext2D) {
    const pts = this.points, n = pts.length;
    if (n < 2) return;
    const ox = this.pathOffset.x, oy = this.pathOffset.y, a = pts[n - 2], b = pts[n - 1];
    const ang = Math.atan2(b.y - a.y, b.x - a.x), head = headSize(this.strokeWidth);
    ctx.beginPath();
    ctx.moveTo(pts[0].x - ox, pts[0].y - oy);
    for (let i = 1; i < n - 1; i++) ctx.lineTo(pts[i].x - ox, pts[i].y - oy);
    ctx.lineTo(b.x - ox - Math.cos(ang) * head * 0.75, b.y - oy - Math.sin(ang) * head * 0.75);
    this._renderStroke(ctx);
    ctx.beginPath();
    ctx.moveTo(b.x - ox, b.y - oy);
    ctx.lineTo(b.x - ox - head * Math.cos(ang - 0.45), b.y - oy - head * Math.sin(ang - 0.45));
    ctx.lineTo(b.x - ox - head * Math.cos(ang + 0.45), b.y - oy - head * Math.sin(ang + 0.45));
    ctx.closePath();
    ctx.fillStyle = this.stroke as string;
    ctx.fill();
  }
}
classRegistry.setClass(Arrow);
const headSize = (w: number) => Math.max(12, w * 3.6);

const lineish = (o: Polyline, s: Style, u: number, kind: "arrow" | "line") => {
  const w = WIDTHS[s.width] * u;
  o.set({
    stroke: s.color, strokeWidth: w, fill: "", strokeLineCap: "round", strokeLineJoin: "round", objectCaching: false,
    perPixelTargetFind: true, hasBorders: false, padding: kind === "arrow" ? headSize(w) / 2 : 0, shadow: shadowFor(s.shadow, u),
  });
  o.controls = controlsUtils.createPolyControls(o);
  return setMeta(o, { kind });
};

export function makeLine(kind: "arrow" | "line", x1: number, y1: number, x2: number, y2: number, s: Style, u: number) {
  const pts = [new Point(x1, y1), new Point(x2, y2)];
  return lineish(kind === "arrow" ? new Arrow(pts) : new Polyline(pts), s, u, kind);
}

/** After a vertex moves the shape keeps its own controls (enlivened shapes come back with the defaults). */
export function restoreControls(o: FabricObject) {
  const k = meta(o)?.kind;
  if ((k === "arrow" || k === "line") && o instanceof Polyline) o.controls = controlsUtils.createPolyControls(o);
}

export function makeBox(kind: "rect" | "ellipse", x: number, y: number, w: number, h: number, s: Style, u: number) {
  const common = {
    stroke: s.color, strokeWidth: WIDTHS[s.width] * u, strokeUniform: true, fill: s.fill === "none" ? "" : s.fill === "soft" ? soft(s.color) : s.color,
    perPixelTargetFind: s.fill === "none", shadow: shadowFor(s.shadow, u),
  };
  const o = kind === "rect" ? new Rect({ ...common, width: w, height: h, rx: u * 3, ry: u * 3 }) : new Ellipse({ ...common, rx: w / 2, ry: h / 2 });
  return setMeta(place(o, x, y), { kind });
}

export function makeText(x: number, y: number, s: Style, u: number, text = "") {
  const size = FONTS[s.font] * u;
  const o = new IText(text, {
    fontFamily: "Segoe UI, system-ui, sans-serif", fontWeight: 600, fontSize: size, fill: s.textBg ? contrast(s.color) : s.color,
    backgroundColor: s.textBg ? s.color : "", padding: s.textBg ? size * 0.25 : 0, shadow: s.textBg ? null : shadowFor(s.shadow, u * 0.6),
    editingBorderColor: "#3884ff", cursorColor: s.textBg ? contrast(s.color) : s.color,
  });
  return setMeta(place(o, x, y - size * 0.6), { kind: "text" });
}

export function makeStep(n: number, cx: number, cy: number, s: Style, u: number) {
  const r = FONTS[s.font] * u * 0.85;
  const disc = new Circle({ radius: r, fill: s.color, stroke: "#ffffff", strokeWidth: Math.max(1.5, u * 0.8), originX: "center", originY: "center", shadow: shadowFor(s.shadow, u) });
  const label = new FabricText(String(n), { fontFamily: "Segoe UI, system-ui, sans-serif", fontWeight: 700, fontSize: r * 1.15, fill: contrast(s.color), originX: "center", originY: "center" });
  const g = new Group([disc, label]);
  g.setPositionByOrigin(new Point(cx, cy), "center", "center");
  g.setCoords();
  return setMeta(g, { kind: "step", n });
}

export async function makeImage(dataURL: string, x: number, y: number, w: number, h: number, m: Meta) {
  const img = await FabricImage.fromURL(dataURL);
  img.set({ scaleX: w / img.width, scaleY: h / img.height });
  return setMeta(place(img, x, y), m);
}

export function makeBlack(x: number, y: number, w: number, h: number) {
  return setMeta(place(new Rect({ width: w, height: h, fill: "#000000", strokeWidth: 0 }), x, y), { kind: "redact", mode: "black" });
}

/** Apply a style change to existing shapes (only what makes sense for each kind). */
export function restyle(o: FabricObject, s: Style, u: number) {
  const k = meta(o)?.kind;
  const sh = shadowFor(s.shadow, u);
  if (k === "arrow" || k === "line") { const w = WIDTHS[s.width] * u; o.set({ stroke: s.color, strokeWidth: w, shadow: sh, padding: k === "arrow" ? headSize(w) / 2 : 0 }); }
  else if (k === "rect" || k === "ellipse") o.set({ stroke: s.color, strokeWidth: WIDTHS[s.width] * u, fill: s.fill === "none" ? "" : s.fill === "soft" ? soft(s.color) : s.color, perPixelTargetFind: s.fill === "none", shadow: sh });
  else if (k === "pen") o.set({ stroke: s.color, strokeWidth: WIDTHS[s.width] * u, shadow: sh });
  else if (k === "highlight") o.set({ stroke: s.color + "66" });
  else if (k === "text" && o instanceof IText) {
    const size = FONTS[s.font] * u;
    o.set({ fontSize: size, fill: s.textBg ? contrast(s.color) : s.color, backgroundColor: s.textBg ? s.color : "", padding: s.textBg ? size * 0.25 : 0, shadow: s.textBg ? null : shadowFor(s.shadow, u * 0.6) });
  } else if (k === "step" && o instanceof Group) {
    const [disc, label] = o.getObjects();
    disc.set({ fill: s.color, shadow: sh });
    label.set({ fill: contrast(s.color) });
  } else return false;
  o.setCoords();
  return true;
}
