/**
 * Israeli IBAN (IL_IBAN) recognizer — deterministic, ISO-13616 mod-97 checksum, no NER
 * (CLAUDE.md hard rule 1). Mirrors the server's IL_IBAN recognizer (src/recognizers/
 * israeli_iban.py; not vendored here — faithful re-implementation).
 *
 * An Israeli IBAN is "IL" + 2 check digits + 19 BBAN digits = 23 characters (IL + 21 digits).
 * Validation is the standard IBAN mod-97: move the first four chars to the end, map letters to
 * numbers (A=10 … Z=35, so I=18, L=21), and require the whole number mod 97 === 1.
 */
import type { Recognizer, Span } from "../types";
import { HWS } from "./separators";

const IL_IBAN_SHAPE = /^IL\d{21}$/;

/** mod 97 over a decimal string, computed iteratively so it never overflows Number. */
function mod97(numeric: string): number {
  let remainder = 0;
  for (const ch of numeric) {
    remainder = (remainder * 10 + Number(ch)) % 97;
  }
  return remainder;
}

/** True if `raw` (any spacing) is a mod-97-valid Israeli IBAN. */
export function isValidIsraeliIban(raw: string): boolean {
  const compact = raw.replace(/[\s-]/g, "").toUpperCase();
  if (!IL_IBAN_SHAPE.test(compact)) {
    return false;
  }
  // Rearrange (first 4 chars to the end), then map I->18, L->21; digits stay.
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  return mod97(numeric) === 1;
}

/** "IL" + 2 check + 19 digits, tolerating single hyphen/horizontal-space (HWS) separators between groups
 *  (M-format). Separator is the shared HWS set, not `\s`: a `\s` admits a newline, so a line-wrapped IBAN
 *  would swallow the next line's leading digit, overrun 19 groups / fail mod-97, and leak. See separators.ts. */
const IBAN_CANDIDATE = new RegExp(`\\bIL\\d{2}(?:[-${HWS}]?\\d){19}\\b`, "gi");

/** Flags mod-97-valid Israeli IBANs. */
export const israeliIbanRecognizer: Recognizer = {
  name: "IsraeliIbanRecognizer",
  entity: "IL_IBAN",
  recognize(text: string): readonly Span[] {
    const spans: Span[] = [];
    for (const match of text.matchAll(IBAN_CANDIDATE)) {
      if (isValidIsraeliIban(match[0])) {
        spans.push({
          start: match.index,
          end: match.index + match[0].length,
          type: "IL_IBAN",
          score: 1,
        });
      }
    }
    return spans;
  },
};
