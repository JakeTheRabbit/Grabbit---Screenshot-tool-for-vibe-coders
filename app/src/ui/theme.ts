// Light, dark or the system's choice, for every Grabbit window. The choice lives in localStorage ("theme"), which all
// windows share, so changing it in Settings or the editor re-themes every open window at once (the storage event).

import { getCurrentWindow } from "@tauri-apps/api/window";
import { inTauri } from "../bridge";
import "./theme.css";

export type Theme = "system" | "light" | "dark";

export function getTheme(): Theme {
  try { const t = localStorage.getItem("theme"); return t === "light" || t === "dark" ? t : "system"; } catch { return "system"; }
}

function apply(t: Theme, startup = false) {
  if (t === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  // The native title bar (and Mica behind see-through windows) follow too; at startup "system" needs no call.
  if (inTauri && !(startup && t === "system")) void getCurrentWindow().setTheme(t === "system" ? null : t).catch(() => {});
}

const listeners = new Set<() => void>();

export function setTheme(t: Theme) {
  try { localStorage.setItem("theme", t); } catch { /* private mode */ }
  apply(t);
  listeners.forEach((f) => f());
}

const systemDark = matchMedia("(prefers-color-scheme: dark)");
export const isDark = () => { const t = getTheme(); return t === "dark" || (t === "system" && systemDark.matches); };

/** Calls `f` whenever the look changes: the setting (in any window) or the system's light/dark. */
export function onThemeChange(f: () => void) {
  listeners.add(f);
  systemDark.addEventListener("change", f);
  return () => { listeners.delete(f); systemDark.removeEventListener("change", f); };
}

apply(getTheme(), true);
addEventListener("storage", (e) => { if (e.key === "theme") { apply(getTheme()); listeners.forEach((f) => f()); } });
