/**
 * Israeli phone recognizer — deterministic regex against the national numbering plan,
 * no NER (CLAUDE.md hard rule 1). Mirrors the server's IL_PHONE recognizer
 * (src/recognizers/israeli_phone.py); that file lives in the separate server repo and is
 * not vendored here, so this is a faithful re-implementation of the same numbering plan —
 * reconcile against the server samples if they ever diverge.
 *
 * National (leading-0) forms and the international +972 trunk are both accepted:
 *   - Mobile / non-geographic: 0 + (5X | 7[2-9]) + 7 digits   → 10 digits  (05x / 07x)
 *   - Landline (geographic):   0 + [2-489]      + 7 digits   →  9 digits  (02/03/04/08/09)
 * Separators (space, hyphen, dot, parentheses) between groups are tolerated; the value is
 * normalised (separators stripped, +972/972 trunk → leading 0) before validation.
 */
import type { Recognizer, Span } from "../types";

/** 05x + 7 digits, or 07[2-9] + 7 digits (10 digits). */
const MOBILE = /^0(?:5\d|7[2-9])\d{7}$/;
/** Geographic area code 0[2,3,4,8,9] + 7 digits (9 digits). */
const LANDLINE = /^0[2-489]\d{7}$/;

/** Strip separators and fold the international trunk (+972 / 972) to a national leading 0. */
function normalize(raw: string): string {
  const compact = raw.replace(/[^\d+]/g, "");
  return compact.replace(/^\+?972/, "0");
}

/** True if `raw` is a valid Israeli mobile or landline number (any accepted formatting). */
export function isValidIsraeliPhone(raw: string): boolean {
  const digits = normalize(raw);
  return MOBILE.test(digits) || LANDLINE.test(digits);
}

/**
 * Phone-like token: an optional leading "(" and +972/972 or 0 trunk, then 8–10 digits with up to two
 * separators between digits (space, hyphen, dot, parentheses) — so parenthesized area codes
 * "(02) 624-1234" and double spaces are tolerated (M-format). `(?<![\w+])` / `(?![\w])` still stop it
 * from biting into a longer digit run (an account number or a 9-digit ID that does not start 0/972);
 * normalize() strips every non-digit before the numbering-plan check.
 *
 * The separator class is horizontal whitespace ONLY (` \t`), never `\s` — a bare `\s` includes the
 * newline, so a phone at the end of a numbered line ("...052-1234567\n8. ...") would swallow the next
 * line's leading digit, overflow the numbering plan, and leak the whole number unredacted.
 */
const PHONE_CANDIDATE = /(?<![\w+])\(?(?:\+?972[-. \t()]{0,2}|0)(?:\d[-. \t()]{0,2}){7,9}\d(?![\w])/g;

/** Flags Israeli phone numbers (mobile + landline, national and +972 forms). */
export const israeliPhoneRecognizer: Recognizer = {
  name: "IsraeliPhoneRecognizer",
  entity: "IL_PHONE",
  recognize(text: string): readonly Span[] {
    const spans: Span[] = [];
    for (const match of text.matchAll(PHONE_CANDIDATE)) {
      if (isValidIsraeliPhone(match[0])) {
        spans.push({
          start: match.index,
          end: match.index + match[0].length,
          type: "IL_PHONE",
          // Pattern-validated against the numbering plan — max score, like the server.
          score: 1,
        });
      }
    }
    return spans;
  },
};
