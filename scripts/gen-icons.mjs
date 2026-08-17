// Generate Chrome extension icons (16/32/48/128) from the mechikon mascot logo, using Playwright to
// rasterize — no image-library dependency. Source logo is the same brand mark as the web app.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "web", "public", "logo.png");
const outDir = path.join(root, "public", "icons");
fs.mkdirSync(outDir, { recursive: true });
const b64 = fs.readFileSync(src).toString("base64");

const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>*{margin:0;padding:0}html,body{width:${size}px;height:${size}px;background:#fff}` +
      `img{width:${size}px;height:${size}px;object-fit:contain;background:#fff}</style>` +
      `<img src="data:image/png;base64,${b64}">`,
  );
  const buf = await page.locator("img").screenshot();
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), buf);
  console.log(`wrote icon-${size}.png`);
}
await browser.close();
