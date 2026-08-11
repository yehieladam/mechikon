/**
 * Occurrence completion — a confirmed PII value must be redacted at EVERY occurrence, not only the
 * ones the detector happened to tag. The deterministic recognizers already find all their matches via
 * regex, but NER can tag just some occurrences of a repeated name (or only part of a two-word name);
 * a missed occurrence then leaks — and for PDF it (correctly) trips the self-verify, failing the whole
 * file. This pass takes each detected span's surface value and adds a span for every WHOLE-WORD
 * occurrence of it in the text, so downstream redaction covers them all.
 *
 * Word-bounded on purpose: a short value like "ישראל" must never be redacted inside a longer word that
 * merely contains it ("ישראלי", "ישראלים"). A "word char" is a Hebrew/Latin letter or a digit; an
 * occurrence counts only when neither the char before it nor the char after it is a word char.
 */
import type { Span } from "./types";

const WORD_CHAR = /[A-Za-z0-9֐-׿]/;

function isWholeWord(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] : "";
  const after = end < text.length ? text[end] : "";
  return !WORD_CHAR.test(before) && !WORD_CHAR.test(after);
}

/**
 * Does `needle` occur as a WHOLE WORD in `text` — the exact standard redaction uses (isWholeWord). The
 * PDF/office self-verify uses this so a redacted short name ("כהן") is NOT falsely reported as a leak
 * when it merely appears inside a legit un-redacted word ("מכהן"/"הכהן") — the substring is not the
 * entity we redact, so it is not a leak. A real whole-word survivor still matches. Shared so the leak
 * standard can never drift from the redaction standard.
 */
export function occursAsWholeWord(text: string, needle: string): boolean {
  if (needle.length === 0) {
    return false;
  }
  for (let from = text.indexOf(needle); from !== -1; from = text.indexOf(needle, from + 1)) {
    if (isWholeWord(text, from, from + needle.length)) {
      return true;
    }
  }
  return false;
}

/**
 * For each span, emit a span at every whole-word occurrence of its surface value in `text` (same type
 * and score). Returns only the ADDITIONAL occurrence spans; callers resolve these together with the
 * originals (resolveOverlaps drops duplicates and keeps the longest on overlap, so a value that is a
 * prefix of a longer detected value never wins over it).
 */
export function completeOccurrences(text: string, spans: readonly Span[]): Span[] {
  const added: Span[] = [];
  const seen = new Set<string>();
  for (const span of spans) {
    const surface = text.slice(span.start, span.end);
    const dedupeKey = `${span.type}:${surface}`;
    if (surface.length === 0 || seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    for (let from = text.indexOf(surface); from !== -1; from = text.indexOf(surface, from + 1)) {
      const end = from + surface.length;
      if (isWholeWord(text, from, end)) {
        added.push({ start: from, end, type: span.type, score: span.score });
      }
    }
  }
  return added;
}
