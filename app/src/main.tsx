import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./ui/base";
import { MarkupApp } from "./markup/MarkupApp";
import { editorKind } from "./carry";

// The classic editor brings Excalidraw (1.3 MB); it loads only when that editor is wanted.
const App = lazy(() => import("./App").then((m) => ({ default: m.App })));

createRoot(document.getElementById("root")!).render(editorKind() === "markup" ? <MarkupApp /> : <Suspense fallback={null}><App /></Suspense>);
