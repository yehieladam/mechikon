import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./src/manifest.config";

// Builds the NEW React MV3 popup (P2 target) into dist/.
// The hand-built plain-JS spike in extension/ is untouched by this build and stays
// loadable until P2-01 verifies this build as its replacement (see docs/tasks.md).
export default defineConfig({
  plugins: [react(), crx({ manifest })],
  resolve: {
    alias: {
      "@engine": fileURLToPath(new URL("./engine/src", import.meta.url)),
    },
  },
  // mupdf ships as an ESM module with top-level await and loads its own wasm via new URL(); excluding
  // it from pre-bundling + targeting es2022 lets the popup's PDF text extraction work (mirrors web).
  optimizeDeps: { exclude: ["mupdf"] },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      // Extra HTML entry not referenced by the manifest (the offscreen document is created at
      // runtime via chrome.offscreen.createDocument, not declared as an action/page).
      input: {
        offscreen: fileURLToPath(new URL("./src/offscreen/offscreen.html", import.meta.url)),
      },
    },
  },
});
