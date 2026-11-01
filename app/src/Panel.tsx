// The editor's side panel: Beautify, Share, AI and Info. One open at a time; closed by default so the editor stays
// a plain drawing surface.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BACKGROUNDS, SIZES, type Beauty } from "./beautify";
import { send } from "./bridge";

export type PanelName = "beautify" | "share" | "ai" | "info";
export type Region = { x: number; y: number; width: number; height: number };

export type EditorOps = {
  render: () => Promise<string>;            // the drawing as a PNG data URL (beautify applied when on)
  baseDataURL: () => string | null;         // the picture underneath, without drawings
  selectedRegion: () => Region | null;      // selected box, in picture pixels
  replaceBase: (dataURL: string, dropBox?: boolean) => void;   // swap the picture (undoable), optionally removing the marking box
  toast: (t: string) => void;
  setBusy: (t: string) => void;
  name: string;
  size: { width: number; height: number } | null;
};

const TARGET_LABEL: Record<string, string> = { onedrive: "OneDrive", immich: "Immich", mega: "MEGA", s3: "S3", obsidian: "Obsidian" };

export function Panel({ which, ops, beauty, setBeauty, onClose }: { which: PanelName; ops: EditorOps; beauty: Beauty; setBeauty: (b: Beauty) => void; onClose: () => void }) {
  return (
    <aside className="panel">
      <header><b>{{ beautify: "Beautify", share: "Share", ai: "AI", info: "Info" }[which]}</b><button className="x" onClick={onClose} title="Close">×</button></header>
      {which === "beautify" && <BeautifyPanel beauty={beauty} setBeauty={setBeauty} ops={ops} />}
      {which === "share" && <SharePanel ops={ops} />}
      {which === "ai" && <AiPanel ops={ops} />}
      {which === "info" && <InfoPanel ops={ops} />}
    </aside>
  );
}

function BeautifyPanel({ beauty: b, setBeauty, ops }: { beauty: Beauty; setBeauty: (b: Beauty) => void; ops: EditorOps }) {
  const set = (p: Partial<Beauty>) => setBeauty({ ...b, ...p, on: true });
  // The look only applies to copies and saves, so show what they'll be (debounced; sliders fire fast).
  const [preview, setPreview] = useState("");
  useEffect(() => {
    if (!b.on) { setPreview(""); return; }
    let live = true;
    const t = setTimeout(() => void ops.render().then((u) => { if (live) setPreview(u); }), 200);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b]);
  return (
    <div className="pbody">
      <label className="line"><input type="checkbox" checked={b.on} onChange={(e) => setBeauty({ ...b, on: e.target.checked })} /> Apply to copies and saves</label>
      {preview ? <img className="bpreview" src={preview} alt="How copies will look" /> : <p className="hint">Pick a background to turn it on and see a preview.</p>}
      <h4>Background</h4>
      <div className="swatches">
        {Object.entries(BACKGROUNDS).map(([n, [a, z]]) => (
          <button key={n} title={n} className={b.background === n ? "on" : ""} style={{ background: `linear-gradient(135deg, ${a}, ${z})` }} onClick={() => set({ background: n })} />
        ))}
        <button title="White" className={b.background === "#ffffff" ? "on" : ""} style={{ background: "#fff" }} onClick={() => set({ background: "#ffffff" })} />
        <button title="Transparent" className={`checker${b.background === "transparent" ? " on" : ""}`} onClick={() => set({ background: "transparent" })} />
        <input type="color" title="Any colour" value={b.background.startsWith("#") ? b.background : "#222222"} onChange={(e) => set({ background: e.target.value })} />
      </div>
      <h4>Size</h4>
      <select value={b.size ? b.size.join("x") : ""} onChange={(e) => set({ size: (SIZES.find(([, s]) => (s ? s.join("x") : "") === e.target.value)?.[1]) ?? null })}>
        {SIZES.map(([n, s]) => <option key={n} value={s ? s.join("x") : ""}>{n}</option>)}
      </select>
      <h4>Padding</h4>
      <input type="range" min={0} max={0.25} step={0.01} value={b.padding} onChange={(e) => set({ padding: Number(e.target.value) })} />
      <h4>Corners</h4>
      <input type="range" min={0} max={60} step={1} value={b.radius} onChange={(e) => set({ radius: Number(e.target.value) })} />
      <h4>Shadow</h4>
      <input type="range" min={0} max={1} step={0.05} value={b.shadow} onChange={(e) => set({ shadow: Number(e.target.value) })} />
      <p className="hint">Copy, Save and Share use this look while it's on.</p>
    </div>
  );
}

function SharePanel({ ops }: { ops: EditorOps }) {
  const [targets, setTargets] = useState<string[] | null>(null);
  const [result, setResult] = useState("");
  useEffect(() => { void invoke<string[]>("share_targets").then(setTargets); }, []);
  const go = async (target: string) => {
    ops.setBusy("Uploading…"); setResult("");
    try {
      const path = await send<string>({ type: "exportFile", name: ops.name, dataURL: await ops.render() });
      const link = await invoke<string>("share_file", { path, target });
      setResult(link.startsWith("http") ? `Link copied: ${link}` : link);
    } catch (e) { setResult(String(e)); }
    ops.setBusy("");
  };
  return (
    <div className="pbody">
      {targets === null ? null : targets.length === 0 ? (
        <p className="hint">No places set up yet. Add OneDrive, Immich, MEGA or your Obsidian vault in Settings → Sharing.</p>
      ) : targets.map((t) => <button key={t} className="wide" onClick={() => go(t)}>{t === "obsidian" ? "Send to Obsidian" : `Upload to ${TARGET_LABEL[t]} and copy link`}</button>)}
      <button className="wide subtle" onClick={() => void invoke("open_settings_at", { section: "Sharing" })}>Set up sharing…</button>
      {result && <p className="result">{result}</p>}
    </div>
  );
}

function AiPanel({ ops }: { ops: EditorOps }) {
  const [prompt, setPrompt] = useState("");
  const [text, setText] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const run = async (op: object, label: string) => {
    const src = ops.baseDataURL();
    if (!src) return;
    ops.setBusy(label);
    try { ops.replaceBase(await invoke<string>("ai_edit", { dataUrl: src, op }), "region" in op); ops.toast("Done. Ctrl+Z undoes it."); }
    catch (e) { ops.toast(String(e)); }
    ops.setBusy("");
  };
  const needRegion = (f: (r: Region) => void) => {
    const r = ops.selectedRegion();
    if (!r) { ops.toast("Draw a box round the part to change, keep it selected, then press the button."); return; }
    f(r);
  };
  const ask = async () => {
    if (!question.trim()) return;
    ops.setBusy("Asking…");
    try { setAnswer(await invoke<string>("ai_ask", { dataUrl: await ops.render(), question })); } catch (e) { setAnswer(String(e)); }
    ops.setBusy("");
  };
  return (
    <div className="pbody">
      <button className="wide" onClick={() => run({ op: "removeBackground" }, "Removing the background…")}>Remove background</button>
      <button className="wide" onClick={() => needRegion((region) => run({ op: "removeObject", region }, "Removing…"))}>Remove what's in the box</button>
      <h4>Change what's in the box</h4>
      <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. make the button green" />
      <button className="wide" disabled={!prompt.trim()} onClick={() => needRegion((region) => run({ op: "editObject", region, prompt }, "Changing…"))}>Change</button>
      <h4>Change the text in the box</h4>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="New text" />
      <button className="wide" disabled={!text.trim()} onClick={() => needRegion((region) => run({ op: "editText", region, text }, "Rewriting the text…"))}>Replace text</button>
      <h4>Edit the whole picture</h4>
      <button className="wide" disabled={!prompt.trim()} onClick={() => run({ op: "edit", prompt }, "Editing…")} title="Uses the description above">Apply description to everything</button>
      <button className="wide" onClick={async () => {
        ops.setBusy("Describing…");
        try {
          const d = await invoke<{ summary: string; tags: string[] }>("ai_describe", { dataUrl: await ops.render() });
          const t = d.tags.length ? `${d.summary}

Tags: ${d.tags.join(", ")}` : d.summary;
          setAnswer(t);
          await invoke("copy_text", { text: t });
          ops.toast("Description copied");
        } catch (e) { setAnswer(String(e)); }
        ops.setBusy("");
      }}>Describe &amp; tag (copies it)</button>
      <h4>Ask about this picture</h4>
      <textarea value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="What's wrong in this error? Turn this table into CSV…" rows={3} />
      <button className="wide" disabled={!question.trim()} onClick={ask}>Ask</button>
      {answer && <div className="answer"><pre>{answer}</pre><button onClick={() => void invoke("copy_text", { text: answer })}>Copy answer</button></div>}
      <p className="hint">Uses your own key (Settings → AI). Pictures only leave this computer when you press a button here.</p>
    </div>
  );
}

function InfoPanel({ ops }: { ops: EditorOps }) {
  const [s, setS] = useState<Record<string, any> | null>(null);
  const [mark, setMark] = useState("");
  useEffect(() => { void invoke<Record<string, any>>("get_settings").then(setS); }, []);
  if (!s) return null;
  const m = s.metadata;
  const save = (next: Record<string, any>) => { setS(next); void invoke("set_settings", { settings: next }); };
  const check = async () => {
    const src = ops.baseDataURL();
    if (!src) return;
    setMark("Reading…");
    const r = await send<{ found: boolean; yours?: boolean; id?: number; capture?: { path: string; time: string } }>({ type: "checkMark", dataURL: src });
    setMark(!r?.found ? "No Grabbit watermark in this picture." : r.yours ? `Your capture${r.capture ? ` from ${new Date(r.capture.time).toLocaleString()}` : ""} (id ${r.id}).` : `Someone else's Grabbit watermark (id ${r.id}).`);
  };
  return (
    <div className="pbody">
      {ops.size && <p className="kv"><span>Size</span><b>{ops.size.width} × {ops.size.height} px</b></p>}
      <h4>Metadata on copies and saves</h4>
      <label className="line"><input type="checkbox" checked={m.strip} onChange={(e) => save({ ...s, metadata: { ...m, strip: e.target.checked } })} /> Strip everything else</label>
      <input value={m.author} placeholder="Author" onChange={(e) => save({ ...s, metadata: { ...m, author: e.target.value } })} />
      <input value={m.copyright} placeholder="Copyright" onChange={(e) => save({ ...s, metadata: { ...m, copyright: e.target.value } })} />
      <p className="hint">Custom fields: Settings → Metadata.</p>
      <h4>Protection</h4>
      <label className="line"><input type="checkbox" checked={s.branding.invisible_mark} onChange={(e) => save({ ...s, branding: { ...s.branding, invisible_mark: e.target.checked } })} /> Invisible watermark</label>
      <label className="line"><input type="checkbox" checked={s.branding.on_images} onChange={(e) => save({ ...s, branding: { ...s.branding, on_images: e.target.checked } })} disabled={!s.branding.logo_path} /> Logo overlay {s.branding.logo_path ? "" : "(pick one in Settings → Branding)"}</label>
      <button className="wide" onClick={check}>Check this picture for a watermark</button>
      {mark && <p className="result">{mark}</p>}
    </div>
  );
}
