/**
 * Label-gated recognizer — deterministic, regex only, no NER (CLAUDE.md hard rule 1).
 *
 * Some PII carries no checksum we can verify (passport, bar-license number, birth date), and some
 * checksum-verified types still slip through when the document holds a TYPO'd, OCR-mangled, or otherwise
 * checksum-invalid value (a real ת״ז or ח״פ that fails the Luhn digit). For those, the surrounding LABEL
 * is the evidence: a number sitting right after "ת״ז" / "ח.פ." / "דרכון" / "מ.ר.", or a date right after
 * "יליד" / "נולד", is almost certainly that entity regardless of any checksum.
 *
 * This recognizer fires ONLY when such a label immediately precedes the value (a short window), so a naked
 * number elsewhere in the prose is untouched — precision stays high, we just stop losing labeled values.
 * The number recognizers (israeliId / israeliCompany) keep their ungated checksum path; this ADDS the
 * label-gated fallback on top, and resolve.ts dedups the overlap. Score is 1: a label is strong evidence,
 * and it must not lose the IL_PHONE tiebreak (resolve.ts) on a landline-shaped ID.
 *
 * Label forms require a real separator between the two-letter abbreviations (ת״ז / ח.פ / מ.ר.) so ordinary
 * words (תזמורת, חפץ) and the square-meter unit מ״ר (gershayim, no dot) never count as context.
 */
import type { EntityType, Recognizer, Span } from "../types";

interface LabelRule {
  readonly entity: EntityType;
  /** Context label to anchor on (global). */
  readonly label: RegExp;
  /** The value token to capture inside the window after the label (searched, not anchored). */
  readonly value: RegExp;
  /** How far past the label to look for the value — enough to skip a few filler words ("ישראלי מס'"). */
  readonly window: number;
}

/** A digit run of `min`..`max` digits, single -/./space separators allowed, not part of a longer run.
 *  Separator is horizontal whitespace only ([ \t]) — a bare `\s` would match a newline and let the run
 *  swallow the next line's leading digit (e.g. a numbered clause), corrupting the value and the layout. */
function digits(min: number, max: number): RegExp {
  return new RegExp(String.raw`(?<!\d)\d(?:[-. \t]?\d){${min - 1},${max - 1}}(?!\d)`);
}

const RULES: readonly LabelRule[] = [
  // ת״ז / תעודת זהות — 7..9 digits. Fires even when the checksum fails (typo/OCR/fabricated).
  // "עוסק מורשה" / "עוסק פטור" carry a person's tax number, which is their ת״ז; when a ח.פ. label also
  // precedes it (a company's file), IL_COMPANY wins the overlap in resolve.ts, so this stays correct.
  {
    entity: "ISRAELI_ID",
    label: /(?:ת["'׳״.]ז|תעודת\s+זהות|מספר\s+זהות|עוסק\s+(?:מורשה|פטור))/g,
    value: digits(7, 9),
    window: 20,
  },
  // ח.פ / ח״פ / מספר תאגיד — 9 digits. Fires without the teudat-zehut Luhn (real companies can fail it,
  // and a fabricated/typo'd number never passes it — the label is what tells us it is a company).
  {
    entity: "IL_COMPANY",
    label: /(?:ח["'׳״.]פ|מספר\s+תאגיד)/g,
    value: digits(9, 9),
    window: 24,
  },
  // דרכון — passport, 6..9 digits. No public checksum exists, so this is label-gated ONLY (a bare run is
  // never flagged as a passport).
  {
    entity: "IL_PASSPORT",
    label: /דרכון/g,
    value: digits(6, 9),
    window: 24,
  },
  // מ.ר. / מספר רישיון (עו״ד) — bar-license, 3..7 digits. The dot form only, so the square-meter unit מ״ר
  // (gershayim) is not mistaken for it. Label-gated only.
  {
    entity: "IL_BAR",
    label: /(?:מ\.\s*ר\.?|מספר\s+רישיון(?:\s+עו["'׳״]?ד)?)/g,
    value: digits(3, 7),
    window: 12,
  },
  // Birth date — יליד / ילידת / נולד / ת. לידה / תאריך לידה. Gated to a birth label so ordinary dates in the
  // document (filing date, "נכון ליום …") are left alone.
  {
    entity: "DATE_OF_BIRTH",
    label: /(?:יליד(?:ת|ה)?|נולד(?:ה)?|תארי?ך\s+לידה|ת\.?\s*לידה)/g,
    value: /\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}/,
    window: 20,
  },
  // Birth YEAR only — "יליד 1969" / "ילידת 1959". The `(?=\s)` after the singular verb blocks the plural
  // "ילידי" ("natives of …", not a personal birth date). The tight 8-char window keeps a stray nearby year
  // from being mistaken for a birth year, and stops it double-firing on a full date the rule above handles.
  {
    entity: "DATE_OF_BIRTH",
    label: /(?:יליד[תה]?|נולד[הו]?)(?=\s)/g,
    value: /(?<!\d)(?:19|20)\d{2}(?!\d)/,
    window: 8,
  },
];

/** Flags PII whose surrounding label identifies it, independent of any checksum (see file header). */
export const labeledRecognizer: Recognizer = {
  name: "LabeledRecognizer",
  entity: "ISRAELI_ID", // mixed — spans carry their own type; `entity` is nominal (see Recognizer).
  recognize(text: string): readonly Span[] {
    const spans: Span[] = [];
    for (const rule of RULES) {
      for (const label of text.matchAll(rule.label)) {
        const from = label.index + label[0].length;
        const candidate = rule.value.exec(text.slice(from, from + rule.window));
        if (candidate === null) {
          continue;
        }
        const start = from + candidate.index;
        spans.push({
          start,
          end: start + candidate[0].length,
          type: rule.entity,
          score: 1,
        });
      }
    }
    return spans;
  },
};
