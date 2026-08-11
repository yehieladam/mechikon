/**
 * Scan restore-key fidelity + text leak-scan (OCR Stage 6) — pure, framework-free.
 *
 * On the scan path the key's `original` values come from OCR, not exact text, so each row is marked with
 * its fidelity so the UI (and the user) can trust high-fidelity rows and verify the rest — never a silent
 * wrong restore. And the tokenized "Word for AI" text is leak-scanned for any surviving VALIDATED
 * original (a tokenization bug backstop; B/C originals are OCR-lossy so they are scanned best-effort).
 */
import type { KeyRow } from "./types";
import { isValidIsraeliId } from "./recognizers/israeliId";
import { isValidIsraeliPhone } from "./recognizers/israeliPhone";
import { isValidIsraeliCompany } from "./recognizers/israeliCompany";

/**
 * Fidelity of a scan key row's `original` (see KeyRow.source). The DEFAULT is deliberately "ocr"/"unreadable",
 * NOT "validated": most deterministic types (case/land/policy/insured/passport/bar/DOB) have NO checksum, and
 * label-gated ID/company can fire on a checksum-INVALID value, so on OCR text their `original` is only
 * OCR-quality and must be presented for review — marking it "validated" would be a silent wrong restore.
 * "validated" is an explicit OPT-IN for the types we actually verify: a format-checked email/IBAN, or a
 * checksum-VALID ID/phone/company. Everything else is OCR-quality (or "unreadable" when no digit was read).
 */
function numericFidelity(row: KeyRow): NonNullable<KeyRow["source"]> {
  return /\d/.test(row.original) ? "ocr" : "unreadable";
}

function sourceFor(row: KeyRow): NonNullable<KeyRow["source"]> {
  switch (row.type) {
    case "PERSON":
    case "ORGANIZATION":
    case "LOCATION":
      return "ocr"; // NER on OCR text — OCR-quality, restorable
    case "IL_NUMBER":
      return "ocr"; // generic digit run (B) — the OCR-read number round-trips
    case "EMAIL_ADDRESS":
    case "IL_IBAN":
      return "validated"; // format/mod-97-verified
    case "ISRAELI_ID":
      return isValidIsraeliId(row.original) ? "validated" : numericFidelity(row);
    case "IL_PHONE":
      return isValidIsraeliPhone(row.original) ? "validated" : numericFidelity(row);
    case "IL_COMPANY":
      return isValidIsraeliCompany(row.original) ? "validated" : numericFidelity(row);
    default:
      // Context-only numeric types (case/land/policy/insured/passport/bar/DOB) — no checksum, OCR-quality.
      return numericFidelity(row);
  }
}

/** Annotate each scan key row with its fidelity marker. */
export function markScanKeySources(key: readonly KeyRow[]): KeyRow[] {
  return key.map((row) => ({ ...row, source: sourceFor(row) }));
}

/** Minimum original length worth leak-scanning (short/common strings false-positive). */
const MIN_LEAK_LEN = 4;

/**
 * Return any VALIDATED original (the faithful needles) that still appears in the tokenized text — a
 * tokenization bug. By construction the spans were replaced, so this should be empty; it is the backstop.
 * B/C ("ocr"/"unreadable") originals are OCR-lossy and NOT asserted (same limitation as the pixel verify).
 */
export function scanTextLeaks(anonymizedText: string, key: readonly KeyRow[]): string[] {
  return key
    .filter((row) => row.source === "validated" && row.original.length >= MIN_LEAK_LEN)
    .map((row) => row.original)
    .filter((original) => anonymizedText.includes(original));
}
