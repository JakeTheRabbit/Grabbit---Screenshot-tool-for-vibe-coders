// The picture editor (the default): the capture is the canvas, tools are made for screenshots. Fabric.js does the
// drawing; scene units are the capture's own pixels with the picture at 0,0. Spec: docs/markup-editor.md.

import { useCallback, useEffect, useRef, useState } from "react";
import { ActiveSelection, Canvas, FabricImage, FabricText, IText, InteractiveFabricObject, PencilBrush, Point, Rect, util, type FabricObject, type TPointerEventInfo } from "fabric";
import { invoke } from "@tauri-apps/api/core";
import { getImage, onHost, post, type ExportAction, type RecentItem, type Size } from "../host";
import { send } from "../bridge";
import { EMOJI, ICONS, iconDataURL } from "../stickers";
import { Icon } from "../icons";
import { Menu } from "../Menu";
import { redact, spotlight, type Box } from "../redact";
import { beautify, DEFAULT_BEAUTY, type Beauty } from "../beautify";
import { findPrivate, type Word } from "../private";
import { Panel, type EditorOps, type PanelName } from "../Panel";
import { switchEditor, takeCarried } from "../carry";
import { Library, type Dock } from "./Library";
import { getTheme, setTheme, type Theme } from "../ui/theme";
import {
  COLORS, DEFAULT_STYLE, FONTS, PROPS, fontOf, WIDTHS, makeBlack, makeBox, makeImage, makeLine, makeStep, makeText, meta, place,
  restoreControls, restyle, setMeta, unit, type Style,
} from "./shapes";

type Tool = "select" | "arrow" | "line" | "rect" | "ellipse" | "pen" | "highlight" | "text" | "step" | "pixelate" | "blur" | "black" | "spotlight" | "magnify" | "crop" | "eyedropper";
const TOOLS: { id: Tool; icon: Parameters<typeof Icon>[0]["name"]; label: string; key: string }[] = [
  { id: "select", icon: "pointer", label: "Select", key: "V" },
  { id: "arrow", icon: "arrow", label: "Arrow", key: "A" },
  { id: "line", icon: "line", label: "Line", key: "L" },
  { id: "rect", icon: "rect", label: "Box", key: "R" },
  { id: "ellipse", icon: "ellipse", label: "Ellipse", key: "O" },
  { id: "pen", icon: "pen", label: "Pen", key: "P" },
  { id: "highlight", icon: "highlight", label: "Highlighter", key: "H" },
  { id: "text", icon: "text", label: "Text", key: "T" },
  { id: "step", icon: "step", label: "Numbered step", key: "N" },
  { id: "pixelate", icon: "pixelate", label: "Pixelate", key: "X" },
  { id: "blur", icon: "blur", label: "Blur", key: "B" },
  { id: "black", icon: "black", label: "Black out", key: "K" },
  { id: "spotlight", icon: "spot", label: "Spotlight", key: "S" },
  { id: "magnify", icon: "magnify", label: "Magnify", key: "M" },
  { id: "crop", icon: "crop", label: "Crop", key: "C" },
  { id: "eyedropper", icon: "pipette", label: "Pick a colour from the picture", key: "I" },
];
const BOXY: Tool[] = ["rect", "ellipse", "pixelate", "blur", "black", "spotlight", "magnify", "crop"];
const STAYS: Tool[] = ["pen", "highlight", "step"];   // tools that stay picked after use

type Snap = { base: string; objs: object[] };
type Base = { url: string; w: number; h: number };
type Doc = { id: string; name: string; bases: Map<string, Base>; hist: Snap[]; at: number; saved: number; dirty: boolean };
type TabsAt = "side" | "top";
const pref = <T extends string>(key: string, d: T): T => { try { return (localStorage.getItem(key) as T) || d; } catch { return d; } };
const keep = (key: string, v: string) => { try { localStorage.setItem(key, v); } catch { /* private mode */ } };

InteractiveFabricObject.ownDefaults = {
  ...InteractiveFabricObject.ownDefaults,
  transparentCorners: false, cornerColor: "#ffffff", cornerStrokeColor: "#3884ff", borderColor: "#3884ff", cornerSize: 11, cornerStyle: "circle", borderScaleFactor: 1.5,
};

const BASE_PAD = 24;
/** The dashed box the Crop tool leaves until you apply it (not part of the drawing). */
const isCrop = (o?: FabricObject) => !!(o as unknown as { gbCrop?: boolean } | undefined)?.gbCrop;
/** A rectangle's own area in picture pixels, without its outline (getBoundingRect counts the stroke). */
const areaOf = (o: FabricObject) => {
  const c = o.getCenterPoint(), w = o.width * o.scaleX, h = o.height * o.scaleY;
  return { left: c.x - w / 2, top: c.y - h / 2, width: w, height: h };
};

export function MarkupApp() {
  const host = useRef<HTMLDivElement>(null);
  const el = useRef<HTMLCanvasElement>(null);
  const fcRef = useRef<Canvas | null>(null);
  const [ready, setReady] = useState(false);
  const docs = useRef<Doc[]>([]);
  const active = useRef<Doc | null>(null);
  const restoring = useRef(false);
  const [tabs, setTabs] = useState<{ id: string; name: string; dirty: boolean; thumb: string }[]>([]);
  const [activeId, setActiveId] = useState("");
  const [name, setName] = useState("Grabbit");
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [busy, setBusy] = useState("");
  const [panel, setPanel] = useState<PanelName | null>(null);
  const [stickers, setStickers] = useState(false);
  const [tool, setToolState] = useState<Tool>("select");
  const toolRef = useRef<Tool>("select");
  const [style, setStyleState] = useState<Style>(() => { try { return { ...DEFAULT_STYLE, ...JSON.parse(localStorage.getItem("markupStyle") ?? "{}") }; } catch { return DEFAULT_STYLE; } });
  const styleRef = useRef(style);
  styleRef.current = style;
  const [zoomPct, setZoomPct] = useState(100);
  const fitted = useRef(true);
  const [cropping, setCropping] = useState(false);
  const [hasSel, setHasSel] = useState(false);
  const [beauty, setBeautyState] = useState<Beauty>(() => { try { return { ...DEFAULT_BEAUTY, ...JSON.parse(localStorage.getItem("beauty") ?? "{}"), on: false }; } catch { return DEFAULT_BEAUTY; } });
  const setBeauty = (b: Beauty) => { setBeautyState(b); try { localStorage.setItem("beauty", JSON.stringify(b)); } catch { /* private mode */ } };
  const beautyRef = useRef(beauty);
  beautyRef.current = beauty;
  type BarPos = "top" | "bottom" | "left" | "right";
  const [barPos, setBarPosState] = useState<BarPos>(() => { try { return (localStorage.getItem("barPos") as BarPos) || "top"; } catch { return "top"; } });
  const setBarPos = (p: BarPos) => { setBarPosState(p); try { localStorage.setItem("barPos", p); } catch { /* private mode */ } };
  const [dock, setDockState] = useState<Dock>(() => pref<Dock>("libraryDock", "left"));
  const setDock = (d: Dock) => { setDockState(d); keep("libraryDock", d); };
  const [tabsAt, setTabsAtState] = useState<TabsAt>(() => pref<TabsAt>("tabsAt", "side"));
  const setTabsAt = (t: TabsAt) => { setTabsAtState(t); keep("tabsAt", t); };
  const [look, setLook] = useState<Theme>(getTheme);
  // The computer's fonts, asked for the first time the font menu opens.
  const [fonts, setFonts] = useState<string[]>([]);
  const loadFonts = () => { if (!fonts.length) void invoke<string[]>("system_fonts").then((f) => setFonts(f ?? [])).catch(() => {}); };
  const [tabsSlim, setTabsSlimState] = useState(() => pref<string>("tabsSlim", "") === "1");
  const setTabsSlim = (v: boolean) => { setTabsSlimState(v); keep("tabsSlim", v ? "1" : ""); };

  const fc = () => fcRef.current!;
  const base = (): Base | null => { const d = active.current; return d ? d.bases.get(d.hist[d.at].base) ?? null : null; };
  const u = () => { const b = base(); return b ? unit(b.w, b.h) : 2; };
  const toast = (t: string) => { setBusy(t); window.setTimeout(() => setBusy((b) => (b === t ? "" : b)), 3500); };

  // ---------- tabs and history ----------

  // Tabs show a 120 px copy of their picture: an <img> of the full picture would decode it all again per tab.
  const thumbs = useRef(new Map<string, string>());
  const syncTabs = useCallback(() => {
    const thumb = (url: string) => {
      if (!url) return "";
      if (!thumbs.current.has(url)) {
        thumbs.current.set(url, "");
        const i = new Image();
        i.onload = () => {
          const c = document.createElement("canvas");
          c.width = 120; c.height = Math.max(1, Math.round((i.naturalHeight * 120) / i.naturalWidth));
          c.getContext("2d")!.drawImage(i, 0, 0, c.width, c.height);
          thumbs.current.set(url, c.toDataURL("image/jpeg", 0.8));
          syncTabs();
        };
        i.src = url;
      }
      return thumbs.current.get(url)!;
    };
    const urls = docs.current.map((d) => d.bases.get(d.hist[d.at].base)?.url ?? "");
    for (const k of thumbs.current.keys()) if (!urls.includes(k)) thumbs.current.delete(k);
    setTabs(docs.current.map((d, i) => ({ id: d.id, name: d.name, dirty: d.dirty, thumb: thumb(urls[i]) })));
    post({ type: "dirty", value: docs.current.some((d) => d.dirty) });
  }, []);

  /** Record the drawing as it is now (one undo step). */
  const commit = useCallback(() => {
    const d = active.current;
    if (!d || restoring.current) return;
    const objs = fc().getObjects().filter((o) => meta(o)).map((o) => o.toObject(PROPS));
    d.hist = d.hist.slice(0, d.at + 1);
    d.hist.push({ base: d.hist[d.at].base, objs });
    if (d.hist.length > 100) d.hist.shift(); else d.at++;
    d.at = d.hist.length - 1;
    const dirty = d.at !== d.saved;
    if (dirty !== d.dirty) { d.dirty = dirty; syncTabs(); }
  }, [syncTabs]);

  /** Start a new undo step with a different picture underneath (crop, AI edits). */
  const commitBase = (key: string, b: Base) => {
    const d = active.current!;
    d.bases.set(key, b);
    d.hist = d.hist.slice(0, d.at + 1);
    d.hist.push({ base: key, objs: fc().getObjects().filter((o) => meta(o)).map((o) => o.toObject(PROPS)) });
    d.at = d.hist.length - 1;
    d.dirty = d.at !== d.saved;
    syncTabs();
  };

  const baseImages = useRef(new Map<string, FabricImage>());
  async function restore(snap: Snap, d: Doc) {
    const c = fc();
    restoring.current = true;
    try {
      c.discardActiveObject();
      c.remove(...c.getObjects());
      const key = `${d.id}:${snap.base}`;
      let img = baseImages.current.get(key);
      if (!img) {
        img = await FabricImage.fromURL(d.bases.get(snap.base)!.url);
        place(img, 0, 0);
        baseImages.current.set(key, img);
      }
      c.backgroundImage = img;
      const objs = await util.enlivenObjects<FabricObject>(snap.objs);
      objs.forEach(restoreControls);
      if (objs.length) c.add(...objs);
      c.requestRenderAll();
    } finally { restoring.current = false; }
  }

  const fit = useCallback(() => {
    const c = fcRef.current, b = base();
    if (!c || !b) return;
    const W = c.getWidth(), H = c.getHeight();
    const z = Math.min((W - BASE_PAD * 2) / b.w, (H - BASE_PAD * 2) / b.h, 2);
    c.setViewportTransform([z, 0, 0, z, (W - b.w * z) / 2, (H - b.h * z) / 2]);
    fitted.current = true;
    setZoomPct(Math.round(z * 100));
  }, []);

  async function show(d: Doc) {
    active.current = d;
    await restore(d.hist[d.at], d);
    setActiveId(d.id);
    setName(d.name);
    document.title = `Grabbit — ${d.name}`;
    fit();
  }

  async function addDoc(tabName: string, dataURL: string, w: number, h: number) {
    const d: Doc = { id: `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, name: tabName, bases: new Map([["b0", { url: dataURL, w, h }]]), hist: [{ base: "b0", objs: [] }], at: 0, saved: 0, dirty: false };
    docs.current.push(d);
    await show(d);
    syncTabs();
  }

  function blank() {
    const c = fc();
    active.current = null;
    c.remove(...c.getObjects());
    c.backgroundImage = undefined;
    c.requestRenderAll();
    setActiveId(""); setName("Grabbit"); document.title = "Grabbit";
    syncTabs();
  }

  async function closeTab(id: string) {
    const d = docs.current.find((x) => x.id === id);
    if (!d) return;
    if (d.dirty) { if (active.current !== d) await show(d); await exportAs("closeSave", "Full"); }
    const i = docs.current.indexOf(d);
    docs.current.splice(i, 1);
    if (!docs.current.length) return blank();
    if (active.current === d) await show(docs.current[Math.min(i, docs.current.length - 1)]);
    syncTabs();
  }

  // ---------- output ----------

  /** The capture with its drawings, at the capture's own size (Beautify applied when on). */
  const render = useCallback(async (withBeauty = true) => {
    const c = fc(), b = base();
    if (!b) return "";
    const z = c.getZoom(), vp = c.viewportTransform;
    const raw = c.toCanvasElement(1 / z, { left: vp[4], top: vp[5], width: b.w * z, height: b.h * z, filter: (o) => !!meta(o) });
    let out = raw;
    if (raw.width !== b.w || raw.height !== b.h) {   // float rounding: draw into the exact size
      out = document.createElement("canvas");
      out.width = b.w; out.height = b.h;
      out.getContext("2d")!.drawImage(raw, 0, 0, b.w, b.h);
    }
    const png = out.toDataURL("image/png");
    return withBeauty && beautyRef.current.on ? beautify(png, beautyRef.current) : png;
  }, []);
  (window as unknown as { grabbitRender: typeof render }).grabbitRender = render;   // test hook (CDP checks)

  async function exportAs(action: ExportAction, size: Size) {
    const d = active.current;
    if (!d) return;
    setBusy(action === "save" || action === "saveQuick" ? "Saving…" : "Copying…");
    try {
      post({ type: "export", action, size, name: d.name, dataURL: await render() });
      if (action !== "copyClose") { d.saved = d.at; d.dirty = false; syncTabs(); }
    } finally { setBusy(""); }
  }

  // ---------- picture helpers ----------

  const baseCanvas = useRef<{ key: string; ctx: CanvasRenderingContext2D } | null>(null);
  async function basePixels() {
    const d = active.current!, key = d.hist[d.at].base;
    if (baseCanvas.current?.key === `${d.id}:${key}`) return baseCanvas.current.ctx;
    const b = base()!, img = await new Promise<HTMLImageElement>((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = b.url; });
    const cv = document.createElement("canvas");
    cv.width = b.w; cv.height = b.h;
    const ctx = cv.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    baseCanvas.current = { key: `${d.id}:${key}`, ctx };
    return ctx;
  }

  /** A box clamped to the picture, or null when it's too small to mean anything. */
  const clampBox = (x: number, y: number, w: number, h: number): Box | null => {
    const b = base()!;
    const x0 = Math.max(0, Math.min(x, x + w)), y0 = Math.max(0, Math.min(y, y + h));
    const x1 = Math.min(b.w, Math.max(x, x + w)), y1 = Math.min(b.h, Math.max(y, y + h));
    return x1 - x0 >= 3 && y1 - y0 >= 3 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
  };

  async function hideBox(box: Box, mode: "pixelate" | "blur" | "black") {
    const b = base()!;
    if (mode === "black") return makeBlack(box.x, box.y, box.width, box.height);
    const r = await redact(b.url, { x: 0, y: 0, width: b.w, height: b.h }, box, mode);
    return r ? makeImage(r.dataURL, r.box.x, r.box.y, r.box.width, r.box.height, { kind: "redact", mode }) : null;
  }

  async function addSpotlight(box: Box) {
    const b = base()!;
    const c = fc();
    c.getObjects().filter((o) => meta(o)?.kind === "spot").forEach((o) => c.remove(o));   // one spotlight at a time
    const o = await makeImage(spotlight({ x: 0, y: 0, width: b.w, height: b.h }, box), 0, 0, b.w, b.h, { kind: "spot" });
    o.set({ selectable: false, evented: false });
    c.insertAt(0, o);
  }

  async function addMagnifier(box: Box) {
    const b = base()!, ctx = await basePixels(), k = 2;
    const cv = document.createElement("canvas");
    cv.width = Math.round(box.width * k); cv.height = Math.round(box.height * k);
    const g = cv.getContext("2d")!;
    g.imageSmoothingQuality = "high";
    g.drawImage(ctx.canvas, box.x, box.y, box.width, box.height, 0, 0, cv.width, cv.height);
    const s = styleRef.current, uu = u();
    // Beside the source if it fits on the right, else on the left, else below; kept on the picture.
    let x = box.x + box.width + 12 * uu, y = box.y;
    if (x + cv.width > b.w) x = box.x - cv.width - 12 * uu;
    if (x < 0) { x = Math.max(0, Math.min(b.w - cv.width, box.x)); y = box.y + box.height + 12 * uu; }
    y = Math.max(0, Math.min(b.h - cv.height, y));
    const img = await makeImage(cv.toDataURL("image/png"), x, y, cv.width, cv.height, { kind: "magnify" });
    img.set({ stroke: s.color, strokeWidth: WIDTHS[s.width] * uu, strokeUniform: true });
    const src = makeBox("rect", box.x, box.y, box.width, box.height, { ...s, fill: "none", shadow: false }, uu);
    src.set({ strokeDashArray: [6 * uu, 4 * uu] });
    return [src, img];
  }

  async function applyCrop() {
    const c = fc(), r = c.getObjects().find((o) => isCrop(o));
    if (!r) return;
    const bb = areaOf(r);
    c.remove(r);
    setCropping(false);
    const box = clampBox(bb.left, bb.top, bb.width, bb.height);
    if (!box) return;
    const ctx = await basePixels();
    const cv = document.createElement("canvas");
    cv.width = Math.round(box.width); cv.height = Math.round(box.height);
    cv.getContext("2d")!.drawImage(ctx.canvas, box.x, box.y, box.width, box.height, 0, 0, cv.width, cv.height);
    c.getObjects().filter((o) => meta(o)?.kind === "spot").forEach((o) => c.remove(o));   // sized for the old picture
    for (const o of c.getObjects()) { o.set({ left: o.left - box.x, top: o.top - box.y }); o.setCoords(); }
    const d = active.current!, key = `b${d.bases.size}`;
    commitBase(key, { url: cv.toDataURL("image/png"), w: cv.width, h: cv.height });
    await restore(d.hist[d.at], d);
    fit();
  }

  function cancelCrop() {
    const c = fc();
    c.getObjects().filter((o) => isCrop(o)).forEach((o) => c.remove(o));
    setCropping(false);
  }

  // ---------- tools ----------

  const setTool = useCallback((t: Tool) => {
    toolRef.current = t;
    setToolState(t);
    const c = fcRef.current;
    if (!c) return;
    const draws = t !== "select";
    c.selection = !draws;
    c.skipTargetFind = draws;
    c.isDrawingMode = t === "pen" || t === "highlight";
    if (c.isDrawingMode) {
      const brush = new PencilBrush(c), s = styleRef.current, uu = u();
      brush.color = t === "highlight" ? s.color + "66" : s.color;
      brush.width = t === "highlight" ? 9 * uu : WIDTHS[s.width] * uu;
      brush.strokeLineCap = t === "highlight" ? "square" : "round";
      c.freeDrawingBrush = brush;
    }
    if (draws) c.discardActiveObject();
    c.defaultCursor = t === "select" ? "default" : t === "text" ? "text" : "crosshair";
    c.requestRenderAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setStyle = (p: Partial<Style>) => {
    const s = { ...styleRef.current, ...p };
    styleRef.current = s;
    setStyleState(s);
    try { localStorage.setItem("markupStyle", JSON.stringify(s)); } catch { /* private mode */ }
    const c = fcRef.current;
    if (!c) return;
    const sel = c.getActiveObjects();
    if (sel.length && sel.map((o) => restyle(o, s, u())).some(Boolean)) { c.requestRenderAll(); commit(); }
    if (c.isDrawingMode) setTool(toolRef.current);   // brush picks up the new colour/width
  };

  const nextStep = () => Math.max(0, ...fc().getObjects().map((o) => meta(o)?.n ?? 0)) + 1;

  // Drawing a shape: mouse down starts a preview, move reshapes it, up makes the real thing.
  const drag = useRef<{ x0: number; y0: number; tmp: FabricObject | null } | null>(null);
  const pan = useRef<{ x: number; y: number } | null>(null);
  const space = useRef(false);

  function ghost(t: Tool, x0: number, y0: number, x1: number, y1: number, shift: boolean): FabricObject {
    const s = styleRef.current, uu = u();
    if (t === "arrow" || t === "line") {
      if (shift) {   // snap to 45°
        const a = Math.round(Math.atan2(y1 - y0, x1 - x0) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(x1 - x0, y1 - y0);
        x1 = x0 + Math.cos(a) * len; y1 = y0 + Math.sin(a) * len;
      }
      return makeLine(t, x0, y0, x1, y1, s, uu);
    }
    let w = x1 - x0, h = y1 - y0;
    if (shift) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
    const x = Math.min(x0, x0 + w), y = Math.min(y0, y0 + h);
    if (t === "rect" || t === "ellipse") return makeBox(t, x, y, Math.abs(w), Math.abs(h), s, uu);
    const r = place(new Rect({ width: Math.abs(w), height: Math.abs(h), fill: t === "black" ? "#000000aa" : "rgba(56,132,255,0.12)", stroke: "#3884ff", strokeWidth: 1.5, strokeUniform: true, strokeDashArray: [6, 4], selectable: false, evented: false }), x, y);
    return r;
  }

  async function finish(t: Tool, tmp: FabricObject) {
    const c = fc();
    const bb = t === "arrow" || t === "line" ? tmp.getBoundingRect() : areaOf(tmp);
    c.remove(tmp);
    if (t === "arrow" || t === "line") {
      if (bb.width + bb.height < 6) return;
      c.add(tmp); c.setActiveObject(tmp); commit(); return;
    }
    if (t === "rect" || t === "ellipse") {
      if (bb.width < 4 || bb.height < 4) return;
      c.add(tmp); c.setActiveObject(tmp); commit(); return;
    }
    const box = clampBox(bb.left, bb.top, bb.width, bb.height);
    if (!box) return;
    if (t === "crop") {
      const r = place(new Rect({ width: box.width, height: box.height, fill: "rgba(56,132,255,0.08)", stroke: "#3884ff", strokeWidth: 2, strokeUniform: true, strokeDashArray: [8, 5] }), box.x, box.y);
      (r as unknown as { gbCrop: boolean }).gbCrop = true;
      c.add(r); c.setActiveObject(r);
      setCropping(true);
      return;
    }
    if (t === "spotlight") { await addSpotlight(box); commit(); return; }
    if (t === "magnify") { const objs = await addMagnifier(box); c.add(...objs); c.setActiveObject(objs[1]); commit(); return; }
    const o = await hideBox(box, t as "pixelate" | "blur" | "black");
    if (o) { c.add(o); c.setActiveObject(o); commit(); }
  }

  async function pickColour(x: number, y: number) {
    const b = base();
    if (!b || x < 0 || y < 0 || x >= b.w || y >= b.h) return;
    const [r, g, bl] = (await basePixels()).getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
    setStyle({ color: "#" + [r, g, bl].map((v) => v.toString(16).padStart(2, "0")).join("") });
  }

  // ---------- canvas setup ----------

  useEffect(() => {
    const c = new Canvas(el.current!, {
      preserveObjectStacking: true, targetFindTolerance: 10, uniformScaling: false, stopContextMenu: true,
      selectionColor: "rgba(56,132,255,0.08)", selectionBorderColor: "#3884ff", selectionLineWidth: 1.5, backgroundColor: "",
    });
    fcRef.current = c;
    (window as unknown as { grabbit: object }).grabbit = Object.assign((window as unknown as { grabbit?: object }).grabbit ?? {}, { fabric: c });   // test hook

    const resize = () => {
      const h = host.current!;
      c.setDimensions({ width: h.clientWidth, height: h.clientHeight });
      if (fitted.current) fit(); else c.requestRenderAll();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host.current!);
    resize();

    c.on("mouse:down", (o: TPointerEventInfo) => {
      const e = o.e as MouseEvent, p = o.scenePoint, t = toolRef.current;
      if (e.button === 1 || space.current) { pan.current = { x: e.clientX, y: e.clientY }; c.selection = false; return; }
      if (e.button !== 0 || !active.current || c.isDrawingMode) return;
      if (t === "select") return;
      if (t === "eyedropper") { void pickColour(p.x, p.y); setTool("select"); return; }
      if (t === "text") {
        const tx = makeText(p.x, p.y, styleRef.current, u());
        c.add(tx); c.setActiveObject(tx); (tx as IText).enterEditing();
        setTool("select");
        return;
      }
      if (t === "step") { const s = makeStep(nextStep(), p.x, p.y, styleRef.current, u()); c.add(s); commit(); return; }
      if (t === "crop") cancelCrop();
      drag.current = { x0: p.x, y0: p.y, tmp: null };
    });
    c.on("mouse:move", (o: TPointerEventInfo) => {
      const e = o.e as MouseEvent;
      if (pan.current) {
        c.relativePan(new Point(e.clientX - pan.current.x, e.clientY - pan.current.y));
        pan.current = { x: e.clientX, y: e.clientY };
        fitted.current = false;
        return;
      }
      const d = drag.current;
      if (!d) return;
      if (d.tmp) c.remove(d.tmp);
      d.tmp = ghost(toolRef.current, d.x0, d.y0, o.scenePoint.x, o.scenePoint.y, e.shiftKey);
      c.add(d.tmp);
      c.requestRenderAll();
    });
    c.on("mouse:up", () => {
      if (pan.current) { pan.current = null; c.selection = toolRef.current === "select"; return; }
      const d = drag.current, t = toolRef.current;
      drag.current = null;
      if (!d?.tmp) return;
      void finish(t, d.tmp).then(() => { if (!STAYS.includes(t) && t !== "crop") setTool("select"); });
    });
    c.on("mouse:wheel", (o) => {
      const e = o.e as WheelEvent;
      e.preventDefault();
      if (e.ctrlKey) {
        const z = Math.min(8, Math.max(0.05, c.getZoom() * 0.999 ** e.deltaY));
        c.zoomToPoint(new Point(e.offsetX, e.offsetY), z);
        setZoomPct(Math.round(z * 100));
      } else c.relativePan(new Point(-e.deltaX, -e.deltaY));
      fitted.current = false;
    });
    c.on("path:created", (o) => {
      const t = toolRef.current, path = (o as unknown as { path: FabricObject }).path;
      path.set({ perPixelTargetFind: true, shadow: null });
      if (t === "highlight") path.set({ globalCompositeOperation: "multiply" });
      setMeta(path, { kind: t === "highlight" ? "highlight" : "pen" });
      commit();
    });
    c.on("object:modified", (o) => { if (!isCrop(o.target)) commit(); });
    c.on("text:editing:exited", (o) => {
      const t = o.target as IText;
      if (!t.text?.trim()) { c.remove(t); return; }
      commit();
    });
    const sel = () => setHasSel(c.getActiveObjects().length > 0);
    c.on("selection:created", sel); c.on("selection:updated", sel); c.on("selection:cleared", sel);
    setReady(true);
    return () => { ro.disconnect(); void c.dispose(); fcRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- host messages ----------

  useEffect(() => {
    if (!ready) return;
    const off = onHost(async (m) => {
      if (m.type === "recent") setRecent(m.recent);
      if (m.type === "load" || m.type === "addTab") {
        if (m.type === "load") { setRecent(m.recent); if (m.panel) setPanel(m.panel as PanelName); }
        if (m.dataURL && m.width && m.height) await addDoc(m.name, m.dataURL, m.width, m.height);
        else if (m.scene) toast("The new editor can't open .excalidraw drawings yet — use the classic editor for those.");
      }
      if (m.type === "requestClose") {
        for (const d of [...docs.current]) if (d.dirty) { await show(d); await exportAs("closeSave", "Full"); }
        post({ type: "close" });
      }
    });
    post({ type: "ready" });
    void takeCarried().then(async (list) => { for (const t of list) await addDoc(t.name, t.dataURL, t.width, t.height); });
    return () => { off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // ---------- actions ----------

  const viewCentre = () => { const c = fc(), vp = c.viewportTransform, z = c.getZoom(); return { x: (c.getWidth() / 2 - vp[4]) / z, y: (c.getHeight() / 2 - vp[5]) / z }; };

  /** Top-left for a new sticker `screen` px big: the view centre, stepped right past anything already there. */
  function stickerSpot(screen: number) {
    const c = fc(), size = screen / c.getZoom(), ctr = viewCentre();
    let x = ctr.x - size / 2;
    const y = ctr.y - size / 2;
    const boxes = c.getObjects().filter((o) => meta(o) && meta(o)!.kind !== "spot").map((o) => o.getBoundingRect());
    while (boxes.some((r) => r.left < x + size && x < r.left + r.width && r.top < y + size && y < r.top + r.height)) x += size * 1.3;
    return { x, y, size };
  }

  function addEmoji(e: string) {
    const c = fc(), { x, y, size } = stickerSpot(72);
    const t = setMeta(place(new FabricText(e, { fontSize: size, fontFamily: "Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji, sans-serif" }), x, y), { kind: "sticker" });
    c.add(t); c.setActiveObject(t); commit(); setTool("select");
  }

  async function addIcon(svg: string) {
    const c = fc(), { x, y, size } = stickerSpot(96);
    const o = await makeImage(iconDataURL(svg, styleRef.current.color), x, y, size, size, { kind: "sticker" });
    c.add(o); c.setActiveObject(o); commit(); setTool("select");
  }

  async function insertPicture(dataURL: string, w: number, h: number) {
    const c = fc(), b = base()!, k = Math.min(1, (b.w * 0.6) / w), ctr = viewCentre();
    const o = await makeImage(dataURL, ctr.x - (w * k) / 2, ctr.y - (h * k) / 2, w * k, h * k, { kind: "image" });
    c.add(o); c.setActiveObject(o); commit(); setTool("select");
  }

  async function openAsTab(item: RecentItem) {
    const img = await getImage(item.path);
    await addDoc(item.name.replace(/\.(webp|png|jpe?g)$/i, ""), img.dataURL, img.width, img.height);
  }

  /** A library item on its own: pictures in a new tab, recordings in the video editor. */
  async function openItem(item: RecentItem) {
    if (item.kind === "video") { await invoke("open_file", { path: item.path }).catch((e) => toast(String(e))); return; }
    await openAsTab(item);
  }

  async function insertRecent(item: RecentItem) {
    if (!active.current) return openAsTab(item);
    const img = await getImage(item.path);
    await insertPicture(img.dataURL, img.width, img.height);
  }

  /** Pixelate / blur / black out the selected boxes or hidden areas (switching an area between modes). */
  async function hideSelected(mode: "pixelate" | "blur" | "black") {
    const c = fc(), sel = c.getActiveObjects().filter((o) => ["rect", "ellipse", "redact"].includes(meta(o)?.kind ?? ""));
    if (!sel.length) { toast("Pick Pixelate, Blur or Black out in the tools and drag over what to hide."); return; }
    c.discardActiveObject();
    for (const o of sel) {
      const bb = o.getBoundingRect(), box = clampBox(bb.left, bb.top, bb.width, bb.height);
      c.remove(o);
      const n = box && (await hideBox(box, mode));
      if (n) c.add(n);
    }
    commit();
  }

  async function autoHide() {
    const b = base();
    if (!b) return;
    setBusy("Looking for private details…");
    try {
      const words = await send<Word[]>({ type: "ocr", dataURL: b.url });
      const hits = findPrivate(words ?? []);
      if (!hits.length) { toast("Nothing private found. Drag Pixelate over anything else."); return; }
      const c = fc();
      for (const h of hits) { const o = await hideBox({ x: h.x, y: h.y, width: h.width, height: h.height }, "pixelate"); if (o) c.add(o); }
      commit();
      toast(`Hid ${hits.length} private detail${hits.length > 1 ? "s" : ""} (${[...new Set(hits.map((h) => h.kind))].join(", ")}). Ctrl+Z to undo.`);
    } finally { setBusy((t) => (t.startsWith("Looking") ? "" : t)); }
  }

  function removeSpotlight() {
    const c = fc(), s = c.getObjects().filter((o) => meta(o)?.kind === "spot");
    if (!s.length) return;
    s.forEach((o) => c.remove(o));
    commit();
  }

  async function copyText() {
    setBusy("Reading text…");
    try {
      const words = await send<Word[]>({ type: "ocr", dataURL: await render(false) });
      const lines: string[] = [];
      let cur = -1;
      for (const w of words ?? []) { if (w.line !== cur) { lines.push(w.text); cur = w.line; } else lines[lines.length - 1] += " " + w.text; }
      if (!lines.length) { toast("No text found"); return; }
      await invoke("copy_text", { text: lines.join("\n") });
      toast(`Copied ${lines.length} line${lines.length > 1 ? "s" : ""} of text`);
    } finally { setBusy((t) => (t === "Reading text…" ? "" : t)); }
  }

  async function readQr() {
    const codes = await send<string[]>({ type: "qr", dataURL: await render(false) });
    if (!codes?.length) { toast("No QR code found"); return; }
    await invoke("copy_text", { text: codes.join("\n") });
    toast(`Copied: ${codes[0].slice(0, 80)}`);
  }

  async function talkToAi() {
    if (!active.current) return;
    setBusy("Opening Talk to AI…");
    try {
      const path = await send<string>({ type: "exportFile", name, dataURL: await render() });
      await invoke("voice_open", { path, title: name });
    } catch (e) { toast(String(e)); } finally { setBusy((t) => (t.startsWith("Opening") ? "" : t)); }
  }

  async function undo() { const d = active.current; if (d && d.at > 0) await jump(d, d.at - 1); }
  async function redo() { const d = active.current; if (d && d.at < d.hist.length - 1) await jump(d, d.at + 1); }
  async function jump(d: Doc, to: number) {
    const before = d.hist[d.at].base;
    d.at = to;
    await restore(d.hist[to], d);
    if (d.hist[to].base !== before) fit();   // crop undone or redone: the picture changed size
    d.dirty = d.at !== d.saved;
    syncTabs();
  }

  function removeSelected() {
    const c = fc(), sel = c.getActiveObjects();
    if (!sel.length) return;
    c.discardActiveObject();
    sel.forEach((o) => c.remove(o));
    if (sel.some((o) => isCrop(o))) setCropping(false);
    commit();
  }

  async function duplicate() {
    const c = fc(), sel = c.getActiveObjects().filter((o) => meta(o));
    if (!sel.length) return;
    c.discardActiveObject();
    const off = 16 / c.getZoom(), copies: FabricObject[] = [];
    for (const o of sel) { const k = await o.clone(PROPS); restoreControls(k); k.set({ left: o.left + off, top: o.top + off }); k.setCoords(); c.add(k); copies.push(k); }
    if (copies.length === 1) c.setActiveObject(copies[0]);
    commit();
  }

  function layer(front: boolean) {
    const c = fc(), sel = c.getActiveObjects();
    if (!sel.length) return;
    sel.forEach((o) => (front ? c.bringObjectToFront(o) : c.sendObjectToBack(o)));
    // Spotlight always stays right above the picture.
    c.getObjects().filter((o) => meta(o)?.kind === "spot").forEach((o) => c.sendObjectToBack(o));
    commit();
  }

  function zoomTo(z: number) {
    const c = fc(), ctr = new Point(c.getWidth() / 2, c.getHeight() / 2);
    c.zoomToPoint(ctr, z);
    fitted.current = false;
    setZoomPct(Math.round(z * 100));
  }

  const ops: EditorOps = {
    render: () => render(),
    baseDataURL: () => base()?.url ?? null,
    selectedRegion: () => {
      const o = fcRef.current?.getActiveObjects().find((x) => ["rect", "ellipse"].includes(meta(x)?.kind ?? ""));
      if (!o) return null;
      const bb = o.getBoundingRect(), r = clampBox(bb.left, bb.top, bb.width, bb.height);
      return r && { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    },
    replaceBase: (dataURL, dropBox) => {
      const d = active.current;
      if (!d) return;
      const c = fc();
      if (dropBox) c.getActiveObjects().filter((x) => ["rect", "ellipse"].includes(meta(x)?.kind ?? "")).forEach((x) => c.remove(x));
      const b = base()!, key = `b${d.bases.size}`;
      commitBase(key, { url: dataURL, w: b.w, h: b.h });
      void restore(d.hist[d.at], d);
    },
    applyBeauty: async () => {
      const d = active.current;
      if (!d) return;
      const url = await render(true);
      const img = await new Promise<HTMLImageElement>((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = url; });
      const c = fc();
      c.discardActiveObject();
      c.remove(...c.getObjects());   // the drawings are in the new picture now
      commitBase(`b${d.bases.size}`, { url, w: img.naturalWidth, h: img.naturalHeight });
      await restore(d.hist[d.at], d);
      fit();
      setBeauty({ ...beautyRef.current, on: false });
      toast("Beautify is now part of the picture (Ctrl+Z to undo).");
    },
    toast, setBusy, name,
    size: (() => { const b = active.current ? base() : null; return b ? { width: b.w, height: b.h } : null; })(),
  };

  async function toClassic() {
    const list: { name: string; dataURL: string }[] = [];
    for (const d of docs.current) { await show(d); list.push({ name: d.name, dataURL: await render(false) }); }
    await switchEditor("classic", list);
  }

  // ---------- keyboard and paste ----------

  useEffect(() => {
    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      return /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || (fcRef.current?.getActiveObject() as IText | undefined)?.isEditing;
    };
    const down = (e: KeyboardEvent) => {
      if (e.key === " " && !typing(e)) { space.current = true; if (fcRef.current) fcRef.current.defaultCursor = "grab"; }
      if (typing(e)) return;
      const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key === "Enter") { e.preventDefault(); void exportAs(e.shiftKey ? "copy" : "copyClose", "Full"); return; }
      if (ctrl && k === "s") { e.preventDefault(); void exportAs(e.shiftKey ? "save" : "saveQuick", "Full"); return; }
      if (ctrl && k === "z") { e.preventDefault(); void (e.shiftKey ? redo() : undo()); return; }
      if (ctrl && k === "y") { e.preventDefault(); void redo(); return; }
      if (ctrl && k === "d") { e.preventDefault(); void duplicate(); return; }
      if (ctrl && k === "c") { e.preventDefault(); void exportAs("copy", "Full"); return; }
      if (ctrl && k === "a") {
        e.preventDefault();
        const c = fc(), all = c.getObjects().filter((o) => o.selectable && meta(o));
        setTool("select");
        c.discardActiveObject();
        if (all.length) c.setActiveObject(all.length === 1 ? all[0] : new ActiveSelection(all, { canvas: c }));
        c.requestRenderAll();
        return;
      }
      if (ctrl) return;
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeSelected(); return; }
      if (e.key === "Enter" && cropping) { void applyCrop(); return; }
      if (e.key === "Escape") {
        if (stickers) { setStickers(false); return; }
        if (cropping) { cancelCrop(); return; }
        fc().discardActiveObject(); fc().requestRenderAll(); setTool("select"); return;
      }
      if (e.key.startsWith("Arrow")) {
        const c = fc(), sel = c.getActiveObjects();
        if (!sel.length) return;
        e.preventDefault();
        const n = (e.shiftKey ? 10 : 1) / c.getZoom(), dx = { ArrowLeft: -n, ArrowRight: n }[e.key] ?? 0, dy = { ArrowUp: -n, ArrowDown: n }[e.key] ?? 0;
        const target = c.getActiveObject()!;
        target.set({ left: target.left + dx, top: target.top + dy }); target.setCoords(); c.requestRenderAll(); commit();
        return;
      }
      if (k === "0") { fit(); return; }
      if (k === "1") { zoomTo(1); return; }
      if (k === "[" || k === "]") { layer(k === "]"); return; }
      const t = TOOLS.find((x) => x.key.toLowerCase() === k);
      if (t && active.current) setTool(t.id);
    };
    const up = (e: KeyboardEvent) => { if (e.key === " ") { space.current = false; if (fcRef.current) fcRef.current.defaultCursor = toolRef.current === "select" ? "default" : "crosshair"; } };
    const paste = async (e: ClipboardEvent) => {
      const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith("image/"));
      if (!f || (e.target as HTMLElement).tagName === "INPUT") return;
      e.preventDefault();
      const url = await new Promise<string>((ok) => { const r = new FileReader(); r.onload = () => ok(r.result as string); r.readAsDataURL(f); });
      const img = await new Promise<HTMLImageElement>((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = url; });
      if (active.current) await insertPicture(url, img.naturalWidth, img.naturalHeight);
      else await addDoc("Pasted", url, img.naturalWidth, img.naturalHeight);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("paste", paste);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("paste", paste); };
  });

  // Sticker picker closes on a click outside it.
  useEffect(() => {
    if (!stickers) return;
    const downOut = (e: PointerEvent) => { if (!(e.target as Element).closest?.(".stickers, [data-stickers]")) setStickers(false); };
    window.addEventListener("pointerdown", downOut, true);
    return () => window.removeEventListener("pointerdown", downOut, true);
  }, [stickers]);

  const t = TOOLS.find((x) => x.id === tool)!;
  const shapeTool = ["arrow", "line", "rect", "ellipse", "pen", "highlight"].includes(tool);
  const showFill = tool === "rect" || tool === "ellipse" || (tool === "select" && hasSel);
  const showText = tool === "text" || tool === "step" || (tool === "select" && hasSel);

  return (
    <div className={`shell bar-${barPos}`}>
      <header className="bar">
        <div className="seg">
          <Menu label="Copy" icon="copy" primary onMain={() => exportAs("copy", "Full")} title="Copy the picture with your drawing on it, ready to paste (Ctrl+C)" items={[
            ["Copy smaller (≤ 1920 px)", () => exportAs("copy", "Reduced")],
            ["Copy for chat (small JPEG)", () => exportAs("copy", "Chat")],
            ["Copy and close", () => exportAs("copyClose", "Full"), "Ctrl+Enter"],
            ["Copy text in the picture", copyText],
            ["Read QR code", readQr],
          ]} />
          <Menu label="Save" icon="save" onMain={() => exportAs("saveQuick", "Full")} title="Save it to your Grabbit folder as “… edited” (Ctrl+S). The arrow has Save as…" items={[
            ["Save as…", () => exportAs("save", "Full"), "Ctrl+Shift+S"],
            ["Save and copy the path", () => exportAs("copyPath", "Full")],
            ["Pin on top of everything", () => exportAs("pin", "Full")],
          ]} />
        </div>
        <div className="seg">
          <Menu label="Hide" icon="pixelate" title="Hide private things: find emails, phone numbers and keys automatically, or pixelate, blur or black out what you've selected" items={[
            ["Hide private details automatically", autoHide],
            ["Pixelate the selected areas", () => hideSelected("pixelate")],
            ["Blur the selected areas", () => hideSelected("blur")],
            ["Black out the selected areas", () => hideSelected("black")],
            ["Remove the spotlight", removeSpotlight],
          ]} />
          <button className={stickers ? "on" : ""} data-stickers onClick={() => setStickers(!stickers)} title="Emoji and icons"><Icon name="smile" />Stickers</button>
        </div>
        <div className="seg">
          <button onClick={talkToAi} title="Talk over this picture: mark things, say what you want, then paste it all into ChatGPT, Claude or Gemini"><Icon name="mic" />Talk</button>
          {(["beautify", "share", "ai", "info"] as PanelName[]).map((p) => (
            <button key={p} className={panel === p ? "on" : ""} onClick={() => setPanel(panel === p ? null : p)} title={{
              beautify: "Put the picture on a background with padding, rounded corners and a shadow, ready to share",
              share: "Upload the picture and copy a link to it, or send it to an app",
              ai: "Ask AI about the picture, or have AI change it",
              info: "The picture's size and details, and whether it carries your invisible Grabbit mark",
            }[p]}>
              <Icon name={({ beautify: "spot", share: "link", ai: "sparkles", info: "info" } as const)[p]} />{{ beautify: "Beautify", share: "Share", ai: "AI", info: "Info" }[p]}
              {p === "beautify" && beauty.on && <span className="dot" />}
            </button>
          ))}
        </div>
        <div className="name">{busy ? <span className="busy">{busy}</span> : name}</div>
        <Menu label="" icon="layout" title="Move the toolbar" items={[
          ...(["top", "bottom", "left", "right"] as BarPos[]).map((p): [string, () => void] => [`Toolbar on the ${p}${p === barPos ? "  ✓" : ""}`, () => setBarPos(p)]),
          ...(["left", "right", "top", "bottom"] as Dock[]).map((d): [string, () => void] => [`Captures on the ${d}${d === dock ? "  ✓" : ""}`, () => setDock(d)]),
          [`Tabs down the side${tabsAt === "side" ? "  ✓" : ""}`, () => setTabsAt("side")],
          [`Tabs across the top${tabsAt === "top" ? "  ✓" : ""}`, () => setTabsAt("top")],
          ...(["system", "light", "dark"] as Theme[]).map((t): [string, () => void] => [`${{ system: "Look: same as the system", light: "Look: light", dark: "Look: dark" }[t]}${look === t ? "  ✓" : ""}`, () => { setTheme(t); setLook(t); }]),
          ["Use the classic editor", toClassic],
        ]} />
        {tabs.length > 0 && <button className="icon-only" onClick={() => active.current && closeTab(active.current.id)} title="Close this tab (unsaved edits are kept)"><Icon name="close" /></button>}
      </header>
      <div className={`body lib-at-${dock}`}>
        <Library items={recent} dock={dock} setDock={setDock} hasPicture={!!activeId} onInsert={(r) => void insertRecent(r)} onOpen={(r) => void openItem(r)} />
        <div className="work">
        {tabsAt === "side" && tabs.length > 0 && (
          <nav className={`vtabs${tabsSlim ? " slim" : ""}`} role="tablist" aria-orientation="vertical">
            <div className="vtabs-head">
              {!tabsSlim && <b>Open pictures</b>}
              <button className="icon-only" onClick={() => setTabsSlim(!tabsSlim)} title={tabsSlim ? "Widen the tabs to show their names" : "Narrow the tabs to just pictures"} aria-label="Tab width"><Icon name={tabsSlim ? "panelOpen" : "panelClose"} /></button>
            </div>
            {tabs.map((d) => (
              <div key={d.id} role="tab" aria-selected={d.id === activeId} className={`vtab${d.id === activeId ? " on" : ""}`}
                onClick={() => { const x = docs.current.find((y) => y.id === d.id); if (x && x !== active.current) void show(x); }}
                title={`${d.name}${d.dirty ? " · unsaved changes" : ""}`}>
                {d.thumb ? <img src={d.thumb} alt="" draggable={false} /> : <span className="vtab-ph" />}
                {!tabsSlim && <span className="label">{d.name}</span>}
                {d.dirty && <span className="dot" aria-label="unsaved changes" />}
                <button className="x" onClick={(e) => { e.stopPropagation(); void closeTab(d.id); }} title="Close this tab (unsaved edits are kept as “… edited.png”)" aria-label="Close tab">×</button>
              </div>
            ))}
          </nav>
        )}
        <main className="canvas mk">
          {tabsAt === "top" && tabs.length > 0 && (
            <nav className="doctabs" role="tablist">
              {tabs.map((d) => (
                <div key={d.id} role="tab" aria-selected={d.id === activeId} className={`doctab${d.id === activeId ? " on" : ""}`} onClick={() => { const x = docs.current.find((y) => y.id === d.id); if (x && x !== active.current) void show(x); }} title={d.name}>
                  {d.dirty && <span className="dot" aria-label="unsaved changes" />}
                  <span className="label">{d.name}</span>
                  <button className="x" onClick={(e) => { e.stopPropagation(); void closeTab(d.id); }} title="Close tab (unsaved edits are kept as “… edited.png”)">×</button>
                </div>
              ))}
            </nav>
          )}
          <div className="mk-tools" role="toolbar" aria-label="Markup tools">
            <div className="mk-group">
              {TOOLS.map((x) => (
                <button key={x.id} className={tool === x.id ? "on" : ""} onClick={() => setTool(x.id)} title={`${x.label} (${x.key})`} aria-label={x.label} disabled={!activeId}><Icon name={x.icon} /></button>
              ))}
            </div>
            {cropping ? (
              <div className="mk-group">
                <button className="primary" onClick={applyCrop}><Icon name="crop" />Crop (Enter)</button>
                <button onClick={cancelCrop}>Cancel (Esc)</button>
              </div>
            ) : (
              <>
                <div className="mk-group mk-colors">
                  {COLORS.map((c) => <button key={c} className={`sw${style.color === c ? " on" : ""}`} style={{ background: c }} onClick={() => setStyle({ color: c })} title={c} aria-label={`Colour ${c}`} />)}
                  <label className="sw custom" title="Any colour" style={{ background: COLORS.includes(style.color) ? undefined : style.color }}><input type="color" value={style.color} onChange={(e) => setStyle({ color: e.target.value })} /></label>
                </div>
                {(shapeTool || (tool === "select" && hasSel)) && (
                  <div className="mk-group">
                    {WIDTHS.map((_, i) => <button key={i} className={style.width === i ? "on" : ""} onClick={() => setStyle({ width: i })} title={["Thin", "Medium", "Thick", "Extra thick"][i]}><span className="wdot" style={{ width: 4 + i * 4, height: 4 + i * 4 }} /></button>)}
                  </div>
                )}
                {showFill && (
                  <div className="mk-group">
                    {(["none", "soft", "solid"] as const).map((f) => <button key={f} className={style.fill === f ? "on" : ""} onClick={() => setStyle({ fill: f })} title={{ none: "No fill", soft: "See-through fill", solid: "Solid fill" }[f]}><span className={`fill ${f}`} /></button>)}
                  </div>
                )}
                {showText && (
                  <div className="mk-group">
                    <select className="mk-font" value={style.family} onFocus={loadFonts} onPointerDown={loadFonts} onChange={(e) => setStyle({ family: e.target.value })} title="Font for text and numbered steps (any font installed on this computer)" style={{ fontFamily: fontOf(style) }}>
                      <option value="">System font</option>
                      {(fonts.length ? fonts : style.family ? [style.family] : []).map((f) => <option key={f} value={f} style={{ fontFamily: `"${f}"` }}>{f}</option>)}
                    </select>
                    {FONTS.map((_, i) => <button key={i} className={style.font === i ? "on" : ""} onClick={() => setStyle({ font: i })} title={`Text size: ${["small", "medium", "large", "extra large"][i]}`}>{["S", "M", "L", "XL"][i]}</button>)}
                    <button className={style.textBg ? "on" : ""} onClick={() => setStyle({ textBg: !style.textBg })} title="Text on a coloured background">Aa</button>
                  </div>
                )}
                <div className="mk-group">
                  <button className={style.shadow ? "on" : ""} onClick={() => setStyle({ shadow: !style.shadow })} title="Shadow (stands out on busy pictures)"><Icon name="shadow" /></button>
                </div>
              </>
            )}
            <div className="mk-group mk-end">
              <button onClick={undo} title="Undo (Ctrl+Z)" aria-label="Undo"><Icon name="undo" /></button>
              <button onClick={redo} title="Redo (Ctrl+Y)" aria-label="Redo"><Icon name="redo" /></button>
              {hasSel && <>
                <button onClick={duplicate} title="Duplicate (Ctrl+D)" aria-label="Duplicate"><Icon name="duplicate" /></button>
                <button onClick={() => layer(true)} title="Bring to front (])" aria-label="Bring to front"><Icon name="front" /></button>
                <button onClick={() => layer(false)} title="Send to back ([)" aria-label="Send to back"><Icon name="back" /></button>
                <button onClick={removeSelected} title="Delete (Del)" aria-label="Delete"><Icon name="trash" /></button>
              </>}
              <button onClick={fit} title="Fit to window (0)" aria-label="Fit to window"><Icon name="fit" /></button>
              <button className="zoom" onClick={() => zoomTo(1)} title="Actual size (1) · Ctrl+wheel to zoom, Space+drag to pan">{zoomPct}%</button>
            </div>
          </div>
          <div className="mk-stage" ref={host}>
            <canvas ref={el} />
            {tabs.length === 0 && <div className="blank">No picture open<span>Pick a capture on the left: Insert or New tab. Or paste one (Ctrl+V).</span></div>}
            {activeId && tool !== "select" && <div className="mk-hint">{t.label}{tool === "crop" ? ": drag the part to keep" : BOXY.includes(tool) ? ": drag over the picture" : tool === "step" ? ": click to place the next number" : tool === "eyedropper" ? ": click the picture" : ""} · Esc to stop</div>}
          </div>
          {panel && <Panel which={panel} ops={ops} beauty={beauty} setBeauty={setBeauty} onClose={() => setPanel(null)} />}
          {stickers && (
            <div className="stickers">
              <header><b>Stickers</b><button className="x" onClick={() => setStickers(false)} title="Close (Esc)">×</button></header>
              <div className="grid emoji">{EMOJI.map((e) => <button key={e} onClick={() => { addEmoji(e); setStickers(false); }} disabled={!activeId}>{e}</button>)}</div>
              <div className="grid icons">
                {ICONS.map((i) => <button key={i.name} title={i.name} disabled={!activeId} onClick={() => { void addIcon(i.svg); setStickers(false); }} dangerouslySetInnerHTML={{ __html: i.svg }} />)}
              </div>
              <div className="hint">Icons take the current colour.</div>
            </div>
          )}
        </main>
        </div>
      </div>
    </div>
  );
}
