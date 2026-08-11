/**
 * IL_PHONE recognizer — covers mobile (05x), non-geographic (07x), landline (02/03/04/08/09),
 * the +972 international trunk, and common separator styles; plus negatives (bad prefix, wrong
 * length, and a 9-digit Israeli ID that must NOT be read as a phone).
 */
import { describe, expect, it } from "vitest";
import { isValidIsraeliPhone, israeliPhoneRecognizer } from "./israeliPhone";

const VALID = [
  "052-1234567", // mobile, hyphen
  "0521234567", // mobile, no separators
  "050 123 4567", // mobile, spaces
  "054.123.4567", // mobile, dots
  "073-1234567", // non-geographic 07x
  "03-1234567", // Tel Aviv landline
  "02-1234567", // Jerusalem landline
  "09-1234567", // Sharon landline
  "+972-52-1234567", // international mobile
  "+972521234567", // international mobile, compact
  "972-3-1234567", // international landline, no plus
];

const INVALID = [
  "06-1234567", // 06 is not an assigned area code
  "071-1234567", // 071 not assigned (07[2-9] only)
  "052-12345", // too short
  "03-123456789", // too long
  "1234567", // no trunk, too short
];

describe("isValidIsraeliPhone (numbering plan)", () => {
  it.each(VALID)("accepts %s", (n) => {
    expect(isValidIsraeliPhone(n)).toBe(true);
  });

  it.each(INVALID)("rejects %s", (n) => {
    expect(isValidIsraeliPhone(n)).toBe(false);
  });

  it("does not treat a 9-digit Israeli ID as a phone", () => {
    expect(isValidIsraeliPhone("123456709")).toBe(false);
  });
});

describe("israeliPhoneRecognizer", () => {
  it.each(VALID)("detects %s as a standalone number", (n) => {
    const spans = israeliPhoneRecognizer.recognize(n);
    expect(spans).toHaveLength(1);
    expect(n.slice(spans[0].start, spans[0].end)).toBe(n);
    expect(spans[0].type).toBe("IL_PHONE");
  });

  it.each(INVALID)("does not detect %s", (n) => {
    expect(israeliPhoneRecognizer.recognize(n)).toHaveLength(0);
  });

  it("finds a phone embedded in a Hebrew sentence with correct offsets", () => {
    const text = "אפשר להשיג את הלקוח בטלפון 052-1234567 בשעות הבוקר";
    const spans = israeliPhoneRecognizer.recognize(text);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("052-1234567");
  });

  it("does not flag a 9-digit ID sitting in Hebrew text", () => {
    const text = 'ת"ז של הלקוח היא 123456709';
    expect(israeliPhoneRecognizer.recognize(text)).toHaveLength(0);
  });

  it("does not bite into a longer digit run", () => {
    // 12 digits — no clean phone boundary; must not yield a 10-digit sub-match.
    expect(israeliPhoneRecognizer.recognize("035212345670123")).toHaveLength(0);
  });

  it("detects multiple distinct numbers in one text", () => {
    const text = "משרד 03-1234567 ונייד 052-7654321";
    const values = israeliPhoneRecognizer
      .recognize(text)
      .map((span) => text.slice(span.start, span.end));
    expect(values).toEqual(["03-1234567", "052-7654321"]);
  });

  describe("M-format (parenthesized area code + multiple separators)", () => {
    it("accepts a parenthesized landline with a space and hyphen", () => {
      expect(isValidIsraeliPhone("(02) 624-1234")).toBe(true);
      const spans = israeliPhoneRecognizer.recognize("להתקשר (02) 624-1234 בבוקר");
      expect(spans).toHaveLength(1);
      expect(spans[0].type).toBe("IL_PHONE");
    });

    it("accepts a mobile written with a double space", () => {
      const spans = israeliPhoneRecognizer.recognize("נייד 052  1234567");
      expect(spans).toHaveLength(1);
      expect(spans[0].type).toBe("IL_PHONE");
    });

    it("does NOT swallow the next line's leading digit (numbered clauses)", () => {
      // A newline must not act as an in-number separator: "...052-1234567\n8. ..." would otherwise
      // overflow the numbering plan and leak the whole phone. Common in numbered legal documents.
      const spans = israeliPhoneRecognizer.recognize("7. טלפון 052-1234567\n8. ביום 15.3.2024");
      expect(spans).toHaveLength(1);
      expect(spans[0].type).toBe("IL_PHONE");
    });

    it("treats NBSP / narrow-NBSP as in-number separators (Word/PDF keep-together spaces)", () => {
      const nbsp = String.fromCharCode(0x00a0);
      const narrow = String.fromCharCode(0x202f);
      expect(isValidIsraeliPhone(`03${nbsp}624${nbsp}1234`)).toBe(true);
      const spans = israeliPhoneRecognizer.recognize(`נייד 052${narrow}123${narrow}4567`);
      expect(spans).toHaveLength(1);
      expect(spans[0].type).toBe("IL_PHONE");
    });

    it("does NOT cross a Unicode LINE/PARAGRAPH separator (U+2028/U+2029) into the next number", () => {
      // Guard against a fix that uses \s or [^\S\n\r]: both admit U+2028/U+2029 and re-open the leak.
      for (const sep of [String.fromCharCode(0x2028), String.fromCharCode(0x2029)]) {
        const spans = israeliPhoneRecognizer.recognize(`052-1234567${sep}8`);
        expect(spans).toHaveLength(1);
        expect(spans[0].end - spans[0].start).toBe("052-1234567".length);
      }
    });
  });
});
