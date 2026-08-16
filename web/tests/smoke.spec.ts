import { test, expect } from "./fixtures";

/**
 * Stage-0 smoke: the app loads under the production headers, is crossOriginIsolated (COOP/COEP work),
 * the engine worker is alive (a pasted value is anonymized), and the trust badge reads a true zero.
 * This proves the harness + preview environment before the PDF acceptance tests build on it.
 */
test("app loads, is cross-origin isolated, and the worker anonymizes", async ({ page }) => {
  await page.goto("/");

  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);

  await page.fill("textarea", "לקוח בטלפון 052-1234567");
  await page.getByRole("button", { name: "השחרת המסמך" }).click();

  // The deterministic path is instant — a phone placeholder must appear without any model load.
  await expect(page.getByRole("button", { name: "[PHONE_1]", exact: true })).toBeVisible({ timeout: 15_000 });

  // Trust badge: the main network counter stays a true zero on the deterministic path (0-state copy).
  // The badge lives in the hero (moved out of the header), so assert on the copy, not its container.
  await expect(page.getByText("המידע אינו נשלח לשרתים")).toBeVisible();
});
