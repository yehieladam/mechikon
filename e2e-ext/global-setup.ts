/**
 * Build the extension WITH the e2e-only localhost content-script match (MECHIKON_E2E), so the fixture
 * page on :5599 gets the inline content script. Runs once before the suite; the flag is read in
 * src/manifest.config.ts and never present in a normal build.
 */
import { execSync } from "node:child_process";

export default function globalSetup(): void {
  execSync("npm run build", { stdio: "inherit", env: { ...process.env, MECHIKON_E2E: "1" } });
}
