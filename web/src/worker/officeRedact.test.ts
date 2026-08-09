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
import { anonymizeManualOnly } from "@engine/pipeline";
import { redactDocx, redactXlsx, XLSX_FORMULA_PII, OFFICE_SELFVERIFY_FAILED, type Anonymize } from "./officeRedact";
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

  /** Build a nested xlsx embed carrying `cellText` in one shared string. */
  async function embeddedXlsx(cellText: string): Promise<Uint8Array> {
    const embedded = new JSZip();
    embedded.file("[Content_Types].xml", "<Types/>");
    embedded.file(
      "xl/sharedStrings.xml",
      `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>${cellText}</t></si></sst>`,
    );
    return embedded.generateAsync({ type: "uint8array" });
  }

  it("B4. refuses a docx that embeds an OOXML object holding a PII table (embed opened + scanned)", async () => {
    const embeddedBytes = await embeddedXlsx("מספר זהות 123456709");
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", BODY("ראה קובץ מצורף"));
    zip.file("word/embeddings/Microsoft_Excel_Worksheet1.xlsx", embeddedBytes);
    await expect(redactDocx(await zip.generateAsync({ type: "arraybuffer" }))).rejects.toThrow(
      OFFICE_SELFVERIFY_FAILED,
    );
  });

  it("B4a. PRODUCES a docx embedding a NON-PII xlsx (chart data), embed passes through byte-identical", async () => {
    // Word stores every native chart's data as word/embeddings/*.xlsx — refusing on presence rejected
    // every charted business doc. A clean embed must pass through untouched.
    const embeddedBytes = await embeddedXlsx("רבעון סכום מכירות");
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", BODY("לקוח 123456709")); // outer HAS PII → gets redacted
    zip.file("word/embeddings/Microsoft_Excel_Worksheet1.xlsx", embeddedBytes);
    const { bytes } = await redactDocx(await zip.generateAsync({ type: "arraybuffer" }));
    const out = await JSZip.loadAsync(bytes);
    const embedOut = await out.file("word/embeddings/Microsoft_Excel_Worksheet1.xlsx")!.async("uint8array");
    expect(Array.from(embedOut)).toEqual(Array.from(embeddedBytes)); // byte-identical
  });

  it("B4b. refuses a docx embedding an xlsx that carries a client ID", async () => {
    const embeddedBytes = await embeddedXlsx("לקוח 040493389 בטבלה");
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", BODY("שלום")); // outer clean; only the embed carries PII
    zip.file("word/embeddings/Microsoft_Excel_Worksheet1.xlsx", embeddedBytes);
    await expect(redactDocx(await zip.generateAsync({ type: "arraybuffer" }))).rejects.toThrow(
      OFFICE_SELFVERIFY_FAILED,
    );
  });

  it("B4c. PRODUCES a docx with a clean oleObject*.bin (legacy equation), byte-scan finds nothing", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", BODY("לקוח 123456709")); // outer PII → gives the byte-scan needles
    zip.file("word/embeddings/oleObject1.bin", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3]));
    const { bytes } = await redactDocx(await zip.generateAsync({ type: "arraybuffer" }));
    const out = await JSZip.loadAsync(bytes);
    expect(await out.file("word/embeddings/oleObject1.bin")!.async("uint8array")).toBeTruthy();
  });

  it("B4d. refuses an oleObject*.bin whose bytes carry an outer needle (UTF-8 byte-scan)", async () => {
    const oleBytes = new TextEncoder().encode("\x00\x00OLEHDR לקוח 123456709 \x00\x00");
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", BODY("לקוח 123456709")); // 123456709 becomes a needle
    zip.file("word/embeddings/oleObject1.bin", oleBytes);
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

describe("redactXlsx — hidden text surfaces (silent-leak fix)", () => {
  const WORKSHEET = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  async function partOut(bytes: Uint8Array, path: string): Promise<string> {
    return (await JSZip.loadAsync(bytes)).file(path)!.async("string");
  }
  async function buildZip(files: Record<string, string>): Promise<ArrayBuffer> {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    for (const [path, content] of Object.entries(files)) {
      zip.file(path, content);
    }
    return zip.generateAsync({ type: "arraybuffer" });
  }

  it("redacts a client name in a worksheet print header (<oddHeader>)", async () => {
    const sheet = `<?xml version="1.0"?><worksheet xmlns="${WORKSHEET}"><sheetData/><headerFooter><oddHeader>&amp;Cלקוח דנה כהן</oddHeader></headerFooter></worksheet>`;
    const detectName: Anonymize = (t) => anonymizeManualOnly(t, ["דנה כהן"]);
    const { bytes } = await redactXlsx(await buildZip({ "xl/worksheets/sheet1.xml": sheet }), detectName);
    const out = await partOut(bytes, "xl/worksheets/sheet1.xml");
    expect(out).not.toContain("דנה כהן");
    expect(out).toMatch(/\[TERM_\d+\]/);
  });

  it("redacts an ID in a threaded comment (xl/threadedComments/*)", async () => {
    const tc = `<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"><threadedComment ref="A1" id="{1}"><text>מספר 123456709</text></threadedComment></ThreadedComments>`;
    const { bytes } = await redactXlsx(
      await buildZip({
        "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet xmlns="${WORKSHEET}"><sheetData/></worksheet>`,
        "xl/threadedComments/threadedComment1.xml": tc,
      }),
    );
    const out = await partOut(bytes, "xl/threadedComments/threadedComment1.xml");
    expect(out).toContain("[ID_1]");
    expect(out).not.toContain("123456709");
  });

  it("redacts a phone in a drawing textbox (xl/drawings/* <a:t>)", async () => {
    const drawing = `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:sp><xdr:txBody><a:p><a:r><a:t>טלפון 052-1234567</a:t></a:r></a:p></xdr:txBody></xdr:sp></xdr:wsDr>`;
    const { bytes } = await redactXlsx(
      await buildZip({
        "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet xmlns="${WORKSHEET}"><sheetData/></worksheet>`,
        "xl/drawings/drawing1.xml": drawing,
      }),
    );
    const out = await partOut(bytes, "xl/drawings/drawing1.xml");
    expect(out).toContain("[PHONE_1]");
    expect(out).not.toContain("1234567");
  });

  it("redacts an ID constant in a <definedName> (xl/workbook.xml)", async () => {
    const workbook = `<workbook xmlns="${WORKSHEET}"><definedNames><definedName name="Client">"123456709"</definedName></definedNames><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`;
    const { bytes } = await redactXlsx(
      await buildZip({
        "xl/workbook.xml": workbook,
        "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet xmlns="${WORKSHEET}"><sheetData/></worksheet>`,
      }),
    );
    const out = await partOut(bytes, "xl/workbook.xml");
    expect(out).toContain("[ID_1]");
    expect(out).not.toContain("123456709");
  });
});

describe("redactXlsx — formula cache PII (full scan, fail closed)", () => {
  it("refuses a formula cell whose cached <v> hides a phone in a MIXED string", async () => {
    // numericPii only fires on a whole-value deterministic match; a cached string result carrying a phone
    // slips past it. The full anonymize must run over the cached <v> so any hit refuses the file.
    const sheet = `<row r="1"><c r="A1" t="str"><f>CONCATENATE(B1,C1)</f><v>טלפון 052-1234567</v></c></row>`;
    await expect(redactXlsx(await buildXlsxWith(sheet))).rejects.toThrow(XLSX_FORMULA_PII);
  });

  it("refuses a formula cell caching a PERSON NAME (full injected anonymize over <v>)", async () => {
    const sheet = `<row r="1"><c r="A1" t="str"><f>VLOOKUP(B1,D:E,2,0)</f><v>דנה כהן</v></c></row>`;
    const detectName: Anonymize = (text) => anonymizeManualOnly(text, ["דנה כהן"]);
    await expect(redactXlsx(await buildXlsxWith(sheet), detectName)).rejects.toThrow(XLSX_FORMULA_PII);
  });

  it("leaves a NON-PII formula cell byte-identical (no false refuse, no conversion)", async () => {
    const sheet = `<row r="1"><c r="A1"><f>SUM(B1:B3)</f><v>42</v></c></row>`;
    const { bytes, result } = await redactXlsx(await buildXlsxWith(sheet));
    const out = await sheetOut(bytes);
    expect(out).toContain("<f>SUM(B1:B3)</f><v>42</v>");
    expect(out).not.toContain("inlineStr");
    expect(result.key.length).toBe(0);
  });
});
