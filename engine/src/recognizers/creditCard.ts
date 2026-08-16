/**
 * Credit-card (CREDIT_CARD) recognizer — deterministic, Luhn-validated, no NER. International: any
 * 13–19 digit PAN, optionally grouped with single spaces or hyphens. The Luhn check is what keeps
 * false positives out (random long numbers rarely pass); an Israeli IBAN's 21-digit body is too long
 * to match, and a 9-digit Israeli ID is too short.
 */
import type { Recognizer, Span } from "../types";

/** Standard Luhn (mod-10) checksum over a bare digit string. */
export function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) {
    return false;
  }
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) {
      return false;
    }
    if (double) {
      d *= 2;
      if (d > 9) {
        d -= 9;
      }
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// 13–19 digits with optional single space/hyphen separators. The boundaries stop the match from
// gluing onto an adjacent digit/hyphen (so a longer run — e.g. an IBAN body — can't be sliced into a
// spurious card).
const CANDIDATE = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;

/** Flags Luhn-valid 13–19 digit card numbers. */
export const creditCardRecognizer: Recognizer = {
  name: "CreditCardRecognizer",
  entity: "CREDIT_CARD",
  recognize(text: string): readonly Span[] {
    const spans: Span[] = [];
    for (const match of text.matchAll(CANDIDATE)) {
      const digits = match[0].replace(/[ -]/g, "");
      if (luhnValid(digits)) {
        spans.push({
          start: match.index,
          end: match.index + match[0].length,
          type: "CREDIT_CARD",
          score: 1,
        });
      }
    }
    return spans;
  },
};
