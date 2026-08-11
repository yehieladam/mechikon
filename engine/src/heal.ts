/**
 * Self-heal for the output leak-scan. When the post-redaction scan (pdfVerify.textLeaks) reports that a
 * KEY value still survives in the output, the file must NOT be refused — the surviving value is one we
 * already know (it has a key row), so we locate its remaining occurrences and redact them too, then
 * produce. `leakSpans` returns spans for those occurrences so the caller can re-anonymize with them merged
 * in (covering BOTH the string deliverable AND the visual PDF quads, since both derive from the spans).
 *
 * It matches the SAME way textLeaks flags a survivor, so healing actually clears the scan:
 *   - numeric value  -> every maximal digit-run whose separator-stripped digits equal the value
 *     (so "052-123-4567" and "0521234567" both heal a "0521234567" needle);
 *   - name/text value -> every WHOLE-WORD occurrence (a substring inside a longer word is not the entity).
 *
 * Forward occurrences only. A reversed (RTL visual-order) survivor is a display artifact, not a logical-
 * order run we can span; if only those remain the caller warns rather than refusing. Pure, framework-free.
 */
import type { KeyRow, Span } from "./types";
import { normalizeForLeak } from "./pdfVerify";

/** A word char for whole-word bounding — a Hebrew/Latin letter or a digit (mirrors occurrences.ts). */
const WORD_CHAR = /[A-Za-z0-9֐-׿]/;
/** A maximal digit run with optional single separators (space, dot, hyphen/dash variants, parens). */
const DIGIT_RUN = /\d(?:[\s.()­‐-―-]?\d)*/g;

function isWholeWord(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] : "";
  const after = end < text.length ? text[end] : "";
  return !WORD_CHAR.test(before) && !WORD_CHAR.test(after);
}

/** Spans for every forward occurrence of a numeric value (matched separator-robustly, like textLeaks). */
function numericSpans(text: string, row: KeyRow, digits: string): Span[] {
  const out: Span[] = [];
  for (const match of text.matchAll(DIGIT_RUN)) {
    if (normalizeForLeak(match[0]) === digits) {
      out.push({ start: match.index, end: match.index + match[0].length, type: row.type, score: 1 });
    }
  }
  return out;
}

/** Spans for every whole-word occurrence of a name/text value. */
function nameSpans(text: string, row: KeyRow, needle: string): Span[] {
  const out: Span[] = [];
  for (let from = text.indexOf(needle); from !== -1; from = text.indexOf(needle, from + 1)) {
    const end = from + needle.length;
    if (isWholeWord(text, from, end)) {
      out.push({ start: from, end, type: row.type, score: 1 });
    }
  }
  return out;
}

/**
 * Locate the remaining occurrences of each SURVIVING key value in `text` and return spans to redact them.
 * `survivorRows` are the key rows whose `original` textLeaks still found in the output. The returned spans
 * are typed by their row so the same value keeps its placeholder when re-anonymized.
 */
export function leakSpans(text: string, survivorRows: readonly KeyRow[]): Span[] {
  const spans: Span[] = [];
  for (const row of survivorRows) {
    const original = row.original;
    if (original.length === 0) {
      continue;
    }
    const digits = normalizeForLeak(original);
    if (/^\d+$/.test(digits)) {
      spans.push(...numericSpans(text, row, digits));
    } else {
      const name = original.trim();
      if (name.length > 0) {
        spans.push(...nameSpans(text, row, name));
      }
    }
  }
  return spans;
}
