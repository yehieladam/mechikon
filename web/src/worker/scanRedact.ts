/**
 * Scanned-PDF redaction (OCR Stage 3) — worker side. Holds the mupdf plumbing; the pure detection math
 * is in engine/detectScanPii and the px->pt geometry in engine/ocrMap. A scanned page has no text
 * layer, so we RASTERIZE it, OCR the raster, detect PII on the OCR words, map their pixel boxes to page
 * points, and truly remove the covered pixels with REDACT_IMAGE_PIXELS.
 *
 * The OCR primitive is INJECTED (like `anonymize`): the browser wires ocr.ts (vendored tesseract in the
 * worker); the node reality test injects a node tesseract. So this module is testable end-to-end without
 * a DOM, and the engine stays framework-free.
 *
 * Produce + per-page warning (owner decision): a page that fails the scan-quality gate is NOT redacted
 * and is reported in `unverifiedImagePages` (1-based) so the UI warns per page, rather than refusing the
 * whole file for one unreadable page. Only when EVERY page is unverified (a whole-document unreadable
 * scan) do we still refuse with SCAN_LOW_CONFIDENCE — producing an all-unverified file is pointless. An
 * unmappable standard detection (SCAN_UNMAPPABLE_PII) is a detected-but-uncoverable PII and still throws
 * (fail closed), as does a self-verify failure (a redaction that left PII behind).
 */
import { evaluateScanQuality, SCAN_LOW_CONFIDENCE } from "@engine/scanGate";
import { detectScanPii, type ScanDetection } from "@engine/detectScanPii";
import { imageBoxToPageRect } from "@engine/ocrMap";
import { anonymize as tokenize } from "@engine/anonymize";
import { markScanKeySources, scanTextLeaks } from "@engine/scanKey";
import type { OcrPageResult } from "@engine/ocrTypes";
import type { AnonymizeResult, Span } from "@engine/types";
import { sanitizeMetadata, collectOutlineItems } from "./pdfSanitize";
import { assertPageCountWithinCap } from "./pdfLimits";
import { ocrImage } from "./ocr";
import type { RedactedFile, Anonymize } from "./officeRedact";

// reason: mupdf's ESM/WASM surface (PDFDocument, PDFPage, Pixmap, Matrix) is not worth modelling; it is
// narrowly used here and behind a dynamic import.
/* eslint-disable @typescript-eslint/no-explicit-any */

export { SCAN_LOW_CONFIDENCE } from "@engine/scanGate";
export { SCAN_UNMAPPABLE_PII } from "@engine/detectScanPii";

/** Thrown when the redacted OUTPUT still trips our own detection on re-OCR — the fixed-point failure. */
export const SCAN_SELFVERIFY_FAILED = "SCAN_SELFVERIFY_FAILED";

/** Injected OCR primitive: a rendered scan-page PNG -> words+bboxes. Browser=ocr.ts, node test=tesseract. */
export type ScanOcr = (png: Uint8Array) => Promise<OcrPageResult>;

/** Injected detector (defaults to the full detectScanPii). The node reality test overrides it to
 * exercise a single mechanism (e.g. label-anchor only) through the real pixel-redaction path. */
export type ScanDetect = (page: OcrPageResult) => Promise<ScanDetection>;

/** Progress for the slow OCR op (the UI must never look hung). `page` is 1-based; `total` is page count. */
export type ScanProgress = (event: { phase: "reading" | "verifying"; page: number; total: number }) => void;

/** Fixed render resolution for OCR (Stage-1 calibration: 200 DPI keeps heb+eng clean; see docs/ocr-calibration.md). */
const OCR_RENDER_DPI = 200;

/** Same proven garbage-collecting save options as the text path (spikes/pdf-01) — never incremental. */
const SAFE_SAVE_OPTIONS = { garbage: "deduplicate", compress: true, sanitize: true } as const;

/**
 * Redact a scanned PDF page-by-page: rasterize -> OCR -> quality gate -> detectScanPii (standard + the
 * three content mechanisms) -> px->pt mapped, inflated rects -> Redact annotations -> REDACT_IMAGE_PIXELS.
 * Metadata is stripped and the file saved with the garbage-collecting options. The restore key is
 * best-effort from standard detections only (content-mechanism regions have no recoverable value).
 */
export async function redactScan(
  buffer: ArrayBuffer,
  anonymize: Anonymize,
  ocr: ScanOcr = ocrImage,
  detect: ScanDetect = (page) => detectScanPii(page, anonymize),
  onProgress?: ScanProgress,
): Promise<RedactedFile> {
  const mupdf: any = await import("mupdf");
  const doc = mupdf.PDFDocument.openDocument(new Uint8Array(buffer), "application/pdf");
  // Everything that touches the open source document runs inside redactScanDoc, called under one
  // try/finally so ANY throw (OCR reject, SCAN_UNMAPPABLE_PII, gate refusal) still releases the WASM
  // heap. Only JS-owned values escape (the copied bytes + the accumulated text/spans).
  let produced: ScanProduced;
  try {
    produced = await redactScanDoc(mupdf, doc, ocr, detect, onProgress);
  } finally {
    doc.destroy(); // release the source document on every path, before the verify pass opens its own
  }
  const { bytes, redactedPages, combinedText, allSpans, unverifiedImagePages } = produced;
  // Fixed-point self-verify: re-detect the OUTPUT and require it to find nothing (Stage 4).
  await selfVerifyScan(bytes, ocr, detect, redactedPages, onProgress);

  // Document-level tokenization (Stage 6): the unified spans → one tokenized "Word for AI" text + one
  // restore key with unified numbering. Mark each key row's OCR fidelity, and text self-verify (a
  // validated original surviving in the AI text is a tokenization bug → refuse, like the pixel verify).
  const tokenized = tokenize(combinedText, allSpans);
  const key = markScanKeySources(tokenized.key);
  if (scanTextLeaks(tokenized.anonymizedText, key).length > 0) {
    throw new Error(SCAN_SELFVERIFY_FAILED);
  }
  const result: AnonymizeResult = { anonymizedText: tokenized.anonymizedText, spans: [], key };
  return { bytes, result, ...(unverifiedImagePages.length > 0 ? { unverifiedImagePages } : {}) };
}

/** What the doc-scoped scan pass hands back — all JS-owned (safe to outlive the destroyed document). */
interface ScanProduced {
  readonly bytes: Uint8Array;
  readonly redactedPages: number[];
  readonly combinedText: string;
  readonly allSpans: Span[];
  readonly unverifiedImagePages: number[];
}

/** The doc-scoped body of redactScan — everything that reads or mutates the open source document.
 * Split out so the caller destroys the document in one try/finally regardless of which path threw. */
async function redactScanDoc(
  mupdf: any,
  doc: any,
  ocr: ScanOcr,
  detect: ScanDetect,
  onProgress?: ScanProgress,
): Promise<ScanProduced> {
  const PDFPage = mupdf.PDFPage;
  const scale = OCR_RENDER_DPI / 72;
  // Document-level tokenization (Stage 6): accumulate each page's OCR text + its unified spans (shifted
  // to the combined-text offset), so the "Word for AI" tokens + restore key get ONE unified numbering
  // across pages (same value on two pages -> same token) and the AI text hides everything the pixels do.
  const PAGE_SEP = "\n\n";
  let combinedText = "";
  const allSpans: Span[] = [];

  const redactedPages: number[] = []; // pages that actually got >=1 rect — the only ones worth re-verifying
  const unverifiedImagePages: number[] = []; // 1-based pages that failed the quality gate (produce + warn)
  const pageCount: number = doc.countPages();
  // Page cap (B8): OCR costs seconds per page — refuse an absurd count BEFORE the rasterize/OCR loop.
  assertPageCountWithinCap(pageCount);
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const page = doc.loadPage(pageIndex);
    const bounds = page.getBounds(); // [x0, y0, x1, y1] in points (presented orientation)
    onProgress?.({ phase: "reading", page: pageIndex + 1, total: pageCount });

    // Rasterize at the calibrated DPI and OCR the raster (a scan has no text layer to read).
    const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
    const image = { width: pixmap.getWidth(), height: pixmap.getHeight() };
    let ocrPage: OcrPageResult;
    try {
      ocrPage = await ocr(new Uint8Array(pixmap.asPNG()));
    } finally {
      // free the multi-MB WASM bitmap now, even if OCR throws — a multi-page scan otherwise grows the
      // heap unboundedly (and a leaked pixmap survives the doc.destroy in the caller).
      pixmap.destroy();
    }

    // Quality gate: a page we cannot read reliably is NOT redacted and is flagged for a per-page warning
    // (owner decision: produce + warn, not whole-file refuse). If EVERY page is unverified the file is
    // useless and we refuse below (keeps the whole-document unreadable-scan refusal). Skip this page's
    // detection/redaction so its unread content is reported rather than silently shipped as "clean".
    if (!evaluateScanQuality(ocrPage).ok) {
      unverifiedImagePages.push(pageIndex + 1);
      continue;
    }

    // Detect (may throw SCAN_UNMAPPABLE_PII on a span we cannot cover). Accumulate text + shifted spans
    // for the document-level tokenize below.
    const detection = await detect(ocrPage);
    const offset = combinedText.length;
    combinedText += (offset > 0 ? PAGE_SEP : "") + detection.text;
    const shift = offset > 0 ? offset + PAGE_SEP.length : 0;
    for (const span of detection.spans) {
      allSpans.push({ ...span, start: span.start + shift, end: span.end + shift });
    }

    const pageBox = {
      widthPt: bounds[2] - bounds[0],
      heightPt: bounds[3] - bounds[1],
      originX: bounds[0],
      originY: bounds[1],
    };
    let touched = false;
    for (const box of detection.boxes) {
      const rect = imageBoxToPageRect(box, image, pageBox, {}); // {} -> apply the default over-cover inflation
      const annot = page.createAnnotation("Redact");
      annot.setRect([rect.x0, rect.y0, rect.x1, rect.y1]);
      annot.update();
      touched = true;
    }
    if (touched) {
      page.applyRedactions(true, PDFPage.REDACT_IMAGE_PIXELS, PDFPage.REDACT_LINE_ART_NONE, PDFPage.REDACT_TEXT_REMOVE);
      redactedPages.push(pageIndex);
    }
  }

  // Every page unreadable → nothing was redacted or verified → refuse (a whole-document unreadable scan;
  // producing an all-unverified file is pointless). A MIXED / partially-readable file falls through to
  // produce + warn with the unverified pages reported. The caller's finally destroys the document.
  if (unverifiedImagePages.length === pageCount) {
    throw new Error(SCAN_LOW_CONFIDENCE);
  }

  // Strip the invisible metadata leak channels (Info, XMP, embedded files, annotation text).
  sanitizeMetadata(doc);
  // Blank outline (bookmark) titles. The digital redactPdf path anonymizes them coherently with the body
  // key, but on a scan the titles are exact text with no tie to the OCR-derived key/verify — so a
  // bookmark like "יוסי כהן - תיק 4711" would ship verbatim. We cannot certify a title clean, so we clear
  // it (fail closed): navigation labels are secondary; a burned-in name in them is not.
  for (const item of collectOutlineItems(doc)) {
    item.setTitle("");
  }

  // Copy out of WASM memory before the caller destroys the doc and self-verify re-opens mupdf
  // (asUint8Array is a live view).
  const bytes = new Uint8Array(doc.saveToBuffer(SAFE_SAVE_OPTIONS).asUint8Array());
  return { bytes, redactedPages, combinedText, allSpans, unverifiedImagePages };
}

/**
 * Fixed-point self-verify (OCR Stage 4): re-open the redacted OUTPUT, and on every page that actually
 * received a redaction, re-rasterize -> OCR -> run detection again; the output is clean ONLY if detection
 * now finds NOTHING (zero boxes). A surviving box means either a rect that failed to cover a PII (an
 * execution failure) or a PII-shaped token the second OCR pass revealed (a real under-detection) — BOTH
 * must refuse. This is stricter than needle-matching and self-consistent: the output is judged clean by
 * the exact standard we redact with. Redaction is a fixed point because every mechanism whites the whole
 * PII region (label-anchor includes the label word, so a lone label cannot re-anchor). Zero-rect pages
 * are skipped — there is nothing executed to validate, and their re-OCR is the same pass-1 OCR the gate
 * already vetted. Any survivor throws SCAN_SELFVERIFY_FAILED (whole-file refuse).
 */
export async function selfVerifyScan(
  bytes: Uint8Array,
  ocr: ScanOcr,
  detect: ScanDetect,
  redactedPages: readonly number[],
  onProgress?: ScanProgress,
): Promise<void> {
  if (redactedPages.length === 0) {
    return;
  }
  const mupdf: any = await import("mupdf");
  const doc = mupdf.PDFDocument.openDocument(bytes, "application/pdf");
  const scale = OCR_RENDER_DPI / 72;
  const total: number = doc.countPages();
  try {
    for (const pageIndex of redactedPages) {
      onProgress?.({ phase: "verifying", page: pageIndex + 1, total });
      const pixmap = doc.loadPage(pageIndex).toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
      const ocrPage = await ocr(new Uint8Array(pixmap.asPNG()));
      pixmap.destroy();
      let boxCount: number;
      try {
        boxCount = (await detect(ocrPage)).boxes.length;
      } catch {
        // detect threw (e.g. SCAN_UNMAPPABLE_PII) — a PII was detected on the output → not clean.
        throw new Error(SCAN_SELFVERIFY_FAILED);
      }
      if (boxCount > 0) {
        throw new Error(SCAN_SELFVERIFY_FAILED);
      }
    }
  } finally {
    doc.destroy();
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
