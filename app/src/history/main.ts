// History: every capture and recording, findable again by anything known about it: the words in it, the programs
// and windows it showed, where it was pasted, when, tags, notes, and the AI description. Star it, keep it for later,
// or have Grabbit remind you about it.

import { invoke } from "@tauri-apps/api/core";
import "../ui/base";
import { icon, type Icon } from "../ui/icons";
import { corsUrl, inTauri, thumbUrl } from "../bridge";
import "./history.css";

type Paste = { app: string; title: string; time: string };
type Item = {
  path: string; name: string; folder: string; time: string; width: number; height: number; bytes: number;
  kind: string; text: string; description: string; apps: string[]; windows: string[]; pasted: Paste[];
  starred: boolean; later: boolean; remind: string; tags: string[]; note: string; full: string; notes: string;
};

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
function h(tag: string, attrs: Record<string, unknown> = {}, ...kids: (Node | string | null | undefined | false)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) (e as any)[k] = v; else if (k === "html") e.innerHTML = String(v); else e.setAttribute(k, String(v));
  }
  for (const c of kids) if (c != null && c !== false) e.append(c);
  return e;
}
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const btn = (ic: Icon | null, label: string, title: string, run: () => void, cls = "btn") => h("button", { class: cls, title, onclick: run }, ic ? h("span", { html: icon(ic) }) : null, label ? h("span", {}, label) : null);
let toastTimer = 0;
function toast(t: string) { const el = $("#toast"); el.textContent = t; el.classList.add("on"); clearTimeout(toastTimer); toastTimer = window.setTimeout(() => el.classList.remove("on"), 2200); }

let items: Item[] = [];
let shown: Item[] = [];
let view = "all";      // all · starred · later · remind · pasted · recording
let when = "";         // today · yesterday · week · month · older
let app = "";          // a program name
let pastedTo = "";     // a program it was pasted into
let tag = "";
let sel: string | null = new URLSearchParams(location.search).get("focus");

// ---- dates ----
const day = (t: string) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
const today = () => day(new Date().toISOString());
const DAY = 86400000;
function dayLabel(t: string) {
  const d = day(t), n = today();
  const long = new Date(t).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return d === n ? `Today · ${long}` : d === n - DAY ? `Yesterday · ${long}` : long;
}
const clock = (t: string) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const full = (t: string) => new Date(t).toLocaleString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
const size = (b: number) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
/** Every way someone might say when it was: "tuesday", "november", "2026-11-21", "21 nov". */
function dateWords(t: string) {
  const d = new Date(t);
  return [d.toLocaleDateString(undefined, { weekday: "long" }), d.toLocaleDateString(undefined, { month: "long" }), d.toLocaleDateString(undefined, { month: "short" }),
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`, `${d.getDate()} ${d.toLocaleDateString(undefined, { month: "short" })}`, String(d.getFullYear())].join(" ");
}

// ---- searching ----
type Q = { words: string[]; app: string[]; pasted: string[]; tag: string[]; is: string[]; before?: number; after?: number };
function parse(q: string): Q {
  const out: Q = { words: [], app: [], pasted: [], tag: [], is: [] };
  for (const m of q.toLowerCase().matchAll(/(\w+):"([^"]+)"|(\w+):(\S+)|"([^"]+)"|(\S+)/g)) {
    const [k, v] = m[1] ? [m[1], m[2]] : m[3] ? [m[3], m[4]] : ["", m[5] ?? m[6]];
    if (k === "app" || k === "in") out.app.push(v); else if (k === "pasted" || k === "to") out.pasted.push(v); else if (k === "tag") out.tag.push(v);
    else if (k === "is") out.is.push(v); else if (k === "before") out.before = new Date(v).getTime(); else if (k === "after") out.after = new Date(v).getTime();
    else out.words.push(k ? `${k}:${v}` : v);
  }
  return out;
}
const pastedText = (i: Item) => i.pasted.map((p) => `${p.app} ${p.title}`).join(" ");
/** 0 = no match; higher = better. Every word has to be found somewhere. */
function score(i: Item, q: Q) {
  const low = (s: string) => s.toLowerCase();
  if (q.app.some((a) => !i.apps.concat(i.windows).some((x) => low(x).includes(a)))) return 0;
  if (q.pasted.some((a) => !low(pastedText(i)).includes(a))) return 0;
  if (q.tag.some((a) => !i.tags.some((x) => low(x).includes(a)))) return 0;
  for (const s of q.is) {
    if ((s === "starred" || s === "star") && !i.starred) return 0;
    if (s === "later" && !i.later) return 0;
    if (s === "pasted" && !i.pasted.length) return 0;
    if ((s === "recording" || s === "video") && i.kind !== "recording") return 0;
    if (s === "reminder" && !i.remind) return 0;
  }
  const t = new Date(i.time).getTime();
  if (q.before && t >= q.before) return 0;
  if (q.after && t < q.after) return 0;
  const strong = low(`${i.name} ${i.apps.join(" ")} ${i.windows.join(" ")} ${i.tags.join(" ")} ${i.note}`);
  const weak = low(`${i.text} ${i.description} ${pastedText(i)} ${dateWords(i.time)} ${i.width}x${i.height}`);
  let s = 1;
  for (const w of q.words) { if (strong.includes(w)) s += 3; else if (weak.includes(w)) s += 1; else return 0; }
  return s;
}

function filter() {
  const q = parse($<HTMLInputElement>("#q").value.trim());
  const n = today();
  const inWhen = (i: Item) => {
    const d = day(i.time);
    return !when || (when === "today" ? d === n : when === "yesterday" ? d === n - DAY : when === "week" ? d > n - 7 * DAY : when === "month" ? d > n - 31 * DAY : d <= n - 31 * DAY);
  };
  const inView = (i: Item) => view === "all" || (view === "starred" && i.starred) || (view === "later" && i.later) || (view === "remind" && !!i.remind) || (view === "pasted" && i.pasted.length > 0) || (view === "recording" && i.kind === "recording");
  const scored = items.filter((i) => inView(i) && inWhen(i) && (!app || i.apps.includes(app)) && (!pastedTo || i.pasted.some((p) => p.app === pastedTo)) && (!tag || i.tags.includes(tag)))
    .map((i) => [i, score(i, q)] as const).filter(([, s]) => s > 0);
  const searching = q.words.length > 0;
  shown = scored.sort((a, b) => (searching ? b[1] - a[1] : 0) || b[0].time.localeCompare(a[0].time)).map(([i]) => i);
  drawList(searching ? q.words : []);
  drawSide();
}

// ---- sidebar ----
function count<T>(xs: T[]) { const m = new Map<T, number>(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); }
function drawSide() {
  const side = $("#side");
  side.innerHTML = "";
  const row = (label: string, n: number, on: boolean, ic: Icon | null, run: () => void) => h("button", { class: `side-row${on ? " on" : ""}`, onclick: run }, ic ? h("span", { class: "ic", html: icon(ic) }) : null, h("span", { class: "t" }, label), h("span", { class: "n" }, String(n)));
  const group = (title: string, ...rows: HTMLElement[]) => rows.length && side.append(h("div", { class: "side-group" }, h("div", { class: "side-title" }, title), ...rows));
  const views: [string, string, Icon, (i: Item) => boolean][] = [["all", "Everything", "history", () => true], ["starred", "Starred", "star", (i) => i.starred], ["later", "Saved for later", "bookmark", (i) => i.later],
    ["remind", "Reminders", "bell", (i) => !!i.remind], ["pasted", "Pasted somewhere", "copy", (i) => i.pasted.length > 0], ["recording", "Recordings", "record", (i) => i.kind === "recording"]];
  group("Show", ...views.map(([k, l, ic, f]) => row(l, items.filter(f).length, view === k, ic, () => { view = k; filter(); })));
  const n = today();
  const whens: [string, string, (d: number) => boolean][] = [["today", "Today", (d) => d === n], ["yesterday", "Yesterday", (d) => d === n - DAY], ["week", "Last 7 days", (d) => d > n - 7 * DAY], ["month", "Last 31 days", (d) => d > n - 31 * DAY], ["older", "Older", (d) => d <= n - 31 * DAY]];
  group("When", ...whens.map(([k, l, f]) => row(l, items.filter((i) => f(day(i.time))).length, when === k, null, () => { when = when === k ? "" : k; filter(); })));
  group("In the picture", ...count(items.flatMap((i) => i.apps)).slice(0, 14).map(([a, c]) => row(a, c, app === a, null, () => { app = app === a ? "" : a; filter(); })));
  group("Pasted into", ...count(items.flatMap((i) => [...new Set(i.pasted.map((p) => p.app))])).slice(0, 10).map(([a, c]) => row(a || "Unknown", c, pastedTo === a, null, () => { pastedTo = pastedTo === a ? "" : a; filter(); })));
  group("Tags", ...count(items.flatMap((i) => i.tags)).slice(0, 20).map(([a, c]) => row(a, c, tag === a, "tag", () => { tag = tag === a ? "" : a; filter(); })));
}

// ---- the list ----
function snippet(text: string, words: string[]) {
  const low = text.toLowerCase();
  const at = words.map((w) => low.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (at == null) return "";
  const s = Math.max(0, at - 50), e = Math.min(text.length, at + 90);
  let out = esc((s ? "…" : "") + text.slice(s, e).replace(/\s+/g, " ") + (e < text.length ? "…" : ""));
  for (const w of words) out = out.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (m) => `<mark>${m}</mark>`);
  return out;
}
function thumb(i: Item) {
  if (i.kind === "recording") return h("video", { src: `${corsUrl(i.path)}#t=0.5`, preload: "metadata", muted: "" });
  return h("img", { src: thumbUrl(i.path), loading: "lazy", alt: "" });
}
function drawList(words: string[]) {
  const list = $("#list");
  list.innerHTML = "";
  if (!shown.length) {
    list.append(h("div", { class: "empty" }, items.length ? "Nothing matches. Try fewer words, or clear the filters on the left." : "No captures yet. Everything you capture from now on shows up here."));
    showDetail();
    return;
  }
  let lastDay = -1, grid: HTMLElement | null = null;
  const sorted = words.length ? null : true;
  for (const i of shown) {
    if (sorted && day(i.time) !== lastDay) { lastDay = day(i.time); list.append(h("h2", {}, dayLabel(i.time))); grid = h("div", { class: "grid" }); list.append(grid); }
    if (!grid) { grid = h("div", { class: "grid" }); list.append(grid); }
    const snip = words.length ? snippet(i.text + " " + i.description, words) : "";
    const card = h("button", { class: `card${sel === i.path ? " sel" : ""}`, "data-path": i.path, title: i.name, onclick: () => select(i.path), ondblclick: () => act("edit", i) },
      h("div", { class: "pic" }, thumb(i), i.kind === "recording" ? h("span", { class: "badge" }, "Video") : null),
      h("div", { class: "meta" },
        h("div", { class: "line1" }, h("span", { class: "time" }, sorted ? clock(i.time) : `${new Date(i.time).toLocaleDateString()} ${clock(i.time)}`),
          i.starred ? h("span", { class: "flag star", html: icon("star"), title: "Starred" }) : null,
          i.later ? h("span", { class: "flag", html: icon("bookmark"), title: "Saved for later" }) : null,
          i.remind ? h("span", { class: "flag", html: icon("bell"), title: `Reminder ${full(i.remind)}` }) : null,
          i.pasted.length ? h("span", { class: "flag", html: icon("copy"), title: `Pasted into ${i.pasted.map((p) => p.app || p.title).join(", ")}` }) : null),
        h("div", { class: "line2" }, i.apps[0] ?? (i.kind === "recording" ? "Recording" : `${i.width} × ${i.height}`)),
        snip ? h("div", { class: "snip", html: snip }) : null));
    grid.append(card);
  }
  if (sel && !shown.some((i) => i.path === sel)) sel = null;
  showDetail();
}

function select(path: string | null) {
  sel = path;
  document.querySelectorAll(".card").forEach((c) => c.classList.toggle("sel", c.getAttribute("data-path") === path));
  document.querySelector(".card.sel")?.scrollIntoView({ block: "nearest" });
  showDetail();
}
(window as any).focusCapture = (p: string) => { view = "all"; when = app = pastedTo = tag = ""; $<HTMLInputElement>("#q").value = ""; filter(); select(p); };

// ---- doing things ----
async function act(what: string, i: Item) {
  try {
    if (what === "copy") { await invoke(i.kind === "recording" ? "quick_action" : "copy_file_image", i.kind === "recording" ? { action: "folder", path: i.path } : { path: i.path }); toast(i.kind === "recording" ? "Shown in its folder" : "Copied"); }
    else if (what === "text") { await invoke("copy_text", { text: i.text }); toast("Copied the text"); }
    else if (what === "full") await invoke("open_file", { path: i.full });
    else if (what === "notes") await invoke("open_recording_notes", { path: i.path });
    else await invoke("quick_action", { action: what, path: i.path });
  } catch (e) { toast(String(e)); }
}
async function update(i: Item, patch: Partial<Item>) {
  Object.assign(i, patch);
  try { await invoke("history_update", { path: i.path, patch }); } catch (e) { toast(String(e)); }
  filter();
}
function remindAt(choice: string) {
  const d = new Date();
  if (choice === "hour") d.setHours(d.getHours() + 1);
  else if (choice === "evening") { d.setHours(18, 0, 0, 0); if (d < new Date()) d.setDate(d.getDate() + 1); }
  else if (choice === "tomorrow") { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); }
  else if (choice === "week") { d.setDate(d.getDate() + 7); d.setHours(9, 0, 0, 0); }
  return d;
}
/** RFC 3339 with the local offset, which the core compares against its own clock. */
function rfc(d: Date) {
  const o = -d.getTimezoneOffset(), p = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00${o >= 0 ? "+" : "-"}${p(o / 60)}:${p(o % 60)}`;
}

// ---- the detail panel ----
function showDetail() {
  const box = $("#detail");
  const i = items.find((x) => x.path === sel);
  box.hidden = !i;
  if (!i) return;
  box.innerHTML = "";
  const chips = (xs: string[], cls = "chip") => h("div", { class: "chips" }, ...xs.map((x) => h("span", { class: cls }, x)));
  const section = (title: string, ...kids: (Node | null)[]) => h("section", {}, h("div", { class: "label" }, title), ...kids);
  const preview = i.kind === "recording" ? h("video", { src: corsUrl(i.path), controls: "", preload: "metadata" }) : h("img", { src: corsUrl(i.path), alt: "", ondblclick: () => act("edit", i) });

  const remind = h("select", { class: "btn", title: "Grabbit shows it to you again then" }) as HTMLSelectElement;
  for (const [v, l] of [["", i.remind ? `Reminder: ${full(i.remind)}` : "Remind me…"], ["hour", "In an hour"], ["evening", "This evening (6 pm)"], ["tomorrow", "Tomorrow morning (9 am)"], ["week", "Next week"], ["pick", "Pick a time…"], ...(i.remind ? [["clear", "No reminder"]] : [])]) remind.add(new Option(l, v));
  const picker = h("input", { type: "datetime-local", class: "text", hidden: true }) as HTMLInputElement;
  remind.onchange = () => {
    const v = remind.value;
    if (v === "pick") { picker.hidden = false; picker.focus(); return; }
    if (v === "clear") void update(i, { remind: "" });
    else if (v) { const d = remindAt(v); void update(i, { remind: rfc(d) }); toast(`I'll remind you ${full(d.toISOString())}`); }
  };
  picker.onchange = () => { if (picker.value) { const d = new Date(picker.value); void update(i, { remind: rfc(d) }); toast(`I'll remind you ${full(d.toISOString())}`); } };

  const tags = h("input", { type: "text", class: "text", placeholder: "Add tags, separated by commas", value: i.tags.join(", ") }) as HTMLInputElement;
  tags.onchange = () => void update(i, { tags: tags.value.split(",").map((t) => t.trim()).filter(Boolean) });
  const note = h("textarea", { class: "text", rows: "3", placeholder: "A note to help you find it, or to remind yourself why you kept it" }) as HTMLTextAreaElement;
  note.value = i.note;
  note.onchange = () => void update(i, { note: note.value });

  const toggles = h("div", { class: "row" },
    btn("star", i.starred ? "Starred" : "Star", "Star it (S)", () => void update(i, { starred: !i.starred }), `btn${i.starred ? " on" : ""}`),
    btn("bookmark", i.later ? "Saved for later" : "Save for later", "Keep it in Saved for later (L)", () => void update(i, { later: !i.later }), `btn${i.later ? " on" : ""}`),
    remind, picker);
  const image = i.kind !== "recording";
  const actions = h("div", { class: "row wrap" },
    btn("copy", "Copy", image ? "Copy the picture (Enter)" : "Show the recording in its folder", () => void act("copy", i), "btn primary"),
    btn("edit", image ? "Mark up" : "Edit video", "Open it in the editor (E)", () => void act("edit", i)),
    btn("mic", "Talk to AI", "Say what you want done with it (V)", () => void act("ai", i)),
    image ? btn("pin", "Pin", "Float it on top of every window (I)", () => void act("pin", i)) : null,
    btn("share", "Share", "Upload it and copy a link", () => void act("share", i)),
    btn("folder", "Show in folder", "Show the file in Explorer / Finder (O)", () => void act("folder", i)),
    i.full ? btn("monitor", "Whole screen", "Open the full screen this was taken from", () => void act("full", i)) : null,
    i.notes ? btn("text", "Notes", "Open the notes folder: transcript, captions and stills, ready for a coding agent", () => void act("notes", i)) : null);

  const words = parse($<HTMLInputElement>("#q").value).words;
  const text = i.text ? h("div", { class: "ocr", html: words.length ? esc(i.text).replace(new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi"), (m) => `<mark>${m}</mark>`) : esc(i.text) }) : null;

  box.append(...([
    h("div", { class: "preview" }, preview),
    h("div", { class: "name", title: i.path }, i.name),
    h("div", { class: "sub" }, `${full(i.time)} · ${i.kind === "recording" ? "Recording" : `${i.width} × ${i.height}`} · ${size(i.bytes)}`),
    h("button", { class: "path", title: "Show it in its folder", onclick: () => void act("folder", i) }, i.folder),
    actions, toggles,
    i.apps.length || i.windows.length ? section("In the picture", chips(i.apps), i.windows.length ? h("div", { class: "windows" }, ...i.windows.map((w) => h("div", {}, w))) : null) : null,
    i.pasted.length ? section("Pasted into", h("div", { class: "pasted" }, ...i.pasted.map((p) => h("div", {}, h("b", {}, p.app || "Unknown"), ` · ${p.title} · ${new Date(p.time).toLocaleString()}`)))) : null,
    section("Tags", tags),
    section("Note", note),
    i.description ? section("AI description", h("div", { class: "desc" }, i.description)) : null,
    text ? section(image ? "Text in it" : "What was said", text, btn("text", "Copy the text", "Copy all the words read from it", () => void act("text", i), "btn small")) : null,
    h("div", { class: "row end" }, btn("trash", "Remove from History", "Forget it here. The file itself stays where it is.", async () => {
      if (!confirm("Remove this from History? The file stays in its folder.")) return;
      await invoke("history_remove", { path: i.path }); items = items.filter((x) => x !== i); sel = null; filter();
    }, "btn ghost danger")),
  ].filter(Boolean) as Node[]));
}

// ---- keys ----
addEventListener("keydown", (e) => {
  const q = $<HTMLInputElement>("#q");
  if ((e.key === "f" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && document.activeElement !== q)) { e.preventDefault(); q.focus(); q.select(); return; }
  if (e.key === "Escape") { if (document.activeElement === q && q.value) { q.value = ""; filter(); } else select(null); return; }
  const typing = /INPUT|TEXTAREA|SELECT/.test((document.activeElement as HTMLElement)?.tagName ?? "");
  if (typing && !(document.activeElement === q && /Arrow(Up|Down)|Enter/.test(e.key))) return;
  const at = shown.findIndex((i) => i.path === sel);
  const cols = Math.max(1, Math.round(($("#list .grid")?.clientWidth ?? 600) / 196));
  const move = (d: number) => { const n = shown[Math.min(shown.length - 1, Math.max(0, (at < 0 ? -d : at) + d))]; if (n) { select(n.path); e.preventDefault(); } };
  if (e.key === "ArrowRight") return move(1);
  if (e.key === "ArrowLeft") return move(-1);
  if (e.key === "ArrowDown") { if (document.activeElement === q) q.blur(); return move(cols); }
  if (e.key === "ArrowUp") return move(-cols);
  const i = shown[at];
  if (!i) return;
  const k = e.key.toLowerCase();
  if (e.key === "Enter") { e.preventDefault(); void act("copy", i); }
  else if (k === "s") void update(i, { starred: !i.starred });
  else if (k === "l") void update(i, { later: !i.later });
  else if (k === "e") void act("edit", i);
  else if (k === "v") void act("ai", i);
  else if (k === "i") void act("pin", i);
  else if (k === "o") void act("folder", i);
});

// ---- start ----
async function load() {
  items = (inTauri ? await invoke<Item[]>("history_list").catch(() => null) : null) ?? [];
  filter();
  if (sel) select(sel);
}
function header() {
  const q = h("input", { id: "q", type: "search", class: "text", placeholder: "Search words in your captures, programs, where you pasted them, tags, notes, dates…", autofocus: "" }) as HTMLInputElement;
  let t = 0;
  q.oninput = () => { clearTimeout(t); t = window.setTimeout(filter, 120); };
  const help = h("span", { class: "hint", title: "app:chrome · pasted:slack · tag:invoice · is:starred · is:later · is:pasted · is:recording · before:2026-11-01 · after:2026-10-01 · \"exact phrase\"" }, "Tips");
  $("#top").append(
    h("div", { class: "search" }, h("span", { class: "ic", html: icon("search") }), q, help),
    btn("folder", "Open Grabbit folder", "Open the folder your captures are saved in", () => void invoke("open_captures_folder", {}).catch((e) => toast(String(e)))),
    btn("record", "Recordings folder", "Open the folder your recordings are saved in", () => void invoke("open_captures_folder", { videos: true }).catch((e) => toast(String(e)))),
  );
}
header();
void load();
addEventListener("focus", () => void load());
