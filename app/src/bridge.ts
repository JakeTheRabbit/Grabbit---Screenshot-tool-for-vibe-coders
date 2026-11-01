// Talking to Grabbit's Rust core from any page. Outside Tauri (a plain browser, tests) messages queue in
// window.grabbit.outbox instead.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

export const inTauri = "__TAURI_INTERNALS__" in window;

declare global {
  interface Window { grabbitOutbox?: unknown[] }
}

/** Send an editor message; resolves with the core's answer (OCR words, search results…). */
export async function send<T = unknown>(msg: object): Promise<T> {
  (window.grabbitOutbox ??= []).push(msg);
  if (window.grabbitOutbox.length > 20) window.grabbitOutbox.shift();
  if (!inTauri) return null as T;
  return invoke<T>("editor_msg", { msg });
}

/** Messages the core sends to this window. */
export function onHostEvent<T>(f: (m: T) => void) {
  if (!inTauri) return () => {};
  const p = getCurrentWebviewWindow().listen<T>("host", (e) => f(e.payload));
  return () => { p.then((un) => un()); };
}

/** A local file as a URL the page can load. */
export const fileUrl = (path: string) => (inTauri ? convertFileSrc(path) : path);

export const call = <T = unknown>(cmd: string, args?: Record<string, unknown>) => (inTauri ? invoke<T>(cmd, args) : Promise.resolve(null as T));

/** OS name for per-platform styling: "windows" | "macos" | "linux". */
export const os = /Mac/.test(navigator.platform) ? "macos" : /Win/.test(navigator.platform) ? "windows" : "linux";
document.documentElement.dataset.os = os;
