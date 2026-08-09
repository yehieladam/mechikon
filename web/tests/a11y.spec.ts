import { test, expect } from "./fixtures";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

/**
 * Automated accessibility gate. ת"י 5568 references WCAG 2.0 Level AA, so we scan against the
 * `wcag2a` + `wcag2aa` rule tags (axe's WCAG 2.0 A/AA set). Runs in CI via test:e2e alongside the
 * other core specs (no @model tag -> no 185 MB model download). A regression that reintroduces an
 * unlabeled control, a low-contrast text color, or a broken heading order fails the build.
 */
const WCAG_TAGS = ["wcag2a", "wcag2aa"];

async function scan(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  // Map to a compact, human-readable shape so a failing assertion names the rule + count instead of
  // dumping the full axe node tree.
  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.length,
  }));
}

test.describe('accessibility — WCAG 2.0 AA (ת"י 5568)', () => {
  test("app landing page has no violations", async ({ page }) => {
    await page.goto("/");
    expect(await scan(page)).toEqual([]);
  });

  test("app result state (after redaction) has no violations", async ({ page }) => {
    await page.goto("/");
    await page.fill("textarea", "לקוח דנה כהן בטלפון 052-1234567");
    await page.getByRole("button", { name: "השחרת המסמך" }).click();
    // The deterministic path renders a phone placeholder with no model load — this brings the whole
    // result UI (chips, download, key card, preview) into the DOM for the scan.
    await expect(page.getByRole("button", { name: "[PHONE_1]", exact: true })).toBeVisible({
      timeout: 15_000,
    });
    expect(await scan(page)).toEqual([]);
  });

  test("terms page has no violations", async ({ page }) => {
    await page.goto("/terms.html");
    expect(await scan(page)).toEqual([]);
  });

  test("accessibility statement page has no violations", async ({ page }) => {
    await page.goto("/accessibility.html");
    expect(await scan(page)).toEqual([]);
  });
});
