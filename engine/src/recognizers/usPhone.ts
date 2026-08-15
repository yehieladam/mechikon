/**
 * North-American (NANP) phone-number (US_PHONE) recognizer — deterministic, no NER. Matches only the
 * STRUCTURED form (parenthesized area code, or separators between all groups, optionally a +1/1
 * prefix) — never a bare 10-digit run, which would false-positive on any long number. NANP requires
 * the area and exchange codes to start 2–9, which also excludes Israeli numbers (they start with 0).
 */
import type { Recognizer, Span } from "../types";

// optional +1 / 1 ; area (parenthesized OR bare-then-separated), [2-9]NN ; exchange [2-9]NN ; line NNNN.
// A separator (space, dot, hyphen) is REQUIRED between exchange and line, and between area and
// exchange unless the area is parenthesized — so a bare 10-digit string never matches.
const US_PHONE =
  /(?<![\w+])(?:\+?1[ .-]?)?(?:\([2-9]\d{2}\)[ .-]?|[2-9]\d{2}[ .-])[2-9]\d{2}[ .-]\d{4}(?!\w)/g;

/** Flags structured NANP phone numbers. */
export const usPhoneRecognizer: Recognizer = {
  name: "UsPhoneRecognizer",
  entity: "US_PHONE",
  recognize(text: string): readonly Span[] {
    const spans: Span[] = [];
    for (const match of text.matchAll(US_PHONE)) {
      spans.push({
        start: match.index,
        end: match.index + match[0].length,
        type: "US_PHONE",
        score: 1,
      });
    }
    return spans;
  },
};
