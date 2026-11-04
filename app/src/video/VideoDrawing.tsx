import { useEffect, useRef, useState } from "react";
import "@excalidraw/excalidraw/index.css";
import { CaptureUpdateAction, Excalidraw, FONT_FAMILY, convertToExcalidrawElements, exportToCanvas, getCommonBounds } from "@excalidraw/excalidraw";
import type { AppState, ExcalidrawImperativeAPI, NormalizedZoomValue } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

// Excalidraw over the whole stage. The camera is locked to video pixels (zoom = shown width / video width, scrolled so
// scene (0,0) is the picture's corner), so its panels sit at the stage edges rather than on the picture, and a
// drawing exports at exactly the size and place it covers. Each drawing has a time span; only the ones live at the
// playhead are in the scene, the rest wait in `all`. Export bakes each span's drawings into a video-sized PNG.

export type Timed = { id: string; label: string; from: number; to: number };
export type Baked = { dataURL: string; from: number; to: number };
/** A privacy blur: a box in video pixels, blurred while its bar is under the playhead. */
export type Blur = { x: number; y: number; width: number; height: number; from: number; to: number };
export type DrawingHandle = {
  bake(): Promise<{ overlays: Baked[]; blurs: Blur[] }>;
  addBlur(): void;
  select(id: string): void;
  setTimes(id: string, from: number, to: number): void;
  count(): number;
};

const DEFAULT_SPAN = 4; // seconds a new drawing stays up
const PAD = 32; // px around baked drawings

const isBlur = (e: ExcalidrawElement) => !!(e.customData as { grabbitBlur?: boolean } | undefined)?.grabbitBlur;

function label(e: ExcalidrawElement) {
  if (isBlur(e)) return "Blur";
  if (e.type === "text") return `“${(e as unknown as { text: string }).text.slice(0, 24)}”`;
  return { arrow: "Arrow", rectangle: "Box", ellipse: "Ellipse", diamond: "Diamond", line: "Line", freedraw: "Pen", image: "Image", frame: "Frame" }[e.type as string] ?? e.type;
}

export function VideoDrawing(props: {
  box: { left: number; top: number; width: number; height: number }; // where the picture is shown, in px
  width: number; height: number; // video pixels
  t: number; duration: number;
  drawing: boolean;
  onItems: (items: Timed[], selected: string[]) => void;
  handle: (h: DrawingHandle) => void;
}) {
  const { box, width, height, t, duration, drawing } = props;
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const all = useRef(new Map<string, ExcalidrawElement>()); // every live drawing, shown or not
  const times = useRef(new Map<string, { from: number; to: number }>());
  const shown = useRef("");
  const selected = useRef<string[]>([]);
  const tRef = useRef(t);
  tRef.current = t;
  const zoom = box.width / Math.max(1, width);
  const camera = { zoom: { value: zoom as NormalizedZoomValue }, scrollX: box.left / zoom, scrollY: box.top / zoom };

  // Bound text lives and dies with its box; everything else carries its own span.
  const spanOf = (e: ExcalidrawElement) => times.current.get((e as { containerId?: string | null }).containerId ?? e.id) ?? times.current.get(e.id);
  const roots = () => [...all.current.values()].filter((e) => !(e as { containerId?: string | null }).containerId);

  const report = () =>
    props.onItems(roots().map((e) => ({ id: e.id, label: label(e), ...(times.current.get(e.id) ?? { from: 0, to: 0 }) })), selected.current);

  /** Put exactly the drawings live at time `at` (plus anything selected) into the scene. */
  const sync = (at: number, force = false) => {
    if (!api) return;
    const live = [...all.current.values()].filter((e) => {
      const s = spanOf(e);
      return selected.current.includes(e.id) || (s && at >= s.from && at < s.to);
    });
    const key = live.map((e) => e.id + ":" + e.version).join(",");
    if (!force && key === shown.current) return;
    shown.current = key;
    api.updateScene({ elements: live, captureUpdate: CaptureUpdateAction.NEVER });
  };

  // Lock the camera to video pixels whenever the shown size changes.
  useEffect(() => {
    api?.updateScene({ appState: camera, captureUpdate: CaptureUpdateAction.NEVER });
  }, [api, zoom, box.left, box.top]);

  useEffect(() => sync(t), [t, api]);

  // Excalidraw takes keys (R, A, T, …) only while it has focus: hand it focus when drawing starts.
  useEffect(() => {
    if (drawing) requestAnimationFrame(() => document.querySelector<HTMLElement>(".drawing .excalidraw")?.focus());
  }, [drawing]);

  const onChange = (elements: readonly ExcalidrawElement[], app: AppState) => {
    // Panning or zooming the canvas would break the pixel lock: put it back.
    if (Math.abs(app.zoom.value - zoom) > 1e-4 || Math.abs(app.scrollX - camera.scrollX) > 0.01 || Math.abs(app.scrollY - camera.scrollY) > 0.01)
      queueMicrotask(() => api?.updateScene({ appState: camera, captureUpdate: CaptureUpdateAction.NEVER }));
    let changed = false;
    for (const e of elements) {
      if (e.isDeleted) {
        if (all.current.delete(e.id)) { times.current.delete(e.id); changed = true; }
        continue;
      }
      if (all.current.get(e.id)?.version !== e.version) { all.current.set(e.id, e); changed = true; }
      const owner = (e as { containerId?: string | null }).containerId;
      if (!owner && !times.current.has(e.id)) {
        const from = Math.min(tRef.current, Math.max(0, duration - 0.5));
        times.current.set(e.id, { from, to: Math.min(duration, from + DEFAULT_SPAN) });
        changed = true;
      }
    }
    const sel = Object.keys(app.selectedElementIds ?? {}).filter((id) => app.selectedElementIds[id]);
    if (sel.join() !== selected.current.join()) { selected.current = sel; changed = true; }
    shown.current = elements.filter((e) => !e.isDeleted).map((e) => e.id + ":" + e.version).join(",");
    if (changed) report();
  };

  useEffect(() => {
    props.handle({
      count: () => all.current.size,
      select(id) {
        selected.current = [id];
        sync(tRef.current, true);
        api?.updateScene({ appState: { selectedElementIds: { [id]: true } }, captureUpdate: CaptureUpdateAction.NEVER });
        report();
      },
      setTimes(id, from, to) {
        times.current.set(id, { from, to });
        sync(tRef.current, true);
        report();
      },
      addBlur() {
        if (!api) return;
        const [el] = convertToExcalidrawElements([{
          type: "rectangle", x: width * 0.35, y: height * 0.35, width: width * 0.3, height: height * 0.3,
          strokeColor: "#7048e8", strokeStyle: "dashed", strokeWidth: 2, backgroundColor: "rgba(112,72,232,0.15)", fillStyle: "solid", roughness: 0,
          customData: { grabbitBlur: true },
        }]);
        api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), el], appState: { selectedElementIds: { [el.id]: true } } as Partial<AppState> as never, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      },
      async bake() {
        if (!api || all.current.size === 0) return { overlays: [], blurs: [] };
        const blurs: Blur[] = [];
        for (const e of all.current.values()) {
          const s = spanOf(e);
          if (!isBlur(e) || !s) continue;
          const x = Math.max(0, Math.round(e.x)), y = Math.max(0, Math.round(e.y));
          blurs.push({ x, y, width: Math.min(width - x, Math.round(e.width)), height: Math.min(height - y, Math.round(e.height)), from: s.from, to: s.to });
        }
        // One picture per distinct time span, so ffmpeg overlays as few layers as possible.
        const groups = new Map<string, { from: number; to: number; els: ExcalidrawElement[] }>();
        for (const e of all.current.values()) {
          const s = spanOf(e);
          if (!s || s.to - s.from < 0.01 || isBlur(e)) continue;
          const k = `${s.from}-${s.to}`;
          (groups.get(k) ?? groups.set(k, { ...s, els: [] }).get(k)!).els.push(e);
        }
        const out: Baked[] = [];
        for (const g of groups.values()) {
          const [minX, minY] = getCommonBounds(g.els);
          const canvas = await exportToCanvas({
            elements: g.els,
            appState: { ...api.getAppState(), exportBackground: false, viewBackgroundColor: "transparent", exportWithDarkMode: false, exportScale: 1 },
            files: api.getFiles(),
            exportPadding: PAD, // room for strokes and handwriting glyphs that reach past their measured box
          });
          // exportToCanvas crops to the drawings; put them back where they sit on the frame.
          const frame = document.createElement("canvas");
          frame.width = width;
          frame.height = height;
          frame.getContext("2d")!.drawImage(canvas, Math.round(minX - PAD), Math.round(minY - PAD));
          out.push({ dataURL: frame.toDataURL("image/png"), from: g.from, to: g.to });
        }
        return { overlays: out, blurs };
      },
    });
  });

  return (
    <div
      className={"drawing" + (drawing ? " on" : "")}
      style={{ inset: 0 }}
      onClick={(e) => drawing && e.stopPropagation()}
    >
      <Excalidraw
        excalidrawAPI={(a) => { setApi(a); Object.assign(window, { grabbitDraw: { api: a, convert: convertToExcalidrawElements } }); }}   // test hook (CDP checks)
        theme="dark"
        viewModeEnabled={!drawing}
        zenModeEnabled={!drawing}
        initialData={{
          appState: {
            viewBackgroundColor: "transparent",
            currentItemRoughness: 0,
            currentItemStrokeColor: "#e03131",
            currentItemStrokeWidth: 4,
            currentItemFontFamily: FONT_FAMILY.Nunito,
            currentItemFontSize: 36,
            currentItemEndArrowhead: "triangle",
            ...camera,
          },
        }}
        onChange={onChange}
        UIOptions={{
          canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, clearCanvas: false, toggleTheme: false, changeViewBackgroundColor: false },
          tools: { image: false },
        }}
      />
    </div>
  );
}
