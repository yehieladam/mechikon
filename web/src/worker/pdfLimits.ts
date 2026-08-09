/**
 * PDF page-count cap (B8) — an uploaded PDF is untrusted input, and every PDF path here walks all of
 * its pages (text extraction, per-page classification, rasterize+OCR). A hostile file can declare a
 * six-figure page count in a few KB and pin the worker for hours; refuse it BEFORE any per-page loop.
 * Shared by the digital path (pdfRedact) and the scan/OCR path (scanRedact) so both refuse identically.
 */

/** Thrown (as an Error message, so it survives Comlink) when a PDF exceeds the page cap. */
export const PDF_TOO_MANY_PAGES = "PDF_TOO_MANY_PAGES";

/** Far above any real business document, far below a CPU-pinning declaration. */
export const MAX_PDF_PAGES = 1000;

/** Refuse a page count over the cap — call right after countPages(), before any per-page loop. */
export function assertPageCountWithinCap(pageCount: number): void {
  if (pageCount > MAX_PDF_PAGES) {
    throw new Error(PDF_TOO_MANY_PAGES);
  }
}
