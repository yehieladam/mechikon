/**
 * US Social Security Number (US_SSN) recognizer — deterministic, no NER. Matches ONLY the written
 * 3-2-4 grouped form (hyphen- or space-separated), never a bare 9-digit run: a bare 9 digits is the
 * Israeli teudat-zehut's shape, and matching it here would collide with ISRAELI_ID. Applies the SSA
 * allocation rules (area not 000/666/900+, group not 00, serial not 0000) to cut false positives.
 */
import type { Recognizer, Span } from "../types";

// area(3) SEP group(2) SEP serial(4); the same separator on both gaps (backreference \2).
const SSN = /(?<!\d)(\d{3})([ -])(\d{2})\2(\d{4})(?!\d)/g;

function isValidSsn(area: string, group: string, serial: string): boolean {
  const a = Number(area);
  if (a === 0 || a === 666 || a >= 900) {
    return false;
  }
  return Number(group) !== 0 && Number(serial) !== 0;
}

/** Flags well-formed, SSA-valid US SSNs in grouped form. */
export const usSsnRecognizer: Recognizer = {
  name: "UsSsnRecognizer",
  entity: "US_SSN",
  recognize(text: string): readonly Span[] {
    const spans: Span[] = [];
    for (const match of text.matchAll(SSN)) {
      const [, area, , group, serial] = match;
      if (isValidSsn(area, group, serial)) {
        spans.push({
          start: match.index,
          end: match.index + match[0].length,
          type: "US_SSN",
          score: 1,
        });
      }
    }
    return spans;
  },
};
