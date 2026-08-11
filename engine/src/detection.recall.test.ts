/**
 * DETERMINISTIC RECALL GATE — the fast, model-free accuracy gate for the regex + checksum + label-gated
 * detectors. Unlike ner.recall.test.ts (which pulls the 185 MB dictabert model and is gated behind
 * RUN_RECALL), this runs on every CI push: it exercises anonymizeDeterministic over a gold corpus of
 * realistic Hebrew snippets and asserts that every sensitive value is redacted (recall) and every
 * non-sensitive value is preserved (precision). A recognizer regression flips a case here immediately.
 *
 * The corpus is redaction-oriented: a POSITIVE passes when its value no longer appears verbatim in the
 * output (it was tokenized), a NEGATIVE passes when its value is still present (it was left alone). Add a
 * row whenever a new pattern is supported or a real document surfaces a gap — this file is the living
 * definition of "how good is automatic detection".
 */
import { describe, expect, it } from "vitest";
import { anonymizeDeterministic } from "./pipeline";

interface GoldCase {
  readonly name: string;
  readonly text: string;
  /** Values that MUST be redacted (absent from the output). */
  readonly redact: readonly string[];
  /** Values that MUST be preserved (present in the output). */
  readonly keep?: readonly string[];
}

const CORPUS: readonly GoldCase[] = [
  // --- Identifiers (checksum + label-gated) ---
  {
    name: "ID after ת״ז label, even when the checksum fails",
    text: "מר כהן, ת.ז. 037541239, יליד 14.07.1981",
    redact: ["037541239"],
  },
  {
    name: "landline-shaped ID is [ID], not [PHONE]",
    text: "ת.ז. 037541239",
    redact: ["037541239"],
  },
  {
    name: "company after ח.פ. label, checksum-invalid, both occurrences",
    text: 'אורלייט בע"מ, ח.פ. 514872903\nח.פ. עוסק מורשה 514872903',
    redact: ["514872903"],
  },
  {
    name: "osek murshe number → ID",
    text: "עוסק מורשה 305873946",
    redact: ["305873946"],
  },
  {
    name: "passport after דרכון",
    text: "דרכון ישראלי מס' 31847205",
    redact: ["31847205"],
  },
  {
    name: "bar-license after מ.ר.",
    text: '(מ.ר. 42817) ועו"ד אחר (מ.ר. 51203)',
    redact: ["42817", "51203"],
  },
  {
    name: "birth date (full) — bare year is intentionally not detected",
    text: "יליד 14.07.1981",
    redact: ["14.07.1981"],
  },
  // --- Contact ---
  {
    name: "phone at end of a numbered clause (newline must not swallow next digit)",
    text: "7. טלפון 052-1234567\n8. ביום 15.3.2024 נחתם",
    redact: ["052-1234567"],
  },
  {
    name: "landline with separators",
    text: "טל' בית: 03-6241234",
    redact: ["03-6241234"],
  },
  {
    name: "labeled ID far from its label is captured whole (no truncated-prefix leak)",
    text: "תעודת זהות של מרשי היא 312345678",
    redact: ["312345678"],
  },
  {
    name: "email",
    text: 'דוא"ל: yossi@example.co.il',
    redact: ["yossi@example.co.il"],
  },
  // --- Financial / legal numbers ---
  {
    name: "policy — 'פוליסת ביטוח מס׳' and 'שמספרה' phrasings",
    text: "פוליסת ביטוח מס' 98765432. פוליסה שמספרה 55501.",
    redact: ["98765432", "55501"],
  },
  {
    name: "court case — type prefixes and net-hamishpat",
    text: 'ע"א 1234/05 ; תיק 12345-01-20',
    redact: ["1234/05", "12345-01-20"],
  },
  // --- Organizations (private, suffix-anchored) ---
  {
    name: "company name ending בע״מ (defendant)",
    text: 'הנתבעת: אורלייט טכנולוגיות בע"מ הגישה',
    redact: ['אורלייט טכנולוגיות בע"מ'],
  },
  {
    name: "amuta ending ע״ר",
    text: 'עמותת לתת ע"ר פעלה',
    redact: ['עמותת לתת ע"ר'],
  },
];

// Negatives grouped separately: each value must survive in its own realistic context.
const NEGATIVES: readonly GoldCase[] = [
  { name: "amount with commas", text: "סכום התביעה: 487,500 ש\"ח", redact: [], keep: ["487,500"] },
  { name: "amount whose digits pass a company checksum", text: "נזק בסך 520,013,954 ש\"ח", redact: [], keep: ["520,013,954"] },
  { name: "contract year (not a birth year)", text: "חוזה משנת 2024", redact: [], keep: ["2024"] },
  { name: "filing date (not a birth date)", text: "נכון ליום 12.02.2026", redact: [], keep: ["12.02.2026"] },
  { name: "square meters (not a bar-license)", text: "דירה בת 85 מ\"ר", redact: [], keep: ["85"] },
  { name: "public bodies (no private suffix)", text: "משרד הבריאות ועיריית תל אביב ובית משפט השלום", redact: [], keep: ["משרד הבריאות", "עיריית תל אביב"] },
  { name: "generic company, not a name", text: 'החברה בע"מ התחייבה', redact: [], keep: ["החברה"] },
  { name: "case prefix used as a place (ת״א = תל אביב)", text: 'רחוב הרצל 12, ת"א 6971022', redact: [], keep: ["6971022"] },
  { name: "dotted date near a number label is not a number", text: "דרכון בתוקף עד 12.03.2027", redact: [], keep: ["12.03.2027"] },
  { name: "contract year equal to a birth year elsewhere is not globalized", text: "יליד 1969 וההסכם נחתם בשנת 1969", redact: [], keep: ["בשנת 1969"] },
];

describe("deterministic recall gate", () => {
  it.each(CORPUS.map((c) => [c.name, c] as const))("redacts: %s", (_name, c) => {
    const out = anonymizeDeterministic(c.text).anonymizedText;
    for (const value of c.redact) {
      expect(out, `expected "${value}" to be redacted`).not.toContain(value);
    }
    for (const value of c.keep ?? []) {
      expect(out, `expected "${value}" to be preserved`).toContain(value);
    }
  });

  it.each(NEGATIVES.map((c) => [c.name, c] as const))("preserves: %s", (_name, c) => {
    const out = anonymizeDeterministic(c.text).anonymizedText;
    for (const value of c.keep ?? []) {
      expect(out, `expected "${value}" to be preserved (no over-redaction)`).toContain(value);
    }
  });

  it("aggregate recall on the gold positives is 100% (the gate)", () => {
    const allValues = CORPUS.flatMap((c) => c.redact.map((v) => ({ text: c.text, v })));
    const redactedCount = allValues.filter(
      ({ text, v }) => !anonymizeDeterministic(text).anonymizedText.includes(v),
    ).length;
    const recall = redactedCount / allValues.length;
    // A hard gate: every curated deterministic case must stay caught. Loosen ONLY with a deliberate,
    // reviewed reason (and update the row), never to make a red build green.
    expect(recall).toBe(1);
  });
});
