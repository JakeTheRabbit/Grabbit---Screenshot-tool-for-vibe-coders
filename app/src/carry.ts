// Switching between the classic (Excalidraw) and new (markup) editor reloads the page. Open tabs come along as
// pictures: each is saved to a temp file first, then reopened after the reload.

import { getImage } from "./host";
import { send } from "./bridge";

export type EditorKind = "classic" | "markup";
export const editorKind = (): EditorKind => { try { return localStorage.getItem("editor") === "markup" ? "markup" : "classic"; } catch { return "classic"; } };

export async function switchEditor(to: EditorKind, tabs: { name: string; dataURL: string }[]) {
  const carry: { name: string; path: string }[] = [];
  for (const t of tabs) {
    const path = await send<string>({ type: "exportFile", name: t.name, dataURL: t.dataURL });
    if (path) carry.push({ name: t.name, path });
  }
  try { sessionStorage.setItem("carry", JSON.stringify(carry)); localStorage.setItem("editor", to); } catch { /* private mode */ }
  location.reload();
}

/** Tabs brought over from the other editor, as pictures (call once, after the page is ready). */
export async function takeCarried() {
  let list: { name: string; path: string }[] = [];
  try { list = JSON.parse(sessionStorage.getItem("carry") ?? "[]"); sessionStorage.removeItem("carry"); } catch { /* none */ }
  const out = [];
  for (const c of list) out.push({ name: c.name, ...(await getImage(c.path)) });
  return out;
}
