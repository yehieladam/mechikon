/**
 * Same gate as the server's check_task1.py: the 5 checksum-VALID synthetic IDs it builds
 * (prefixes 1234567/8765432/2030405/1111111/9988776, zero-padded to 8 + computed check
 * digit) must pass, and each with the last digit flipped (+1 mod 10) must fail.
 */
import { describe, expect, it } from "vitest";
import { isValidIsraeliId, israeliIdRecognizer } from "./israeliId";

const VALID_IDS = ["123456709", "876543208", "203040506", "111111100", "998877609"];
// check_task1.py's make_invalid_id: flip the last digit (+1 mod 10) so the checksum fails.
const INVALID_IDS = ["123456700", "876543209", "203040507", "111111101", "998877600"];

describe("isValidIsraeliId (Luhn checksum, server parity)", () => {
  it.each(VALID_IDS)("accepts checksum-valid ID %s", (id) => {
    expect(isValidIsraeliId(id)).toBe(true);
  });

  it.each(INVALID_IDS)("rejects checksum-invalid ID %s", (id) => {
    expect(isValidIsraeliId(id)).toBe(false);
  });

  it("rejects the all-zeros ID even though its checksum sums to 0", () => {
    expect(isValidIsraeliId("000000000")).toBe(false);
  });

  it("left-pads short IDs with zeros like the server does", () => {
    // 123456709 minus its leading digit is only valid if padding restores 9 digits
    // with a passing checksum — 023456709: 0+4+3+8+5+3+7+0+9 = 39 -> invalid.
    expect(isValidIsraeliId("23456709")).toBe(false);
    // 3040506 pads to 003040506: 0+0+3+0+4+0+5+0+6 = 18 -> invalid.
    expect(isValidIsraeliId("3040506")).toBe(false);
  });

  it("rejects empty and over-long inputs", () => {
    expect(isValidIsraeliId("")).toBe(false);
    expect(isValidIsraeliId("1234567090")).toBe(false);
  });
});

describe("israeliIdRecognizer", () => {
  it.each(VALID_IDS)("detects valid ID %s as a standalone number", (id) => {
    const spans = israeliIdRecognizer.recognize(id);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ start: 0, end: 9, type: "ISRAELI_ID" });
  });

  it.each(INVALID_IDS)("does not detect checksum-invalid number %s", (id) => {
    expect(israeliIdRecognizer.recognize(id)).toHaveLength(0);
  });

  it("finds a valid ID embedded in a Hebrew sentence with correct offsets", () => {
    const text = 'ת"ז של הלקוח היא 123456709 בבקשה';
    const spans = israeliIdRecognizer.recognize(text);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("123456709");
  });

  it("does not flag 9-digit windows inside longer digit runs", () => {
    // 123456709 is valid, but here it is part of a 12-digit number (e.g. an account/IBAN tail).
    expect(israeliIdRecognizer.recognize("123123456709")).toHaveLength(0);
  });

  it("detects multiple distinct valid IDs in one text", () => {
    const text = "ראשון 123456709 ושני 876543208";
    const values = israeliIdRecognizer
      .recognize(text)
      .map((span) => text.slice(span.start, span.end));
    expect(values).toEqual(["123456709", "876543208"]);
  });
});

describe("israeliIdRecognizer — H-id8 (8-digit + separator forms, gated to ID context)", () => {
  it("detects an 8-digit ID (dropped leading zero) next to a ת\"ז label", () => {
    const text = 'ת"ז 61234506'; // -> 061234506, checksum-valid
    const spans = israeliIdRecognizer.recognize(text);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("61234506");
    expect(spans[0].type).toBe("ISRAELI_ID");
  });

  it("detects a separator-formatted 9-digit ID next to a ת\"ז label", () => {
    const text = 'ת"ז 061-234-506';
    const spans = israeliIdRecognizer.recognize(text);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("061-234-506");
  });

  it("detects an 8-digit ID after a מספר זהות label", () => {
    const spans = israeliIdRecognizer.recognize("מספר זהות: 61234506");
    expect(spans.map((s) => s.type)).toContain("ISRAELI_ID");
  });

  it("does NOT flag a bare 8-digit number with no ID context (over-refusal guard)", () => {
    // Same digits, no ת"ז/זהות nearby — must stay untouched so ordinary 8-digit numbers are not eaten.
    expect(israeliIdRecognizer.recognize("יתרה 61234506 שקלים")).toHaveLength(0);
  });

  it("does not double-count a 9-digit ID that already matched the standalone run", () => {
    const text = 'ת"ז של הלקוח היא 123456709 בבקשה';
    expect(israeliIdRecognizer.recognize(text)).toHaveLength(1);
  });
});

describe("israeliIdRecognizer — M-2 (anchored separator, no cross-word ת...ז over-refusal)", () => {
  // The ת...ז context must be an ACTUAL ת"ז token, not ת and ז landing in two unrelated
  // quoted words with a plain 8-digit number nearby. Each of these is an ordinary number.
  it("does NOT flag a plain number in 'בעלת \"זכות\" בחשבון 61234506'", () => {
    expect(israeliIdRecognizer.recognize('בעלת "זכות" בחשבון 61234506')).toHaveLength(0);
  });

  it("does NOT flag a plain number in 'עלות \"זהב\" של 61234506'", () => {
    expect(israeliIdRecognizer.recognize('עלות "זהב" של 61234506')).toHaveLength(0);
  });

  it("does NOT flag a plain number in 'רשות \"זמנית\" מספר 61234506'", () => {
    expect(israeliIdRecognizer.recognize('רשות "זמנית" מספר 61234506')).toHaveLength(0);
  });

  it("still detects a real ת\"ז label (positive)", () => {
    const spans = israeliIdRecognizer.recognize('ת"ז 61234506');
    expect(spans.map((s) => s.type)).toContain("ISRAELI_ID");
  });

  it("still detects a real ת.ז label (positive)", () => {
    const spans = israeliIdRecognizer.recognize("ת.ז 61234506");
    expect(spans.map((s) => s.type)).toContain("ISRAELI_ID");
  });

  it("still detects a מספר זהות label (positive)", () => {
    const spans = israeliIdRecognizer.recognize("מספר זהות 61234506");
    expect(spans.map((s) => s.type)).toContain("ISRAELI_ID");
  });

  it("captures a grouped ID WHOLE when filler pushes it near the context window edge", () => {
    // Regression twin of the labeled-window truncation: a grouped valid ID some words after the label must
    // be captured in full, not as a truncated prefix that leaks its last digit.
    const text = "תעודת זהות של מרשי היא 12-345-6709";
    const span = israeliIdRecognizer.recognize(text).find((s) => s.type === "ISRAELI_ID");
    expect(span).toBeDefined();
    expect(text.slice(span!.start, span!.end)).toBe("12-345-6709");
  });
});
