import { useCallback, useEffect, useRef, useState } from "react";
import "@excalidraw/excalidraw/index.css";
import {
  CaptureUpdateAction, Excalidraw, FONT_FAMILY, convertToExcalidrawElements, exportToBlob,
  getCommonBounds, getSceneVersion, newElementWith, restoreElements, serializeAsJSON,
} from "@excalidraw/excalidraw";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI, BinaryFileData, DataURL, NormalizedZoomValue } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, FileId } from "@excalidraw/excalidraw/element/types";
import { getImage, onHost, post, type ExportAction, type RecentItem, type Size } from "./host";
import { EMOJI, ICONS, iconDataURL } from "./stickers";
import { Icon } from "./icons";
import { redact, spotlight, type Box } from "./redact";
import { invoke } from "@tauri-apps/api/core";
import { send } from "./bridge";
import { beautify, DEFAULT_BEAUTY, type Beauty } from "./beautify";
import { findPrivate, type Word } from "./private";
import { Panel, type EditorOps, type PanelName } from "./Panel";
import { Menu } from "./Menu";
import { switchEditor } from "./carry";
import { isDark, onThemeChange } from "./ui/theme";

const BASE_ID = "grabbit-base";

/** Distance from (px,py) to the segment (ax,ay)–(bx,by). */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function blobToDataURL(blob: Blob) {
  return new Promise<string>((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.readAsDataURL(blob);
  });
}

function fileId() {
  return `grabbit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` as FileId;
}

export function App() {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [name, setName] = useState("Grabbit");
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [tab, setTab] = useState<"capture" | "copied">("capture");
  const [stickers, setStickers] = useState(false);
  const [busy, setBusy] = useState("");
  const [panel, setPanel] = useState<PanelName | null>(null);
  const [beauty, setBeautyState] = useState<Beauty>(() => { try { return { ...DEFAULT_BEAUTY, ...JSON.parse(localStorage.getItem("beauty") ?? "{}"), on: false }; } catch { return DEFAULT_BEAUTY; } });
  const setBeauty = (b: Beauty) => { setBeautyState(b); try { localStorage.setItem("beauty", JSON.stringify(b)); } catch { /* private mode */ } };
  // Which side of the window the toolbar sits on (remembered per computer).
  type BarPos = "top" | "bottom" | "left" | "right";
  const [barPos, setBarPosState] = useState<BarPos>(() => { try { return (localStorage.getItem("barPos") as BarPos) || "top"; } catch { return "top"; } });
  const setBarPos = (p: BarPos) => { setBarPosState(p); try { localStorage.setItem("barPos", p); } catch { /* private mode */ } };
  const [tabs, setTabs] = useState<{ id: string; name: string; dirty: boolean }[]>([]);
  const [activeId, setActiveId] = useState("");
  const [dark, setDark] = useState(isDark);
  useEffect(() => onThemeChange(() => setDark(isDark())), []);
  // Hover a thumbnail for a moment → large preview with details beside the strip.
  const [preview, setPreview] = useState<{ item: RecentItem; top: number } | null>(null);
  const [previewSize, setPreviewSize] = useState("");
  const hoverTimer = useRef<number>(0);
  const hoverStart = (item: RecentItem, el: HTMLElement) => {
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => { setPreviewSize(""); setPreview({ item, top: el.getBoundingClientRect().top }); }, 450);
  };
  const hoverEnd = () => { window.clearTimeout(hoverTimer.current); setPreview(null); };

  // Each tab is its own drawing. Only the active one lives in Excalidraw; the others are parked here.
  type Doc = {
    id: string; name: string; elements: readonly ExcalidrawElement[]; files: BinaryFiles;
    view?: { scrollX: number; scrollY: number; zoom: AppState["zoom"] }; loadedVersion: number; dirty: boolean;
  };
  const docs = useRef<Doc[]>([]);
  const active = useRef<Doc | null>(null);

  const syncTabs = useCallback(() => {
    setTabs(docs.current.map((d) => ({ id: d.id, name: d.name, dirty: d.dirty })));
    post({ type: "dirty", value: docs.current.some((d) => d.dirty) });
  }, []);

  /** Park the active tab's drawing (elements, images, scroll/zoom) before showing another. */
  const park = useCallback(() => {
    const d = active.current;
    if (!d || !api) return;
    const s = api.getAppState();
    d.elements = api.getSceneElementsIncludingDeleted();
    d.files = api.getFiles();
    d.view = { scrollX: s.scrollX, scrollY: s.scrollY, zoom: s.zoom };
  }, [api]);

  const show = useCallback((d: Doc) => {
    if (!api) return;
    if (active.current && active.current !== d) park();
    active.current = d;
    api.addFiles(Object.values(d.files));
    api.updateScene({
      elements: d.elements,
      appState: (d.view ? { selectedElementIds: {}, ...d.view } : { selectedElementIds: {} }) as Partial<AppState> as never,
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    api.history.clear();   // undo history is per visit; switching tabs starts it fresh
    if (!d.view) requestAnimationFrame(() => {
      // Fit into the area right of Excalidraw's style panel (12.5rem, shown whenever a tool is picked) and below its
      // toolbar, and left of our own side panel if one is open, so picking a tool never covers the picture. Narrow
      // windows put Excalidraw's panel at the bottom instead.
      const s = api.getAppState();
      const els = api.getSceneElements();
      if (!els.length) return;
      const [x1, y1, x2, y2] = getCommonBounds(els);
      const left = s.width >= 730 ? 232 : 24, top = 76, pad = 24;
      const side = document.querySelector(".panel")?.getBoundingClientRect().left;
      const w = (side ? side - s.offsetLeft : s.width) - left - pad, h = s.height - top - pad;
      const zoom = Math.min(Math.max(Math.min(w / (x2 - x1), h / (y2 - y1)), 0.1), 30);
      api.updateScene({
        appState: {
          zoom: { value: zoom as NormalizedZoomValue },
          scrollX: (left + (w - (x2 - x1) * zoom) / 2) / zoom - x1,
          scrollY: (top + (h - (y2 - y1) * zoom) / 2) / zoom - y1,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    });
    setActiveId(d.id);
    setName(d.name);
    document.title = `Grabbit — ${d.name}`;
  }, [api, park]);

  /** A new tab from a picture (locked as the base layer) or a saved .excalidraw drawing. */
  const addDoc = useCallback((tabName: string, src: { dataURL?: string; width?: number; height?: number; scene?: string }) => {
    const id = `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    let elements: readonly ExcalidrawElement[] = [];
    let files: BinaryFiles = {};
    if (src.scene) {
      const data = JSON.parse(src.scene);
      files = data.files ?? {};
      elements = restoreElements(data.elements, null);
    } else if (src.dataURL && src.width && src.height) {
      const fid = `base-${id}` as FileId;
      const mimeType = src.dataURL.slice(5, src.dataURL.indexOf(";")) as BinaryFileData["mimeType"];
      files = { [fid]: { id: fid, dataURL: src.dataURL as DataURL, mimeType, created: Date.now() } };
      elements = convertToExcalidrawElements([
        { type: "image", id: BASE_ID, fileId: fid, x: 0, y: 0, width: src.width, height: src.height, locked: true },
      ], { regenerateIds: false });
    }
    const d: Doc = { id, name: tabName, elements, files, loadedVersion: getSceneVersion(elements), dirty: false };
    docs.current.push(d);
    show(d);
    syncTabs();
    return d;
  }, [show, syncTabs]);

  // ---------- scene helpers ----------

  const base = useCallback((): (ExcalidrawElement & { type: "image" }) | undefined => {
    return api?.getSceneElements().find((e) => e.id === BASE_ID && e.type === "image") as never;
  }, [api]);

  const viewportCenter = useCallback(() => {
    const s = api!.getAppState();
    return { x: -s.scrollX + s.width / 2 / s.zoom.value, y: -s.scrollY + s.height / 2 / s.zoom.value };
  }, [api]);

  const addElements = useCallback((skeletons: Parameters<typeof convertToExcalidrawElements>[0], select = true) => {
    const els = convertToExcalidrawElements(skeletons, { regenerateIds: false });
    api!.updateScene({
      elements: [...api!.getSceneElementsIncludingDeleted(), ...els],
      appState: select ? { selectedElementIds: Object.fromEntries(els.map((e) => [e.id, true])) } : undefined,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    return els;
  }, [api]);

  const addImage = useCallback((dataURL: string, w: number, h: number, at?: { x: number; y: number }, extra: object = {}) => {
    const id = fileId();
    const mimeType = dataURL.slice(5, dataURL.indexOf(";")) as BinaryFileData["mimeType"];
    api!.addFiles([{ id, dataURL: dataURL as DataURL, mimeType, created: Date.now() }]);
    const c = at ?? viewportCenter();
    return addElements([{ type: "image", fileId: id, x: c.x - w / 2, y: c.y - h / 2, width: w, height: h, ...extra }]);
  }, [api, addElements, viewportCenter]);

  // ---------- host messages ----------

  useEffect(() => {
    if (!api) return;
    const off = onHost(async (m) => {
      if (m.type === "recent") setRecent(m.recent);
      if (m.type === "load" || m.type === "addTab") {
        if (m.type === "load") { setRecent(m.recent); if (m.type === "load" && m.panel) setPanel(m.panel as PanelName); }
        addDoc(m.name, m);
      }
      if (m.type === "requestClose") {
        // Keep every tab's unsaved edits (host writes "<name> edited.png"), then close.
        for (const d of [...docs.current]) if (d.dirty) { show(d); await exportAs("closeSave", "Full"); }
        post({ type: "close" });
      }
    });
    post({ type: "ready" });
    const unsub = api.onChange((elements) => {
      const d = active.current;
      if (!d) return;
      const dirty = getSceneVersion(elements) !== d.loadedVersion;
      if (dirty !== d.dirty) { d.dirty = dirty; syncTabs(); }
    });
    return () => { off(); unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  function switchTo(id: string) {
    const d = docs.current.find((x) => x.id === id);
    if (d && d !== active.current) show(d);
  }

  async function closeTab(id: string) {
    const d = docs.current.find((x) => x.id === id);
    if (!d) return;
    if (d.dirty) { show(d); await exportAs("closeSave", "Full"); }   // never lose edits: saved, then closed
    const i = docs.current.indexOf(d);
    docs.current.splice(i, 1);
    if (docs.current.length === 0) {   // last tab: an empty editor, ready for the next Insert / New tab
      active.current = null;
      api!.updateScene({ elements: [], appState: { selectedElementIds: {} }, captureUpdate: CaptureUpdateAction.NEVER });
      api!.history.clear();
      setActiveId(""); setName("Grabbit"); document.title = "Grabbit";
      syncTabs();
      return;
    }
    if (active.current === d) { active.current = null; show(docs.current[Math.min(i, docs.current.length - 1)]); }
    syncTabs();
  }

  async function openAsTab(item: RecentItem) {
    const img = await getImage(item.path);
    addDoc(item.name.replace(/\.(webp|png|jpe?g)$/i, ""), img);
  }

  // ---------- output ----------

  const render = useCallback(async () => {
    const elements = api!.getSceneElements();
    const blob = await exportToBlob({
      elements,
      appState: { ...api!.getAppState(), exportBackground: true, viewBackgroundColor: "#ffffff", exportWithDarkMode: false, exportScale: 1 },
      files: api!.getFiles(),
      exportPadding: 0,
      mimeType: "image/png",
    });
    const png = await blobToDataURL(blob);
    return beautyRef.current.on ? beautify(png, beautyRef.current) : png;
  }, [api]);
  const beautyRef = useRef(beauty);
  beautyRef.current = beauty;
  (window as unknown as { grabbitRender: typeof render }).grabbitRender = render;   // test hook (CDP checks)

  async function exportAs(action: ExportAction, size: Size) {
    const d = active.current;
    if (!d) return;
    setBusy(action === "save" || action === "saveQuick" ? "Saving…" : "Copying…");
    try {
      post({ type: "export", action, size, name: d.name, dataURL: await render() });
      if (action !== "copyClose") {   // the drawing as it is now counts as kept
        d.loadedVersion = getSceneVersion(api!.getSceneElementsIncludingDeleted());
        d.dirty = false;
        syncTabs();
      }
    } finally { setBusy(""); }
  }

  /** Switch to the new editor; open tabs come along as pictures (drawings flattened in, no Beautify). */
  async function toMarkup() {
    const list: { name: string; dataURL: string }[] = [];
    const look = beautyRef.current;
    beautyRef.current = { ...look, on: false };
    for (const d of [...docs.current]) {
      show(d);
      await new Promise((r) => requestAnimationFrame(r));
      list.push({ name: d.name, dataURL: await render() });
    }
    beautyRef.current = look;
    await switchEditor("markup", list);
  }

  function saveProject() {
    post({ type: "saveProject", json: serializeAsJSON(api!.getSceneElements(), api!.getAppState(), api!.getFiles(), "local") });
  }

  // ---------- Grabbit tools ----------

  const selectedBoxes = useCallback(() => {
    const s = api!.getAppState();
    return api!.getSceneElements().filter((e) => s.selectedElementIds[e.id] && e.id !== BASE_ID);
  }, [api]);

  async function applyRedact(mode: "pixelate" | "blur" | "black") {
    const b = base();
    // Boxes, or patches an earlier Pixelate/Blur left (so a hidden area can be switched to another mode).
    const targets = selectedBoxes().filter((e) => e.type === "rectangle" || e.type === "ellipse" || e.type === "diamond" || (e.type === "image" && (e.customData?.redact || e.customData?.grabbitHidden)));
    if (!b || targets.length === 0) { api!.setToast({ message: "Draw a box over what to hide, select it, then pick Pixelate, Blur or Black out.", duration: 4000 }); return; }
    if (mode === "black") {
      const ids = new Set(targets.map((t) => t.id));
      const patches = targets.filter((t) => t.type === "image");
      const black = { backgroundColor: "#000000", strokeColor: "#000000", fillStyle: "solid" } as const;
      api!.updateScene({
        elements: [
          ...api!.getSceneElementsIncludingDeleted().map((e) => !ids.has(e.id) ? e : e.type === "image" ? newElementWith(e, { isDeleted: true }) : newElementWith(e, black)),
          ...convertToExcalidrawElements(patches.map((p) => ({ type: "rectangle" as const, x: p.x, y: p.y, width: p.width, height: p.height, roughness: 0, ...black }))),
        ],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      return;
    }
    const baseFile = api!.getFiles()[b.fileId!];
    const replacements: ExcalidrawElement[] = [];
    for (const t of targets) {
      const r = await redact(baseFile.dataURL, b as Box, t as Box, mode);
      if (!r) continue;
      const id = fileId();
      api!.addFiles([{ id, dataURL: r.dataURL as DataURL, mimeType: "image/png", created: Date.now() }]);
      replacements.push(...convertToExcalidrawElements([{ type: "image", fileId: id, ...r.box, customData: { redact: true } }], { regenerateIds: false }));
    }
    const gone = new Set(targets.map((t) => t.id));
    api!.updateScene({
      elements: [...api!.getSceneElementsIncludingDeleted().map((e) => gone.has(e.id) ? newElementWith(e, { isDeleted: true }) : e), ...replacements],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }

  function applySpotlight() {
    const b = base();
    const t = selectedBoxes().find((e) => e.type === "rectangle" || e.type === "ellipse");
    if (!b || !t) { api!.setToast({ message: "Draw a box round what to spotlight, select it, then pick Spotlight.", duration: 4000 }); return; }
    const id = fileId();
    api!.addFiles([{ id, dataURL: spotlight(b as Box, t as Box) as DataURL, mimeType: "image/png", created: Date.now() }]);
    const [dim] = convertToExcalidrawElements([{ type: "image", fileId: id, x: b.x, y: b.y, width: b.width, height: b.height, locked: true }]);
    // Right above the picture, so drawings already made stay bright on top of the dimming.
    const rest = api!.getSceneElementsIncludingDeleted().map((e) => e.id === t.id ? newElementWith(e, { isDeleted: true }) : e);
    const at = rest.findIndex((e) => e.id === BASE_ID) + 1;
    api!.updateScene({ elements: [...rest.slice(0, at), dim, ...rest.slice(at)], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }

  const baseDataURL = () => { const b = base(); return b ? api!.getFiles()[b.fileId!]?.dataURL ?? null : null; };

  /** Selected box in picture pixels. */
  const selectedRegion = () => {
    const b = base();
    const t = selectedBoxes().find((e) => e.type === "rectangle" || e.type === "ellipse" || e.type === "diamond");
    if (!b || !t) return null;
    const x = Math.max(0, Math.round(t.x - b.x)), y = Math.max(0, Math.round(t.y - b.y));
    const w = Math.min(Math.round(b.width) - x, Math.round(t.width)), h = Math.min(Math.round(b.height) - y, Math.round(t.height));
    return w > 2 && h > 2 ? { x, y, width: w, height: h } : null;
  };

  /** Swap the picture underneath (AI edits), keeping drawings and undo. With `dropBox`, the box that marked the area
   *  goes too (same undo step), so it doesn't sit over the result. */
  function replaceBase(dataURL: string, dropBox = false) {
    const b = base();
    if (!b) return;
    const id = fileId();
    const box = dropBox ? selectedBoxes().find((e) => e.type === "rectangle" || e.type === "ellipse" || e.type === "diamond")?.id : undefined;
    api!.addFiles([{ id, dataURL: dataURL as DataURL, mimeType: "image/png", created: Date.now() }]);
    api!.updateScene({
      elements: api!.getSceneElementsIncludingDeleted().map((e) => e.id === BASE_ID ? newElementWith(e as ExcalidrawElement & { type: "image" }, { fileId: id })
        : e.id === box ? newElementWith(e, { isDeleted: true }) : e),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }

  /** Read the picture's text, then pixelate every email, IP, key, phone or card number found. */
  async function autoHide() {
    const b = base();
    const src = baseDataURL();
    if (!b || !src) return;
    setBusy("Looking for private details…");
    try {
      const words = await send<Word[]>({ type: "ocr", dataURL: src });
      const hits = findPrivate(words ?? []);
      if (!hits.length) { api!.setToast({ message: "Nothing private found. Draw a box and use Pixelate for anything else.", duration: 3500 }); return; }
      const replacements: ExcalidrawElement[] = [];
      for (const h of hits) {
        const r = await redact(src, b as Box, { x: b.x + h.x, y: b.y + h.y, width: h.width, height: h.height } as Box, "pixelate");
        if (!r) continue;
        const id = fileId();
        api!.addFiles([{ id, dataURL: r.dataURL as DataURL, mimeType: "image/png", created: Date.now() }]);
        replacements.push(...convertToExcalidrawElements([{ type: "image", fileId: id, ...r.box, customData: { grabbitHidden: h.kind } }], { regenerateIds: false }));
      }
      api!.updateScene({ elements: [...api!.getSceneElementsIncludingDeleted(), ...replacements], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      const kinds = [...new Set(hits.map((h) => h.kind))].join(", ");
      api!.setToast({ message: `Hid ${hits.length} private detail${hits.length > 1 ? "s" : ""} (${kinds}). Ctrl+Z to undo.`, duration: 4000 });
    } finally { setBusy(""); }
  }

  async function copyText() {
    setBusy("Reading text…");
    try {
      const words = await send<Word[]>({ type: "ocr", dataURL: await render() });
      const lines: string[] = [];
      let cur = -1;
      for (const w of words ?? []) { if (w.line !== cur) { lines.push(w.text); cur = w.line; } else lines[lines.length - 1] += " " + w.text; }
      if (!lines.length) { api!.setToast({ message: "No text found", duration: 2500 }); return; }
      await invoke("copy_text", { text: lines.join("\n") });
      api!.setToast({ message: `Copied ${lines.length} line${lines.length > 1 ? "s" : ""} of text`, duration: 2500 });
    } finally { setBusy(""); }
  }

  /** Voice note + marks over the edited picture, then one paste into ChatGPT / Claude. */
  async function talkToAi() {
    setBusy("Opening Talk to AI…");
    try {
      const path = await send<string>({ type: "exportFile", name: name, dataURL: await render() });
      await invoke("voice_open", { path, title: name });
    } catch (e) { api!.setToast({ message: String(e), duration: 4000 }); }
    finally { setBusy(""); }
  }

  async function readQr() {
    const codes = await send<string[]>({ type: "qr", dataURL: await render() });
    if (!codes?.length) { api!.setToast({ message: "No QR code found", duration: 2500 }); return; }
    await invoke("copy_text", { text: codes.join("\n") });
    api!.setToast({ message: `Copied: ${codes[0].slice(0, 80)}`, duration: 3500 });
  }

  const ops: EditorOps = {
    render, baseDataURL, selectedRegion, replaceBase, name,
    toast: (t) => api?.setToast({ message: t, duration: 4000 }),
    setBusy,
    size: (() => { const b = api ? base() : undefined; return b ? { width: Math.round(b.width), height: Math.round(b.height) } : null; })(),
  };

  function addStep() {
    const n = Math.max(0, ...api!.getSceneElements().map((e) => Number(e.customData?.grabbitStep) || 0)) + 1;
    const color = api!.getAppState().currentItemStrokeColor;
    const { x, y, size } = stickerSpot(44);
    const els = convertToExcalidrawElements([{
      type: "ellipse", x, y, width: size, height: size, backgroundColor: color, strokeColor: "#ffffff", strokeWidth: 2,
      fillStyle: "solid", roughness: 0, customData: { grabbitStep: n },
      label: { text: String(n), fontSize: size / 2, strokeColor: "#ffffff", fontFamily: FONT_FAMILY.Nunito },
    }]);
    api!.updateScene({
      elements: [...api!.getSceneElementsIncludingDeleted(), ...els],
      appState: { selectedElementIds: { [els[0].id]: true } },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }

  /** Top-left for a new sticker `screen` px big at the current zoom: the viewport centre, stepped right past anything
   *  already drawn there, so a new sticker never lands on the last one and swallows its clicks. (An emoji's text box
   *  is about 1.4 × its font size wide.) */
  function stickerSpot(screen: number) {
    const size = screen / api!.getAppState().zoom.value, w = size * 1.4, c = viewportCenter();
    let x = c.x - size / 2;
    const y = c.y - size / 2;
    const els = api!.getSceneElements().filter((e) => e.id !== BASE_ID);
    while (els.some((e) => e.x < x + w && x < e.x + e.width && e.y < y + size && y < e.y + e.height)) x += size * 1.5;
    return { x, y, size };
  }

  // Arrows, lines and pen strokes are a pixel or two wide on a zoomed-out capture and Excalidraw only catches clicks a
  // few px from them. A click 4–12 px off one selects it (closer than that Excalidraw takes it, and can drag at once).
  useEffect(() => {
    if (!api) return;
    const host = document.querySelector<HTMLElement>(".excal-host");
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.altKey || (e.target as Element).tagName !== "CANVAS") return;
      const s = api.getAppState();
      if (s.activeTool.type !== "selection") return;
      const z = s.zoom.value, px = (e.clientX - s.offsetLeft) / z - s.scrollX, py = (e.clientY - s.offsetTop) / z - s.scrollY;
      let best: { id: string; d: number } | null = null;
      for (const el of api.getSceneElements()) {
        if (el.locked || !("points" in el) || s.selectedElementIds[el.id]) continue;
        const pts = el.points, xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
        // Undo the element's rotation about its centre, then measure in its own coordinates.
        const cx = el.x + (Math.min(...xs) + Math.max(...xs)) / 2, cy = el.y + (Math.min(...ys) + Math.max(...ys)) / 2;
        const c = Math.cos(-el.angle), sn = Math.sin(-el.angle);
        const qx = cx + (px - cx) * c - (py - cy) * sn - el.x, qy = cy + (px - cx) * sn + (py - cy) * c - el.y;
        for (let i = 1; i < pts.length; i++) {
          const d = segDist(qx, qy, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
          if (!best || d < best.d) best = { id: el.id, d };
        }
      }
      if (best && best.d * z > 4 && best.d * z <= 12) {
        e.stopPropagation();
        api.updateScene({ appState: { selectedElementIds: { [best.id]: true } } });
      }
    };
    host?.addEventListener("pointerdown", down, true);
    return () => host?.removeEventListener("pointerdown", down, true);
  }, [api]);

  // The sticker picker closes on Esc or a click anywhere outside it (its own header button toggles it).
  useEffect(() => {
    if (!stickers) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setStickers(false); } };
    const down = (e: PointerEvent) => { if (!(e.target as Element).closest?.(".stickers, [data-stickers]")) setStickers(false); };
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", down, true);
    return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("pointerdown", down, true); };
  }, [stickers]);

  function addEmoji(e: string) {
    const { x, y, size } = stickerSpot(72);
    addElements([{ type: "text", text: e, x, y, fontSize: size }]);
  }

  function addIcon(svg: string) {
    const { x, y, size } = stickerSpot(96);
    addImage(iconDataURL(svg, api!.getAppState().currentItemStrokeColor), size, size, { x: x + size / 2, y: y + size / 2 });
  }

  async function insertRecent(item: RecentItem) {
    if (!active.current) return openAsTab(item);   // nothing open to insert into
    const img = await getImage(item.path);
    const b = base();
    const maxW = (b?.width ?? 1600) * 0.6;
    const scale = Math.min(1, maxW / img.width);
    addImage(img.dataURL, img.width * scale, img.height * scale);
  }

  // Keyboard: Ctrl+Enter copy & close, Ctrl+Shift+Enter copy, Ctrl+S save as. Excalidraw keeps Ctrl+C for shapes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!api) return;
      if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); exportAs(e.shiftKey ? "copy" : "copyClose", "Full"); }
      else if (e.ctrlKey && (e.key === "s" || e.key === "S")) { e.preventDefault(); e.stopPropagation(); exportAs(e.shiftKey ? "save" : "saveQuick", "Full"); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const shown = recent.filter((r) => tab === "copied" ? r.kind === "copied" : r.kind === "capture" || r.kind === "edited");

  return (
    <div className={`shell bar-${barPos}`}>
      <header className="bar">
        <div className="seg">
          <Menu label="Copy" icon="copy" primary onMain={() => exportAs("copy", "Full")} items={[
            ["Copy smaller (≤ 1920 px)", () => exportAs("copy", "Reduced")],
            ["Copy for chat (small JPEG)", () => exportAs("copy", "Chat")],
            ["Copy and close", () => exportAs("copyClose", "Full"), "Ctrl+Enter"],
            ["Copy text in the picture", copyText],
            ["Read QR code", readQr],
            ["Talk about it, copy for AI…", talkToAi],
          ]} />
          <Menu label="Save" icon="save" onMain={() => exportAs("saveQuick", "Full")} items={[
            ["Save as…", () => exportAs("save", "Full"), "Ctrl+Shift+S"],
            ["Save and copy the path", () => exportAs("copyPath", "Full")],
            ["Save editable (.excalidraw)", saveProject],
            ["Pin on top of everything", () => exportAs("pin", "Full")],
          ]} />
        </div>
        <div className="seg">
          <button onClick={addStep} title="Numbered step badge (next number)"><Icon name="step" />Step</button>
          <Menu label="Hide" icon="pixelate" items={[
            ["Hide private details automatically", autoHide],
            ["Pixelate the selected box", () => applyRedact("pixelate")],
            ["Blur the selected box", () => applyRedact("blur")],
            ["Black out the selected box", () => applyRedact("black")],
            ["Spotlight the selected box", applySpotlight],
          ]} />
          <button className={stickers ? "on" : ""} data-stickers onClick={() => setStickers(!stickers)} title="Emoji and icons"><Icon name="smile" />Stickers</button>
        </div>
        <div className="seg">
          <button onClick={talkToAi} title="Talk over this picture: mark things, say what you want, then paste it all into ChatGPT, Claude or Gemini"><Icon name="mic" />Talk</button>
          {(["beautify", "share", "ai", "info"] as PanelName[]).map((p) => (
            <button key={p} className={panel === p ? "on" : ""} onClick={() => setPanel(panel === p ? null : p)}>
              <Icon name={({ beautify: "spot", share: "link", ai: "sparkles", info: "info" } as const)[p]} />{{ beautify: "Beautify", share: "Share", ai: "AI", info: "Info" }[p]}
              {p === "beautify" && beauty.on && <span className="dot" />}
            </button>
          ))}
        </div>
        <div className="name">{busy ? <span className="busy">{busy}</span> : name}</div>
        <Menu label="" icon="layout" title="Move the toolbar" items={[
          ...(["top", "bottom", "left", "right"] as BarPos[]).map((p): [string, () => void] => [`Toolbar on the ${p}${p === barPos ? "  ✓" : ""}`, () => setBarPos(p)]),
          ["Switch to the new editor", toMarkup],
        ]} />
        {tabs.length > 0 && <button className="icon-only" onClick={() => active.current && closeTab(active.current.id)} title="Close this tab (unsaved edits are kept)"><Icon name="close" /></button>}
      </header>
      <div className="body">
        <aside className="strip">
          <div className="tabs">
            <button className={tab === "capture" ? "on" : ""} onClick={() => setTab("capture")}>Captures</button>
            <button className={tab === "copied" ? "on" : ""} onClick={() => setTab("copied")}>Copied</button>
          </div>
          <div className="thumbs">
            {shown.length === 0 && <div className="empty">Nothing yet</div>}
            {shown.map((r) => (
              <div className="thumb" key={r.path} onMouseEnter={(e) => hoverStart(r, e.currentTarget)} onMouseLeave={hoverEnd}>
                <img src={r.url} loading="lazy" onClick={() => insertRecent(r)} alt={r.name} title="Insert into the picture you're editing" />
                <span className="time">{new Date(r.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                <div className="meta">
                  <button onClick={() => insertRecent(r)} title="Add it on top of the picture you're editing">Insert</button>
                  <button onClick={() => openAsTab(r)} title="Open it on its own in a new tab">New tab</button>
                </div>
              </div>
            ))}
          </div>
        </aside>
        {preview && (
          <div className="preview" style={{ top: Math.max(8, Math.min(preview.top - 40, window.innerHeight - 520)) }} aria-hidden>
            <img src={preview.item.url} alt="" onLoad={(e) => setPreviewSize(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)} />
            <div className="info">
              <strong>{preview.item.name}</strong>
              <span>{new Date(preview.item.time).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
              <span>{[previewSize, preview.item.bytes ? `${(preview.item.bytes / 1024 / 1024).toFixed(preview.item.bytes > 1048576 ? 1 : 2)} MB` : "", { capture: "Capture", edited: "Edited", copied: "Copied to clipboard", video: "Recording" }[preview.item.kind]].filter(Boolean).join(" · ")}</span>
              <em>Insert adds it on top · New tab opens it on its own</em>
            </div>
          </div>
        )}
        <main className="canvas">
          {tabs.length === 0 && api && <div className="blank">No picture open<span>Pick a capture on the left: Insert or New tab.</span></div>}
          {tabs.length > 0 && (
            <nav className="doctabs" role="tablist">
              {tabs.map((t) => (
                <div key={t.id} role="tab" aria-selected={t.id === activeId} className={`doctab${t.id === activeId ? " on" : ""}`} onClick={() => switchTo(t.id)} title={t.name}>
                  {t.dirty && <span className="dot" aria-label="unsaved changes" />}
                  <span className="label">{t.name}</span>
                  <button className="x" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }} title="Close tab (unsaved edits are kept as “… edited.png”)">×</button>
                </div>
              ))}
            </nav>
          )}
          <div className="excal-host">
          <Excalidraw
            excalidrawAPI={(a) => { setApi(a); Object.assign(((window as unknown as { grabbit: object }).grabbit ??= {}), { api: a, convert: convertToExcalidrawElements }); }}   // test hook (CDP checks)
            theme={dark ? "dark" : "light"}
            handleKeyboardGlobally   // Ctrl+Z, Delete and tool keys work right after clicking a toolbar button
            name={name}
            initialData={{
              appState: {
                viewBackgroundColor: "#ffffff",
                currentItemRoughness: 0,
                currentItemStrokeColor: "#e03131",
                currentItemStrokeWidth: 4,
                currentItemFontFamily: FONT_FAMILY.Nunito,
                currentItemFontSize: 28,
                currentItemEndArrowhead: "triangle",
              },
            }}
            UIOptions={{
              canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, clearCanvas: true, toggleTheme: true, changeViewBackgroundColor: true },
              tools: { image: true },
            }}
          />
          </div>
          {panel && <Panel which={panel} ops={ops} beauty={beauty} setBeauty={setBeauty} onClose={() => setPanel(null)} />}
          {stickers && (
            <div className="stickers">
              <header><b>Stickers</b><button className="x" onClick={() => setStickers(false)} title="Close (Esc)">×</button></header>
              <div className="grid emoji">{EMOJI.map((e) => <button key={e} onClick={() => { addEmoji(e); setStickers(false); }}>{e}</button>)}</div>
              <div className="grid icons">
                {ICONS.map((i) => (
                  <button key={i.name} title={i.name} onClick={() => { addIcon(i.svg); setStickers(false); }} dangerouslySetInnerHTML={{ __html: i.svg }} />
                ))}
              </div>
              <div className="hint">Icons take the current stroke colour.</div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
