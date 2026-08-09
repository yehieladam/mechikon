/**
 * mupdf heap hygiene for the scan path: redactScan opens a source PDFDocument and must destroy it on
 * EVERY exit, including a throw from the injected OCR / detect (SCAN_UNMAPPABLE_PII et al). Without a
 * try/finally the parsed document leaked on the throw path. A tracking wrapper around openDocument
 * counts destroys per instance. Model-free: the injected ocr throws before any heavy work.
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

describe("redactScan destroys the source document even when OCR throws", () => {
  it("does not leak the document when the injected OCR rejects mid-page", async () => {
    const { redactScan } = await import("./scanRedact");
    const throwingOcr = async (): Promise<never> => {
      throw new Error("ocr boom");
    };
    opened.length = 0;
    await expect(
      redactScan(fixture(), anonymizeDeterministic, throwingOcr),
    ).rejects.toThrow("ocr boom");
    expect(opened).toHaveLength(1); // only the source doc was opened (verify never reached)
    expect(opened[0].destroyCount()).toBe(1); // and it was released on the throw path
  });
});
