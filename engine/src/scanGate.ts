/**
 * Scan-quality gate — one layer of the scanned-PDF (OCR) track's defense-in-depth, NOT its sole
 * guarantee.
 *
 * THE CRUX (do not weaken, and do not overclaim — see docs/ocr-calibration.md): the confidence gate
 * (lowRatio primary, meanConf backstop) defends the UNSURE-degradation tier — scans that read so
 * poorly the whole file must be refused. It does NOT and CANNOT catch a confident misread: OCR emits a
 * wrong token at high confidence (Stage-1 calibration: an all-1s Israeli ID collapsed to a column of
 * Hebrew vav strokes at lowRatio 0 and word-confidence 85 — invisible to any page-level aggregate,
 * because the failure is content-specific, not an image-quality scalar; variance-of-Laplacian was also
 * empirically refuted). Confident misreads are defended at the CONTENT layer in the redaction pipeline:
 * label-anchored redaction (redact any token containing/adjacent to a PII label, content-blind), ID
 * relax-checksum in scan mode, and phone bbox pixel self-heal. A residual class — an UNLABELED value
 * that collapses to a non-matching (non-digit) token at sub-envelope (fax-grade, <=~60-DPI-equivalent)
 * resolution — is uncovered and documented as a known v1 limitation, not hidden.
 *
 * So: never turn this into a per-word pass/fail, never lower a threshold to "rescue" a borderline scan,
 * and never re-describe this gate as the sole defense — it is one layer among several. Thresholds are
 * calibrated from a real synthetic-scan corpus in Stage 1 (OCR-01); see docs/ocr-calibration.md.
 */
import type { OcrPageResult, OcrWord } from "./ocrTypes";

// Calibrated in Stage 1 (OCR-01) on a 64-sample synthetic-scan corpus. lowRatio is the PRIMARY
// separator; meanConf is a WEAK backstop only (a FAIL at meanConf 81.3 outranks a PASS at 79.4 — do
// not tighten FLOOR expecting it to catch fails). MAX_LOW_CONF_RATIO sits between clean-max .091 and
// fail-min .167; if production shows clean scans false-refusing, the safe band is [0.12, 0.14] and the
// HARD ceiling is < 0.167 (never cross it — that is where real recall failures begin).
const SCAN_MEAN_CONF_FLOOR = 75;
const LOW_CONF_WORD_FLOOR = 60;
const MAX_LOW_CONF_RATIO = 0.12;
// Near-zero recognized words = cannot certify. The confidence signals score only words OCR actually
// FOUND, so ink it cannot read at all (handwriting, stamps) contributes nothing and would otherwise let
// a page carried by a single legible token pass. A page reduced to one recognized word has no readable
// content to trust, so it fails closed. This is a floor, not a cure for confident misreads (see header)
// nor for unread ink beneath a readable printed body — that residual needs pixel-level ink analysis.
const MIN_RECOGNIZED_WORDS = 2;

/** Refusal code surfaced to the UI when a scan reads too poorly to redact reliably. */
export const SCAN_LOW_CONFIDENCE = "SCAN_LOW_CONFIDENCE";

export type ScanQuality = { readonly ok: true } | { readonly ok: false; readonly reason: typeof SCAN_LOW_CONFIDENCE };

/** Words that carry actual text (whitespace-only tokens must not skew the mean/ratio). */
function textWords(page: OcrPageResult): OcrWord[] {
  return page.words.filter((word) => word.text.trim().length > 0);
}

/**
 * Pass a page only when it reads cleanly on BOTH signals: a high page-mean confidence AND a small
 * fraction of low-confidence words. Either signal failing — or a page with near-zero recognized words —
 * refuses. Bounds are inclusive (>= floor, <= max ratio).
 */
export function evaluateScanQuality(page: OcrPageResult): ScanQuality {
  const words = textWords(page);
  if (words.length < MIN_RECOGNIZED_WORDS) {
    return { ok: false, reason: SCAN_LOW_CONFIDENCE }; // empty or a lone token → cannot certify, refuse
  }
  const meanConfidence = words.reduce((sum, word) => sum + word.confidence, 0) / words.length;
  const lowRatio = words.filter((word) => word.confidence < LOW_CONF_WORD_FLOOR).length / words.length;
  const ok = meanConfidence >= SCAN_MEAN_CONF_FLOOR && lowRatio <= MAX_LOW_CONF_RATIO;
  return ok ? { ok: true } : { ok: false, reason: SCAN_LOW_CONFIDENCE };
}
