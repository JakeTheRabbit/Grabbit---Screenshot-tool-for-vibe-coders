// Picture editor ↔ Grabbit core.

import { fileUrl, onHostEvent, send } from "./bridge";

export type Size = "Full" | "Reduced" | "Chat";

/** copy / copyClose → clipboard; saveQuick → "<name> edited" in the Grabbit folder; save → Save-as dialog;
 *  copyPath → saveQuick, then the file's path on the clipboard; closeSave → keep edits of a closing tab; pin → float on screen. */
export type ExportAction = "copy" | "copyClose" | "save" | "saveQuick" | "copyPath" | "closeSave" | "pin";

export type RecentItem = { path: string; url: string; name: string; time: string; kind: "capture" | "edited" | "copied" | "video"; bytes?: number };

export type HostMessage =
  | { type: "load"; name: string; dataURL?: string; width?: number; height?: number; scene?: string; recent: RecentItem[]; panel?: string }
  | { type: "addTab"; name: string; dataURL?: string; width?: number; height?: number; scene?: string }
  | { type: "image"; reqId: number; dataURL: string; width: number; height: number }
  | { type: "recent"; recent: RecentItem[] }
  | { type: "requestClose" };

export type EditorMessage =
  | { type: "ready" }
  | { type: "export"; action: ExportAction; size: Size; name: string; dataURL: string }
  | { type: "saveProject"; json: string }
  | { type: "getImage"; reqId: number; path: string }
  | { type: "dirty"; value: boolean }
  | { type: "close" };

const listeners: ((m: HostMessage) => void)[] = [];

function receive(m: HostMessage) {
  if ((m.type === "load" || m.type === "recent") && m.recent) for (const r of m.recent) r.url ||= fileUrl(r.path);
  listeners.forEach((f) => f(m));
}
onHostEvent<HostMessage>(receive);
(window as unknown as { grabbit: object }).grabbit = { receive };

export function post(m: EditorMessage) { void send(m); }

export function onHost(f: (m: HostMessage) => void) {
  listeners.push(f);
  return () => listeners.splice(listeners.indexOf(f), 1);
}

let nextReq = 1;
const pending = new Map<number, (m: Extract<HostMessage, { type: "image" }>) => void>();
onHost((m) => {
  if (m.type === "image") { pending.get(m.reqId)?.(m); pending.delete(m.reqId); }
});

/** Ask the core for a file from the capture history as a data URL. */
export function getImage(path: string) {
  const reqId = nextReq++;
  return new Promise<Extract<HostMessage, { type: "image" }>>((resolve) => {
    pending.set(reqId, resolve);
    post({ type: "getImage", reqId, path });
  });
}
