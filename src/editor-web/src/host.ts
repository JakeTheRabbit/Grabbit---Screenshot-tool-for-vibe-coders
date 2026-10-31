// Bridge to the WPF host (WebView2). Outside WebView2 (e.g. a test browser) messages queue in window.grabbit.outbox.

export type Size = "Full" | "Reduced" | "Chat";

/** copy / copyClose → clipboard; saveQuick → "<name> edited.png" in the Grabbit folder; save → Save-as dialog;
 *  copyPath → saveQuick, then the file's path on the clipboard; closeSave → keep edits of a closing tab. */
export type ExportAction = "copy" | "copyClose" | "save" | "saveQuick" | "copyPath" | "closeSave";

export type RecentItem = { path: string; url: string; name: string; time: string; kind: "capture" | "edited" | "copied"; bytes?: number };

export type HostMessage =
  | { type: "load"; name: string; dataURL?: string; width?: number; height?: number; scene?: string; recent: RecentItem[] }
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

type WebView = { postMessage(m: unknown): void; addEventListener(t: "message", f: (e: { data: HostMessage }) => void): void };

declare global {
  interface Window {
    chrome?: { webview?: WebView };
    grabbit: { outbox: EditorMessage[]; receive: (m: HostMessage) => void; api?: unknown; convert?: unknown };
  }
}

const listeners: ((m: HostMessage) => void)[] = [];
window.grabbit = { outbox: [], receive: (m) => listeners.forEach((f) => f(m)) };
window.chrome?.webview?.addEventListener("message", (e) => window.grabbit.receive(e.data));

export function post(m: EditorMessage) {
  window.grabbit.outbox.push(m);
  if (window.grabbit.outbox.length > 20) window.grabbit.outbox.shift();
  window.chrome?.webview?.postMessage(m);
}

export function onHost(f: (m: HostMessage) => void) {
  listeners.push(f);
  return () => listeners.splice(listeners.indexOf(f), 1);
}

let nextReq = 1;
const pending = new Map<number, (m: Extract<HostMessage, { type: "image" }>) => void>();
onHost((m) => {
  if (m.type === "image") { pending.get(m.reqId)?.(m); pending.delete(m.reqId); }
});

/** Ask the host for a file from the capture history as a data URL. */
export function getImage(path: string) {
  const reqId = nextReq++;
  return new Promise<Extract<HostMessage, { type: "image" }>>((resolve) => {
    pending.set(reqId, resolve);
    post({ type: "getImage", reqId, path });
  });
}
