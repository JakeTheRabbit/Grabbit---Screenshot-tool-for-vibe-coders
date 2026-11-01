// Small always-on-top windows: the hold-to-record pill, the quick-access card, pinned pictures, and the recording
// frame + bar. One bundle; the page's file name picks which one runs.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import "../native.css";
import "./overlays.css";
import { fileUrl } from "../bridge";
import { icon } from "../ui/icons";

const page = location.pathname.split("/").pop()!.replace(".html", "");
const q = new URLSearchParams(location.search);
const win = getCurrentWebviewWindow();
const root = document.getElementById("root")!;
document.body.className = page;

function hint() {
  root.innerHTML = `<div class="pill"><div class="dot"></div><div><b>Keep holding to record</b><div class="track"><div class="fill"></div></div></div></div>`;
  const fill = root.querySelector(".fill") as HTMLElement;
  void listen<number>("progress", (e) => { fill.style.width = `${Math.min(100, e.payload * 100)}%`; });
}

function quick() {
  const path = q.get("p");
  const text = q.get("t") ?? "";
  const isVideo = !!path && /\.(mp4|mkv|mov|webm|gif)$/i.test(path);
  root.innerHTML = `<div class="card">
    ${path ? `<div class="thumb" draggable="true">${isVideo ? `<video src="${fileUrl(path)}" muted autoplay loop></video>` : `<img src="${fileUrl(path)}">`}</div>` : ""}
    <div class="row"><span class="msg">${text}</span>${path ? `
      <button class="ic" data-a="edit" title="Edit">${icon("edit")}</button>
      <button class="ic" data-a="pin" title="Pin to screen">${icon("pin")}</button>
      <button class="ic" data-a="share" title="Share">${icon("share")}</button>
      <button class="ic" data-a="folder" title="Show in folder">${icon("folder")}</button>` : ""}
      <button class="ic" data-a="close" title="Close">${icon("close")}</button></div></div>`;
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

function recframe() { root.innerHTML = `<div class="frame"></div>`; }

function recbar() {
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

({ hint, quick, pin, recframe, recbar } as Record<string, () => void>)[page]?.();
