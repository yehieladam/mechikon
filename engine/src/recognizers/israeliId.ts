/**
 * Israeli teudat zehut (ID) recognizer — REAL checksum validation, no NER, no mocks.
 * Faithful port of the server's src/recognizers/israeli_id.py (pii-anonymizer-spike).
 *
 * The Israeli ID is 9 digits. Validity is a Luhn-style check digit: weight each digit
 * (left to right) by 1,2,1,2,...; if a product exceeds 9, subtract 9; the total must be
 * divisible by 10. Detection is regex + checksum ONLY (CLAUDE.md hard rule 1).
 */
import type { Recognizer, Span } from "../types";
import { HWS } from "./separators";

const ALL_ZEROS = "000000000";
const ID_LENGTH = 9;

/** True if `raw` (any string) holds a checksum-valid Israeli ID. */
export function isValidIsraeliId(raw: string): boolean {
  const digitsOnly = raw.replace(/\D/g, "");
  if (digitsOnly.length === 0 || digitsOnly.length > ID_LENGTH) {
    return false;
  }
  // IDs shorter than 9 digits are left-padded with zeros (matches the server port).
  const digits = digitsOnly.padStart(ID_LENGTH, "0");
  if (digits === ALL_ZEROS) {
    return false; // passes the checksum but is never a real ID
  }
  let total = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let value = Number(digits[index]) * (index % 2 === 0 ? 1 : 2);
    if (value > 9) {
      value -= 9;
    }
    total += value;
  }
  return total % 10 === 0;
}

/**
 * Standalone 9-digit runs, like the server's `\b\d{9}\b` pattern.
 * (?<!\d) / (?!\d) forbid being part of a longer digit run without consuming characters,
 * so IL_IBAN / longer account numbers are not partially flagged as IDs.
 */
const NINE_DIGIT_RUN = /(?<!\d)\d{9}(?!\d)/g;

/**
 * An ID label near the number, so the two forms below only fire on numbers a human marked as an ID
 * (H-id8). A separator between ת and ז is REQUIRED (so ordinary words like "תזמורת" never count as
 * context). Covers ת"ז / ת.ז, תעודת זהות, מספר זהות, ז.ת.
 */
const ID_CONTEXT = /(?:ת["'׳״.]ז|תעודת\s+זהות|מספר\s+זהות|ז\s*\.\s*ת)/g;
/** 7..9 digits with optional single -, ., horizontal-space separators (a dropped-zero 8-digit or a grouped
 *  ID). Separator is the shared HWS set (horizontal whitespace incl. NBSP, never a line break) + hyphen/dot;
 *  a `\s` here would let the run cross a newline into the next line's digit. See separators.ts. */
const CONTEXT_CANDIDATE = new RegExp(`\\d(?:[-.${HWS}]?\\d){6,8}`);
/** How far after the label to look for the value (a few words of Hebrew + punctuation). */
const CONTEXT_WINDOW = 25;

/**
 * Flags Israeli IDs. Two channels:
 *  - Ungated: standalone 9-digit runs that pass the checksum (unchanged, no context needed).
 *  - Context-gated (H-id8): near an ID label, an 8-digit run (dropped leading zero) or a
 *    separator-formatted 7-9 digit group; separators are stripped and the value is checksum-validated
 *    (isValidIsraeliId left-pads to 9). Gating to a label avoids eating ordinary 8-digit numbers.
 */
export const israeliIdRecognizer: Recognizer = {
  name: "IsraeliIdRecognizer",
  entity: "ISRAELI_ID",
  recognize(text: string): readonly Span[] {
    const spans: Span[] = [];
    for (const match of text.matchAll(NINE_DIGIT_RUN)) {
      if (isValidIsraeliId(match[0])) {
        spans.push({
          start: match.index,
          end: match.index + match[0].length,
          type: "ISRAELI_ID",
          // Checksum-validated — the server boosts validated pattern hits to max score.
          score: 1,
        });
      }
    }
    for (const context of text.matchAll(ID_CONTEXT)) {
      const from = context.index + context[0].length;
      // Slice a margin past the window so a labeled ID near the window edge is matched WHOLE — a truncated
      // 8-of-9-digit prefix can still pass the checksum and leak the final digit. The start-gate keeps only
      // values beginning within CONTEXT_WINDOW.
      const candidate = CONTEXT_CANDIDATE.exec(text.slice(from, from + CONTEXT_WINDOW + 40));
      if (candidate === null || candidate.index >= CONTEXT_WINDOW) {
        continue;
      }
      const digitCount = candidate[0].replace(/\D/g, "").length;
      // Only the dropped-zero (8) or separator-formatted (9) forms; a plain 9-run is already covered.
      if (digitCount < 8 || digitCount > 9 || !isValidIsraeliId(candidate[0])) {
        continue;
      }
      const start = from + candidate.index;
      const end = start + candidate[0].length;
      // Skip if it overlaps a span the standalone-run pass already found (e.g. a labeled 9-digit ID).
      if (!spans.some((span) => span.start < end && start < span.end)) {
        spans.push({ start, end, type: "ISRAELI_ID", score: 1 });
      }
    }
    return spans;
  },
};
