// Copy the onnxruntime-web WASM runtime into public/vendor/ort so the extension loads it LOCALLY.
// MV3 CSP blocks transformers.js's default remote ORT fetch (cdn.jsdelivr.net); the offscreen NER
// init points env.backends.onnx.wasm.wasmPaths at these bundled files instead. Copying from
// node_modules (not downloading) guarantees the version matches the installed transformers/onnxruntime.
import { mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "onnxruntime-web", "dist");
const dest = join(root, "public", "vendor", "ort");

mkdirSync(dest, { recursive: true });

// The wasm device build transformers uses is the "asyncify" variant; copy every ort-wasm-simd-threaded.*
// file so any variant transformers selects at runtime resolves locally.
const files = readdirSync(src).filter((f) => f.startsWith("ort-wasm-simd-threaded."));
if (files.length === 0) {
  throw new Error(`No ORT runtime files found in ${src} — is onnxruntime-web installed?`);
}
for (const file of files) {
  copyFileSync(join(src, file), join(dest, file));
}
console.log(`vendored ${files.length} ORT files -> public/vendor/ort/`);
