/**
 * mupdf heap hygiene: every PDFDocument opened by the digital-PDF path must be destroy()ed exactly
 * once (WASM heap is not GC'd — an undestroyed document leaks its whole parsed tree per processed
 * file, and a double destroy is a use-after-free class bug). The mock below wraps openDocument to
 * count destroys per instance without changing behavior.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { anonymizeDeterministic } from "@engine/pipeline";

interface TrackedDoc {
  readonly destroyCount: () => number;
}
const opened: TrackedDoc[] = [];

vi.mock("mupdf", async (importOriginal) => {
  // reason: mupdf's WASM surface is untyped; the mock only wraps openDocument to count destroys.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const actual: any = await importOriginal();
  class TrackedPDFDocument extends actual.PDFDocument {
    static openDocument(...args: any[]): any {
      const doc = actual.PDFDocument.openDocument(...args);
      const originalDestroy = doc.destroy.bind(doc);
      let destroys = 0;
      doc.destroy = () => {
        destroys += 1;
        originalDestroy();
      };
      opened.push({ destroyCount: () => destroys });
      return doc;
    }
  }
  return { ...actual, PDFDocument: TrackedPDFDocument };
  /* eslint-enable @typescript-eslint/no-explicit-any */
});

function fixture(): ArrayBuffer {
  const abs = fileURLToPath(new URL("../../../web/test-fixtures/pdf/chromium-hebrew.pdf", import.meta.url));
  return new Uint8Array(fs.readFileSync(abs)).buffer;
}

describe("pdfRedact destroys every document it opens (exactly once — no leak, no double-free)", () => {
  it("extractPdfMapped destroys its document", async () => {
    const { extractPdfMapped } = await import("./pdfRedact");
    opened.length = 0;
    const mapped = await extractPdfMapped(fixture());
    expect(mapped.text.length).toBeGreaterThan(0); // extraction still works after the destroy
    expect(opened).toHaveLength(1);
    expect(opened[0].destroyCount()).toBe(1);
  });

  it("redactPdf destroys the main document AND the self-verify document", async () => {
    const { redactPdf } = await import("./pdfRedact");
    opened.length = 0;
    const { bytes } = await redactPdf(fixture(), anonymizeDeterministic);
    expect(bytes.length).toBeGreaterThan(0); // output unaffected (bytes were copied out of WASM first)
    expect(opened.length).toBeGreaterThanOrEqual(2); // redaction doc + self-verify re-open
    for (const doc of opened) {
      expect(doc.destroyCount()).toBe(1);
    }
  });

  it("redactPdf destroys the document on the NO_TEXT_LAYER refusal path too", async () => {
    const { redactPdf, NO_TEXT_LAYER } = await import("./pdfRedact");
    // reason: mupdf's WASM surface is untyped; narrowly used to author a text-free PDF.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mupdf = (await import("mupdf")) as any;
    const doc = new mupdf.PDFDocument();
    doc.insertPage(-1, doc.addPage([0, 0, 200, 200], 0, doc.newDictionary(), "1 0 0 rg 0 0 200 200 re f"));
    const noText = new Uint8Array(doc.saveToBuffer({}).asUint8Array()).buffer as ArrayBuffer;
    opened.length = 0;
    await expect(redactPdf(noText, anonymizeDeterministic)).rejects.toThrow(NO_TEXT_LAYER);
    expect(opened).toHaveLength(1);
    expect(opened[0].destroyCount()).toBe(1); // the throw path must not leak either
  });
});
