import { createRoot } from "react-dom/client";
import "@excalidraw/excalidraw/index.css";
import "./video.css";
import "../ui/tip";
import { VideoApp } from "./VideoApp";

createRoot(document.getElementById("root")!).render(<VideoApp />);
