// Settings: one page per area, everything saved as you change it. Also hosts History (search old captures by the
// words in them) and Check image (read Grabbit's invisible watermark from a found copy).

import { invoke } from "@tauri-apps/api/core";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import "../ui/base";
import { getTheme, setTheme, type Theme } from "../ui/theme";
import "./settings.css";
import { fileUrl, os, send } from "../bridge";

type S = Record<string, any>;
let s: S = {};
const nav = document.getElementById("nav")!;
const page = document.getElementById("page")!;
const MOD = os === "macos" ? "Cmd" : "Ctrl";

type Field =
  | { kind: "toggle"; key: string; label: string; help?: string }
  | { kind: "select"; key: string; label: string; options: [string, string][]; help?: string }
  | { kind: "text"; key: string; label: string; placeholder?: string; secret?: boolean; help?: string }
  | { kind: "number"; key: string; label: string; min: number; max: number; step?: number; unit?: string; help?: string }
  | { kind: "folder"; key: string; label: string }
  | { kind: "file"; key: string; label: string; ext: string[] }
  | { kind: "hotkey"; key: string; label: string }
  | { kind: "note"; html: string }
  | { kind: "button"; label: string; run: (b: HTMLButtonElement) => void | Promise<void> }
  | { kind: "custom"; render: () => HTMLElement };

const get = (k: string): any => k.split(".").reduce((o: any, p) => o?.[p], s);
function set(k: string, v: unknown) {
  const parts = k.split(".");
  let o = s;
  for (const p of parts.slice(0, -1)) o = o[p];
  o[parts.at(-1)!] = v;
  void save();
}
let saving: number | undefined;
async function save() {
  clearTimeout(saving);
  saving = window.setTimeout(async () => {
    try { await invoke("set_settings", { settings: s }); toast("Saved"); } catch (e) { toast(`Couldn't save: ${e}`); }
  }, 250);
}
function toast(t: string) {
  const el = document.getElementById("toast")!;
  el.textContent = t; el.classList.add("on");
  clearTimeout(Number(el.dataset.t));
  el.dataset.t = String(window.setTimeout(() => el.classList.remove("on"), 1400));
}

const h = (tag: string, attrs: Record<string, any> = {}, ...kids: (Node | string)[]) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (k.startsWith("on")) (e as any)[k] = v; else if (v !== undefined) e.setAttribute(k, String(v));
  e.append(...kids);
  return e;
};

/** A key combination recorder: click, press the keys. */
function hotkeyInput(key: string) {
  const b = h("button", { class: "btn hotkey" }, get(key) || "None") as HTMLButtonElement;
  b.onclick = () => {
    b.textContent = "Press keys…";
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      removeEventListener("keydown", onKey, true);
      if (e.key === "Escape") { b.textContent = get(key) || "None"; return; }
      if (e.key === "Backspace" || e.key === "Delete") { set(key, ""); b.textContent = "None"; return; }
      const mods = [e.ctrlKey && "Control", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && (os === "macos" ? "Command" : "Super")].filter(Boolean);
      const name = e.code === "PrintScreen" ? "PrintScreen" : e.code.replace(/^Key/, "").replace(/^Digit/, "");
      const combo = [...mods, name].join("+");
      set(key, combo);
      b.textContent = combo;
    };
    addEventListener("keydown", onKey, true);
  };
  return b;
}

function field(f: Field): HTMLElement {
  if (f.kind === "note") { const n = h("p", { class: "note" }); n.innerHTML = f.html; return n; }
  if (f.kind === "button") { const b = h("button", { class: "btn", title: f.label }, f.label) as HTMLButtonElement; b.onclick = () => void f.run(b); return h("div", { class: "row" }, h("span"), b); }
  if (f.kind === "custom") return f.render();
  let input: HTMLElement;
  switch (f.kind) {
    case "toggle": {
      const c = h("input", { type: "checkbox", class: "switch" }) as HTMLInputElement;
      c.checked = !!get(f.key);
      c.onchange = () => set(f.key, c.checked);
      input = c; break;
    }
    case "select": {
      const sel = h("select", { class: "btn" }) as HTMLSelectElement;
      for (const [v, l] of f.options) sel.add(new Option(l, v, false, String(get(f.key)) === v));
      sel.onchange = () => set(f.key, typeof get(f.key) === "number" ? Number(sel.value) : sel.value);
      input = sel; break;
    }
    case "text": {
      const t = h("input", { type: f.secret ? "password" : "text", class: "text", placeholder: f.placeholder ?? "", spellcheck: "false" }) as HTMLInputElement;
      t.value = get(f.key) ?? "";
      t.onchange = () => set(f.key, t.value.trim());
      input = t; break;
    }
    case "number": {
      const t = h("input", { type: "number", class: "text num", min: f.min, max: f.max, step: f.step ?? 1 }) as HTMLInputElement;
      t.value = String(get(f.key));
      t.onchange = () => set(f.key, Math.min(f.max, Math.max(f.min, Number(t.value))));
      input = h("span", { class: "unit" }, t, f.unit ?? ""); break;
    }
    case "folder": case "file": {
      const label = h("span", { class: "path" }, get(f.key) || "Not set");
      const b = h("button", { class: "btn" }, "Choose…") as HTMLButtonElement;
      b.onclick = async () => {
        const r = await open(f.kind === "folder" ? { directory: true, defaultPath: get(f.key) || undefined } : { filters: [{ name: "Images", extensions: (f as { ext: string[] }).ext }] });
        if (typeof r === "string") { set(f.key, r); label.textContent = r; }
      };
      input = h("span", { class: "pick" }, label, b); break;
    }
    case "hotkey": input = hotkeyInput(f.key); break;
  }
  const lab = h("label", {}, h("span", { class: "title" }, f.label));
  if ("help" in f && f.help) lab.append(h("span", { class: "help" }, f.help));
  const row = h("div", { class: "row" }, lab, input!);
  row.title = "help" in f && f.help ? `${f.label}: ${f.help}` : f.label;
  return row;
}

const SECTIONS: Record<string, () => Field[]> = {
  General: () => [
    { kind: "custom", render: themeRow },
    { kind: "toggle", key: "keep_picker_ready", label: "Keep the capture screen ready", help: "Captures open a little faster, but Grabbit holds 50–100 MB more memory per screen all the time" },
    { kind: "select", key: "after_capture", label: "After picking an area", options: [["Ask", "Show the action bar"], ["Copy", "Copy straight away"], ["Edit", "Open the editor"]] },
    { kind: "toggle", key: "auto_save", label: "Keep a copy of every capture", help: "Full size, in the Grabbit folder below" },
    { kind: "folder", key: "save_folder", label: "Grabbit folder" },
    { kind: "select", key: "save_format", label: "Saved format", options: [["WebpLossless", "WebP lossless (pixel-exact, ~40 % of PNG)"], ["Png", "PNG"]] },
    { kind: "toggle", key: "copy_as_file", label: "Copy as a file too", help: "Chat apps (Signal, Slack, Teams) then attach it with its name" },
    { kind: "number", key: "reduced_long_edge", label: "Smaller copies", min: 320, max: 8000, unit: "px long edge" },
    { kind: "number", key: "chat_max_kb", label: "Chat copies", min: 100, max: 20000, unit: "KB at most" },
    { kind: "custom", render: autostartRow },
    { kind: "custom", render: backupRow },
  ],
  Keys: () => [
    { kind: "hotkey", key: "hotkeys.Capture", label: "Capture (tap) · Record (hold)" },
    { kind: "number", key: "hold_to_record_ms", label: "Hold this long to record", min: 0, max: 5000, step: 100, unit: "ms (0 = off)" },
    { kind: "hotkey", key: "hotkeys.CaptureScreen", label: "Whole screen, no picker" },
    { kind: "hotkey", key: "hotkeys.CaptureRepeat", label: "Same area as last time" },
    { kind: "hotkey", key: "hotkeys.Record", label: "Record (start / stop)" },
    { kind: "hotkey", key: "hotkeys.ReplaySave", label: "Save the replay buffer" },
    { kind: "hotkey", key: "hotkeys.Steps", label: "Step recorder (start / stop)" },
    { kind: "note", html: `Click a key, then press the new combination. <kbd>Backspace</kbd> clears it. In the picker: <kbd>Enter</kbd> copy · <kbd>E</kbd> edit · <kbd>R</kbd> record · <kbd>T</kbd> copy text · <kbd>Q</kbd> QR · <kbd>I</kbd> pin · <kbd>C</kbd> colour · <kbd>M</kbd> measure · <kbd>A</kbd> size presets · <kbd>L</kbd> last area · <kbd>${MOD}+S</kbd> save.` },
  ],
  Recording: () => [
    { kind: "folder", key: "video_folder", label: "Recordings folder" },
    { kind: "toggle", key: "record_system_audio", label: "System sound", help: "Its own track: choose per copy what goes in" },
    { kind: "toggle", key: "record_microphone", label: "Microphone", help: "Its own track too" },
    { kind: "toggle", key: "record_cursor", label: "Mouse pointer" },
    { kind: "toggle", key: "record_webcam", label: "Webcam bubble", help: "Your camera in a circle in the bottom-right corner" },
    ...(os === "windows" ? [{ kind: "toggle", key: "hide_desktop_icons", label: "Hide desktop icons while recording" } as Field] : []),
    { kind: "select", key: "record_fps", label: "Frame rate", options: [["30", "30 fps"], ["60", "60 fps"]] },
    { kind: "number", key: "record_quality", label: "Quality", min: 14, max: 35, unit: "(lower = sharper, bigger)" },
    { kind: "toggle", key: "show_keys", label: "Record key presses", help: "Shown as captions in the video editor" },
    { kind: "toggle", key: "copy_recording", label: "Copy the video when finished" },
    { kind: "toggle", key: "edit_after_recording", label: "Open the video editor when finished" },
    { kind: "toggle", key: "replay_enabled", label: "Replay buffer", help: "Always keeps the last minute or two; the hotkey saves it" },
    { kind: "number", key: "replay_seconds", label: "Replay length", min: 10, max: 600, unit: "seconds" },
    { kind: "number", key: "timelapse_seconds", label: "Timed captures", min: 1, max: 3600, unit: "seconds apart (tray → Timed captures)" },
    { kind: "text", key: "ffmpeg_path", label: "ffmpeg", placeholder: "Found automatically", help: "Only if ffmpeg isn't on your PATH" },
  ],
  Branding: () => [
    { kind: "file", key: "branding.logo_path", label: "Logo or overlay", ext: ["png", "webp", "svg", "jpg"] },
    { kind: "toggle", key: "branding.on_images", label: "Add to pictures" },
    { kind: "toggle", key: "branding.on_videos", label: "Add to videos" },
    { kind: "select", key: "branding.position", label: "Position", options: [["bottom-right", "Bottom right"], ["bottom-left", "Bottom left"], ["top-right", "Top right"], ["top-left", "Top left"], ["center", "Centre"]] },
    { kind: "number", key: "branding.scale", label: "Size", min: 0.03, max: 0.6, step: 0.01, unit: "× picture width" },
    { kind: "number", key: "branding.opacity", label: "Opacity", min: 0.05, max: 1, step: 0.05 },
    { kind: "toggle", key: "branding.invisible_mark", label: "Invisible watermark", help: "Hides your name and the capture's id in the pixels. Survives JPEG, re-saving and cropping." },
    { kind: "text", key: "branding.owner", label: "Watermark owner", placeholder: "Your name or company" },
    { kind: "button", label: "Check an image for a watermark…", run: checkImage },
  ],
  Metadata: () => [
    { kind: "toggle", key: "metadata.strip", label: "Strip metadata", help: "No camera, location or software tags leave Grabbit" },
    { kind: "text", key: "metadata.author", label: "Author", placeholder: "Added to every file" },
    { kind: "text", key: "metadata.copyright", label: "Copyright", placeholder: "© 2026 …" },
    { kind: "custom", render: customMeta },
  ],
  Sharing: () => [
    { kind: "note", html: "Share uploads the file and copies its link. Set up the places you use; the first one set up is the default." },
    { kind: "custom", render: () => shareTarget("OneDrive", "onedrive") },
    { kind: "text", key: "share.onedrive_folder", label: "OneDrive folder", placeholder: "Grabbit" },
    { kind: "text", key: "share.immich_url", label: "Immich server", placeholder: "https://photos.example.com" },
    { kind: "text", key: "share.immich_key", label: "Immich API key", secret: true, help: "Immich → Account settings → API keys" },
    { kind: "custom", render: () => shareTarget("Immich", "immich") },
    { kind: "text", key: "share.mega_email", label: "MEGA email" },
    { kind: "text", key: "share.mega_password", label: "MEGA password", secret: true },
    { kind: "text", key: "share.mega_folder", label: "MEGA folder", placeholder: "Grabbit" },
    { kind: "custom", render: () => shareTarget("MEGA", "mega") },
    { kind: "text", key: "share.s3_endpoint", label: "S3-compatible storage", placeholder: "https://<account>.r2.cloudflarestorage.com", help: "AWS S3, Cloudflare R2, Backblaze B2, MinIO, Wasabi. The link is copied before the upload finishes." },
    { kind: "text", key: "share.s3_bucket", label: "Bucket" },
    { kind: "text", key: "share.s3_region", label: "Region", placeholder: "auto (R2) or e.g. us-east-1" },
    { kind: "text", key: "share.s3_access_key", label: "Access key ID" },
    { kind: "text", key: "share.s3_secret_key", label: "Secret access key", secret: true },
    { kind: "text", key: "share.s3_public_url", label: "Public address", placeholder: "https://cdn.example.com", help: "Where the bucket is publicly readable; links use this" },
    { kind: "text", key: "share.s3_prefix", label: "Folder in the bucket", placeholder: "grabbit" },
    { kind: "custom", render: () => shareTarget("S3", "s3") },
  ],
  AI: () => [
    { kind: "note", html: "Optional. With a key, the editor's AI tab can remove backgrounds, remove or change objects, edit text in a picture, and answer questions about it. Pictures go to the provider you pick only when you press an AI button." },
    { kind: "select", key: "ai.provider", label: "Use", options: [["openai", "OpenAI (gpt-image)"], ["google", "Google (Gemini image)"], ["xai", "xAI (Grok image)"]] },
    { kind: "text", key: "ai.openai_key", label: "OpenAI API key", secret: true, placeholder: "sk-…" },
    { kind: "text", key: "ai.google_key", label: "Google AI API key", secret: true },
    { kind: "text", key: "ai.xai_key", label: "xAI API key", secret: true, placeholder: "xai-…" },
    { kind: "text", key: "ai.openai_base", label: "OpenAI-compatible URL", placeholder: "Leave empty for api.openai.com", help: "Local and free: Ollama's http://localhost:11434/v1 with a vision model (key: any text)" },
    { kind: "text", key: "ai.chat_model", label: "Model for describing and questions", placeholder: "Provider default", help: "e.g. qwen2.5vl or llava with Ollama" },
    { kind: "toggle", key: "ai.auto_describe", label: "Describe every capture", help: "A paragraph and tags for each capture, saved in History so you can search by meaning" },
  ],
  Obsidian: () => [
    { kind: "folder", key: "obsidian_vault", label: "Vault" },
    { kind: "text", key: "obsidian_folder", label: "Folder in the vault", placeholder: "Grabbit" },
    { kind: "note", html: "Send to Obsidian (in the editor's Share tab) saves the picture there and links it in today's daily note." },
  ],
  History: () => [{ kind: "custom", render: historyView }],
};

/** Back up settings to a file, or restore them (e.g. on a new computer). */
/** Light, dark or the system's choice, for every Grabbit window at once. */
function themeRow() {
  const sel = h("select", { class: "btn" }) as HTMLSelectElement;
  for (const [v, l] of [["system", "Same as Windows"], ["light", "Light"], ["dark", "Dark"]]) sel.add(new Option(os === "windows" ? l : l.replace("Windows", "the system"), v, false, getTheme() === v));
  sel.onchange = () => setTheme(sel.value as Theme);
  const row = h("div", { class: "row" }, h("label", {}, h("span", { class: "title" }, "Appearance"), h("span", { class: "help" }, "Light or dark, for every Grabbit window")), sel);
  row.title = "Appearance: light or dark for every Grabbit window, or follow your system's setting";
  return row;
}

function backupRow() {
  const secrets = h("input", { type: "checkbox" }) as HTMLInputElement;
  const out = h("button", { class: "btn" }, "Back up…") as HTMLButtonElement;
  const inn = h("button", { class: "btn" }, "Restore…") as HTMLButtonElement;
  out.title = "Save all your settings to a file, to restore later or on another computer";
  inn.title = "Load settings from a backup file";
  out.onclick = async () => {
    const path = await saveDialog({ defaultPath: "grabbit-settings.json", filters: [{ name: "Grabbit settings", extensions: ["json"] }] });
    if (!path) return;
    try { await invoke("settings_export", { path, secrets: secrets.checked }); toast("Settings backed up"); } catch (e) { toast(String(e)); }
  };
  inn.onclick = async () => {
    const path = await open({ filters: [{ name: "Grabbit settings", extensions: ["json"] }] });
    if (typeof path !== "string") return;
    try { s = await invoke<S>("settings_import", { path }); toast("Settings restored"); show("General"); } catch (e) { toast(String(e)); }
  };
  return h("div", { class: "row" },
    h("label", {}, h("span", { class: "title" }, "Back up or restore settings"), h("span", { class: "help" }, "One .json file: keys, folders, branding, sharing, everything")),
    h("span", { class: "pick" }, h("label", { class: "help", style: "display:flex;gap:4px;align-items:center" }, secrets, "Include passwords and API keys"), out, inn));
}

function autostartRow() {
  const c = h("input", { type: "checkbox", class: "switch" }) as HTMLInputElement;
  void invoke<boolean>("autostart_get").then((v) => (c.checked = v));
  c.onchange = () => void invoke("autostart_set", { on: c.checked }).then(() => toast(c.checked ? "Starts with your computer" : "Won't start automatically"));
  return h("div", { class: "row" }, h("label", {}, h("span", { class: "title" }, "Start with your computer")), c);
}

function customMeta() {
  const box = h("div", { class: "custom" });
  const draw = () => {
    box.innerHTML = "";
    const m: Record<string, string> = get("metadata.custom") ?? {};
    for (const [k, v] of Object.entries(m)) {
      const del = h("button", { class: "btn" }, "Remove") as HTMLButtonElement;
      del.onclick = () => { delete m[k]; set("metadata.custom", m); draw(); };
      box.append(h("div", { class: "row" }, h("label", {}, h("span", { class: "title" }, k)), h("span", { class: "pick" }, h("span", { class: "path" }, v), del)));
    }
    const k = h("input", { class: "text", placeholder: "Field (e.g. Project)" }) as HTMLInputElement;
    const v = h("input", { class: "text", placeholder: "Value" }) as HTMLInputElement;
    const add = h("button", { class: "btn" }, "Add field") as HTMLButtonElement;
    add.onclick = () => { if (!k.value.trim()) return; m[k.value.trim()] = v.value; set("metadata.custom", m); draw(); };
    box.append(h("div", { class: "row" }, h("label", {}, h("span", { class: "title" }, "Custom fields"), h("span", { class: "help" }, "Written as XMP (pictures) and tags (videos)")), h("span", { class: "pick" }, k, v, add)));
  };
  draw();
  return box;
}

function shareTarget(name: string, id: string) {
  const status = h("span", { class: "help" });
  const b = h("button", { class: "btn" }, id === "onedrive" ? "Sign in…" : "Test") as HTMLButtonElement;
  b.onclick = async () => {
    b.disabled = true; status.textContent = id === "onedrive" ? "Opening the Microsoft sign-in page…" : "Testing…";
    try { status.textContent = await invoke<string>("share_setup", { target: id }); } catch (e) { status.textContent = String(e); }
    b.disabled = false;
  };
  return h("div", { class: "row" }, h("label", {}, h("span", { class: "title" }, name), status), b);
}

async function checkImage(b: HTMLButtonElement) {
  const f = await open({ filters: [{ name: "Pictures", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }] });
  if (typeof f !== "string") return;
  b.disabled = true; b.textContent = "Reading…";
  try {
    const r = await invoke<{ found: boolean; yours?: boolean; id?: number; capture?: { path: string; time: string } }>("check_mark", { path: f });
    alert(!r.found ? "No Grabbit watermark found in that picture." :
      r.yours ? `This is your capture${r.capture ? ` from ${new Date(r.capture.time).toLocaleString()}\n${r.capture.path}` : ` (id ${r.id})`}.` :
      `It carries a Grabbit watermark from someone else (id ${r.id}).`);
  } finally { b.disabled = false; b.textContent = "Check an image for a watermark…"; }
}

function historyView() {
  const box = h("div", { class: "history" });
  const q = h("input", { class: "text search", placeholder: "Search captures by the words in them…", type: "search" }) as HTMLInputElement;
  const grid = h("div", { class: "grid" });
  const run = async () => {
    const items = await send<{ path: string; time: string; text: string }[]>({ type: "search", query: q.value });
    grid.innerHTML = "";
    for (const it of items ?? []) {
      const card = h("button", { class: "card", title: it.text.slice(0, 300) }, h("img", { src: fileUrl(it.path), loading: "lazy" }), h("span", {}, new Date(it.time).toLocaleString()));
      card.onclick = () => void invoke("open_file", { path: it.path });
      grid.append(card);
    }
    if (!grid.children.length) grid.append(h("p", { class: "note" }, q.value ? "Nothing matches." : "No captures yet."));
  };
  let t = 0;
  q.oninput = () => { clearTimeout(t); t = window.setTimeout(run, 200); };
  box.append(q, grid);
  void run();
  return box;
}

function show(name: string) {
  for (const b of nav.querySelectorAll("button")) b.classList.toggle("on", b.textContent === name);
  page.innerHTML = "";
  page.append(h("h1", {}, name), ...SECTIONS[name]().map(field));
  location.hash = name;
}

async function main() {
  s = await invoke<S>("get_settings");
  for (const name of Object.keys(SECTIONS)) {
    const b = h("button", {}, name) as HTMLButtonElement;
    b.title = `${name} settings`;
    b.onclick = () => show(name);
    nav.append(b);
  }
  show(decodeURIComponent(location.hash.slice(1)) in SECTIONS ? decodeURIComponent(location.hash.slice(1)) : "General");
}
void main();
