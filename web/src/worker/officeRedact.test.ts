/**
 * Integration test for overlay redaction — builds a REAL .docx / .xlsx zip (with a media file that
 * stands in for a logo), redacts it, and asserts: PII is replaced with placeholders, the original PII
 * is gone, and every non-text part (the "logo") survives byte-for-byte. This is the proof of the core
 * promise: we overlay the original file, we do not regenerate it.
 *
 * Runs in node (jszip works there); the only browser-only piece is the download anchor in App.tsx.
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { restore } from "@engine/restore";
import { redactDocx, redactXlsx, XLSX_FORMULA_PII, OFFICE_SELFVERIFY_FAILED } from "./officeRedact";
import { restoreFile } from "./restoreFile";

/** Wrap worksheet rows in a valid sheet part; optionally add a shared-string table. */
async function buildXlsxWith(sheetInner: string, sharedStrings?: string): Promise<ArrayBuffer> {
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetInner}</sheetData></worksheet>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("xl/worksheets/sheet1.xml", sheet);
  if (sharedStrings !== undefined) {
    zip.file("xl/sharedStrings.xml", sharedStrings);
  }
  return zip.generateAsync({ type: "arraybuffer" });
}

async function sheetOut(bytes: Uint8Array): Promise<string> {
  return (await JSZip.loadAsync(bytes)).file("xl/worksheets/sheet1.xml")!.async("string");
}

const LOGO_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);

/** A minimal docx whose phone is split across three `<w:t>` runs (as Word routinely does). */
async function buildDocx(): Promise<ArrayBuffer> {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t xml:space="preserve">שם הלקוח בטלפון </w:t></w:r><w:r><w:t>052-</w:t></w:r><w:r><w:t>1234</w:t></w:r><w:r><w:t>567</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">ת&quot;ז 123456709 ודוא&quot;ל test@example.co.il</w:t></w:r></w:p>
  </w:body>
</w:document>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("word/document.xml", document);
  zip.file("word/media/image1.png", LOGO_BYTES); // the "logo" — must be preserved untouched
  return zip.generateAsync({ type: "arraybuffer" });
}

/** A minimal xlsx with two shared strings, one carrying an Israeli ID. */
async function buildXlsx(): Promise<ArrayBuffer> {
  const shared = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">
  <si><t>כותרת</t></si>
  <si><t>מספר זהות 123456709</t></si>
</sst>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("xl/sharedStrings.xml", shared);
  zip.file("xl/media/image1.png", LOGO_BYTES);
  return zip.generateAsync({ type: "arraybuffer" });
}

describe("redactDocx", () => {
  it("overlays placeholders, drops the original PII, and preserves the logo", async () => {
    const { bytes, result } = await redactDocx(await buildDocx());

    const out = await JSZip.loadAsync(bytes);
    const document = await out.file("word/document.xml")!.async("string");

    // PII replaced with the Hebrew placeholders...
    expect(document).toContain("[PHONE_1]");
    expect(document).toContain("[ID_1]");
    expect(document).toContain("[EMAIL_1]");
    // ...and the raw values are gone (the phone even though it was split across three runs).
    expect(document).not.toContain("1234567");
    expect(document).not.toContain("123456709");
    expect(document).not.toContain("test@example.co.il");

    // The logo survives byte-for-byte — we overlaid, we did not rebuild.
    const logo = await out.file("word/media/image1.png")!.async("uint8array");
    expect(Array.from(logo)).toEqual(Array.from(LOGO_BYTES));

    // The key is coherent and restore reverses the concatenated stream exactly.
    expect(result.key.length).toBe(3);
    expect(restore(result.anonymizedText, result.key).restoredText).toContain("123456709");
  });
});

describe("redactXlsx", () => {
  it("overlays placeholders into shared strings and preserves other parts", async () => {
    const { bytes, result } = await redactXlsx(await buildXlsx());

    const out = await JSZip.loadAsync(bytes);
    const shared = await out.file("xl/sharedStrings.xml")!.async("string");

    expect(shared).toContain("[ID_1]");
    expect(shared).not.toContain("123456709");
    expect(shared).toContain("כותרת"); // untouched string stays
    expect(result.key.length).toBe(1);

    const logo = await out.file("xl/media/image1.png")!.async("uint8array");
    expect(Array.from(logo)).toEqual(Array.from(LOGO_BYTES));
  });

  it("redacts INLINE worksheet strings, not only the shared-string table (no silent leak)", async () => {
    // Some generators write cell text inline (<c t="inlineStr"><is><t>) instead of the shared table.
    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>מספר זהות 123456709</t></is></c></row>
  </sheetData>
</worksheet>`;
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("xl/worksheets/sheet1.xml", sheet);
    const buffer = await zip.generateAsync({ type: "arraybuffer" });

    const { bytes, result } = await redactXlsx(buffer);
    const out = await JSZip.loadAsync(bytes);
    const rewritten = await out.file("xl/worksheets/sheet1.xml")!.async("string");

    expect(rewritten).toContain("[ID_1]");
    expect(rewritten).not.toContain("123456709");
    expect(result.key.length).toBe(1);
  });
});

describe("redactOffice — self-verify (fail closed)", () => {
  const BODY_DOC = (text: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:body>
</w:document>`;

  it("6. refuses when a detected value also survives in a part the redactor never rewrites", async () => {
    // Same ID in the body (detected → in the key) AND in word/settings.xml (neither redacted nor
    // sanitized — a genuinely unhandled channel, so the backstop must fire).
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", BODY_DOC("לקוח 123456709"));
    zip.file("word/settings.xml", `<w:settings xmlns:w="w"><w:note>123456709</w:note></w:settings>`);
    const buffer = await zip.generateAsync({ type: "arraybuffer" });
    await expect(redactDocx(buffer)).rejects.toThrow(OFFICE_SELFVERIFY_FAILED);
  });

  it("7. passes a normal docx and no original value survives in any output part", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", BODY_DOC("לקוח 123456709 בטלפון 052-1234567"));
    const buffer = await zip.generateAsync({ type: "arraybuffer" });

    const { bytes } = await redactDocx(buffer);
    const out = await JSZip.loadAsync(bytes);
    for (const name of Object.keys(out.files)) {
      if (!out.files[name].dir && /\.(xml|rels)$/i.test(name)) {
        const content = await out.files[name].async("string");
        expect(content).not.toContain("123456709");
        expect(content).not.toContain("1234567");
      }
    }
  });
});

describe("redactOffice — metadata strip + comment routing (2b)", () => {
  const DOC = (text: string) => `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:body></w:document>`;

  it("7. routes docx comment body text through the key, coherent with the document body", async () => {
    const comments = `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="1" w:author="יעל"><w:p><w:r><w:t xml:space="preserve">לגבי 123456709</w:t></w:r></w:p></w:comment></w:comments>`;
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", DOC("לקוח 123456709"));
    zip.file("word/comments.xml", comments);
    const { bytes, result } = await redactDocx(await zip.generateAsync({ type: "arraybuffer" }));

    // One value, one key row — coherent across body and comment.
    expect(result.key.filter((r) => r.original === "123456709")).toHaveLength(1);
    const out = await JSZip.loadAsync(bytes);
    expect(await out.file("word/comments.xml")!.async("string")).toContain("[ID_1]");
    expect(await out.file("word/comments.xml")!.async("string")).toContain('w:author=""');

    // Restore brings both occurrences (body + comment) back.
    const restored = await restoreFile("d.docx", bytes.buffer.slice(0) as ArrayBuffer, result.key);
    const rdoc = await JSZip.loadAsync(restored.bytes);
    expect(await rdoc.file("word/document.xml")!.async("string")).toContain("123456709");
    expect(await rdoc.file("word/comments.xml")!.async("string")).toContain("123456709");
  });

  it("8. routes xlsx legacy comment text through the key", async () => {
    const comments = `<comments><authors><author>משה</author></authors><commentList><comment ref="A1" authorId="0"><text><r><t>מספר 123456709</t></r></text></comment></commentList></comments>`;
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`);
    zip.file("xl/comments1.xml", comments);
    const { bytes } = await redactXlsx(await zip.generateAsync({ type: "arraybuffer" }));
    const out = await JSZip.loadAsync(bytes);
    const commentsOut = await out.file("xl/comments1.xml")!.async("string");
    expect(commentsOut).toContain("[ID_1]");
    expect(commentsOut).not.toContain("123456709");
    expect(commentsOut).toContain("<author></author>"); // author blanked
  });

  it("9. the previously-refused file now downloads clean (metadata blanked before the backstop)", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", DOC("לקוח 123456709"));
    zip.file("docProps/core.xml", `<cp:coreProperties xmlns:cp="c" xmlns:dc="d"><dc:creator>123456709</dc:creator></cp:coreProperties>`);
    // Was throwing OFFICE_SELFVERIFY_FAILED in 2a; now returns bytes.
    const { bytes } = await redactDocx(await zip.generateAsync({ type: "arraybuffer" }));
    const core = await (await JSZip.loadAsync(bytes)).file("docProps/core.xml")!.async("string");
    expect(core).toContain("<dc:creator></dc:creator>");
    expect(core).not.toContain("123456709");
  });

  it("10. still fails closed for a value surviving in a genuinely unhandled part", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", DOC("לקוח 123456709"));
    zip.file("customXml/item1.xml", `<root>123456709</root>`); // neither redacted nor sanitized
    await expect(redactDocx(await zip.generateAsync({ type: "arraybuffer" }))).rejects.toThrow(
      OFFICE_SELFVERIFY_FAILED,
    );
  });
});

describe("redactOffice — embedded objects (B4, fail closed)", () => {
  const BODY = (text: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:body>
</w:document>`;

  it("B4. refuses a docx that embeds an OOXML object holding a PII table (neither redacted nor scanned)", async () => {
    // The embedded xlsx is a whole nested zip — its bytes (with the ID) are copied verbatim into the
    // outer docx and never touched by the overlay/self-verify. Silently shipping it leaks the table.
    const embedded = new JSZip();
    embedded.file("[Content_Types].xml", "<Types/>");
    embedded.file(
      "xl/sharedStrings.xml",
      `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>מספר זהות 123456709</t></si></sst>`,
    );
    const embeddedBytes = await embedded.generateAsync({ type: "uint8array" });

    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", BODY("ראה קובץ מצורף"));
    zip.file("word/embeddings/Microsoft_Excel_Worksheet1.xlsx", embeddedBytes);
    await expect(redactDocx(await zip.generateAsync({ type: "arraybuffer" }))).rejects.toThrow(
      OFFICE_SELFVERIFY_FAILED,
    );
  });

  it("B4. refuses a docx that embeds a legacy OLE object (oleObject1.bin)", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", BODY("שלום"));
    zip.file("word/embeddings/oleObject1.bin", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3]));
    await expect(redactDocx(await zip.generateAsync({ type: "arraybuffer" }))).rejects.toThrow(
      OFFICE_SELFVERIFY_FAILED,
    );
  });
});

describe("redactDocx — tracked changes + fields (silent-leak fix)", () => {
  const DOC = (bodyInner: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${bodyInner}</w:body>
</w:document>`;

  it("redacts an ID retained inside <w:delText> (tracked deletion), not just visible <w:t>", async () => {
    // A tracked deletion keeps the deleted text in the file as <w:delText> — invisible in Word's final
    // view but present in the bytes. Currently only <w:t> is collected, so this ID sails through.
    const doc = DOC(
      `<w:p><w:del w:id="1" w:author="עו״ד"><w:r><w:delText xml:space="preserve">מספר זהות 123456709</w:delText></w:r></w:del></w:p>`,
    );
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", doc);
    const { bytes, result } = await redactDocx(await zip.generateAsync({ type: "arraybuffer" }));
    const out = await (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
    expect(out).toContain("[ID_1]");
    expect(out).not.toContain("123456709");
    expect(result.key.map((r) => r.original)).toContain("123456709");
  });

  it("redacts an email carried in a field instruction (<w:instrText>)", async () => {
    const doc = DOC(
      `<w:p><w:r><w:instrText xml:space="preserve"> HYPERLINK "mailto:test@example.co.il" </w:instrText></w:r></w:p>`,
    );
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", doc);
    const { bytes } = await redactDocx(await zip.generateAsync({ type: "arraybuffer" }));
    const out = await (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
    expect(out).toContain("[EMAIL_1]");
    expect(out).not.toContain("test@example.co.il");
  });
});

describe("redactXlsx — numeric cells (the silent-leak fix)", () => {
  it("1. redacts a 9-digit ID stored as a NUMBER and keeps the restore mapping", async () => {
    const { bytes, result } = await redactXlsx(
      await buildXlsxWith(`<row r="1"><c r="A1"><v>123456709</v></c></row>`),
    );
    const out = await sheetOut(bytes);
    expect(out).toContain('t="inlineStr"');
    expect(out).toContain("[ID_1]");
    expect(out).not.toContain("123456709");
    expect(result.key.map((r) => r.type)).toContain("ISRAELI_ID");
    expect(restore("[ID_1]", result.key).restoredText).toBe("123456709");
  });

  it("2. restores the leading zero dropped by numeric storage (8-digit → valid 9-digit ID)", async () => {
    // 012345674 is a checksum-valid ID (and not a valid phone — 01 is not an area code); stored as a
    // number it loses the leading zero (12345674).
    const { bytes, result } = await redactXlsx(
      await buildXlsxWith(`<row r="1"><c r="A1"><v>12345674</v></c></row>`),
    );
    const out = await sheetOut(bytes);
    expect(out).toContain("[ID_1]");
    expect(out).not.toContain("12345674");
    expect(result.key[0].original).toBe("012345674");
  });

  it("3. leaves a shared-string INDEX cell (t=\"s\") byte-identical while redacting shared text", async () => {
    const shared = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>מספר זהות 123456709</t></si></sst>`;
    const { bytes } = await redactXlsx(
      await buildXlsxWith(`<row r="1"><c r="A1" t="s"><v>0</v></c></row>`, shared),
    );
    const out = await sheetOut(bytes);
    // The index cell is untouched (still points at shared string 0)…
    expect(out).toContain('<c r="A1" t="s"><v>0</v></c>');
    // …and the shared string itself is redacted.
    const sharedOut = await (await JSZip.loadAsync(bytes)).file("xl/sharedStrings.xml")!.async("string");
    expect(sharedOut).toContain("[ID_1]");
    expect(sharedOut).not.toContain("123456709");
  });

  it("4. leaves ordinary numbers untouched (no inline-string conversion)", async () => {
    const sheet = `<row r="1"><c r="A1"><v>42</v></c><c r="A2"><v>3.14</v></c><c r="A3"><v>123456700</v></c></row>`;
    const { bytes, result } = await redactXlsx(await buildXlsxWith(sheet));
    const out = await sheetOut(bytes);
    expect(out).not.toContain("inlineStr");
    expect(out).toContain("<v>42</v>");
    expect(out).toContain("<v>3.14</v>");
    expect(out).toContain("<v>123456700</v>"); // 9 digits but checksum-invalid → not an ID
    expect(result.key.length).toBe(0);
  });

  it("5. preserves the cell's r and s attributes through the conversion", async () => {
    const { bytes } = await redactXlsx(
      await buildXlsxWith(`<row r="1"><c r="B2" s="4"><v>123456709</v></c></row>`),
    );
    const out = await sheetOut(bytes);
    expect(out).toMatch(/<c r="B2" s="4" t="inlineStr">/);
  });

  it("6. refuses (throws) an xlsx whose PII sits in a FORMULA cell", async () => {
    const sheet = `<row r="1"><c r="A1"><f>B1&amp;C1</f><v>123456709</v></c></row>`;
    await expect(redactXlsx(await buildXlsxWith(sheet))).rejects.toThrow(XLSX_FORMULA_PII);
  });

  it("7. leaves no original ID digits anywhere in the output part", async () => {
    const { bytes } = await redactXlsx(
      await buildXlsxWith(`<row r="1"><c r="A1"><v>40493389</v></c></row>`),
    );
    const out = await sheetOut(bytes);
    expect(out).not.toContain("40493389");
    expect(out).not.toContain("040493389");
  });

  it("8. numbers text (sharedString phone) and numeric (ID) cells coherently", async () => {
    const shared = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>טלפון 052-1234567</t></si></sst>`;
    const { result } = await redactXlsx(
      await buildXlsxWith(`<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>123456709</v></c></row>`, shared),
    );
    const types = result.key.map((r) => r.type).sort();
    expect(types).toEqual(["IL_PHONE", "ISRAELI_ID"]);
    // Distinct, non-colliding placeholders.
    const placeholders = result.key.map((r) => r.placeholder);
    expect(new Set(placeholders).size).toBe(placeholders.length);
  });
});
