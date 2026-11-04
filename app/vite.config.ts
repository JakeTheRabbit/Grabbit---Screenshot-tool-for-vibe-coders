import { cpSync, existsSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// One page per Grabbit window. Built into dist/, which Tauri bundles and serves offline.
const pages = ["index", "video", "picker", "quick", "pin", "recframe", "recbar", "settings", "voice"].filter((p) => existsSync(`${p}.html`));

export default defineConfig({
  base: "./",
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  plugins: [
    react(),
    {
      // Excalidraw fetches fonts at runtime; ship them so the editor never needs the network.
      name: "copy-excalidraw-fonts",
      closeBundle() {
        cpSync("node_modules/@excalidraw/excalidraw/dist/prod/fonts", "dist/fonts", { recursive: true });
      },
    },
  ],
  define: { "process.env.IS_PREACT": JSON.stringify("false") },
  build: {
    outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 6000, target: "es2022",
    rollupOptions: { input: Object.fromEntries(pages.map((p) => [p, `${p}.html`])) },
  },
});
