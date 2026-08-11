import { describe, expect, it } from "vitest";
import { labeledRecognizer } from "./labeled";
import { anonymizeDeterministic } from "../pipeline";

/** All spans of a given type, as the exact surface strings the recognizer flagged. */
function values(text: string, type: string): string[] {
  return labeledRecognizer
    .recognize(text)
    .filter((span) => span.type === type)
    .map((span) => text.slice(span.start, span.end));
}

describe("labeledRecognizer", () => {
  it("flags a checksum-INVALID ת״ז because the ת״ז label precedes it", () => {
    // 037541239 fails the teudat-zehut Luhn, so the ungated recognizer would miss it.
    expect(values("מר כהן, ת.ז. 037541239 , יליד", "ISRAELI_ID")).toEqual(["037541239"]);
  });

  it("flags a checksum-INVALID ח.פ. after the ח.פ. label", () => {
    // 514872903 fails the Luhn (fabricated), but the label identifies it as a company.
    expect(values("אורלייט בע\"מ, ח.פ. 514872903, מרחוב", "IL_COMPANY")).toEqual(["514872903"]);
  });

  it("finds the company number even with filler between label and value", () => {
    expect(values("ח.פ. עוסק מורשה 514872903", "IL_COMPANY")).toEqual(["514872903"]);
  });

  it("flags a passport number after דרכון (no checksum exists for it)", () => {
    expect(values("דרכון ישראלי מס' 31847205", "IL_PASSPORT")).toEqual(["31847205"]);
  });

  it("flags a bar-license number after מ.ר.", () => {
    expect(values("(מ.ר. 42817)", "IL_BAR")).toEqual(["42817"]);
  });

  it("flags a birth date after יליד", () => {
    expect(values("יליד 14.07.1981", "DATE_OF_BIRTH")).toEqual(["14.07.1981"]);
  });

  it("does NOT treat the square-meter unit מ״ר as a bar label", () => {
    expect(values('דירה בת 120 מ"ר עם 3 חדרים', "IL_BAR")).toEqual([]);
  });

  it("does NOT flag an ordinary (non-birth) date", () => {
    expect(values("נכון ליום 12.02.2026", "DATE_OF_BIRTH")).toEqual([]);
  });

  it("does NOT detect a bare birth YEAR (weak PII; only a full date is matched)", () => {
    // A bare 4-digit year collides with contract years / clause numbers, so it is intentionally not
    // detected — redacting every occurrence over-redacts, redacting one leaves a leak-scan survivor.
    expect(values("יליד 1969", "DATE_OF_BIRTH")).toEqual([]);
    expect(values("ילידי שנות ה-2000 בישראל", "DATE_OF_BIRTH")).toEqual([]);
    expect(values("חוזה משנת 2024", "DATE_OF_BIRTH")).toEqual([]);
  });

  it("flags an עוסק מורשה number as an ID", () => {
    expect(values("עוסק מורשה 305873946", "ISRAELI_ID")).toEqual(["305873946"]);
  });

  it("captures the WHOLE ID when filler pushes it near the window edge (no truncated-prefix leak)", () => {
    // Regression: a value straddling the window edge must be matched whole, not a truncated prefix whose
    // tail then leaks. '312345678' is checksum-invalid + non-phone-shaped, so only the labeled rule catches it.
    const text = "תעודת זהות של מרשי היא 312345678";
    expect(values(text, "ISRAELI_ID")).toEqual(["312345678"]);
    const out = anonymizeDeterministic(text).anonymizedText;
    expect(out).toContain("[ID_1]");
    // No digit of the ID survives (neither the whole value nor a truncated tail like "78").
    expect(out.replace(/\[ID_1\]/g, "")).not.toMatch(/\d/);
  });

  it("does NOT capture a dotted DATE inside a label window as a number type", () => {
    expect(values("דרכון בתוקף עד 12.03.2027", "IL_PASSPORT")).toEqual([]);
    expect(values("מספר זהות 12.03.2024", "ISRAELI_ID")).toEqual([]);
  });

  it("does NOT double-match the year inside a full birth date", () => {
    expect(values("יליד 14.07.1981", "DATE_OF_BIRTH")).toEqual(["14.07.1981"]);
    expect(values("יליד 14/07/1981", "DATE_OF_BIRTH")).toEqual(["14/07/1981"]);
  });

  it("does not tokenize a bare birth year at all, so a recurring year never trips the leak-scan", () => {
    // Regression for the production refusal: a bare year is not detected, so it is not a key needle and
    // cannot survive in the output as a leak — the file is produced normally.
    const out = anonymizeDeterministic("הנתבע יליד 1969 וההסכם נחתם בשנת 1969").anonymizedText;
    expect(out).not.toContain("[DOB");
    expect(out).toContain("יליד 1969");
  });

  it("does NOT read תזמורת / חפץ as ID / company labels", () => {
    const text = "התזמורת ניגנה 123456789 ליד חפץ 987654321";
    expect(values(text, "ISRAELI_ID")).toEqual([]);
    expect(values(text, "IL_COMPANY")).toEqual([]);
  });

  it("a labeled landline-shaped ID is tokenized [ID_n], not [PHONE_n]", () => {
    // 037541239 is landline-shaped AND fails the ID checksum; the label + resolve.ts tiebreak win it for ID.
    const out = anonymizeDeterministic("ת.ז. 037541239").anonymizedText;
    expect(out).toContain("[ID_1]");
    expect(out).not.toContain("[PHONE");
  });

  it("a labeled number does not swallow the next line's leading digit", () => {
    // "דרכון מס' 31234567\n9. ..." must not capture the "9" — that corrupts the value and merges lines.
    expect(values("דרכון מס' 31234567\n9. סעיף", "IL_PASSPORT")).toEqual(["31234567"]);
  });

  it("redacts BOTH occurrences of a labeled company number (occurrence-completion)", () => {
    const out = anonymizeDeterministic(
      'אורלייט, ח.פ. 514872903\nח.פ. עוסק מורשה 514872903',
    ).anonymizedText;
    expect(out.match(/\[COMPANY_1\]/g)).toHaveLength(2);
    expect(out).not.toContain("514872903");
  });
});
