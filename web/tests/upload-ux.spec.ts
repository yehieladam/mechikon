import { test, expect } from "./fixtures";
import AxeBuilder from "@axe-core/playwright";

/**
 * Upload UX: the drag-highlight must stay stable while the pointer is over the zone's children (the
 * flicker bug), a dropped file must process and surface a filename chip (the "did anything happen?"
 * complaint), and clearing the chip must return to a pristine input. Runs in automatic mode (fixtures
 * seed it) so a dropped .txt with a phone number produces a deterministic [PHONE_1] with no model.
 */

/** Build a DataTransfer carrying one file, as a handle usable in dispatched drag events. */
async function fileTransfer(page: import("@playwright/test").Page, name: string, content: string) {
  return page.evaluateHandle(
    ([n, c]) => {
      const dt = new DataTransfer();
      dt.items.add(new File([c], n, { type: "text/plain" }));
      return dt;
    },
    [name, content] as const,
  );
}

test("drag highlight stays on while the pointer moves over the textarea (no flicker)", async ({ page }) => {
  await page.goto("/");
  const textarea = page.getByPlaceholder(/הדביקו כאן טקסט/);
  const zone = textarea.locator("xpath=..");
  const dt = await fileTransfer(page, "note.txt", "hi");

  await zone.dispatchEvent("dragenter", { dataTransfer: dt });
  await zone.dispatchEvent("dragover", { dataTransfer: dt });
  await expect(zone).toHaveClass(/border-dashed/);

  // Pointer crosses onto the textarea (a child of the zone) — the old code flickered the highlight off.
  const textareaHandle = await textarea.elementHandle();
  await zone.dispatchEvent("dragleave", { dataTransfer: dt, relatedTarget: textareaHandle });
  await expect(zone).toHaveClass(/border-dashed/);

  // Pointer actually leaves the zone (to <body>) — now the highlight clears.
  const body = await page.locator("body").elementHandle();
  await zone.dispatchEvent("dragleave", { dataTransfer: dt, relatedTarget: body });
  await expect(zone).not.toHaveClass(/border-dashed/);
});

test("dropping a file processes it and shows a filename chip", async ({ page }) => {
  await page.goto("/");
  const textarea = page.getByPlaceholder(/הדביקו כאן טקסט/);
  const zone = textarea.locator("xpath=..");
  const dt = await fileTransfer(page, "note.txt", "טלפון 052-1234567");

  await zone.dispatchEvent("dragenter", { dataTransfer: dt });
  await zone.dispatchEvent("dragover", { dataTransfer: dt });
  await zone.dispatchEvent("drop", { dataTransfer: dt });

  await expect(page.getByRole("button", { name: "[PHONE_1]", exact: true })).toBeVisible({
    timeout: 15_000,
  });
  // The chip is the persistent proof the upload happened; its accessible name carries the filename.
  const chip = page.getByRole("button", { name: /note\.txt/ });
  await expect(chip).toBeVisible();

  // Wait for the result panel's fade-in to settle before scanning — axe against a mid-animation opacity
  // reports transient contrast noise (the steady state is what the a11y gate cares about).
  const resultSection = page
    .locator("section")
    .filter({ has: page.getByRole("button", { name: "[PHONE_1]", exact: true }) });
  await expect
    .poll(async () => resultSection.evaluate((el) => getComputedStyle(el).opacity))
    .toBe("1");

  // No axe violations with the chip + result on screen.
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
});

test("clearing the chip returns to a pristine empty input", async ({ page }) => {
  await page.goto("/");
  const textarea = page.getByPlaceholder(/הדביקו כאן טקסט/);
  const zone = textarea.locator("xpath=..");
  const dt = await fileTransfer(page, "note.txt", "טלפון 052-1234567");
  await zone.dispatchEvent("drop", { dataTransfer: dt });

  const chip = page.getByRole("button", { name: /note\.txt/ });
  await expect(chip).toBeVisible({ timeout: 15_000 });

  await chip.click();
  await expect(chip).toHaveCount(0);
  await expect(textarea).toHaveValue("");
  // Focus must move to the paste box, not fall back to <body>, when the chip unmounts.
  await expect(textarea).toBeFocused();
  await expect(page.getByRole("button", { name: "[PHONE_1]", exact: true })).toHaveCount(0);
  // Submit is disabled again with an empty input.
  await expect(page.getByRole("button", { name: "השחרת המסמך" })).toBeDisabled();
});
