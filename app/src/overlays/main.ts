// Small always-on-top windows: the quick-access card, pinned pictures, and the recording
// frame + bar. One bundle; the page's file name picks which one runs.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import "../ui/base";
import "./overlays.css";
import { fileUrl } from "../bridge";
import { icon } from "../ui/icons";

const page = location.pathname.split("/").pop()!.replace(".html", "");
const q = new URLSearchParams(location.search);
const win = getCurrentWebviewWindow();
const root = document.getElementById("root")!;
document.body.className = page;

/** AI description of a capture: readable, copyable. */
function describe() {
  const path = q.get("p");
  root.innerHTML = `<div class="card describe">${path ? `<div class="thumb small"><img src="${fileUrl(path)}"></div>` : ""}
    <div class="text"></div>
    <div class="row"><span class="msg">Copied</span><button class="btn" data-a="copy">${icon("copy")}<span>Copy again</span></button><button class="ic" data-a="close" title="Close">${icon("close")}</button></div></div>`;
  (root.querySelector(".text") as HTMLElement).textContent = q.get("t") ?? "";
  root.querySelector<HTMLButtonElement>('[data-a="copy"]')!.onclick = () => void invoke("copy_text", { text: q.get("t") ?? "" });
  root.querySelector<HTMLButtonElement>('[data-a="close"]')!.onclick = () => void win.close();
  addEventListener("keydown", (e) => { if (e.key === "Escape") void win.close(); });
}

function quick() {
  if (q.get("mode") === "describe") return describe();
  const path = q.get("p");
  const text = q.get("t") ?? "";
  const isVideo = !!path && /\.(mp4|mkv|mov|webm|gif)$/i.test(path);
  root.innerHTML = `<div class="card">
    ${path ? `<div class="thumb" draggable="true" title="Drag this into any app (chat, email, document) to drop the file there">${isVideo ? `<video src="${fileUrl(path)}" muted autoplay loop></video>` : `<img src="${fileUrl(path)}">`}</div>` : ""}
    <div class="row"><span class="msg">${text}</span>${path ? `
      <button class="ic" data-a="edit" title="Mark it up in the editor: arrows, boxes, text, blur, crop">${icon("edit")}</button>
      <button class="ic" data-a="ai" title="Talk to AI: say what you want done with it, then paste picture + words into ChatGPT, Claude or Gemini">${icon("mic")}</button>
      <button class="ic" data-a="pin" title="Pin it on top of every window">${icon("pin")}</button>
      <button class="ic" data-a="share" title="Share it as a link">${icon("share")}</button>
      <button class="ic" data-a="folder" title="Show the file in its folder">${icon("folder")}</button>` : ""}
      <button class="ic" data-a="close" title="Close this card">${icon("close")}</button></div></div>`;
  let timer = window.setTimeout(() => void win.close(), path ? 7000 : 3000);
  root.onmouseenter = () => clearTimeout(timer);
  root.onmouseleave = () => { timer = window.setTimeout(() => void win.close(), 2500); };
  root.querySelectorAll<HTMLButtonElement>("button").forEach((b) => (b.onclick = async () => {
    const a = b.dataset.a!;
    if (a !== "close" && path) await invoke("quick_action", { action: a, path });
    void win.close();
  }));
  // Drag the thumbnail out into any app: the OS gets the real file.
  const thumb = root.querySelector(".thumb") as HTMLElement | null;
  thumb?.addEventListener("mousedown", (e) => { if (e.button === 0 && path) { e.preventDefault(); void invoke("drag_out", { path }); } });
}

function pin() {
  const path = q.get("p")!;
  root.innerHTML = `<img src="${fileUrl(path)}" draggable="false">`;
  const imgEl = root.querySelector("img")!;
  let zoom = 1;
  root.addEventListener("mousedown", (e) => { if (e.button === 0) void win.startDragging(); });
  root.addEventListener("dblclick", () => void win.close());
  addEventListener("keydown", (e) => { if (e.key === "Escape") void win.close(); if ((e.ctrlKey || e.metaKey) && e.key === "c") void invoke("copy_file_image", { path }); });
  root.addEventListener("wheel", async (e) => {
    e.preventDefault();
    zoom = Math.min(4, Math.max(0.2, zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    const { PhysicalSize } = await import("@tauri-apps/api/dpi");
    const s = devicePixelRatio;
    await win.setSize(new PhysicalSize(Math.round(imgEl.naturalWidth / s * zoom * s), Math.round(imgEl.naturalHeight / s * zoom * s)));
  }, { passive: false });
  root.title = "Drag to move · scroll to zoom · double-click or Esc to close";
}

/** The red frame. While paused it can be dragged (inside) or resized (edges); resume records the new spot. */
function recframe() {
  root.innerHTML = `<div class="frame"></div><div class="tip">Paused · drag to move, drag an edge to resize, then resume</div>`;
  void listen<boolean>("rec-state", (e) => document.body.classList.toggle("editable", e.payload));
  const edge = (x: number, y: number) => {
    const m = 10, w = innerWidth, h = innerHeight;
    const v = y < m ? "North" : y > h - m ? "South" : "", hz = x < m ? "West" : x > w - m ? "East" : "";
    return (v + hz) || null;
  };
  root.addEventListener("mousemove", (e) => {
    if (!document.body.classList.contains("editable")) return;
    const d = edge(e.clientX, e.clientY);
    root.style.cursor = !d ? "move" : ({ North: "ns", South: "ns", East: "ew", West: "ew", NorthWest: "nwse", SouthEast: "nwse", NorthEast: "nesw", SouthWest: "nesw" } as Record<string, string>)[d] + "-resize";
  });
  root.addEventListener("mousedown", (e) => {
    if (!document.body.classList.contains("editable") || e.button !== 0) return;
    const d = edge(e.clientX, e.clientY);
    if (d) void win.startResizeDragging(d as never); else void win.startDragging();
  });
}

function scrollbar() {
  root.innerHTML = `<div class="rec"><span class="live"></span><span class="status">Starting…</span>
    <button class="stop" data-a="done">${icon("check")}<span>Done</span></button>
    <button class="ic" data-a="cancel" title="Cancel">${icon("close")}</button></div>`;
  const st = root.querySelector(".status")!;
  void listen<string>("status", (e) => { st.textContent = e.payload; });
  root.querySelectorAll<HTMLButtonElement>("button").forEach((b) => (b.onclick = () => void invoke("scroll_control", { what: b.dataset.a })));
  addEventListener("keydown", (e) => { if (e.key === "Escape") void invoke("scroll_control", { what: "cancel" }); });
}

/** The AI batch bar: how many pictures so far, Done opens the review. */
function batchbar() {
  root.innerHTML = `<div class="rec"><span class="live"></span><span class="status">AI batch · <b class="n">0</b> pictures · talk about each one</span>
    <button class="stop" data-a="done">${icon("check")}<span>Done</span></button>
    <button class="ic" data-a="cancel" title="Throw the batch away">${icon("close")}</button></div>`;
  const n = root.querySelector(".n")!;
  void invoke<unknown[]>("batch_items").then((i) => { n.textContent = String(i.length); });
  void listen<number>("count", (e) => { n.textContent = String(e.payload); });
  root.querySelector<HTMLButtonElement>('[data-a="done"]')!.onclick = () => void invoke("batch_finish");
  root.querySelector<HTMLButtonElement>('[data-a="cancel"]')!.onclick = () => void invoke("batch_clear");
  root.addEventListener("mousedown", (e) => { if (!(e.target as HTMLElement).closest("button")) void win.startDragging(); });
}

function recbar() {
  if (q.get("mode") === "scroll") return scrollbar();
  if (q.get("mode") === "batch") return batchbar();
  root.innerHTML = `<div class="rec"><span class="live"></span><span class="time">0:00</span>
    <button class="ic" data-a="pause" title="Pause">${icon("pause")}</button>
    <button class="stop" data-a="stop" title="Stop and keep">${icon("stop")}<span>Stop</span></button>
    <button class="ic" data-a="discard" title="Throw away">${icon("close")}</button></div>`;
  const time = root.querySelector(".time")!;
  const pause = root.querySelector('[data-a="pause"]') as HTMLButtonElement;
  root.querySelectorAll<HTMLButtonElement>("button").forEach((b) => (b.onclick = () => void invoke("rec_control", { what: b.dataset.a })));
  root.addEventListener("mousedown", (e) => { if (!(e.target as HTMLElement).closest("button")) void win.startDragging(); });
  const tick = async () => {
    const s = await invoke<{ elapsed: number; paused: boolean; recording: boolean }>("rec_status");
    const t = Math.floor(s.elapsed);
    time.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
    root.classList.toggle("paused", s.paused);
    pause.innerHTML = icon(s.paused ? "play" : "pause");
    pause.title = s.paused ? "Resume" : "Pause";
  };
  void tick();
  setInterval(tick, 500);
}

({ quick, pin, recframe, recbar } as Record<string, () => void>)[page]?.();
