import { useCallback, useEffect, useRef, useState } from "react";
import {
  CaptureUpdateAction, Excalidraw, FONT_FAMILY, convertToExcalidrawElements, exportToBlob,
  getSceneVersion, restoreElements, serializeAsJSON,
} from "@excalidraw/excalidraw";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI, BinaryFileData, DataURL } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, FileId } from "@excalidraw/excalidraw/element/types";
import { getImage, onHost, post, type ExportAction, type RecentItem, type Size } from "./host";
import { EMOJI, ICONS, iconDataURL } from "./stickers";
import { Icon } from "./icons";
import { redact, spotlight, type Box } from "./redact";

const BASE_ID = "grabbit-base";

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
  const [tabs, setTabs] = useState<{ id: string; name: string; dirty: boolean }[]>([]);
  const [activeId, setActiveId] = useState("");
  const [dark, setDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const q = matchMedia("(prefers-color-scheme: dark)");
    const f = () => setDark(q.matches);
    q.addEventListener("change", f);
    return () => q.removeEventListener("change", f);
  }, []);
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
    if (!d.view) requestAnimationFrame(() => api.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.92, animate: false }));
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
        if (m.type === "load") setRecent(m.recent);
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
    if (docs.current.length === 0) { active.current = null; post({ type: "close" }); return; }
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
    return blobToDataURL(blob);
  }, [api]);

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
    const targets = selectedBoxes().filter((e) => e.type === "rectangle" || e.type === "ellipse" || e.type === "diamond");
    if (!b || targets.length === 0) { api!.setToast({ message: "Draw a box over what to hide, select it, then pick Pixelate, Blur or Black out.", duration: 4000 }); return; }
    if (mode === "black") {
      const ids = new Set(targets.map((t) => t.id));
      api!.updateScene({
        elements: api!.getSceneElementsIncludingDeleted().map((e) => ids.has(e.id) ?{ ...e, backgroundColor: "#000000", strokeColor: "#000000", fillStyle: "solid", version: e.version + 1 } as ExcalidrawElement : e),
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
      replacements.push(...convertToExcalidrawElements([{ type: "image", fileId: id, ...r.box }], { regenerateIds: false }));
    }
    const gone = new Set(targets.map((t) => t.id));
    api!.updateScene({
      elements: [...api!.getSceneElementsIncludingDeleted().map((e) => gone.has(e.id) ? { ...e, isDeleted: true, version: e.version + 1 } as ExcalidrawElement : e), ...replacements],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }

  function applySpotlight() {
    const b = base();
    const t = selectedBoxes().find((e) => e.type === "rectangle" || e.type === "ellipse");
    if (!b || !t) { api!.setToast({ message: "Draw a box round what to spotlight, select it, then pick Spotlight.", duration: 4000 }); return; }
    addImage(spotlight(b as Box, t as Box), b.width, b.height, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, { locked: true });
    api!.updateScene({
      elements: api!.getSceneElementsIncludingDeleted().map((e) => e.id === t.id ? { ...e, isDeleted: true, version: e.version + 1 } as ExcalidrawElement : e),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }

  function addStep() {
    const n = api!.getSceneElements().filter((e) => e.customData?.grabbitStep).length + 1;
    const color = api!.getAppState().currentItemStrokeColor;
    const c = viewportCenter();
    const els = convertToExcalidrawElements([{
      type: "ellipse", x: c.x - 22, y: c.y - 22, width: 44, height: 44, backgroundColor: color, strokeColor: "#ffffff", strokeWidth: 2,
      fillStyle: "solid", roughness: 0, customData: { grabbitStep: n },
      label: { text: String(n), fontSize: 22, strokeColor: "#ffffff", fontFamily: FONT_FAMILY.Nunito },
    }]);
    api!.updateScene({
      elements: [...api!.getSceneElementsIncludingDeleted(), ...els],
      appState: { selectedElementIds: { [els[0].id]: true } },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }

  function addEmoji(e: string) {
    const c = viewportCenter();
    addElements([{ type: "text", text: e, x: c.x - 32, y: c.y - 32, fontSize: 64 }]);
  }

  function addIcon(svg: string) {
    addImage(iconDataURL(svg, api!.getAppState().currentItemStrokeColor), 96, 96);
  }

  async function insertRecent(item: RecentItem) {
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

  const shown = recent.filter((r) => tab === "copied" ? r.kind === "copied" : r.kind !== "copied");

  return (
    <div className="shell">
      <header className="bar">
        <div className="seg">
          <button className="primary" onClick={() => exportAs("copy", "Full")} title="Copy full size (Ctrl+Shift+Enter)"><Icon name="copy" />Copy</button>
          <button onClick={() => exportAs("copy", "Reduced")} title="Copy with the long edge cut down to 1920 px"><Icon name="shrink" />Smaller</button>
          <button onClick={() => exportAs("copy", "Chat")} title="Copy as a small JPEG for chat apps"><Icon name="chat" />Chat</button>
          <button onClick={() => exportAs("copyClose", "Full")} title="Copy and close (Ctrl+Enter)"><Icon name="check" />Copy &amp; close</button>
        </div>
        <div className="seg">
          <button onClick={() => exportAs("saveQuick", "Full")} title="Save to the Grabbit folder, lossless WebP (Ctrl+S)"><Icon name="save" />Save</button>
          <button onClick={() => exportAs("copyPath", "Full")} title="Save, then copy the file's path in quotes (like Explorer's Copy as path)"><Icon name="link" />Copy path</button>
          <button onClick={() => exportAs("save", "Full")} title="Choose where, as WebP, PNG or JPEG (Ctrl+Shift+S)"><Icon name="saveAs" />Save as…</button>
          <button onClick={saveProject} title="Save an editable .excalidraw file you can reopen later"><Icon name="editable" />Editable</button>
        </div>
        <div className="seg">
          <button onClick={addStep} title="Numbered step badge (next number)"><Icon name="step" />Step</button>
          <button onClick={() => applyRedact("pixelate")} title="Select a box, then pixelate what's under it"><Icon name="pixelate" />Pixelate</button>
          <button onClick={() => applyRedact("blur")} title="Select a box, then blur what's under it"><Icon name="blur" />Blur</button>
          <button onClick={() => applyRedact("black")} title="Select a box, then fill it solid black"><Icon name="black" />Black out</button>
          <button onClick={applySpotlight} title="Select a box, then dim everything else"><Icon name="spot" />Spotlight</button>
          <button className={stickers ? "on" : ""} onClick={() => setStickers(!stickers)} title="Emoji and icons"><Icon name="smile" />Stickers</button>
        </div>
        <div className="name">{busy ? <span className="busy">{busy}</span> : name}</div>
        <button className="icon-only" onClick={() => active.current && closeTab(active.current.id)} title="Close this tab (unsaved edits are kept)"><Icon name="close" /></button>
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
                <img src={r.url} loading="lazy" onClick={() => insertRecent(r)} alt={r.name} />
                <div className="meta">
                  <span>{new Date(r.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  <button onClick={() => openAsTab(r)} title="Open this one in a new tab">Open</button>
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
              <span>{[previewSize, preview.item.bytes ? `${(preview.item.bytes / 1024 / 1024).toFixed(preview.item.bytes > 1048576 ? 1 : 2)} MB` : "", { capture: "Capture", edited: "Edited", copied: "Copied to clipboard" }[preview.item.kind]].filter(Boolean).join(" · ")}</span>
              <em>Click to add on top · Open for a new tab</em>
            </div>
          </div>
        )}
        <main className="canvas">
          {tabs.length > 1 && (
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
          <Excalidraw
            excalidrawAPI={(a) => { setApi(a); Object.assign(window.grabbit, { api: a, convert: convertToExcalidrawElements }); }}   // test hook (CDP checks)
            theme={dark ? "dark" : "light"}
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
          {stickers && (
            <div className="stickers">
              <div className="grid emoji">{EMOJI.map((e) => <button key={e} onClick={() => addEmoji(e)}>{e}</button>)}</div>
              <div className="grid icons">
                {ICONS.map((i) => (
                  <button key={i.name} title={i.name} onClick={() => addIcon(i.svg)} dangerouslySetInnerHTML={{ __html: i.svg }} />
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
