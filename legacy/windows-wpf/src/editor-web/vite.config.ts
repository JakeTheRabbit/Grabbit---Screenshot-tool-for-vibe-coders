import { cpSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Builds straight into the WPF app (served offline from https://grabbit.app/ via WebView2 virtual host mapping).
const out = "../Grabbit/EditorWeb";

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    {
      // Excalidraw fetches fonts at runtime; ship them so the editor never needs the network.
      name: "copy-excalidraw-fonts",
      closeBundle() {
        cpSync("node_modules/@excalidraw/excalidraw/dist/prod/fonts", `${out}/fonts`, { recursive: true });
      },
    },
  ],
  define: { "process.env.IS_PREACT": JSON.stringify("false") },
  build: {
    outDir: out, emptyOutDir: true, chunkSizeWarningLimit: 6000,
    // index.html = picture editor (Excalidraw), video.html = recording timeline.
    rollupOptions: { input: { index: "index.html", video: "video.html" } },
  },
});
