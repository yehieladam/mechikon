import { fileURLToPath, URL } from "node:url";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Mechikon web app — a SEPARATE build from the extension (own Vercel project on the
 * mechikon.bai-solutions subdomain). Reuses `@engine/*` unchanged.
 *
 * COOP/COEP make the served page `crossOriginIsolated`, which lets onnxruntime-web use
 * multi-threaded WASM for faster NER (Phase-0). These headers are set for dev + preview here;
 * production is served with the same headers via the repo-root vercel.json (which Vercel reads from
 * the project root — the repo root, since build:web + package.json live there).
 */
const COOP = "same-origin";
const COEP = "require-corp";

/**
 * Strict CSP — the browser-enforced backbone of the "nothing leaves the device" promise (TR-01).
 * `connect-src` is locked to self + the model/runtime asset hosts so PII cannot be exfiltrated even if
 * a bundled dependency were compromised (these hosts serve GETs for the model + wasm; PII is never
 * sent anywhere). `wasm-unsafe-eval` is needed by onnxruntime-web; `worker-src blob:` for its workers.
 *
 * Hosts (verified live 2026-08-04): huggingface.co (model resolve) + *.hf.co (the actual model bytes
 * now come from the Xet CDN, e.g. us.aws.cdn.hf.co — regional, hence the wildcard) + cdn.jsdelivr.net
 * (onnxruntime-web wasm binaries, transformers.js default `wasmPaths`).
 *
 * HARDENING (P4-02): self-host the model on R2 AND vendor the ORT wasm locally, then collapse
 * `connect-src` to `'self'` — removing every third-party runtime dependency. Keep in sync with
 * the repo-root vercel.json.
 */
const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  // blob: — onnxruntime-web's threaded backend executes its worker bootstrap from a blob URL (the
  // blob is minted same-origin via createObjectURL, so this does not widen the origin's trust).
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "worker-src 'self' blob:",
  // blob: — onnxruntime-web's threaded backend fetches its wasm / spawns workers via blob URLs.
  "connect-src 'self' blob: https://huggingface.co https://*.hf.co https://cdn.jsdelivr.net",
  // WebRTC reaches hosts outside connect-src (ICE/STUN/data channels) — block it outright; the app
  // has no WebRTC use. Belt to the monitor's RTCPeerConnection suspenders (lib/networkMonitor.ts).
  "webrtc 'block'",
].join("; ");

/**
 * `withCsp` controls whether the strict CSP is attached. The dev server injects INLINE scripts and
 * uses eval for HMR/react-refresh, which the strict `script-src 'self'` would block (blank page), so
 * dev sets only COOP/COEP. Preview mirrors production (vercel.json) with the full CSP.
 */
function isolationHeaders(withCsp: boolean) {
  return (_req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    res.setHeader("Cross-Origin-Opener-Policy", COOP);
    res.setHeader("Cross-Origin-Embedder-Policy", COEP);
    // Defense in depth, mirrored in vercel.json: no MIME sniffing, and never leak the page URL in a
    // Referer header (belt to the connect-src suspenders — even allowed hosts learn nothing).
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (withCsp) {
      res.setHeader("Content-Security-Policy", CSP);
    }
    next();
  };
}

function securityHeaders(): Plugin {
  return {
    name: "mechikon-security-headers",
    configureServer(server) {
      server.middlewares.use(isolationHeaders(false)); // dev: COOP/COEP only (HMR needs inline/eval)
    },
    configurePreviewServer(server) {
      server.middlewares.use(isolationHeaders(true)); // preview mirrors prod (full CSP)
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // ES-module workers so the engine worker can code-split (lazy-import mammoth/xlsx/mupdf on demand).
  worker: { format: "es" },
  plugins: [react(), securityHeaders()],
  resolve: {
    alias: {
      "@engine": fileURLToPath(new URL("../engine/src", import.meta.url)),
    },
  },
  build: {
    // es2022 for top-level await (mupdf's wasm loader uses it).
    target: "es2022",
    outDir: fileURLToPath(new URL("../dist-web", import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      // Multi-page: the app (index.html) + self-contained static legal pages (terms.html at
      // /terms.html, accessibility.html at /accessibility.html). No router, no runtime cost to the
      // app — the static pages ship no JS.
      input: {
        main: resolve(fileURLToPath(new URL(".", import.meta.url)), "index.html"),
        terms: resolve(fileURLToPath(new URL(".", import.meta.url)), "terms.html"),
        accessibility: resolve(fileURLToPath(new URL(".", import.meta.url)), "accessibility.html"),
        // Privacy policy for the Chrome extension (required by the Web Store listing). Static, no JS.
        "extension-privacy": resolve(
          fileURLToPath(new URL(".", import.meta.url)),
          "extension-privacy.html",
        ),
        // Early-access signup for the Chrome extension. Ships its own small JS module (unlike the
        // static legal pages) and talks to Supabase; its relaxed CSP lives in the repo-root vercel.json.
        waitlist: resolve(fileURLToPath(new URL(".", import.meta.url)), "waitlist.html"),
      },
    },
  },
  optimizeDeps: {
    esbuildOptions: { target: "es2022" },
    // mupdf loads its wasm via `new URL("mupdf-wasm.wasm", import.meta.url)`. When Vite pre-bundles it
    // into .vite/deps that URL 404s in dev (the SPA fallback returns index.html, not wasm). Excluding
    // it keeps mupdf served from node_modules so the relative wasm path resolves. Dev-only; the
    // production build bundles the wasm correctly either way.
    exclude: ["mupdf"],
  },
});
