import { createRoot } from "react-dom/client";
import "./video.css";
import "../ui/base";
import { VideoApp } from "./VideoApp";

createRoot(document.getElementById("root")!).render(<VideoApp />);
