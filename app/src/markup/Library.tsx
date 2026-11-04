// The editor's library: captures and recordings by day, in folders you make. It docks on any side of the window,
// its edge drags to resize it (the pictures grow with it), and it shows a list, small pictures or big pictures.
// Folders only group what's listed here; files stay where they are.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { corsUrl, thumbUrl } from "../bridge";
import { Icon, type IconName } from "../icons";
import type { RecentItem } from "../host";
import "./library.css";

export type Dock = "left" | "right" | "top" | "bottom";
type View = "list" | "small" | "large";
type Sort = "new" | "old" | "name" | "size";
type Kind = "all" | "image" | "video";
type Prefs = { width: number; height: number; view: View; sort: Sort; kind: Kind; source: "captures" | "copied"; hidden: boolean };
type Folder = { name: string; paths: string[] };

const DEFAULTS: Prefs = { width: 230, height: 180, view: "small", sort: "new", kind: "all", source: "captures", hidden: false };
const read = <T,>(key: string, d: T): T => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : d; } catch { return d; } };
const write = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ } };

const dayKey = (t: string) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
function dayLabel(key: string) {
  const d = new Date(`${key}T12:00:00`), today = dayKey(new Date().toISOString());
  const y = new Date(); y.setDate(y.getDate() - 1);
  const long = d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return key === today ? `Today · ${long}` : key === dayKey(y.toISOString()) ? `Yesterday · ${long}` : long;
}
const when = (t: string) => new Date(t).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
const kb = (b?: number) => (b == null ? "" : b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const isVideo = (r: RecentItem) => r.kind === "video";

/** A recording's first frame, loaded only once it scrolls into view. */
function VideoThumb({ path }: { path: string }) {
  const el = useRef<HTMLVideoElement>(null);
  const [src, setSrc] = useState("");
  useEffect(() => {
    const v = el.current;
    if (!v) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setSrc(`${corsUrl(path)}#t=0.5`); io.disconnect(); } });
    io.observe(v);
    return () => io.disconnect();
  }, [path]);
  return <video ref={el} src={src || undefined} preload="metadata" muted playsInline />;
}

type Props = {
  items: RecentItem[];
  dock: Dock;
  setDock: (d: Dock) => void;
  hasPicture: boolean;
  onInsert: (r: RecentItem) => void;
  onOpen: (r: RecentItem) => void;
};

export function Library({ items, dock, setDock, hasPicture, onInsert, onOpen }: Props) {
  const [prefs, setPrefsState] = useState<Prefs>(() => ({ ...DEFAULTS, ...read<Partial<Prefs>>("library", {}) }));
  const setPrefs = (p: Partial<Prefs>) => setPrefsState((o) => { const n = { ...o, ...p }; write("library", n); return n; });
  const [folders, setFoldersState] = useState<Folder[]>(() => read<Folder[]>("libraryFolders", []));
  const setFolders = (f: Folder[]) => { setFoldersState(f); write("libraryFolders", f); };
  const [folder, setFolder] = useState("");
  const [day, setDay] = useState("");
  const [menu, setMenu] = useState<"" | "dock" | `folder:${string}`>("");
  const [dropOn, setDropOn] = useState("");
  const [preview, setPreview] = useState<{ r: RecentItem; rect: DOMRect } | null>(null);
  const hoverTimer = useRef(0);
  const root = useRef<HTMLElement>(null);
  const horiz = dock === "top" || dock === "bottom";

  // Menus close on a click anywhere else.
  useEffect(() => {
    if (!menu) return;
    const off = (e: PointerEvent) => { if (!(e.target as Element).closest?.(".lib-menu, [data-menu]")) setMenu(""); };
    addEventListener("pointerdown", off, true);
    return () => removeEventListener("pointerdown", off, true);
  }, [menu]);

  const shown = useMemo(() => {
    const inFolder = folder ? new Set(folders.find((f) => f.name === folder)?.paths ?? []) : null;
    const v = items.filter((r) =>
      (prefs.source === "copied" ? r.kind === "copied" : r.kind !== "copied") &&
      (prefs.kind === "all" || (prefs.kind === "video") === isVideo(r)) &&
      (!inFolder || inFolder.has(r.path)) &&
      (!day || dayKey(r.time) === day));
    const by: Record<Sort, (a: RecentItem, b: RecentItem) => number> = {
      new: (a, b) => b.time.localeCompare(a.time), old: (a, b) => a.time.localeCompare(b.time),
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }), size: (a, b) => (b.bytes ?? 0) - (a.bytes ?? 0),
    };
    return v.sort(by[prefs.sort]);
  }, [items, prefs, folder, folders, day]);

  // Grouped by day when sorted by date.
  const groups = useMemo(() => {
    if (prefs.sort !== "new" && prefs.sort !== "old") return [{ key: "", items: shown }];
    const out: { key: string; items: RecentItem[] }[] = [];
    for (const r of shown) { const k = dayKey(r.time); if (out.at(-1)?.key !== k) out.push({ key: k, items: [] }); out.at(-1)!.items.push(r); }
    return out;
  }, [shown, prefs.sort]);

  // ---------- folders ----------

  const toggleIn = (name: string, path: string) =>
    setFolders(folders.map((f) => (f.name !== name ? f : { ...f, paths: f.paths.includes(path) ? f.paths.filter((p) => p !== path) : [...f.paths, path] })));
  function newFolder(withPath?: string) {
    const name = prompt("Name the new folder:")?.trim();
    if (!name) return;
    if (folders.some((f) => f.name === name)) { if (withPath) toggleIn(name, withPath); return; }
    setFolders([...folders, { name, paths: withPath ? [withPath] : [] }]);
  }
  function renameFolder(name: string) {
    const next = prompt("Rename the folder:", name)?.trim();
    if (!next || next === name || folders.some((f) => f.name === next)) return;
    setFolders(folders.map((f) => (f.name === name ? { ...f, name: next } : f)));
    if (folder === name) setFolder(next);
  }
  function deleteFolder(name: string) {
    if (!confirm(`Remove the folder "${name}"? The pictures in it stay where they are.`)) return;
    setFolders(folders.filter((f) => f.name !== name));
    if (folder === name) setFolder("");
  }
  const dropProps = (name: string) => ({
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes("text/x-grabbit-path")) { e.preventDefault(); setDropOn(name); } },
    onDragLeave: () => setDropOn((d) => (d === name ? "" : d)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault(); setDropOn("");
      const p = e.dataTransfer.getData("text/x-grabbit-path");
      if (!p) return;
      if (name === "+") newFolder(p);
      else if (name && !folders.find((f) => f.name === name)?.paths.includes(p)) toggleIn(name, p);
    },
  });

  // ---------- resizing by the inner edge ----------

  function startResize(e: React.PointerEvent) {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX, y0 = e.clientY, s0 = horiz ? prefs.height : prefs.width;
    const [min, max] = horiz ? [96, Math.round(innerHeight * 0.6)] : [130, Math.round(innerWidth * 0.6)];
    const move = (ev: PointerEvent) => {
      const d = { left: ev.clientX - x0, right: x0 - ev.clientX, top: ev.clientY - y0, bottom: y0 - ev.clientY }[dock];
      const v = Math.max(min, Math.min(max, s0 + d));
      setPrefsState((o) => (horiz ? { ...o, height: v } : { ...o, width: v }));
    };
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); setPrefsState((o) => { write("library", o); return o; }); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  }

  // ---------- hover preview, placed beside the library whichever side it's on ----------

  const previewStyle = (rect: DOMRect): CSSProperties => {
    const lib = root.current!.getBoundingClientRect(), w = Math.min(560, innerWidth * 0.5);
    if (dock === "left") return { left: lib.right + 8, top: Math.max(8, Math.min(rect.top - 40, innerHeight - 500)), width: w };
    if (dock === "right") return { left: lib.left - 8 - w, top: Math.max(8, Math.min(rect.top - 40, innerHeight - 500)), width: w };
    const left = Math.max(8, Math.min(rect.left, innerWidth - w - 8));
    return dock === "top" ? { left, top: lib.bottom + 8, width: w } : { left, bottom: innerHeight - lib.top + 8, width: w };
  };

  if (prefs.hidden) {
    return (
      <aside className={`lib lib-${dock} lib-hidden`}>
        <button className="lib-show" onClick={() => setPrefs({ hidden: false })} title="Show your captures and recordings"><Icon name="panelOpen" /><span>Captures</span></button>
      </aside>
    );
  }

  const seg = <T extends string>(value: T, set: (v: T) => void, opts: [T, IconName, string][]) => (
    <div className="lib-seg">
      {opts.map(([v, ic, tip]) => <button key={v} className={value === v ? "on" : ""} onClick={() => set(v)} title={tip} aria-label={tip}><Icon name={ic} /></button>)}
    </div>
  );

  const item = (r: RecentItem) => {
    const vid = isVideo(r), tip = `${r.name}\n${when(r.time)}${r.bytes ? ` · ${kb(r.bytes)}` : ""}${vid ? "\nA recording: click to open it in the video editor." : hasPicture ? "\nClick to add it on top of the picture you're editing." : "\nClick to open it."}`;
    const inFolders = folders.filter((f) => f.paths.includes(r.path)).map((f) => f.name);
    return (
      <div key={r.path} className={`lib-item${vid ? " video" : ""}`} draggable
        onDragStart={(e) => { e.dataTransfer.setData("text/x-grabbit-path", r.path); e.dataTransfer.effectAllowed = "copy"; setPreview(null); }}
        onMouseEnter={(e) => { const rect = e.currentTarget.getBoundingClientRect(); window.clearTimeout(hoverTimer.current); hoverTimer.current = window.setTimeout(() => setPreview({ r, rect }), 500); }}
        onMouseLeave={() => { window.clearTimeout(hoverTimer.current); setPreview(null); }}>
        <div className="lib-pic" onClick={() => (vid || !hasPicture ? onOpen(r) : onInsert(r))} title={tip}>
          {vid ? <VideoThumb path={r.path} /> : <img src={thumbUrl(r.path)} loading="lazy" decoding="async" alt="" draggable={false} />}
          {vid && <span className="lib-badge" aria-label="video"><Icon name="film" /></span>}
          <span className="lib-time">{new Date(r.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
        </div>
        <div className="lib-meta">
          {view === "list" && <div className="lib-text"><b>{r.name}</b><span>{when(r.time)}{r.bytes ? ` · ${kb(r.bytes)}` : ""}{inFolders.length ? ` · ${inFolders.join(", ")}` : ""}</span></div>}
          <div className="lib-acts">
            {vid ? <button onClick={() => onOpen(r)} title="Open the recording in the video editor (trim, captions, zoom, export)">Open</button> : <>
              <button onClick={() => onInsert(r)} title="Add it on top of the picture you're editing, to combine pictures">Insert</button>
              <button onClick={() => onOpen(r)} title="Open it on its own, in a new tab">Open</button>
            </>}
            <span className="menuwrap">
              <button className={`lib-fbtn${inFolders.length ? " on" : ""}`} data-menu onClick={() => setMenu(menu === `folder:${r.path}` ? "" : `folder:${r.path}`)} title={inFolders.length ? `In: ${inFolders.join(", ")}. Click to change.` : "Put it in a folder"} aria-label="Folders"><Icon name="folderInput" /></button>
              {menu === `folder:${r.path}` && (
                <div className="lib-menu">
                  {folders.map((f) => <button key={f.name} onClick={() => toggleIn(f.name, r.path)}>{f.paths.includes(r.path) ? "✓ " : ""}{f.name}</button>)}
                  <button onClick={() => { setMenu(""); newFolder(r.path); }}><Icon name="folderPlus" />New folder…</button>
                </div>
              )}
            </span>
          </div>
        </div>
      </div>
    );
  };

  const sizeStyle = horiz ? { height: prefs.height, ["--h" as string]: `${prefs.height}px` } : { width: prefs.width };
  const view = horiz && prefs.view === "list" ? "small" : prefs.view;   // a row of pictures has no room for a list
  const thumbMin = { list: 0, small: 78, large: 150 }[prefs.view];

  return (
    <aside ref={root} className={`lib lib-${dock} view-${view}`} style={sizeStyle}>
      <div className="lib-side">
      <div className="lib-head">
        <div className="tabs">
          <button className={prefs.source === "captures" ? "on" : ""} onClick={() => setPrefs({ source: "captures" })} title="Pictures and recordings you've saved">Captures</button>
          <button className={prefs.source === "copied" ? "on" : ""} onClick={() => setPrefs({ source: "copied" })} title="Pictures you've copied (kept until the temp folder is cleared)">Copied</button>
        </div>
        <span className="menuwrap">
          <button className="lib-icon" data-menu onClick={() => setMenu(menu === "dock" ? "" : "dock")} title="Move or hide this panel" aria-label="Move or hide this panel"><Icon name="panelLeft" /></button>
          {menu === "dock" && (
            <div className="lib-menu end">
              {(["left", "right", "top", "bottom"] as Dock[]).map((d) => <button key={d} onClick={() => { setDock(d); setMenu(""); }}>{d === dock ? "✓ " : ""}Captures on the {d}</button>)}
              <button onClick={() => { setPrefs({ hidden: true }); setMenu(""); }}><Icon name="panelClose" />Hide the captures</button>
            </div>
          )}
        </span>
      </div>
      <div className="lib-tools">
        {seg(prefs.kind, (kind) => setPrefs({ kind }), [["all", "images", "Pictures and recordings"], ["image", "image", "Pictures only"], ["video", "film", "Recordings only"]])}
        {seg(prefs.view, (view) => setPrefs({ view }), [["list", "list", "List with names, dates and sizes"], ["small", "gridSmall", "Small pictures"], ["large", "gridLarge", "Big pictures"]])}
        <select value={prefs.sort} onChange={(e) => setPrefs({ sort: e.target.value as Sort })} title="Sort by">
          <option value="new">Newest first</option><option value="old">Oldest first</option><option value="name">Name</option><option value="size">Biggest first</option>
        </select>
        <label className={`lib-day${day ? " on" : ""}`} title={day ? `Showing ${dayLabel(day)} only. Pick another day, or × to show every day.` : "Show one day only: pick it on the calendar"}>
          <Icon name="calendar" />
          <input type="date" value={day} max={dayKey(new Date().toISOString())} onChange={(e) => setDay(e.target.value)} aria-label="Show one day" />
          {day && <button onClick={(e) => { e.preventDefault(); setDay(""); }} aria-label="Show every day">×</button>}
        </label>
      </div>
      <div className="lib-folders">
        <button className={`chip${!folder ? " on" : ""}`} onClick={() => setFolder("")} title="Everything, in or out of folders">All</button>
        {folders.map((f) => (
          <button key={f.name} className={`chip${folder === f.name ? " on" : ""}${dropOn === f.name ? " drop" : ""}`} {...dropProps(f.name)}
            onClick={() => setFolder(folder === f.name ? "" : f.name)} onDoubleClick={() => renameFolder(f.name)}
            title={`${f.name}: ${f.paths.length} item${f.paths.length === 1 ? "" : "s"}. Drag pictures here to add them. Double-click to rename.`}>
            <Icon name="folder" />{f.name}<em>{f.paths.length}</em>
          </button>
        ))}
        <button className={`chip add${dropOn === "+" ? " drop" : ""}`} {...dropProps("+")} onClick={() => newFolder()} title="New folder (or drop a picture here to start one with it)" aria-label="New folder"><Icon name="folderPlus" /></button>
        {folder && <button className="chip x" onClick={() => deleteFolder(folder)} title={`Remove the folder "${folder}" (the pictures stay)`}>×</button>}
      </div>
      </div>
      <div className="lib-items" style={{ ["--thumb" as string]: `${thumbMin}px` }}>
        {shown.length === 0 && <div className="empty">{day ? "Nothing on that day" : folder ? "This folder is empty. Drag pictures onto its name above." : "Nothing yet"}</div>}
        {groups.map((g) => (
          <section key={g.key || "all"} className="lib-group">
            {g.key && <h4 title={dayLabel(g.key)}>{horiz ? new Date(`${g.key}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) : dayLabel(g.key)}</h4>}
            <div className="lib-grid">{g.items.map(item)}</div>
          </section>
        ))}
      </div>
      <div className="lib-resize" onPointerDown={startResize} title="Drag to resize" />
      {preview && (
        <div className="preview" style={previewStyle(preview.rect)} aria-hidden>
          {isVideo(preview.r) ? <video src={corsUrl(preview.r.path)} autoPlay muted loop /> : <img src={preview.r.url} alt="" />}
          <div className="info"><strong>{preview.r.name}</strong><span>{when(preview.r.time)}{preview.r.bytes ? ` · ${kb(preview.r.bytes)}` : ""}</span>
            <em>{isVideo(preview.r) ? "Open edits it in the video editor" : "Insert adds it on top · New tab opens it on its own"}</em></div>
        </div>
      )}
    </aside>
  );
}
