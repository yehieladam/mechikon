/**
 * Inline manual-redaction smoke tests against the real built extension. These guard the bugs found
 * while debugging Gemini/Claude by hand — bugs the type-checker and build could NOT catch:
 *  - a runtime TDZ crash that killed the whole content script (chip never rendered),
 *  - closestEditable resolving to a per-line inner block instead of the editing host,
 *  - the write guard skipping already-keyed (repeated) values so a click looked broken.
 */
import { test, expect } from "./extension";
import type { Page } from "@playwright/test";

const FIXTURE = "http://localhost:5599/manual.html";
const TOKEN = /\[[A-Za-z]+_\d+\]/;
const INSTRUCTION_MARKER = "הנחיה ל-AI (מחיקון)";

/** innerText of the composer (what the user actually sees, line breaks preserved). */
const composerText = (page: Page): Promise<string> =>
  page.$eval("#composer", (el) => (el as HTMLElement).innerText);

/** Reset the fixture composer back to its original three-line draft (for the reuse test). */
async function resetComposer(page: Page, text: string): Promise<void> {
  await page.$eval("#composer", (el, t) => (el.textContent = t as string), text);
}

/** Click the centre of the first occurrence of `word` inside the composer. */
async function clickWord(page: Page, word: string): Promise<void> {
  const rect = await page.evaluate((w) => {
    const root = document.getElementById("composer");
    if (!root) return null;
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walk.nextNode())) {
      const i = (node.nodeValue ?? "").indexOf(w);
      if (i >= 0) {
        const r = document.createRange();
        r.setStart(node, i);
        r.setEnd(node, i + w.length);
        const b = r.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      }
    }
    return null;
  }, word);
  expect(rect, `word "${word}" should be locatable`).not.toBeNull();
  await page.mouse.click(rect!.x, rect!.y);
}

/** Select the first occurrence of `value` inside the composer and fire mouseup (opens the popover). */
async function selectValue(page: Page, value: string): Promise<void> {
  await page.evaluate((v) => {
    const root = document.getElementById("composer");
    if (!root) return;
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walk.nextNode())) {
      const i = (node.nodeValue ?? "").indexOf(v);
      if (i >= 0) {
        const r = document.createRange();
        r.setStart(node, i);
        r.setEnd(node, i + v.length);
        const s = window.getSelection();
        s?.removeAllRanges();
        s?.addRange(r);
        root.dispatchEvent(new Event("mouseup", { bubbles: true }));
        return;
      }
    }
  }, value);
}

test("chip renders and pick-mode + popover mask across the whole composer", async ({ context }) => {
  const page = context.pages()[0] ?? (await context.newPage());
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(FIXTURE);
  await page.click("#composer");
  // The chip must appear — a content-script crash (e.g. the TDZ bug) would leave it hidden forever.
  await expect(page.locator(".chip")).toBeVisible({ timeout: 5000 });

  // --- pick mode: click the name ---
  await page.getByRole("button", { name: "בחר ידנית" }).click();
  await clickWord(page, "דוד");
  await expect
    .poll(() => composerText(page))
    .not.toContain("דוד"); // the raw name is gone
  expect(await composerText(page)).toMatch(TOKEN); // replaced by a token

  // --- popover: select the ID ---
  await page.keyboard.press("Escape"); // leave pick mode
  await selectValue(page, "203458179");
  await page.getByRole("button", { name: "הסתר בחירה" }).click();
  await expect.poll(() => composerText(page)).not.toContain("203458179");

  const finalText = await composerText(page);
  // The AI instruction is appended exactly ONCE, at the very END — not once per line / per action.
  expect(finalText.split(INSTRUCTION_MARKER).length - 1).toBe(1);
  // A Hebrew draft keeps the HEBREW instruction and Hebrew chip even though the masked text now holds
  // Latin [TOKEN] placeholders (regression: tokens must not flip language to English).
  expect(finalText).toContain("הנחיה ל-AI (מחיקון)");
  expect(finalText).not.toContain("Note to the AI");
  await expect(page.getByRole("button", { name: "בחר ידנית" })).toBeVisible();
  // Later lines survived (host was rewritten, not a single inner block): the email is still there.
  expect(finalText).toContain("david.cohen@gmail.com");

  expect(errors, "no uncaught content-script errors").toEqual([]);
});

test("UI language follows the text: English draft -> English chip + English instruction", async ({
  context,
}) => {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(FIXTURE);
  // Replace the Hebrew draft with an English one, then focus so the chip re-detects the language.
  await page.$eval(
    "#composer",
    (el) => (el.textContent = "Hello, my name is John Smith and my client is Jane Doe."),
  );
  await page.click("#composer");
  await expect(page.locator(".chip")).toBeVisible({ timeout: 5000 });

  // Chip labels are English (the button reads "Select manually", not "בחר ידנית").
  await expect(page.getByRole("button", { name: "Select manually" })).toBeVisible();

  // Hide a word manually; the appended AI instruction must be the ENGLISH one.
  await page.getByRole("button", { name: "Select manually" }).click();
  await clickWord(page, "John");
  await expect.poll(() => composerText(page)).not.toContain("John");
  const text = await composerText(page);
  expect(text).toContain("Note to the AI (Mechikon)"); // English instruction
  expect(text).not.toContain("הנחיה ל-AI"); // not the Hebrew one
});

test("re-masking a value already in the key still writes (repeat-value guard)", async ({ context }) => {
  const page = context.pages()[0] ?? (await context.newPage());
  const original =
    "שלום, קוראים לי דוד כהן ואני גר ברחוב הרצל 15 תל אביב. הטלפון של דוד הוא 050-1234567.";

  await page.goto(FIXTURE);
  await page.click("#composer");
  await expect(page.locator(".chip")).toBeVisible({ timeout: 5000 });

  // Mask "דוד" the first time — mints [TERM_1].
  await page.getByRole("button", { name: "בחר ידנית" }).click();
  await clickWord(page, "דוד");
  await expect.poll(() => composerText(page)).not.toContain("דוד");

  // Reset the draft so "דוד" is present again; the key already maps it (no NEW row will be minted).
  await resetComposer(page, original);
  await page.click("#composer");
  await clickWord(page, "דוד");

  // The old guard (newRows.length > 0) skipped this write; now it must still substitute the value.
  await expect.poll(() => composerText(page)).not.toContain("דוד");
  expect(await composerText(page)).toMatch(TOKEN);
});
