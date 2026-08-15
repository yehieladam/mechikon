// Package the built extension (dist/) into a single .zip for Chrome Web Store upload.
// Uses jszip (already a dependency). Run AFTER a clean `npm run build`.
import JSZip from "jszip";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
if (!fs.existsSync(path.join(dist, "manifest.json"))) {
  console.error("dist/manifest.json not found — run `npm run build` first.");
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(path.join(dist, "manifest.json"), "utf8"));
if (String(manifest.name).toLowerCase().includes("localhost") || process.env.MECHIKON_E2E) {
  console.error("Refusing to pack an E2E build (localhost match present). Build without MECHIKON_E2E.");
  process.exit(1);
}

const zip = new JSZip();
const add = (dir, base) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.posix.join(base, entry.name);
    if (entry.isDirectory()) add(abs, rel);
    else zip.file(rel, fs.readFileSync(abs));
  }
};
add(dist, "");

const outName = `mechikon-extension-v${manifest.version}.zip`;
const out = path.join(root, outName);
const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
fs.writeFileSync(out, buf);
console.log(`packed ${outName} (${(buf.length / 1024 / 1024).toFixed(1)} MB) — upload this to the Web Store.`);
