/**
 * Insurance policy number (IL_POLICY, מספר פוליסה) recognizer — context-anchored, no checksum.
 * Israeli policy numbers have no national standard format (each insurer differs), so the only
 * reliable signal is the keyword פוליסה introducing the number. We flag the number token only,
 * not the keyword. Mirrors the server's IL_POLICY recognizer (src/recognizers/israeli_policy.py;
 * not vendored here — faithful re-implementation of the context approach).
 */
import type { Recognizer, Span } from "../types";

/**
 * פוליסה / פוליסת [ביטוח] (מספר | מס׳ | שמספרה)? <token> — token may contain digits, hyphens, slashes.
 * The optional "ביטוח" and "שמספרה" cover the two most common real phrasings ("פוליסת ביטוח מס׳ …",
 * "פוליסה שמספרה …") that the bare keyword form missed.
 */
const POLICY_CONTEXT =
  /פוליס(?:ה|ת)(?:\s+ביטוח)?(?:\s+(?:מספר|מס['׳]?|שמספרה))?\s+(\d[\d\-/]{3,19})/g;

/** Flags numbers introduced by the keyword פוליסה. */
export const israeliPolicyRecognizer: Recognizer = {
  name: "IsraeliPolicyRecognizer",
  entity: "IL_POLICY",
  recognize(text: string): readonly Span[] {
    const spans: Span[] = [];
    for (const match of text.matchAll(POLICY_CONTEXT)) {
      const value = match[1];
      const start = match.index + match[0].indexOf(value);
      spans.push({
        start,
        end: start + value.length,
        type: "IL_POLICY",
        // Context-only (no checksum) — below deterministic-with-checksum matches.
        score: 0.9,
      });
    }
    return spans;
  },
};
