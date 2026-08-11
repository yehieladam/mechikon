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

  it("flags a bare birth YEAR after יליד / ילידת / נולד", () => {
    expect(values("יליד 1969", "DATE_OF_BIRTH")).toEqual(["1969"]);
    expect(values("ילידת 1959", "DATE_OF_BIRTH")).toEqual(["1959"]);
    expect(values("נולד 1948", "DATE_OF_BIRTH")).toEqual(["1948"]);
  });

  it("does NOT read the plural ילידי (natives of) as a birth year, nor a plain year", () => {
    expect(values("ילידי שנות ה-2000 בישראל", "DATE_OF_BIRTH")).toEqual([]);
    expect(values("חוזה משנת 2024", "DATE_OF_BIRTH")).toEqual([]);
  });

  it("flags an עוסק מורשה number as an ID", () => {
    expect(values("עוסק מורשה 305873946", "ISRAELI_ID")).toEqual(["305873946"]);
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
