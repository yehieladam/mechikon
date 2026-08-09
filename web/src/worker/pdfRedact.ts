/**
 * PDF redaction (PDF-03/04) — worker side. This module holds the mupdf plumbing; the pure text math is
 * in engine/pdfText. Stage 1 provides mapped extraction (logical text + per-char quads); the redaction
 * pipeline (Redact annotations + applyRedactions + safe save + self-verify) is added in stage 2.
 *
 * mupdf is dynamically imported so it loads only when a PDF is actually processed (P0I-02).
 */
import {
  buildMappedText,
  quadsForSpan,
  refsToRects,
  type CharBox,
  type MappedText,
  type PageLines,
  type RedactRect,
} from "@engine/pdfText";
import { toReplacements } from "@engine/overlay";
import type { AnonymizeResult } from "@engine/types";
import { highConfidenceSurvivors, layerB, layerC, textLeaks } from "@engine/pdfVerify";
import type { KeyRow } from "@engine/types";
import type { RedactedFile, Anonymize } from "./officeRedact";
import {
  collectFormFields,
  collectOutlineItems,
  collectOutlineUris,
  sanitizeMetadata,
  setNeedAppearances,
  type FormFieldValue,
  type OutlineItem,
} from "./pdfSanitize";

// reason: mupdf's ESM/WASM surface (PDFDocument, PDFPage, StructuredText walker) is not worth
// modelling in the type system; it is narrowly used here and behind a dynamic import.
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * PROVEN save options (spikes/pdf-01, CLAUDE.md). A plain or compress-only save leaves the orphaned
 * pre-redaction content stream in the file; only garbage collection removes it. NEVER incremental,
 * NEVER a save without garbage — the raw-byte self-verify below is the backstop either way.
 */
const SAFE_SAVE_OPTIONS = { garbage: "deduplicate", compress: true, sanitize: true } as const;

/** Thrown (as an Error message, so it survives Comlink) when a PDF has no usable text layer. */
export const NO_TEXT_LAYER = "NO_TEXT_LAYER";
/** Thrown when the tokenized "Word for AI" text ITSELF still contains a detected original — a real
 * tokenization/overlay bug, so BOTH deliverables are refused (this hard gate is never relaxed). Distinct
 * from a visual-PDF verify failure, which only warns (RedactedFile.pdfUnverified). */
export const TEXT_SELFVERIFY_FAILED = "TEXT_SELFVERIFY_FAILED";
/** Below this many non-whitespace characters (per page AND whole-document), we treat it as image-only. */
const NO_TEXT_LAYER_MIN_CHARS = 3;
/** Fraction of a page's area an image must cover to read as "most of the page" (a full-bleed scan). */
const IMAGE_ONLY_COVER_MIN = 0.5;

/**
 * Per-page scan classification (B3): the 1-based numbers of pages that carry almost no extractable text
 * (< MIN_CHARS non-whitespace) yet are mostly covered by an image — image-only pages, burned-in content
 * our glyph-based text detection is blind to. On a MIXED file these are the pages the text path cannot
 * verify clean (reported to the user for a per-page warning). A genuinely blank page (no text AND no
 * large image) is NOT image-only, so it is never flagged. `preserve-images` is required for onImageBlock
 * to fire (default stext drops image blocks).
 */
function imageOnlyPageNumbers(doc: any): number[] {
  const pages: number[] = [];
  const pageCount: number = doc.countPages();
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const page = doc.loadPage(pageIndex);
    const bounds = page.getBounds();
    const pageArea = Math.max(1, (bounds[2] - bounds[0]) * (bounds[3] - bounds[1]));
    let textChars = 0;
    let maxImageCover = 0;
    page.toStructuredText("preserve-whitespace,preserve-images").walk({
      onChar(char: string) {
        if (char.trim().length > 0) {
          textChars += 1;
        }
      },
      onImageBlock(bbox: ArrayLike<number>) {
        const area = Math.max(0, (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]));
        maxImageCover = Math.max(maxImageCover, area / pageArea);
      },
    });
    if (textChars < NO_TEXT_LAYER_MIN_CHARS && maxImageCover >= IMAGE_ONLY_COVER_MIN) {
      pages.push(pageIndex + 1); // 1-based, for the UI warning
    }
  }
  return pages;
}

/**
 * Classify a PDF as text-layer vs scanned (image-only) — shared so the dispatcher can ROUTE (scan → OCR
 * path) instead of hitting the NO_TEXT_LAYER refusal. Scanned = the WHOLE document has no usable text OR
 * ANY single page is image-only (a mixed digital+scanned file, B3). A cheap extra mupdf open; OCR dwarfs
 * it. redactPdf keeps its own NO_TEXT_LAYER throw (whole-doc scan) + per-page warning as a backstop.
 */
export async function isScannedPdf(buffer: ArrayBuffer): Promise<boolean> {
  const mupdf: any = await import("mupdf");
  const doc = mupdf.PDFDocument.openDocument(new Uint8Array(buffer), "application/pdf");
  try {
    const wholeDocNoText = mappedFromDoc(doc).text.replace(/\s/g, "").length < NO_TEXT_LAYER_MIN_CHARS;
    return wholeDocNoText || imageOnlyPageNumbers(doc).length > 0;
  } finally {
    doc.destroy(); // do not leak the classification doc — the caller re-opens for the real pass
  }
}

/** Build the mapped text from an already-open mupdf document (shared by extract + redact). */
function mappedFromDoc(doc: any): MappedText {
  const pages: PageLines[] = [];
  const pageCount: number = doc.countPages();
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const structured = doc.loadPage(pageIndex).toStructuredText("preserve-whitespace");
    const lines: { chars: CharBox[] }[] = [];
    let current: CharBox[] | null = null;
    structured.walk({
      beginLine() {
        current = [];
      },
      endLine() {
        if (current) {
          lines.push({ chars: current });
          current = null;
        }
      },
      onChar(char: string, _origin: unknown, _font: unknown, _size: unknown, quad: ArrayLike<number>) {
        if (current) {
          current.push({ char, quad: Array.from(quad) });
        }
      },
    });
    pages.push({ pageIndex, lines });
  }
  return buildMappedText(pages);
}

/**
 * Extract a PDF into one logical text stream with a quad attached to every character (engine/pdfText).
 * Uses mupdf's walk() emission order — mupdf applies bidi, so a real (Word/Chrome-shaped) PDF yields
 * Hebrew names in logical order.
 */
export async function extractPdfMapped(buffer: ArrayBuffer): Promise<MappedText> {
  const mupdf: any = await import("mupdf");
  const doc = mupdf.PDFDocument.openDocument(new Uint8Array(buffer), "application/pdf");
  try {
    return mappedFromDoc(doc); // plain JS output (chars + copied quads) — safe to outlive the doc
  } finally {
    doc.destroy(); // WASM heap is not GC'd; an undestroyed doc leaks its parsed tree per call
  }
}

/** Read every metadata channel's text (Info values, outline titles, form field values, annotation
 * text) DECODED. */
function readMetadataChannels(doc: any): string {
  const parts: string[] = [];
  const info = doc.getTrailer().get("Info");
  if (info && info.isDictionary && info.isDictionary()) {
    for (const key of ["Author", "Title", "Subject", "Keywords", "Creator", "Producer"]) {
      const value = info.get(key);
      if (value && value.asString) {
        parts.push(value.asString());
      }
    }
  }
  for (const item of collectOutlineItems(doc)) {
    parts.push(item.title);
  }
  for (const uri of collectOutlineUris(doc)) {
    parts.push(uri); // outline /A /URI — decoded, so a hex-ASCII survivor is not invisible to layer A
  }
  for (const field of collectFormFields(doc)) {
    parts.push(field.value); // AcroForm /V — decoded, so hex-ASCII UTF-16BE strings are not invisible
  }
  const pageCount: number = doc.countPages();
  for (let i = 0; i < pageCount; i += 1) {
    const annots = doc.loadPage(i).getAnnotations?.() ?? [];
    for (const annot of annots) {
      if (annot.getContents) {
        parts.push(annot.getContents());
      }
      // A surviving /A /URI action (should have been stripped) — read it DECODED so layer A sees it.
      // Each step is guarded: mupdf's get() crashes on a PDF null object rather than chaining.
      const obj = annot.getObject?.();
      const action = obj && !(obj.isNull?.() ?? false) ? obj.get("A") : null;
      const uri = action && !(action.isNull?.() ?? false) ? action.get("URI") : null;
      if (uri && (uri.isString?.() ?? false)) {
        parts.push(uri.asString());
      }
    }
  }
  return parts.join("\n");
}

/**
 * Re-open the redacted bytes and assert no detected value survives — in the page text (layer A), in the
 * raw bytes/streams (layer B), in the structure (layer C), AND in the metadata channels read DECODED
 * (PDF stores Hebrew strings as hex-ASCII `<FEFF…>`, so a raw-byte scan is blind to them — decoding and
 * reading Info/outlines/annotations is the reliable check there).
 */
interface VisualVerify {
  /** The HIGH-CONFIDENCE survivors (engine/pdfVerify highConfidenceSurvivors): structured values, or
   * full multi-token name surfaces, that layer A / layer B actually flagged — named to the user so the
   * download is an informed, targeted check. Single short name fragments that merely substring-match
   * inside unrelated words (the #90 noise) are filtered OUT and never warned. Empty when clean. */
  readonly terms: readonly string[];
  readonly detail: string;
}

async function selfVerify(bytes: Uint8Array, rows: readonly KeyRow[]): Promise<VisualVerify> {
  const needles = [...new Set(rows.map((row) => row.original))];
  if (needles.length === 0) {
    return { terms: [], detail: "ok" };
  }
  const mupdf: any = await import("mupdf");
  const doc = mupdf.PDFDocument.openDocument(bytes, "application/pdf");
  let bodyText: string;
  let metaText: string;
  try {
    bodyText = mappedFromDoc(doc).text;
    metaText = readMetadataChannels(doc);
  } finally {
    doc.destroy(); // layers B/C below are pure byte work — the verify doc is no longer needed
  }
  // Layer A: whole-word for names (a short name inside a longer legit word is NOT a leak — the false
  // positive that threw away correctly-redacted files), digit-bounded for numerics. See engine/pdfVerify.
  const layerAHits = textLeaks(bodyText, metaText, needles);
  // Layers B + C — raw-byte scan (incl. inflated streams) and structure check.
  const b = await layerB(bytes, needles);
  const c = layerC(bytes);
  // Warn PROVENANCE-AWARE (see highConfidenceSurvivors): every layer A hit (whole-word/digit-bounded
  // verified) warns unconditionally; layer-B-only raw-byte hits are shape-filtered so a short-fragment
  // substring match cannot resurface as noise. A layer-C-only anomaly without any surviving value is
  // not a PII-survival signal (layer B already scanned every generation's bytes for every value; and
  // SAFE_SAVE_OPTIONS pins layer C in tests), so it does not warn on its own.
  const layerBHits = b.hits.map((h) => h.split(" [")[0]);
  const terms = highConfidenceSurvivors(rows, layerAHits, layerBHits);
  const detail = `layerA/meta=${layerAHits.join(",") || "ok"} layerB=${b.hits.join(",") || "ok"} layerC=eof:${c.eofCount}/sx:${c.startxrefCount}`;
  return { terms, detail };
}

/**
 * Rewrite one appended range of the unified detection text with its placeholders. Returns the
 * rewritten string, or null when no replacement falls inside the range (leave the channel untouched).
 * Shared by outline titles and form field values so both channels apply the SAME unified key.
 */
function rewriteRange(
  combined: string,
  replacements: readonly { start: number; end: number; placeholder: string }[],
  start: number,
  end: number,
): string | null {
  const inRange = replacements.filter((r) => r.start >= start && r.end <= end);
  if (inRange.length === 0) {
    return null;
  }
  let rewritten = "";
  let cursor = start;
  for (const r of inRange) {
    rewritten += combined.slice(cursor, r.start) + r.placeholder;
    cursor = r.end;
  }
  return rewritten + combined.slice(cursor, end);
}

/** A redaction rect plus the placeholder token to burn onto it. */
interface TokenRect extends RedactRect {
  readonly token: string;
}

/** Font resource name for the burned tokens; arbitrary but must not collide with the page's own. */
const TOKEN_FONT_NAME = "MZKtok";
/** Helvetica average advance per em — used to width-fit a token into its box. */
const HELV_AVG_ADVANCE = 0.52;
const TOKEN_MIN_SIZE = 4.5;
const TOKEN_MAX_SIZE = 11;
/** Faint gray underlay so a stamped box still reads as an intentional redaction. */
const UNDERLAY_GRAY = 0.93;

/** Escape a PDF literal string. Tokens are ASCII `[A-Z]+_\d+`, so backslash + parens is exhaustive. */
function pdfStringEscape(value: string): string {
  return value.replace(/[\\()]/g, (c) => `\\${c}`);
}

/**
 * Burn each token into the page CONTENT STREAM over its (already text-removed) rect, so the token is
 * part of the page text an AI/PDF extractor reads — a FreeText annotation would be ignored by most
 * extractors. Latin tokens render in Helvetica (Hebrew would tofu and RTL-garble). Each token is
 * width-fitted + centered in its box over a faint gray underlay; coordinates flip from mupdf page
 * space (origin top-left, y-down) to PDF content space (origin bottom-left, y-up).
 */
function burnTokens(doc: any, mupdf: any, rects: readonly TokenRect[]): void {
  if (rects.length === 0) {
    return;
  }
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const byPage = new Map<number, TokenRect[]>();
  for (const rect of rects) {
    const list = byPage.get(rect.pageIndex);
    if (list) {
      list.push(rect);
    } else {
      byPage.set(rect.pageIndex, [rect]);
    }
  }
  for (const [pageIndex, pageRects] of byPage) {
    const page = doc.loadPage(pageIndex);
    const pageObj = page.getObject();
    let resources = pageObj.get("Resources");
    if (!resources || resources.isNull?.()) {
      resources = doc.newDictionary();
      pageObj.put("Resources", resources);
    }
    let fonts = resources.get("Font");
    if (!fonts || fonts.isNull?.()) {
      fonts = doc.newDictionary();
      resources.put("Font", fonts);
    }
    fonts.put(TOKEN_FONT_NAME, font);

    const bounds = page.getBounds();
    const pageHeight = bounds[3] - bounds[1];
    let ops = "\nq\n";
    for (const rect of pageRects) {
      const boxWidth = Math.max(1, rect.x1 - rect.x0);
      const boxHeight = rect.y1 - rect.y0;
      const widthFit = boxWidth / (rect.token.length * HELV_AVG_ADVANCE);
      const size = Math.max(TOKEN_MIN_SIZE, Math.min(TOKEN_MAX_SIZE, boxHeight * 0.82, widthFit));
      const textWidth = rect.token.length * HELV_AVG_ADVANCE * size;
      const tx = rect.x0 + Math.max(0, (boxWidth - textWidth) / 2);
      const bottom = pageHeight - rect.y1;
      const baseline = bottom + boxHeight * 0.24;
      ops +=
        `${UNDERLAY_GRAY} ${UNDERLAY_GRAY} ${UNDERLAY_GRAY} rg ` +
        `${rect.x0.toFixed(2)} ${bottom.toFixed(2)} ${boxWidth.toFixed(2)} ${boxHeight.toFixed(2)} re f\n`;
      ops +=
        `0 0 0 rg BT /${TOKEN_FONT_NAME} ${size.toFixed(2)} Tf ` +
        `${tx.toFixed(2)} ${baseline.toFixed(2)} Td (${pdfStringEscape(rect.token)}) Tj ET\n`;
    }
    ops += "Q\n";

    const stream = doc.addStream(ops, {});
    const contents = pageObj.get("Contents");
    const array = doc.newArray();
    if (contents && contents.isArray?.()) {
      for (let i = 0; i < contents.length; i += 1) {
        array.push(contents.get(i));
      }
    } else if (contents && !contents.isNull?.()) {
      array.push(contents);
    }
    array.push(stream);
    pageObj.put("Contents", array);
  }
}

/**
 * Redact a PDF by OVERLAYING true-removal redactions on the original, in place. Detection runs on the
 * mapped logical text (via the injected anonymize — deterministic, plus NER names when loaded); each
 * detected span maps to per-line rects from its glyph quads; a Redact annotation over each rect then
 * `applyRedactions` truly removes the text (and covered image pixels). The result is saved with the
 * proven garbage-collecting options and, before it is ever returned, passes the three-layer self-verify
 * — a leak throws instead of handing back a bad file (real detection only, applied to removal).
 */
export async function redactPdf(buffer: ArrayBuffer, anonymize: Anonymize): Promise<RedactedFile> {
  const mupdf: any = await import("mupdf");
  const doc = mupdf.PDFDocument.openDocument(new Uint8Array(buffer), "application/pdf");
  let produced: ProducedPdf;
  try {
    produced = await redactIntoBytes(mupdf, doc, anonymize);
  } finally {
    // WASM heap is not GC'd — release the (multi-MB) parsed document on every path, including the
    // NO_TEXT_LAYER / TEXT_SELFVERIFY_FAILED throws, BEFORE the verify pass opens its own document.
    // Only JS-owned copies escape redactIntoBytes (never a live WASM view), so this is safe.
    doc.destroy();
  }
  const { result, bytes, unverifiedImagePages } = produced;
  // VISUAL self-verify: gates only whether we can CERTIFY the redacted PDF clean. On failure we no longer
  // withhold the file — the owner reviews the preview and can add missed terms — but we surface a warning
  // (pdfUnverified) so the download is an INFORMED choice, not a blind one. The warning is SOFT and
  // HIGH-CONFIDENCE only (B2): it fires when a structured value or a full multi-token name surface
  // genuinely survived, never on a short fragment's coincidental substring match (the #90 noise). The
  // Word deliverable is already hard-verified. layerB/layerC (byte + structure) still ran inside
  // selfVerify.
  const verify = await selfVerify(bytes, result.key);
  const pdfUnverified =
    verify.terms.length > 0 ? { reason: verify.detail, terms: verify.terms } : undefined;
  return {
    bytes,
    result,
    ...(pdfUnverified ? { pdfUnverified } : {}),
    ...(unverifiedImagePages.length > 0 ? { unverifiedImagePages } : {}),
  };
}

/** What the doc-scoped redaction pass hands back: JS-owned bytes + the detection result. */
interface ProducedPdf {
  readonly result: AnonymizeResult;
  readonly bytes: Uint8Array;
  readonly unverifiedImagePages: number[];
}

/** The doc-scoped body of redactPdf — everything that touches the open mupdf document. Split out so
 * the caller can destroy the document in one try/finally regardless of which path threw. */
async function redactIntoBytes(mupdf: any, doc: any, anonymize: Anonymize): Promise<ProducedPdf> {
  const mapped = mappedFromDoc(doc);

  // Refuse a PDF with NO usable text layer at all (a whole-document scan — there are no text pages to
  // redact, so producing an all-unverified file is pointless; the OCR track handles it when scanOcr is
  // on). But a MIXED file (has text pages AND >=1 image-only page) is NOT refused: we redact the text
  // pages and PRODUCE the file, reporting the image-only pages we cannot see into (owner decision:
  // produce + per-page warning). Those pages carry burned-in content our text detection is blind to, so
  // the App warns per page rather than silently shipping a falsely-clean file.
  if (mapped.text.replace(/\s/g, "").length < NO_TEXT_LAYER_MIN_CHARS) {
    throw new Error(NO_TEXT_LAYER);
  }
  const unverifiedImagePages = imageOnlyPageNumbers(doc);

  // UNIFIED detection pass: the body's logical text PLUS every outline (bookmark) title PLUS every
  // AcroForm field value (/V — an ID typed into a form field is invisible to the page-text walk) go
  // through ONE anonymize call, so the same name is the SAME placeholder in the body, a bookmark and a
  // form field (and the restore key stays coherent). Body spans become glyph-quad rects; outline/field
  // spans become string replacements written back in place.
  const outlineItems = collectOutlineItems(doc);
  const formFields = collectFormFields(doc);
  let combined = mapped.text;
  const titleRanges: { start: number; end: number; item: OutlineItem }[] = [];
  for (const item of outlineItems) {
    combined += "\n";
    const start = combined.length;
    combined += item.title;
    titleRanges.push({ start, end: combined.length, item });
  }
  const fieldRanges: { start: number; end: number; field: FormFieldValue }[] = [];
  for (const field of formFields) {
    combined += "\n";
    const start = combined.length;
    combined += field.value;
    fieldRanges.push({ start, end: combined.length, field });
  }

  const result: AnonymizeResult = await anonymize(combined);
  // TEXT self-verify (hard gate, always): the tokenized "Word for AI" text must not contain any detected
  // original. This deliverable is string-overlay, independent of the visual PDF's quad redaction, so it is
  // clean even when the visual redaction misses a glyph; a failure here is a real overlay bug → refuse.
  // Neutralize placeholder brackets first ("[" / "]" -> word char): tokenizing a value ADJACENT to a
  // needle can otherwise forge a whole-word boundary (e.g. "טל03…" -> "טל[PHONE_4]"), a false positive —
  // the needle was correctly never a span (glued to a digit in the original), only the token isolates it.
  const aiText = result.anonymizedText.replace(/[[\]]/g, "x");
  if (textLeaks(aiText, "", result.key.map((row) => row.original)).length > 0) {
    throw new Error(TEXT_SELFVERIFY_FAILED);
  }
  const replacements = toReplacements(combined, result);
  const bodyEnd = mapped.text.length;

  // Body: replacements inside the body → per-line redaction rectangles from the attached glyph quads,
  // each tagged with its placeholder token so we can BURN the token onto the box after removal.
  const tokenRects: TokenRect[] = replacements
    .filter((r) => r.end <= bodyEnd)
    .flatMap((r) =>
      refsToRects(quadsForSpan(mapped, r.start, r.end)).map((rect) => ({
        ...rect,
        token: r.placeholder,
      })),
    );

  // Outlines: rewrite each title with the unified placeholders (same key as the body).
  for (const { start, end, item } of titleRanges) {
    const rewritten = rewriteRange(combined, replacements, start, end);
    if (rewritten !== null) {
      item.setTitle(rewritten);
    }
  }

  // AcroForm fields: rewrite each /V with the unified placeholders. setValue also drops the field's
  // stale appearance streams (they render — and physically carry — the OLD value); NeedAppearances
  // tells viewers to regenerate them from the rewritten /V.
  let anyFieldRewritten = false;
  for (const { start, end, field } of fieldRanges) {
    const rewritten = rewriteRange(combined, replacements, start, end);
    if (rewritten !== null) {
      field.setValue(rewritten);
      anyFieldRewritten = true;
    }
  }
  if (anyFieldRewritten) {
    setNeedAppearances(doc);
  }

  const PDFPage = mupdf.PDFPage;
  const touchedPages = new Set<number>();
  for (const rect of tokenRects) {
    const page = doc.loadPage(rect.pageIndex);
    const annot = page.createAnnotation("Redact");
    annot.setRect([rect.x0, rect.y0, rect.x1, rect.y1]);
    annot.update();
    touchedPages.add(rect.pageIndex);
  }
  for (const pageIndex of touchedPages) {
    // black_boxes = false: we do NOT paint a solid box — the PII text is removed and the token is
    // burned in its place below, so the redaction reads as "[NAME_1]" not an opaque bar.
    doc
      .loadPage(pageIndex)
      .applyRedactions(
        false,
        PDFPage.REDACT_IMAGE_PIXELS,
        PDFPage.REDACT_LINE_ART_NONE,
        PDFPage.REDACT_TEXT_REMOVE,
      );
  }
  // Burn each Latin token into the page CONTENT (AI-extractable) over its now-empty rect.
  burnTokens(doc, mupdf, tokenRects);

  // Strip the invisible metadata leak channels (Info, XMP, embedded files, annotation text). Outlines
  // were already anonymized above through the unified key.
  sanitizeMetadata(doc);

  // asUint8Array() is a live view into WASM memory — the caller destroys this document and the
  // self-verify re-opens mupdf, either of which would clobber it. Copy into a JS-owned buffer now.
  const bytes = new Uint8Array(doc.saveToBuffer(SAFE_SAVE_OPTIONS).asUint8Array());
  return { result, bytes, unverifiedImagePages };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
