/**
 * Restore-file round-trip (node, real JSZip): redact a .docx, then restore the redacted file with its
 * key and assert the original values are back and the placeholders are gone — the workflow of
 * redact → (AI edits the file) → restore, proven end to end without an AI in the loop.
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { redactDocx, redactXlsx } from "./officeRedact";
import { restoreFile, RESTORE_UNSUPPORTED } from "./restoreFile";
import { anonymizeDeterministic } from "@engine/pipeline";

async function buildDocx(): Promise<ArrayBuffer> {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t xml:space="preserve">לקוח מספר 123456709 בטלפון 052-1234567</w:t></w:r></w:p>
  </w:body>
</w:document>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("word/document.xml", document);
  return zip.generateAsync({ type: "arraybuffer" });
}

describe("restoreFile — docx round-trip", () => {
  it("puts the original values back into a redacted docx", async () => {
    const { bytes: redacted, result } = await redactDocx(await buildDocx(), anonymizeDeterministic);

    // Sanity: the redacted docx holds placeholders, not the originals.
    const redactedDoc = await JSZip.loadAsync(redacted);
    const redactedXml = await redactedDoc.file("word/document.xml")!.async("string");
    expect(redactedXml).toContain("[ID_1]");
    expect(redactedXml).not.toContain("123456709");

    // Restore the redacted file with its key.
    const restored = await restoreFile("doc.docx", redacted.buffer.slice(0) as ArrayBuffer, result.key);
    const restoredDoc = await JSZip.loadAsync(restored.bytes);
    const restoredXml = await restoredDoc.file("word/document.xml")!.async("string");

    expect(restoredXml).toContain("123456709");
    expect(restoredXml).toContain("052-1234567");
    expect(restoredXml).not.toContain("[ID_1]");
    expect(restoredXml).not.toContain("[PHONE_1]");
    expect(restored.unmatched).toHaveLength(0);
  });

  it("restores a plain .txt file", async () => {
    const { bytes: redacted, result } = await redactDocx(await buildDocx(), anonymizeDeterministic);
    // Take the redacted text and restore it as a txt payload.
    const redactedDoc = await JSZip.loadAsync(redacted);
    const xml = await redactedDoc.file("word/document.xml")!.async("string");
    const placeholders = (xml.match(/\[[^\]]+_\d+\]/g) ?? []).join(" ");
    const buffer = new TextEncoder().encode(placeholders).buffer;
    const restored = await restoreFile("x.txt", buffer, result.key);
    expect(new TextDecoder().decode(restored.bytes)).toContain("123456709");
  });

  it("restores a .csv file (same plain-text path as .txt)", async () => {
    const { result } = await redactDocx(await buildDocx(), anonymizeDeterministic);
    const buffer = new TextEncoder().encode("שורה,[ID_1],[PHONE_1]").buffer;
    const restored = await restoreFile("data.csv", buffer, result.key);
    const text = new TextDecoder().decode(restored.bytes);
    expect(text).toContain("123456709");
    expect(text).toContain("052-1234567");
    expect(restored.unmatched).toHaveLength(0);
  });

  it("throws RESTORE_UNSUPPORTED for an unsupported type (e.g. pdf)", async () => {
    await expect(restoreFile("x.pdf", new ArrayBuffer(4), [])).rejects.toThrow(RESTORE_UNSUPPORTED);
  });
});

/**
 * A minimal multi-sheet .xlsx: sheet1 carries a phone via the shared-string table (`<si><t>`), sheet2
 * carries an Israeli ID typed as a NUMBER (`<c><v>…</v></c>`) — the two forms redaction rewrites
 * differently (shared string in place vs numeric cell converted to an inline-string placeholder). A
 * correct restore must reverse BOTH, across both sheets.
 */
async function buildXlsx(): Promise<ArrayBuffer> {
  const sharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t xml:space="preserve">טלפון 052-1234567</t></si></sst>`;
  const sheet1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`;
  const sheet2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>123456709</v></c></row></sheetData></worksheet>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("xl/sharedStrings.xml", sharedStrings);
  zip.file("xl/worksheets/sheet1.xml", sheet1);
  zip.file("xl/worksheets/sheet2.xml", sheet2);
  return zip.generateAsync({ type: "arraybuffer" });
}

describe("restoreFile — xlsx round-trip (multi-sheet)", () => {
  it("puts the original values back into a redacted multi-sheet xlsx", async () => {
    const { bytes: redacted, result } = await redactXlsx(await buildXlsx(), anonymizeDeterministic);

    // Sanity: the redacted xlsx holds placeholders, not the originals — the phone in the shared-string
    // table (sheet1) and the ID converted to an inline-string cell (sheet2).
    const redactedDoc = await JSZip.loadAsync(redacted);
    const redactedShared = await redactedDoc.file("xl/sharedStrings.xml")!.async("string");
    const redactedSheet2 = await redactedDoc.file("xl/worksheets/sheet2.xml")!.async("string");
    expect(redactedShared).toContain("[PHONE_1]");
    expect(redactedShared).not.toContain("052-1234567");
    expect(redactedSheet2).toContain("[ID_1]");
    expect(redactedSheet2).not.toContain("123456709");

    // Restore the redacted file with its key.
    const restored = await restoreFile("book.xlsx", redacted.buffer.slice(0) as ArrayBuffer, result.key);
    const restoredDoc = await JSZip.loadAsync(restored.bytes);
    const restoredShared = await restoredDoc.file("xl/sharedStrings.xml")!.async("string");
    const restoredSheet2 = await restoredDoc.file("xl/worksheets/sheet2.xml")!.async("string");

    expect(restoredShared).toContain("052-1234567");
    expect(restoredShared).not.toContain("[PHONE_1]");
    expect(restoredSheet2).toContain("123456709");
    expect(restoredSheet2).not.toContain("[ID_1]");
    expect(restored.unmatched).toHaveLength(0);
  });
});
