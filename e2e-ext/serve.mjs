// Minimal static server for the inline-composer e2e fixture. The extension's content script only
// injects on host matches, so the MECHIKON_E2E build adds http://localhost:5599/* — this serves the
// fixture there. Any path returns the fixture so the content script always runs.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(dir, "fixture.html"));

http
  .createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
  })
  .listen(5599, () => console.log("e2e fixture server on http://localhost:5599"));
