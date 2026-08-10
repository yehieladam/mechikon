/**
 * pipeline — deterministic detect→resolve→anonymize, and the full merge with NER spans.
 */
import { describe, expect, it } from "vitest";
import type { Span } from "./types";
import {
  anonymizeDeterministic,
  anonymizeFull,
  anonymizeManualOnly,
  anonymizeWith,
  detectDeterministic,
} from "./pipeline";
import { restore } from "./restore";

const DOC = "הלקוח ת״ז 123456709, טלפון 052-1234567, דוא״ל cohen.law@office.co.il";

describe("detectDeterministic", () => {
  it("finds the ID, phone and email across recognizers", () => {
    const types = new Set(detectDeterministic(DOC).map((s) => s.type));
    expect(types).toContain("ISRAELI_ID");
    expect(types).toContain("IL_PHONE");
    expect(types).toContain("EMAIL_ADDRESS");
  });
});

describe("anonymizeDeterministic", () => {
  it("anonymizes and restores byte-exact (no model)", () => {
    const result = anonymizeDeterministic(DOC);
    expect(result.anonymizedText).toContain("[ID_1]");
    expect(result.anonymizedText).not.toContain("123456709");
    expect(restore(result.anonymizedText, result.key).restoredText).toBe(DOC);
  });
});

describe("anonymizeFull", () => {
  it("merges NER spans and lets deterministic outrank them on overlap", () => {
    const text = "עורך הדין דוד כהן, ת״ז 123456709";
    // Simulated NER output (name) alongside the deterministic ID.
    const nerName: Span = {
      start: text.indexOf("דוד כהן"),
      end: text.indexOf("דוד כהן") + "דוד כהן".length,
      type: "PERSON",
      score: 0.99,
    };
    const result = anonymizeFull(text, [nerName]);
    expect(result.anonymizedText).toContain("[NAME_1]");
    expect(result.anonymizedText).toContain("[ID_1]");
    expect(restore(result.anonymizedText, result.key).restoredText).toBe(text);
  });
});

describe("anonymizeWith — H-manual (a shorter high-priority span must not erase a longer NER name)", () => {
  it("keeps the non-overlapping remainder of a name a manual term overlaps", () => {
    const text = "יוסי כהן"; // NER tags the whole name; the user manually redacts only "יוסי"
    const person: Span = { start: 0, end: text.length, type: "PERSON", score: 0.99 };
    const manual: Span = { start: 0, end: 4, type: "MANUAL", score: 1 };
    const result = anonymizeWith(text, [person, manual]);
    // BOTH words must end up redacted — the surname must not leak because the manual term overlapped.
    expect(result.anonymizedText).not.toContain("יוסי");
    expect(result.anonymizedText).not.toContain("כהן");
    expect(restore(result.anonymizedText, result.key).restoredText).toBe(text);
  });
});

describe("anonymizeWith — M-3 (a synthesized remainder must respect the user's reveal)", () => {
  it("keeps a revealed value in cleartext even when it is the remainder of an overlapped name", () => {
    // The user revealed "כהן". A manual "משה" overlaps the PERSON name "משה כהן", so the name's
    // remainder ("כהן") gets synthesized as its own span — which must ALSO honor the reveal.
    const text = "משה כהן דיווח. כהן חתם.";
    const manual: Span = { start: 0, end: 3, type: "MANUAL", score: 1 }; // "משה"
    const person: Span = { start: 0, end: 7, type: "PERSON", score: 0.99 }; // "משה כהן"
    const result = anonymizeWith(text, [person, manual], ["כהן"]);
    // Both occurrences of the revealed surname must stay in cleartext (zero redactions of כהן).
    const cleartextOccurrences = result.anonymizedText.split("כהן").length - 1;
    expect(cleartextOccurrences).toBe(2);
  });
});

describe("anonymizeWith — disabledTypes (category-control layer)", () => {
  it("empty disabledTypes is byte-identical to omitting the argument (regression pin)", () => {
    const withArg = anonymizeWith(DOC, [], [], []);
    const withoutArg = anonymizeWith(DOC, []);
    expect(withArg.anonymizedText).toBe(withoutArg.anonymizedText);
    expect(withArg.key).toEqual(withoutArg.key);
  });

  it("reveals a disabled category while still redacting the others", () => {
    const result = anonymizeWith(DOC, [], [], ["IL_PHONE"]);
    expect(result.anonymizedText).toContain("052-1234567"); // phone left visible
    expect(result.anonymizedText).toContain("[ID_1]"); // ID still redacted
    expect(result.anonymizedText).not.toContain("123456709");
    // The phone is neither tokenized nor keyed; restore round-trips against the untouched cleartext.
    expect(result.key.some((row) => row.type === "IL_PHONE")).toBe(false);
    expect(restore(result.anonymizedText, result.key).restoredText).toBe(DOC);
  });

  it("never disables MANUAL even when its type is listed (explicit human choice wins)", () => {
    const text = "משה כהן";
    const manual: Span = { start: 0, end: 3, type: "MANUAL", score: 1 };
    const result = anonymizeWith(text, [manual], [], ["MANUAL", "PERSON"]);
    expect(result.anonymizedText).toContain("[TERM_1]");
    expect(result.anonymizedText).not.toContain("משה");
  });

  it("occurrence-completion does not resurrect a disabled type", () => {
    const text = "משה כהן דיווח. משה כהן חתם.";
    const person: Span = { start: 0, end: 7, type: "PERSON", score: 0.99 };
    const result = anonymizeWith(text, [person], [], ["PERSON"]);
    expect(result.anonymizedText).toBe(text); // both occurrences stay in cleartext
    expect(result.key).toEqual([]);
  });

  it("composes with excluded: a disabled category and a revealed value are both left visible", () => {
    const result = anonymizeWith(DOC, [], ["cohen.law@office.co.il"], ["IL_PHONE"]);
    expect(result.anonymizedText).toContain("052-1234567"); // disabled category
    expect(result.anonymizedText).toContain("cohen.law@office.co.il"); // revealed value
    expect(result.anonymizedText).toContain("[ID_1]"); // still redacted
    expect(result.anonymizedText).not.toContain("123456709");
  });

  it("an enabled lower-priority type still wins the region when the higher-priority type is disabled", () => {
    const text = "בנק לאומי";
    const person: Span = { start: 0, end: text.length, type: "PERSON", score: 0.99 };
    const org: Span = {
      start: text.indexOf("לאומי"),
      end: text.length,
      type: "ORGANIZATION",
      score: 0.9,
    };
    const result = anonymizeWith(text, [person, org], [], ["PERSON"]);
    expect(result.anonymizedText).toContain("בנק"); // uncovered once PERSON is disabled
    expect(result.anonymizedText).not.toContain("לאומי"); // ORGANIZATION still redacts its span
  });
});

describe("anonymizeManualOnly", () => {
  it("redacts ONLY the chosen terms and leaves auto-detected PII untouched", () => {
    // Deterministic PII (a valid ID) is present, but manual-only must NOT touch it.
    const text = "הלקוח דוד כהן, ת״ז 123456709, גר ברחוב הרצל";
    const result = anonymizeManualOnly(text, ["דוד כהן", "הרצל"]);
    expect(result.anonymizedText).toContain("[TERM_1]"); // דוד כהן
    expect(result.anonymizedText).toContain("[TERM_2]"); // הרצל
    expect(result.anonymizedText).toContain("123456709"); // the ID is left as-is (no auto-detection)
    expect(result.anonymizedText).not.toContain("דוד כהן");
    expect(restore(result.anonymizedText, result.key).restoredText).toBe(text);
  });

  it("redacts every occurrence of a chosen term", () => {
    const result = anonymizeManualOnly("כהן פגש את כהן", ["כהן"]);
    expect(result.anonymizedText).toBe("[TERM_1] פגש את [TERM_1]");
  });

  it("returns the text unchanged with an empty key when no terms are given", () => {
    const result = anonymizeManualOnly("שום דבר לא נבחר", []);
    expect(result.anonymizedText).toBe("שום דבר לא נבחר");
    expect(result.key).toEqual([]);
  });
});
