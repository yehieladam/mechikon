import { test, expect } from "./fixtures";
import JSZip from "jszip";

/**
 * Browser smoke for the non-PDF flows, under production headers.
 *
 * The restore round-trip is model-free (deterministic PII only) so it runs in CI. The Office (docx /
 * xlsx) redaction tests are @model: uploading a file loads NER and the app deliberately withholds the
 * download until NER has settled, so nobody saves a half-redacted document — that gate means the file
 * download path can only be exercised with the model present.
 */

const PHONE = "052-1234567";
const ID = "123456709";

/** Minimal but valid .docx (a zip with the two parts Word needs) carrying deterministic PII. */
async function buildDocx(): Promise<Buffer> {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t xml:space="preserve">לקוח בטלפון ${PHONE} ותעודת זהות ${ID}</w:t></w:r></w:p></w:body>
</w:document>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("word/document.xml", document);
  return zip.generateAsync({ type: "nodebuffer" });
}

/** Minimal .xlsx (a zip with a shared-string table) carrying deterministic PII — built with JSZip so no
 * SheetJS dependency is needed (B7: `xlsx` removed for unpatched Prototype-Pollution + ReDoS). Shared
 * strings are the format the overlay redaction targets (redactXlsx). */
async function buildXlsx(): Promise<Buffer> {
  const shared = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">
  <si><t>לקוח</t></si>
  <si><t>טלפון ${PHONE}</t></si>
</sst>`;
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
  <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
</sheetData></worksheet>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("xl/sharedStrings.xml", shared);
  zip.file("xl/worksheets/sheet1.xml", sheet);
  return zip.generateAsync({ type: "nodebuffer" });
}

/** Upload a file to the MAIN upload input, wait for NER to settle, and capture the redacted download. */
async function uploadAndDownload(
  page: import("@playwright/test").Page,
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<Uint8Array> {
  await page.setInputFiles("input[type=file] >> nth=0", file);
  // The download button only appears once NER has settled (the app blocks a half-redacted download).
  const downloadButton = page.getByRole("button", { name: "הורדת הקובץ המושחר" });
  await expect(downloadButton).toBeVisible({ timeout: 260_000 });
  const [download] = await Promise.all([page.waitForEvent("download"), downloadButton.click()]);
  const fs = await import("node:fs");
  return new Uint8Array(fs.readFileSync((await download.path())!));
}

test("restore: paste → redact (in-memory key) → restore brings the originals back", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.fill("textarea", `לקוח בטלפון ${PHONE} ותעודת זהות ${ID}`);
  await page.getByRole("button", { name: "השחרת המסמך" }).click();
  await expect(page.getByRole("button", { name: "[PHONE_1]", exact: true })).toBeVisible({ timeout: 15_000 });

  // The restore box no longer pre-fills (guided flow): copy the redacted text (this also auto-opens the
  // restore panel), read the tokenized text back from the clipboard, paste it in and restore. The
  // in-memory key from the redaction above is active, so the originals come back in the restored panel.
  await page.getByRole("button", { name: /העתקה/ }).first().click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  const tokenized = clip.split("---")[1]?.trim() ?? clip; // the text after the AI-instruction separator
  await page.locator("details textarea").fill(tokenized);
  await page.getByRole("button", { name: "שחזור", exact: true }).click();
  // Scope the assertions to the restore panel: the main input textarea still holds the raw original, and
  // the restore box's input holds the tokens, so only the restored OUTPUT carries the raw values here.
  const panel = page.locator("details");
  await expect(panel.getByText(PHONE, { exact: false })).toBeVisible({ timeout: 10_000 });
  await expect(panel.getByText(ID, { exact: false })).toBeVisible();
});

test("manual-only: redacts only the chosen term, leaves auto PII, never loads the model", async ({
  page,
}) => {
  // Manual-only must NOT request the 185MB names model — fail if any model host is hit.
  const modelRequests: string[] = [];
  page.on("request", (req) => {
    const { hostname } = new URL(req.url());
    if (/huggingface\.co|hf\.co|jsdelivr\.net/.test(hostname)) modelRequests.push(hostname);
  });

  await page.goto("/");
  await page.getByRole("button", { name: "בחירה ידנית", exact: true }).click(); // switch to manual-only
  await page.fill("textarea", `דוד כהן ותעודת זהות ${ID}`);
  await page.getByRole("button", { name: "השחרת המסמך" }).click();

  // Add the only thing to redact: the user's chosen term.
  await page.getByRole("button", { name: "+ הוספה ידנית" }).click();
  await page.fill("input[placeholder^='מילה או מספר']", "דוד כהן");
  await page.getByRole("button", { name: "הוספה", exact: true }).click();

  // The chosen term is a manual token; the valid ID renders as a plain clickable word (not redacted).
  await expect(page.getByRole("button", { name: "[TERM_1]", exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("button", { name: ID, exact: true })).toBeVisible(); // raw ID survives
  await expect(page.locator("button").filter({ hasText: /\[ID_/ })).toHaveCount(0); // ID not auto-detected
  expect(modelRequests).toEqual([]); // and the 185MB model was never requested
});

test("click-to-redact: click a word to redact it, click the token to undo (manual-only, no model)", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "בחירה ידנית", exact: true }).click(); // manual-only, model-free, everything clickable
  await page.fill("textarea", "דוד כהן גר בעיר");
  await page.getByRole("button", { name: "השחרת המסמך" }).click();

  // The preview renders each word as a clickable button. Click one to redact it everywhere.
  await page.getByRole("button", { name: "כהן", exact: true }).click();
  const token = page.getByRole("button", { name: "[TERM_1]", exact: true });
  await expect(token).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "כהן", exact: true })).toHaveCount(0);

  // Click the (amber) manual token to UNDO — the word comes back, the token is gone.
  await token.click();
  await expect(page.getByRole("button", { name: "כהן", exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "[TERM_1]", exact: true })).toHaveCount(0);
});

test("custom name: a named manual term emits [CLIENT_1]; the label input blocks Hebrew/digits", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "בחירה ידנית", exact: true }).click(); // manual-only, model-free
  await page.fill("textarea", "התובע דוד כהן");
  await page.getByRole("button", { name: "השחרת המסמך" }).click();
  await page.getByRole("button", { name: "+ הוספה ידנית" }).click();
  await page.fill("input[placeholder^='מילה או מספר']", "דוד כהן");

  // The label field sanitizes to uppercase A–Z: Hebrew + digits are stripped so the user can't enter a
  // name that would fail to render on the PDF.
  const label = page.getByPlaceholder("שם (אנגלית)");
  await label.fill("client123דוד");
  await expect(label).toHaveValue("CLIENT");

  await page.getByRole("button", { name: "הוספה", exact: true }).click();
  await expect(page.getByRole("button", { name: "[CLIENT_1]", exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("button", { name: "[TERM_1]", exact: true })).toHaveCount(0);
});

test("exclusions reset per document: a value revealed in doc A is redacted again in doc B", async ({
  page,
}) => {
  await page.goto("/");
  await page.fill("textarea", "מספר 123456709 בתיק"); // ID auto-detected
  await page.getByRole("button", { name: "השחרת המסמך" }).click();
  await page.getByRole("button", { name: "[ID_1]", exact: true }).click(); // reveal it in doc A
  await expect(page.getByRole("button", { name: "123456709", exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // A NEW document containing the same value must NOT inherit the exclusion.
  await page.fill("textarea", "מסמך חדש עם 123456709");
  await page.getByRole("button", { name: "השחרת המסמך" }).click();
  await expect(page.getByRole("button", { name: "[ID_1]", exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("button", { name: "123456709", exact: true })).toHaveCount(0);
});

test("word/number split: a house number is a separate clickable unit from the street name", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "בחירה ידנית", exact: true }).click(); // manual-only, model-free
  await page.fill("textarea", "רחוב הרצל47 בשנת 1947"); // glued letter+digit must split; 1947 is separate
  await page.getByRole("button", { name: "השחרת המסמך" }).click();

  // "הרצל" and "47" are SEPARATE clickable units; the year "1947" is its own unit.
  await expect(page.getByRole("button", { name: "הרצל", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "47", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "1947", exact: true })).toBeVisible();

  // Clicking only "47" redacts that unit; the street name AND the year "1947" are untouched
  // (no substring over-redaction inside the longer number).
  await page.getByRole("button", { name: "47", exact: true }).click();
  await expect(page.getByRole("button", { name: "[TERM_1]", exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("button", { name: "הרצל", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "1947", exact: true })).toBeVisible();
});

test("reveal: click an auto-detected token to un-redact a false positive", async ({ page }) => {
  await page.goto("/");
  await page.fill("textarea", "מספר לקוח 123456709 בתיק"); // ID auto-detected (deterministic, no model)
  await page.getByRole("button", { name: "השחרת המסמך" }).click();

  const idToken = page.getByRole("button", { name: "[ID_1]", exact: true });
  await expect(idToken).toBeVisible({ timeout: 15_000 });
  await idToken.click(); // reveal → exclude the value

  await expect(page.getByRole("button", { name: "123456709", exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("button", { name: "[ID_1]", exact: true })).toHaveCount(0);
});

test("copy prepends an AI instruction so the tokens survive the round-trip", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.fill("textarea", `לקוח בטלפון ${PHONE}`);
  await page.getByRole("button", { name: "השחרת המסמך" }).click();
  await expect(page.getByRole("button", { name: "[PHONE_1]", exact: true })).toBeVisible({
    timeout: 15_000,
  });

  await page.getByRole("button", { name: /העתקה/ }).click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  // The copied payload leads with the keep-the-tokens instruction and still carries the redacted text.
  expect(clip).toContain("[NAME_1]"); // the instruction shows the token format
  expect(clip).toContain("[PHONE_1]"); // and the actual redacted text follows
  expect(clip).not.toContain(PHONE); // never the raw value
  expect(clip.indexOf("---")).toBeLessThan(clip.indexOf("[PHONE_1]")); // instruction precedes the text
});

test("@model docx + xlsx: redact in place and download a file without the originals", async ({
  page,
}) => {
  await page.goto("/");

  const docxBytes = await uploadAndDownload(page, {
    name: "doc.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: await buildDocx(),
  });
  const docXml = await (await JSZip.loadAsync(docxBytes)).file("word/document.xml")!.async("string");
  expect(docXml).toContain("[PHONE_1]");
  expect(docXml).toContain("[ID_1]");
  expect(docXml).not.toContain(PHONE);
  expect(docXml).not.toContain(ID);

  // NER is cached now, so the second upload's download is immediate.
  const xlsxBytes = await uploadAndDownload(page, {
    name: "book.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: await buildXlsx(),
  });
  const sharedStrings = await (await JSZip.loadAsync(xlsxBytes))
    .file("xl/sharedStrings.xml")!
    .async("string");
  expect(sharedStrings).toContain("[PHONE_1]");
  expect(sharedStrings).not.toContain(PHONE);
});
