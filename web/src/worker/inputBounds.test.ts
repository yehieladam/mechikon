/**
 * Untrusted-input boundary tests (B8): a hostile upload must be REFUSED with a clear error, never
 * allowed to exhaust memory/CPU. Covers the zip-bomb bound on the JSZip paths (office redaction +
 * whole-file restore) and the page-count cap on the PDF paths (digital redact, scan redact, classify).
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { anonymizeDeterministic } from "@engine/pipeline";
import { redactDocx, ZIP_BOMB } from "./officeRedact";
import { restoreFile } from "./restoreFile";
import { MAX_PDF_PAGES, PDF_TOO_MANY_PAGES, assertPageCountWithinCap } from "./pdfLimits";
import { redactPdf, isScannedPdf } from "./pdfRedact";
import { redactScan } from "./scanRedact";

/** A minimal docx whose document.xml inflates to `chars` characters of text. */
async function buildBigDocx(chars: number): Promise<ArrayBuffer> {
  const body = "א".repeat(chars);
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t xml:space="preserve">${body}</w:t></w:r></w:p></w:body>
</w:document>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("word/document.xml", document);
  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
}

/** A raw synthetic PDF with `n` empty pages (mupdf repairs the missing xref — verified). */
function buildManyPagePdf(n: number): ArrayBuffer {
  const firstPageObj = 3;
  const kids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    kids.push(`${firstPageObj + i} 0 R`);
  }
  let pdf = "%PDF-1.4\n";
  pdf += "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n";
  pdf += `2 0 obj << /Type /Pages /Kids [${kids.join(" ")}] /Count ${n} >> endobj\n`;
  for (let i = 0; i < n; i += 1) {
    pdf += `${firstPageObj + i} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\n`;
  }
  pdf += "trailer << /Root 1 0 R >>\n%%EOF\n";
  return new TextEncoder().encode(pdf).buffer as ArrayBuffer;
}

const KEY = [{ placeholder: "[NAME_1]", original: "ישראל", type: "PERSON" as const }];

describe("zip-bomb bound (cumulative inflated size)", () => {
  it("redactDocx refuses a docx whose inflated content exceeds the ceiling", async () => {
    const buffer = await buildBigDocx(100_000); // tiny on disk (DEFLATE), 100k chars inflated
    await expect(redactDocx(buffer, anonymizeDeterministic, 10_000)).rejects.toThrow(ZIP_BOMB);
  });

  it("redactDocx accepts the same docx under a sufficient ceiling", async () => {
    const buffer = await buildBigDocx(1_000);
    const { result } = await redactDocx(buffer, anonymizeDeterministic, 10_000_000);
    expect(result.anonymizedText.length).toBeGreaterThan(0);
  });

  it("restoreFile refuses a docx whose inflated content exceeds the ceiling", async () => {
    const buffer = await buildBigDocx(100_000);
    await expect(restoreFile("big.docx", buffer, KEY, 10_000)).rejects.toThrow(ZIP_BOMB);
  });
});

describe("PDF page-count cap", () => {
  it("assertPageCountWithinCap allows the cap and refuses one page over", () => {
    expect(() => assertPageCountWithinCap(MAX_PDF_PAGES)).not.toThrow();
    expect(() => assertPageCountWithinCap(MAX_PDF_PAGES + 1)).toThrow(PDF_TOO_MANY_PAGES);
  });

  it("redactPdf refuses an absurd page count before walking any page", async () => {
    const buffer = buildManyPagePdf(MAX_PDF_PAGES + 1);
    await expect(redactPdf(buffer, anonymizeDeterministic)).rejects.toThrow(PDF_TOO_MANY_PAGES);
  });

  it("redactScan refuses an absurd page count before any OCR runs", async () => {
    const buffer = buildManyPagePdf(MAX_PDF_PAGES + 1);
    let ocrCalls = 0;
    const ocr = async () => {
      ocrCalls += 1;
      return { words: [], lines: [] } as never;
    };
    const detect = async () => ({ text: "", spans: [], boxes: [] });
    await expect(redactScan(buffer, anonymizeDeterministic, ocr, detect)).rejects.toThrow(
      PDF_TOO_MANY_PAGES,
    );
    expect(ocrCalls).toBe(0); // the whole point: the cap fires BEFORE the expensive loop
  });

  it("isScannedPdf refuses an absurd page count before classifying every page", async () => {
    const buffer = buildManyPagePdf(MAX_PDF_PAGES + 1);
    await expect(isScannedPdf(buffer)).rejects.toThrow(PDF_TOO_MANY_PAGES);
  });
});
