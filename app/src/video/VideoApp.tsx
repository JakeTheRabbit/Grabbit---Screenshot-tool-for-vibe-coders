import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { VideoDrawing, type DrawingHandle, type Timed } from "./VideoDrawing";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { call, fileUrl, inTauri, onHostEvent, send } from "../bridge";

// Recording timeline: scrub, trim the ends, split, cut parts out. The edit is just a list of kept ranges;
// Grabbit's core (video.rs) renders them with ffmpeg, so nothing here touches the video file.

type Seg = { s: number; e: number; v?: number };   // v: playback speed of the part (1 = normal)
type Cue = { start: number; end: number; text: string };
type Social = { name: string; width: number; height: number };
type Meta = { social?: Social[]; cursor?: { moves: unknown[]; keys: unknown[] } | null; hasCaptions?: boolean; name: string; path?: string; url: string; duration: number; fps: number; width: number; height: number; hasAudio: boolean; bytes: number; hasSystem?: boolean; hasMic?: boolean };
type Target = "Full" | "Chat" | "Gif" | "Webp" | `Social:${number}x${number}`;
type Action = "copy" | "save" | "saveAs" | "copyPath" | "closeSave" | "share";
type Sound = "All" | "System" | "Mic" | "None";
type HostMsg =
  | ({ type: "load" } & Meta)
  | { type: "keepAndClose" }
  | { type: "progress"; value: number; label: string }
  | { type: "done"; ok: boolean; note: string };

const MIN = 0.1; // shortest part, seconds
const post = (m: object) => void send(m);

function fmt(t: number, fine = true) {
  t = Math.max(0, t);
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${fine ? s.toFixed(2).padStart(5, "0") : String(Math.floor(s)).padStart(2, "0")}`;
}
const key = (k: Seg[]) => k.map((g) => `${g.s.toFixed(3)}-${g.e.toFixed(3)}x${g.v ?? 1}`).join(",");
/** Take [a, b] ranges out of the kept parts (cut silences, cut a caption's stretch). */
const without = (k: Seg[], cuts: [number, number][]) => {
  let out = k;
  for (const [a, b] of cuts) out = out.flatMap((g) => g.e <= a || g.s >= b ? [g] : [{ ...g, e: Math.min(g.e, a) }, { ...g, s: Math.max(g.s, b) }]).filter((g) => g.e - g.s >= MIN);
  return out;
};
const FILLER = /^(?:[\s,.!?…-]*(?:um+|uh+|erm+|er|ah+|hmm+|mm+|like|you know)[\s,.!?…-]*)+$/i;

/** A button with a menu of related actions. */
function Drop({ label, primary, disabled, onMain, items }: { label: string; primary?: boolean; disabled?: boolean; onMain?: () => void; items: [string, () => void][] }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    setTimeout(() => addEventListener("click", close, { once: true }));
    return () => removeEventListener("click", close);
  }, [open]);
  return (
    <span className="drop">
      <button className={primary ? "primary" : ""} disabled={disabled} onClick={onMain ?? (() => setOpen(!open))}>{label}</button>
      {onMain && <button className={"caret" + (primary ? " primary" : "")} disabled={disabled} onClick={() => setOpen(!open)} aria-label={`More ${label}`}>▾</button>}
      {open && <div className="menu">{items.map(([t, f]) => <button key={t} onClick={() => { setOpen(false); f(); }}>{t}</button>)}</div>}
    </span>
  );
}
const total = (k: Seg[]) => k.reduce((a, g) => a + g.e - g.s, 0);
const clip = (k: Seg[], a: number, b: number) =>
  k.map((g) => ({ s: Math.max(g.s, a), e: Math.min(g.e, b) })).filter((g) => g.e - g.s >= MIN);

function once(el: HTMLElement, ev: string) {
  return new Promise<void>((r) => el.addEventListener(ev, () => r(), { once: true }));
}

/** Filmstrip frames, grabbed with a hidden second player so the main one never moves. */
async function makeThumbs(url: string, dur: number, n: number, got: (i: number, c: HTMLCanvasElement) => void, alive: () => boolean) {
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  v.src = url;
  await once(v, "loadeddata");
  const h = 72, w = Math.max(1, Math.round((h * v.videoWidth) / Math.max(1, v.videoHeight)));
  for (let i = 0; i < n && alive(); i++) {
    v.currentTime = Math.min(dur - 0.05, ((i + 0.5) * dur) / n);
    await once(v, "seeked");
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d")!.drawImage(v, 0, 0, w, h);
    got(i, c);
  }
  v.removeAttribute("src");
  v.load();
}

export function VideoApp() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [keep, setKeepState] = useState<Seg[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pps, setPps] = useState(100); // pixels per second
  const [fit, setFit] = useState(true);
  const [thumbs, setThumbs] = useState<HTMLCanvasElement[]>([]);
  const [busy, setBusy] = useState<{ label: string; value: number } | null>(null);
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState("");
  const [sound, setSound] = useState<Sound>("All");
  const [drawing, setDrawing] = useState(false);
  const [items, setItems] = useState<Timed[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [drawVersion, setDrawVersion] = useState(0);
  const [savedDraw, setSavedDraw] = useState(0);
  const [box, setBox] = useState({ left: 0, top: 0, width: 1, height: 1 });
  const [fx, setFx] = useState({ zoom: false, clicks: false, keys: false });
  const [cues, setCues] = useState<Cue[] | null>(null);
  const [captionsOpen, setCaptionsOpen] = useState(false);
  const [burn, setBurn] = useState(false);
  const [targets, setTargets] = useState<string[]>([]);
  useEffect(() => { void call<string[]>("share_targets").then((t) => setTargets(t ?? [])); }, []);
  const stage = useRef<HTMLElement>(null);
  const draw = useRef<DrawingHandle | null>(null);
  const itemsKey = useRef("");

  const video = useRef<HTMLVideoElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const keepRef = useRef(keep);
  const past = useRef<Seg[][]>([]);
  const future = useRef<Seg[][]>([]);
  const lastAction = useRef<Action>("copy");
  keepRef.current = keep;
  const dur = meta?.duration ?? 0;

  const setKeep = (k: Seg[]) => { keepRef.current = k; setKeepState(k); };
  const commit = useCallback((next: Seg[], before = keepRef.current) => {
    if (key(next) === key(before)) return;
    past.current.push(before);
    future.current = [];
    setKeep(next);
  }, []);
  const undo = () => { const p = past.current.pop(); if (p) { future.current.push(keepRef.current); setKeep(p); setSel(null); } };
  const redo = () => { const f = future.current.pop(); if (f) { past.current.push(keepRef.current); setKeep(f); setSel(null); } };

  // ---- host ----
  useEffect(() => {
    const onMsg = (m: HostMsg) => {
      if (m.type === "load") {
        if (!m.url && m.path) m.url = fileUrl(m.path);
        setMeta(m);
        const all = [{ s: 0, e: m.duration }];
        setKeep(all);
        setSaved(key(all));
        document.title = `Grabbit — ${m.name}`;
      } else if (m.type === "progress") setBusy({ label: m.label, value: m.value });
      else if (m.type === "done") {
        setBusy(null);
        setNote(m.note);
        if (m.ok && lastAction.current !== "copy") { setSaved(key(keepRef.current)); setSavedDraw(drawVersionRef.current); }
      } else if (m.type === "keepAndClose") exportRef.current("closeSave", "Full");
    };
    const off = onHostEvent<HostMsg>(onMsg);
    // Outside WebView2 (dev): video.html?src=<url>
    const src = new URLSearchParams(location.search).get("src");
    if (!inTauri && src) {
      const v = document.createElement("video");
      v.src = src;
      v.addEventListener("loadedmetadata", () =>
        onMsg({ type: "load", name: src.split("/").pop() ?? "video", url: src, duration: v.duration, fps: 30, width: v.videoWidth, height: v.videoHeight, hasAudio: true, bytes: 0 }));
    }
    post({ type: "ready" });
    return off;
  }, []);

  const edited = !(keep.length === 1 && keep[0].s < 0.01 && keep[0].e > dur - 0.01 && (keep[0].v ?? 1) === 1);
  const drawVersionRef = useRef(0);
  drawVersionRef.current = drawVersion;
  useEffect(() => {
    if (meta) post({ type: "dirty", value: key(keep) !== saved || drawVersion !== savedDraw });
  }, [keep, saved, meta, drawVersion, savedDraw]);

  // Where the picture actually sits inside the stage (object-fit: contain), for the drawing layer.
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el || !meta) return;
    const fitBox = () => {
      const W = el.clientWidth, H = el.clientHeight, k = Math.min(W / meta.width, H / meta.height);
      const w = meta.width * k, h = meta.height * k;
      setBox({ left: (W - w) / 2, top: (H - h) / 2, width: w, height: h });
    };
    fitBox();
    const ro = new ResizeObserver(fitBox);
    ro.observe(el);
    return () => ro.disconnect();
  }, [meta]);

  // ---- filmstrip ----
  const thumbCount = useMemo(() => (meta ? Math.min(150, Math.max(8, Math.ceil(meta.duration * 2))) : 0), [meta]);
  useEffect(() => {
    if (!meta) return;
    let alive = true;
    const list: HTMLCanvasElement[] = [];
    makeThumbs(meta.url, meta.duration, thumbCount, (i, c) => { list[i] = c; setThumbs([...list]); }, () => alive).catch(() => {});
    return () => { alive = false; };
  }, [meta, thumbCount]);

  // ---- zoom: fit the whole video unless the user zoomed ----
  useLayoutEffect(() => {
    if (!meta || !fit || !scroller.current) return;
    const fitNow = () => setPps(Math.max(1, (scroller.current!.clientWidth - 40) / meta.duration)); // 32 padding + the trim handles' overhang
    fitNow();
    const ro = new ResizeObserver(fitNow);
    ro.observe(scroller.current);
    return () => ro.disconnect();
  }, [meta, fit]);

  const zoom = (f: number, around = video.current?.currentTime ?? 0) => {
    const sc = scroller.current;
    if (!sc || !meta) return;
    const fitPps = (sc.clientWidth - 32) / meta.duration;
    const next = Math.min(400, Math.max(fitPps, pps * f));
    setFit(next <= fitPps * 1.001);
    const screenX = around * pps - sc.scrollLeft;
    setPps(next);
    requestAnimationFrame(() => { sc.scrollLeft = around * next - screenX; });
  };

  // ---- playback: hop over cut parts, stop at the end of the last kept part ----
  useEffect(() => {
    if (!meta) return;
    let raf = 0;
    const loop = () => {
      const v = video.current;
      if (v) {
        let ct = v.currentTime;
        if (!v.paused) {
          const k = keepRef.current;
          if (!k.some((g) => ct >= g.s - 0.001 && ct < g.e)) {
            const next = k.find((g) => g.s > ct);
            if (next) v.currentTime = ct = next.s;
            else { v.pause(); v.currentTime = ct = k[k.length - 1].e; }
          }
        }
        setT((old) => (Math.abs(old - ct) > 0.001 ? ct : old));
        setPlaying(!v.paused);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [meta]);

  // Keep the playhead in view while playing.
  useEffect(() => {
    const sc = scroller.current;
    if (!sc || !playing) return;
    const x = t * pps;
    if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = x - 40;
  }, [t, pps, playing]);

  const seek = (to: number) => { const v = video.current; if (v) v.currentTime = Math.min(Math.max(0, to), dur); };
  const togglePlay = () => {
    const v = video.current;
    if (!v) return;
    if (!v.paused) { v.pause(); return; }
    const k = keepRef.current, ct = v.currentTime;
    if (!k.some((g) => ct >= g.s && ct < g.e - 0.02)) seek((k.find((g) => g.s > ct) ?? k[0]).s);
    v.play();
  };

  // ---- edits ----
  const segAt = (at: number) => keepRef.current.findIndex((g) => at >= g.s && at <= g.e);
  const split = () => {
    const k = keepRef.current, i = segAt(t);
    if (i < 0 || t - k[i].s < MIN || k[i].e - t < MIN) { setNote("Move the playhead inside a part to split it"); return; }
    commit([...k.slice(0, i), { s: k[i].s, e: t }, { s: t, e: k[i].e }, ...k.slice(i + 1)]);
    setSel(i + 1);
  };
  const remove = () => {
    const k = keepRef.current, i = sel ?? segAt(t);
    if (i < 0) return;
    if (k.length === 1) { setNote("That's all that's left — trim its ends instead"); return; }
    commit(k.filter((_, j) => j !== i));
    setSel(null);
  };
  const trimBefore = () => { const n = clip(keepRef.current, t, dur); if (n.length) commit(n); };
  const trimAfter = () => { const n = clip(keepRef.current, 0, t); if (n.length) commit(n); };
  const reset = () => { commit([{ s: 0, e: dur }]); setSel(null); };
  const setSpeed = (v: number) => {
    if (sel === null) { setNote("Click a part first (split with S), then pick its speed"); return; }
    commit(keepRef.current.map((g, i) => (i === sel ? { ...g, v } : g)));
  };
  const cutSilences = async () => {
    setBusy({ label: "Finding quiet parts", value: 0.5 });
    try {
      const quiet = (await send<[number, number][]>({ type: "silences", path: meta!.path, min: 0.8 })) ?? [];
      // Keep a little either side so words aren't clipped.
      const cuts = quiet.map(([a, b]) => [a + 0.15, b - 0.15] as [number, number]).filter(([a, b]) => b - a > 0.3);
      if (!cuts.length) setNote("No long quiet parts found");
      else { commit(without(keepRef.current, cuts)); setNote(`Cut ${cuts.length} quiet part${cuts.length > 1 ? "s" : ""} (${fmt(cuts.reduce((x, [a, b]) => x + b - a, 0), false)}). Ctrl+Z undoes it.`); }
    } catch (e) { setNote(String(e)); }
    setBusy(null);
  };
  const makeCaptions = async () => {
    setCaptionsOpen(true);
    if (cues) return;
    try {
      const engine = await send<string>({ type: "captionEngine" });
      if (engine === "none") { setNote("Captions need ffmpeg 8 (with whisper) or an OpenAI key in Settings → AI"); setCaptionsOpen(false); return; }
      if (engine === "download") {
        if (!confirm("Captions run on this computer with a speech model (148 MB, downloaded once from Hugging Face). Download it now?")) { setCaptionsOpen(false); return; }
        await send({ type: "downloadModel" });
      }
      setBusy({ label: engine === "openai" ? "Transcribing with OpenAI" : "Transcribing on this computer", value: 0.5 });
      setCues((await send<Cue[]>({ type: "captions", path: meta!.path })) ?? []);
    } catch (e) { setNote(String(e)); setCaptionsOpen(false); }
    setBusy(null);
  };
  const saveCues = (next: Cue[]) => { setCues(next); void send({ type: "saveCaptions", path: meta!.path, cues: next }); };
  const cutFillers = () => {
    const f = (cues ?? []).filter((c) => FILLER.test(c.text)).map((c) => [c.start, c.end] as [number, number]);
    if (!f.length) { setNote("No filler-only lines found"); return; }
    commit(without(keepRef.current, f));
    setNote(`Cut ${f.length} filler line${f.length > 1 ? "s" : ""}`);
  };

  const shareTo = useRef<string | null>(null);
  const exportAs = async (action: Action, target: Target) => {
    if (busy || !meta) return;
    lastAction.current = action;
    setNote("");
    setBusy({ label: draw.current?.count() ? "Drawing the annotations" : "Starting…", value: 0 });
    let saveTo: string | null = null;
    if (action === "saveAs") {
      const ext = target === "Gif" ? "gif" : target === "Webp" ? "webp" : "mp4";
      saveTo = await saveDialog({ defaultPath: `${meta.name}.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
      if (!saveTo) { setBusy(null); return; }
    }
    const overlays = (await draw.current?.bake()) ?? [];
    post({ type: "export", action, target, path: meta.path, saveTo, segments: keepRef.current.map((g) => [g.s, g.e, g.v ?? 1]), edited, sound, overlays,
      studio: fx, burnCaptions: burn && !!cues?.length, shareTo: shareTo.current });
  };
  const exportRef = useRef(exportAs);
  exportRef.current = exportAs;

  // ---- pointer: scrub anywhere, drag a part's edge to trim it ----
  const drag = useRef<{ mode: "scrub" | "edge" | "note"; i: number; side: "s" | "e" | "move"; before: Seg[]; moved: boolean; x: number; wasPlaying: boolean; note?: Timed } | null>(null);
  const timeAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return Math.min(dur, Math.max(0, (clientX - r.left) / pps));
  };
  const onDown = (e: React.PointerEvent) => {
    if (!meta || e.button !== 0) return;
    const el = e.target as HTMLElement;
    const v = video.current!;
    const wasPlaying = !v.paused;
    v.pause();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (el.dataset.note) {
      const note = items.find((n) => n.id === el.dataset.note)!;
      drag.current = { mode: "note", i: -1, side: (el.dataset.side as "s" | "e" | undefined) ?? "move", before: keepRef.current, moved: false, x: e.clientX, wasPlaying, note };
      draw.current?.select(note.id);
      return;
    }
    if (el.dataset.edge) {
      const i = Number(el.dataset.i);
      drag.current = { mode: "edge", i, side: el.dataset.edge as "s" | "e", before: keepRef.current, moved: false, x: e.clientX, wasPlaying };
      setSel(i);
      return;
    }
    drag.current = { mode: "scrub", i: -1, side: "s", before: keepRef.current, moved: false, x: e.clientX, wasPlaying };
    seek(timeAt(e.clientX));
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.x) > 3) d.moved = true;
    const at = timeAt(e.clientX);
    if (d.mode === "scrub") { seek(at); return; }
    if (d.mode === "note" && d.note) {
      const n = d.note, dt = (e.clientX - d.x) / pps;
      let from = n.from, to = n.to;
      if (d.side === "s") from = Math.min(Math.max(0, n.from + dt), n.to - MIN);
      else if (d.side === "e") to = Math.max(Math.min(dur, n.to + dt), n.from + MIN);
      else { const len = n.to - n.from; from = Math.min(Math.max(0, n.from + dt), dur - len); to = from + len; }
      draw.current?.setTimes(n.id, from, to);
      seek(d.side === "e" ? to - 0.001 : from);
      return;
    }
    const k = [...d.before], g = { ...k[d.i] };
    if (d.side === "s") g.s = Math.min(Math.max(at, d.i > 0 ? k[d.i - 1].e : 0), g.e - MIN);
    else g.e = Math.max(Math.min(at, d.i < k.length - 1 ? k[d.i + 1].s : dur), g.s + MIN);
    k[d.i] = g;
    setKeep(k);
    seek(d.side === "s" ? g.s : g.e); // show the frame you're trimming to
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.mode === "note") { setDrawVersion((v) => v + 1); return; }
    if (d.mode === "edge") commit(keepRef.current, d.before);
    else if (!d.moved) { const i = segAt(timeAt(e.clientX)); setSel(i >= 0 ? i : null); }
    if (d.wasPlaying && d.mode === "scrub") video.current?.play();
  };
  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey) { zoom(e.deltaY < 0 ? 1.25 : 0.8, timeAt(e.clientX)); return; }
    if (scroller.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) scroller.current.scrollLeft += e.deltaY;
  };

  // ---- keys ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!meta || drawing) return;
      const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
      const step = 1 / (meta.fps || 30);
      if (ctrl && k === "z") { e.shiftKey ? redo() : undo(); }
      else if (ctrl && k === "y") redo();
      else if (ctrl && k === "c") exportAs("copy", e.shiftKey ? "Chat" : "Full");
      else if (ctrl && k === "s") exportAs(e.shiftKey ? "saveAs" : "save", "Full");
      else if (ctrl) return;
      else if (k === " " || k === "k") togglePlay();
      else if (k === "arrowleft") seek(t - (e.shiftKey ? 1 : step));
      else if (k === "arrowright") seek(t + (e.shiftKey ? 1 : step));
      else if (k === "home") seek(keepRef.current[0].s);
      else if (k === "end") seek(keepRef.current[keepRef.current.length - 1].e);
      else if (k === "s") split();
      else if (k === "delete" || k === "backspace") remove();
      else if (k === "i") trimBefore();
      else if (k === "o") trimAfter();
      else if (k === "+" || k === "=") zoom(1.5);
      else if (k === "-") zoom(1 / 1.5);
      else if (k === "0") setFit(true);
      else if (k === "escape") setSel(null);
      else if (k === "d") setDrawing(true);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!meta) return <div className="loading">Loading video…</div>;

  // ---- layout numbers ----
  const width = Math.max(1, dur * pps);
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  const tick = steps.find((s) => s * pps >= 80) ?? 3600;
  const ticks: number[] = [];
  for (let x = 0; x <= dur + 1e-6; x += tick) ticks.push(x);
  const gaps: Seg[] = [];
  let at = 0;
  for (const g of keep) { if (g.s - at > 0.001) gaps.push({ s: at, e: g.s }); at = g.e; }
  if (dur - at > 0.001) gaps.push({ s: at, e: dur });
  const tw = dur / thumbCount;
  // Drawing bars stack in rows so overlapping spans stay readable.
  const rows: number[] = [];
  const lanes = items.map((n) => {
    let r = rows.findIndex((end) => end <= n.from + 1e-6);
    if (r < 0) { r = rows.length; rows.push(0); }
    rows[r] = n.to;
    return { ...n, row: r };
  });

  return (
    <div className="app">
      <header>
        <div className="title">
          <strong>{meta.name}</strong>
          <span>{meta.width} × {meta.height} · {Math.round(meta.fps)} fps · {fmt(dur, false)}{meta.bytes ? ` · ${(meta.bytes / 1048576).toFixed(1)} MB` : ""}{meta.hasAudio ? "" : " · no sound"}</span>
        </div>
        <div className="actions">
          {(meta.hasSystem || meta.hasMic) && (
            <label className="sound" title="What sound goes into Copy / Save. Recordings keep system sound and the mic as separate tracks.">
              Sound
              <select value={sound} onChange={(e) => setSound(e.target.value as Sound)}>
                {meta.hasSystem && meta.hasMic && <option value="All">System + mic</option>}
                {meta.hasSystem && <option value="System">{meta.hasMic ? "System sound only" : "Sound"}</option>}
                {meta.hasMic && <option value="Mic">Microphone only</option>}
                <option value="None">No sound</option>
              </select>
            </label>
          )}
          <span className="sep" />
          <Drop label="Copy" primary disabled={!!busy} onMain={() => exportAs("copy", "Full")} items={[
            ["Copy for chat (≤ 94 MB)", () => exportAs("copy", "Chat")],
            ["Copy as GIF", () => exportAs("copy", "Gif")],
            ["Copy as animated WebP", () => exportAs("copy", "Webp")],
            ["Copy path (saves first)", () => exportAs("copyPath", "Full")],
          ]} />
          <Drop label="Save" disabled={!!busy} onMain={() => exportAs("save", "Full")} items={[
            ["Save as…", () => exportAs("saveAs", "Full")],
            ...(meta.social ?? []).map((x) => [`Save for ${x.name} (${x.width}×${x.height})`, () => exportAs("save", `Social:${x.width}x${x.height}`)] as [string, () => void]),
          ]} />
          <Drop label="Share" disabled={!!busy} items={targets.length ? targets.map((t) => [
            t === "obsidian" ? "Send to Obsidian" : `Upload to ${({ onedrive: "OneDrive", immich: "Immich", mega: "MEGA" } as Record<string, string>)[t]} and copy link`,
            () => { shareTo.current = t; void exportAs("share", "Full").finally(() => { shareTo.current = null; }); },
          ] as [string, () => void]) : [["Set up sharing in Settings…", () => void call("open_settings_at", { section: "Sharing" })]]} />
        </div>
      </header>

      <main ref={stage} onClick={() => !drawing && togglePlay()}>
        <video ref={video} src={meta.url} preload="auto" />
        <VideoDrawing box={box} width={meta.width} height={meta.height} t={t} duration={dur} drawing={drawing}
          onItems={(list, sel) => {
            setItems(list);
            setPicked(sel);
            const k = list.map((n) => `${n.id}@${n.from.toFixed(3)}-${n.to.toFixed(3)}`).join();
            if (k !== itemsKey.current) { itemsKey.current = k; setDrawVersion((v) => v + 1); }   // selecting isn't an edit
          }}
          handle={(h) => (draw.current = h)} />
        {!playing && !drawing && <div className="bigplay">▶</div>}
      </main>

      <div className="controls">
        <button className="icon" onClick={togglePlay} title="Play / pause (Space)">{playing ? "❚❚" : "▶"}</button>
        <button className="icon" onClick={() => seek(t - 1 / meta.fps)} title="Back one frame (←)">‹</button>
        <button className="icon" onClick={() => seek(t + 1 / meta.fps)} title="Forward one frame (→)">›</button>
        <span className="time">{fmt(t)} <em>/ {fmt(dur)}</em></span>
        <span className="sep" />
        <button className={drawing ? "primary" : ""} onClick={() => { video.current?.pause(); setDrawing(!drawing); }}
          title="Draw on the video with Excalidraw (D). Each drawing shows for 4 s from the playhead; drag its bar on the timeline to change when.">
          {drawing ? "Done drawing" : "Draw"}
        </button>
        <span className="sep" />
        <button onClick={split} title="Split the part under the playhead (S)">Split</button>
        <button onClick={remove} disabled={keep.length < 2} title="Cut out the selected part (Delete)">Cut part</button>
        <button onClick={trimBefore} title="Cut everything before the playhead (I)">Trim start</button>
        <button onClick={trimAfter} title="Cut everything after the playhead (O)">Trim end</button>
        <button onClick={undo} disabled={!past.current.length} title="Undo (Ctrl+Z)">Undo</button>
        <button onClick={redo} disabled={!future.current.length} title="Redo (Ctrl+Y)">Redo</button>
        {edited && <button onClick={reset} title="Back to the whole recording">Reset</button>}
        <span className="sep" />
        <select className="speed" value={sel !== null ? String(keep[sel]?.v ?? 1) : ""} onChange={(e) => setSpeed(Number(e.target.value))} title="Speed of the selected part">
          {sel === null && <option value="">Speed…</option>}
          {[0.5, 1, 1.5, 2, 4, 8].map((v) => <option key={v} value={v}>{v}×</option>)}
        </select>
        {meta.hasAudio && <button onClick={cutSilences} title="Cut every quiet stretch longer than about a second">Cut silences</button>}
        {meta.hasAudio && <button className={captionsOpen ? "on" : ""} onClick={() => (captionsOpen ? setCaptionsOpen(false) : makeCaptions())} title="Captions from the speech; edit them, cut lines out, burn them in">Captions</button>}
        {meta.cursor && (
          <span className="fx" title="Effects from the recorded mouse and keys, applied when you copy or save">
            <label><input type="checkbox" checked={fx.zoom} onChange={(e) => setFx({ ...fx, zoom: e.target.checked })} />Zoom on clicks</label>
            <label><input type="checkbox" checked={fx.clicks} onChange={(e) => setFx({ ...fx, clicks: e.target.checked })} />Click rings</label>
            {(meta.cursor.keys?.length ?? 0) > 0 && <label><input type="checkbox" checked={fx.keys} onChange={(e) => setFx({ ...fx, keys: e.target.checked })} />Keys</label>}
          </span>
        )}
        <span className="grow" />
        <span className="kept">{edited ? <>Keeps <b>{fmt(total(keep))}</b> of {fmt(dur)} · {keep.length} part{keep.length > 1 ? "s" : ""}</> : "Whole recording"}</span>
        <span className="sep" />
        <button className="icon" onClick={() => zoom(1 / 1.5)} title="Zoom out (−, Ctrl+wheel)">−</button>
        <button className="icon" onClick={() => setFit(true)} title="Fit (0)">⤢</button>
        <button className="icon" onClick={() => zoom(1.5)} title="Zoom in (+, Ctrl+wheel)">+</button>
      </div>

      <div className="timeline" ref={scroller} onWheel={onWheel}>
        <div className="track" ref={track} style={{ width, height: 104 + rows.length * 22 }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <div className="ruler">
            {ticks.map((x) => <span key={x} style={{ left: x * pps }}>{fmt(x, tick < 1)}</span>)}
          </div>
          <div className="strip">
            {Array.from({ length: thumbCount }, (_, i) => (
              <div key={i} className="thumb" style={{ left: i * tw * pps, width: tw * pps + 0.5 }}
                ref={(el) => { const c = thumbs[i]; if (el && c && el.firstChild !== c) el.replaceChildren(c); }} />
            ))}
            {gaps.map((g, i) => <div key={`g${i}`} className="gap" style={{ left: g.s * pps, width: (g.e - g.s) * pps }} />)}
            {keep.map((g, i) => (
              <div key={`k${i}`} className={"seg" + (sel === i ? " sel" : "")} style={{ left: g.s * pps, width: (g.e - g.s) * pps }}>
                {(g.v ?? 1) !== 1 && <span className="speedtag">{g.v}×</span>}
                <div className="edge l" data-edge="s" data-i={i} title="Drag to trim" />
                <div className="edge r" data-edge="e" data-i={i} title="Drag to trim" />
              </div>
            ))}
          </div>
          {lanes.map((n) => (
            <div key={n.id} className={"note" + (picked.includes(n.id) ? " sel" : "")} data-note={n.id}
              style={{ left: n.from * pps, width: Math.max(6, (n.to - n.from) * pps), top: 104 + n.row * 22 }}
              title={`${n.label}: ${fmt(n.from)} – ${fmt(n.to)}. Drag to move, drag an end to change when it shows.`}>
              <div className="nedge l" data-note={n.id} data-side="s" />
              <span data-note={n.id}>{n.label}</span>
              <div className="nedge r" data-note={n.id} data-side="e" />
            </div>
          ))}
          <div className="playhead" style={{ left: t * pps }}><i /></div>
        </div>
      </div>

      {captionsOpen && cues && (
        <aside className="captions">
          <header>
            <b>Captions</b>
            <label><input type="checkbox" checked={burn} onChange={(e) => setBurn(e.target.checked)} />Burn into the video</label>
            <button onClick={cutFillers} title="Cut lines that are only “um”, “uh”…">Cut fillers</button>
            <button onClick={() => setCaptionsOpen(false)} title="Close">×</button>
          </header>
          <div className="cues">
            {cues.length === 0 && <p>No speech found.</p>}
            {cues.map((c, i) => (
              <div key={i} className={"cue" + (t >= c.start && t < c.end ? " now" : "") + (keep.some((g) => g.s < c.end && g.e > c.start) ? "" : " cut")}>
                <button className="at" onClick={() => seek(c.start)}>{fmt(c.start, false)}</button>
                <input value={c.text} onChange={(e) => setCues(cues.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} onBlur={() => saveCues(cues)} />
                <button title="Cut this stretch out of the video" onClick={() => commit(without(keepRef.current, [[c.start, c.end]]))}>✂</button>
              </div>
            ))}
          </div>
          <footer className="hint">Saved as {meta.name}.srt next to the video. Edit a line to fix it; ✂ cuts that part of the video.</footer>
        </aside>
      )}

      <footer>
        {busy ? (
          <>
            <span>{busy.label}… {Math.round(busy.value * 100)}%</span>
            <div className="bar"><div style={{ width: `${busy.value * 100}%` }} /></div>
            <button onClick={() => post({ type: "cancel" })}>Cancel</button>
          </>
        ) : (
          <span className={note ? "note" : "hint"}>
            {note || (drawing ? "Drawing: Excalidraw's tools and keys · new drawings show for 4 s from the playhead · scrub to place them · Done drawing to get the video keys back" : null) || "Space play · ← → frame (Shift = 1 s) · S split · Delete cut part · I / O trim start / end · drag a part's edge to trim · D draw · Ctrl+wheel zoom"}
          </span>
        )}
      </footer>
    </div>
  );
}
