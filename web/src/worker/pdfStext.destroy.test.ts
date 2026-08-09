/**
 * mupdf StructuredText hygiene: mappedFromDoc and imageOnlyPageNumbers create one StructuredText per
 * page and must destroy each (the WASM heap is not GC'd, so a per-page stext leaks on every processed
 * page). We monkeypatch Page.prototype.toStructuredText to count creations vs destroys, then require
 * them equal. Leak-only (not use-after-free).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { anonymizeDeterministic } from "@engine/pipeline";
import { extractPdfMapped, redactPdf } from "./pdfRedact";

function fixture(): ArrayBuffer {
  const abs = fileURLToPath(new URL("../../../web/test-fixtures/pdf/chromium-hebrew.pdf", import.meta.url));
  return new Uint8Array(fs.readFileSync(abs)).buffer;
}

/** Run `fn` with Page.prototype.toStructuredText instrumented; returns created/destroyed counts. */
async function countStext(fn: () => Promise<void>): Promise<{ created: number; destroyed: number }> {
  // reason: mupdf's WASM surface is untyped; the patch only wraps toStructuredText to count destroys.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mupdf = (await import("mupdf")) as any;
  const Page = mupdf.Page;
  const original = Page.prototype.toStructuredText;
  let created = 0;
  let destroyed = 0;
  Page.prototype.toStructuredText = function patched(...args: unknown[]) {
    const stext = original.apply(this, args);
    created += 1;
    const originalDestroy = stext.destroy.bind(stext);
    stext.destroy = () => {
      destroyed += 1;
      originalDestroy();
    };
    return stext;
  };
  try {
    await fn();
  } finally {
    Page.prototype.toStructuredText = original;
  }
  return { created, destroyed };
}

describe("mappedFromDoc / imageOnlyPageNumbers destroy every per-page StructuredText", () => {
  it("extractPdfMapped destroys each stext it creates", async () => {
    const { created, destroyed } = await countStext(async () => {
      await extractPdfMapped(fixture());
    });
    expect(created).toBeGreaterThan(0);
    expect(destroyed).toBe(created);
  });

  it("redactPdf (mappedFromDoc + imageOnlyPageNumbers + self-verify) destroys every stext", async () => {
    const { created, destroyed } = await countStext(async () => {
      await redactPdf(fixture(), anonymizeDeterministic);
    });
    expect(created).toBeGreaterThan(0);
    expect(destroyed).toBe(created);
  });
});
