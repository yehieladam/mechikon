import { defineManifest } from "@crxjs/vite-plugin";

// Manifest SOURCE for the NEW Vite/crxjs build only (output: dist/manifest.json).
// It deliberately lives under src/ so it never clobbers the hand-built spike's
// extension/manifest.json, which stays loadable until P2-01 (docs/tasks.md).
//
// MV3 constraints carried from docs/chrome-extension-plan.md section 3:
// - 'wasm-unsafe-eval' is required for onnxruntime-web WASM.
// - connect-src lists the model host only (HF CDN for now; P4-02 switches to self-host).
// - Zero permissions: a paste/upload popup needs none — keep it that way (Store trust).
export default defineManifest({
  manifest_version: 3,
  name: "מחיקון · Mechikon — Hebrew PII Anonymizer",
  version: "0.1.0",
  description:
    "Mask Hebrew & Israeli personal details before sending them to AI chats — 100% in your browser. Nothing leaves your device.",
  icons: {
    16: "icons/icon-16.png",
    32: "icons/icon-32.png",
    48: "icons/icon-48.png",
    128: "icons/icon-128.png",
  },
  action: {
    default_popup: "src/popup/index.html",
    default_icon: {
      16: "icons/icon-16.png",
      32: "icons/icon-32.png",
      48: "icons/icon-48.png",
      128: "icons/icon-128.png",
    },
  },
  permissions: ["storage", "offscreen"],
  // Lets the extension fetch the NER model cross-origin from HF without CORS ("Failed to fetch"):
  // connect-src in the CSP allows the request, but host_permissions is what bypasses CORS. Weights
  // redirect to the regional *.hf.co Xet CDN, so both hosts are listed. No user data is ever sent.
  host_permissions: [
    "https://huggingface.co/*",
    "https://*.huggingface.co/*",
    "https://*.hf.co/*",
  ],
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  // Inline redaction inside AI chat composers. Fixed host list (Store trust) — never <all_urls>.
  // The deterministic engine is pure JS and runs in the content script's isolated world; no host
  // permissions needed beyond these matches, and no model (NER is added later via an offscreen doc).
  content_scripts: [
    {
      matches: [
        "https://chatgpt.com/*",
        "https://chat.openai.com/*",
        "https://claude.ai/*",
        "https://gemini.google.com/*",
        // E2E-only: injected on localhost when MECHIKON_E2E is set at build time. Never in a real build.
        ...(process.env.MECHIKON_E2E ? ["http://localhost:5599/*"] : []),
      ],
      js: ["src/content/index.ts"],
      run_at: "document_idle",
    },
  ],
  content_security_policy: {
    // MV3 forbids blob: in worker-src and is strict here. ORT runs single-threaded (numThreads 1), so no
    // blob worker is needed. Model weights download over HF (redirect to the regional *.hf.co Xet CDN);
    // the ORT runtime is vendored locally (script-src 'self'), so no CDN is allowed for code.
    extension_pages:
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' https://huggingface.co https://*.huggingface.co https://*.hf.co",
  },
});
