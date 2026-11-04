import { createRoot } from "react-dom/client";
import "@excalidraw/excalidraw/index.css";
import "./styles.css";
import "./ui/tip";
import { App } from "./App";
import { MarkupApp } from "./markup/MarkupApp";
import { editorKind } from "./carry";

createRoot(document.getElementById("root")!).render(editorKind() === "markup" ? <MarkupApp /> : <App />);
