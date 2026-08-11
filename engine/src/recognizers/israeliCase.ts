/**
 * Israeli court case number (IL_CASE, מספר תיק) recognizer — pattern + context, no checksum
 * exists for these, so detection is deliberately CONSERVATIVE (favour precision over recall):
 * we only flag the distinctive "net hamishpat" dash format and numbers explicitly introduced by
 * the word תיק. Mirrors the server's IL_CASE recognizer (src/recognizers/israeli_case.py; not
 * vendored here — faithful re-implementation).
 *
 * Case-type-prefixed forms (ת״א 1234/20, בג״ץ 5678/20, ת.פ. 4587/09 …) ARE matched, but only when a
 * case-NUMBER shape (NNN/YY or the net-hamishpat dash form) follows the prefix — so the same two-letter
 * abbreviations used as plain words ("ת״א" = תל אביב in an address) never match without a case number.
 */
import type { Recognizer, Span } from "../types";

/**
 * "Net hamishpat" format NNNNN-MM-YY: a 5–7 digit case number, hyphen, 2-digit month, 2-digit
 * year. First group is ≥5 digits on purpose — that excludes 4-digit ISO dates (2020-06-15).
 */
const NET_HAMISHPAT = /(?<!\d)\d{5,7}-\d{2}-\d{2}(?!\d)/g;

/** A number introduced by תיק (optionally תיק מספר / תיק מס׳), e.g. "תיק 12345/20". */
const TIK_CONTEXT = /תיק(?:\s+(?:מספר|מס['׳]?))?\s+(\d{3,7}(?:\/\d{2,4})?)/g;

/**
 * Case-type prefix (ע״א, ע״פ, רע״א, רע״פ, בג״ץ, בש״א, ת״א, ת״פ, ה״פ, דנ״א, and the dotted ת.א./ת.פ.)
 * followed by a case-number shape (NNN/YY or NNNNN-MM-YY). Any geresh/gershayim variant is accepted.
 * `(?<![א-ת])` stops a prefix from matching inside a longer Hebrew word; only the NUMBER is flagged.
 */
const CASE_PREFIX =
  /(?<![א-ת])(?:ע["'׳״]א|ע["'׳״]פ|רע["'׳״]א|רע["'׳״]פ|בג["'׳״][צץ]|בש["'׳״]א|ת["'׳״]א|ת["'׳״]פ|ה["'׳״]פ|דנ["'׳״]א|ת\.[אפ]\.?)\s+(\d{1,6}\/\d{2,4}|\d{3,7}-\d{2}-\d{2,4})/g;

/** Flags Israeli court case numbers (conservative: dash format + תיק-introduced numbers). */
export const israeliCaseRecognizer: Recognizer = {
  name: "IsraeliCaseRecognizer",
  entity: "IL_CASE",
  recognize(text: string): readonly Span[] {
    const spans: Span[] = [];

    for (const match of text.matchAll(NET_HAMISHPAT)) {
      spans.push({
        start: match.index,
        end: match.index + match[0].length,
        type: "IL_CASE",
        // No checksum; distinctive format but not certain — below deterministic-with-checksum.
        score: 0.9,
      });
    }

    for (const match of text.matchAll(TIK_CONTEXT)) {
      // Flag only the number itself (capture group 1), not the word תיק.
      const value = match[1];
      const start = match.index + match[0].indexOf(value);
      spans.push({
        start,
        end: start + value.length,
        type: "IL_CASE",
        score: 0.9,
      });
    }

    for (const match of text.matchAll(CASE_PREFIX)) {
      // Flag only the case number (capture group 1), not the case-type prefix (ע״א etc.).
      const value = match[1];
      const start = match.index + match[0].indexOf(value);
      spans.push({
        start,
        end: start + value.length,
        type: "IL_CASE",
        score: 0.9,
      });
    }

    return spans;
  },
};
