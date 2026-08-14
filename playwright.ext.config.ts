import { defineConfig } from "@playwright/test";

/**
 * Extension e2e harness — loads the REAL built extension in a persistent Chromium context and drives
 * the inline content script against a local composer fixture. Separate from playwright.config.ts (which
 * serves the web app) because extension tests need launchPersistentContext, not the standard page.
 *
 * globalSetup builds dist/ WITH the MECHIKON_E2E localhost match; the webServer serves the fixture on
 * :5599. Runs headed (Chromium loads extensions only outside old headless), so it's a LOCAL safety net,
 * not a CI gate — run with: npm run test:e2e:ext
 */
export default defineConfig({
  testDir: "e2e-ext",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 60_000,
  globalSetup: "./e2e-ext/global-setup.ts",
  webServer: {
    command: "node e2e-ext/serve.mjs",
    url: "http://localhost:5599/manual.html",
    reuseExistingServer: true,
    timeout: 20_000,
  },
});
