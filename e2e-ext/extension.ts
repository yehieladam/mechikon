/**
 * Playwright fixture that loads the REAL built extension (dist/) in a persistent context, so the
 * inline content script runs exactly as it does in Chrome. A fresh temp profile every run keeps the
 * shared restore key from leaking between tests (a stale key silently changed masking behaviour and
 * hid a real bug during manual testing).
 */
import { test as base, chromium, type BrowserContext } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

export const test = base.extend<{ context: BrowserContext }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright's fixture signature requires the {} deps arg
  context: async ({}, use) => {
    // Extensions require a non-headless (or new-headless) Chromium; run headed for the local net.
    const context = await chromium.launchPersistentContext("", {
      headless: false,
      args: [
        `--disable-extensions-except=${distDir}`,
        `--load-extension=${distDir}`,
        "--no-first-run",
      ],
    });
    await use(context);
    await context.close();
  },
});

export const expect = test.expect;
