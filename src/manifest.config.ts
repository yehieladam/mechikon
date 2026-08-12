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
  name: "מחיקון — Hebrew PII Anonymizer (dev build)",
  version: "0.1.0",
  description:
    "Anonymize Israeli PII in Hebrew text, fully in your browser. Nothing leaves your device.",
  action: {
    default_popup: "src/popup/index.html",
  },
  content_security_policy: {
    extension_pages:
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' https://huggingface.co https://*.huggingface.co https://*.hf.co",
  },
});
