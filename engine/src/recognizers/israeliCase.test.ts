/**
 * IL_CASE — conservative: the net-hamishpat dash format (5–7 digit first group) and numbers
 * introduced by תיק. Must NOT fire on an ISO date or a phone number. Prefixed forms (ת״א …)
 * are intentionally out of scope until the server file is reconciled.
 */
import { describe, expect, it } from "vitest";
import { israeliCaseRecognizer } from "./israeliCase";

describe("israeliCaseRecognizer — net hamishpat format", () => {
  it.each(["12345-06-20", "1234567-01-19", "54321-12-24"])("detects %s", (n) => {
    const spans = israeliCaseRecognizer.recognize(n);
    expect(spans).toHaveLength(1);
    expect(n.slice(spans[0].start, spans[0].end)).toBe(n);
    expect(spans[0].type).toBe("IL_CASE");
  });

  it("does not fire on a 4-digit-first ISO date", () => {
    expect(israeliCaseRecognizer.recognize("2020-06-15")).toHaveLength(0);
  });

  it("does not fire on a phone number", () => {
    expect(israeliCaseRecognizer.recognize("052-1234567")).toHaveLength(0);
  });

  it("does not fire on a too-short first group", () => {
    expect(israeliCaseRecognizer.recognize("123-06-20")).toHaveLength(0);
  });
});

describe("israeliCaseRecognizer — תיק context", () => {
  it("detects a number introduced by תיק, flagging only the number", () => {
    const text = "הוגש בתיק 12345/20 בבית המשפט";
    const spans = israeliCaseRecognizer.recognize(text);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("12345/20");
  });

  it("handles תיק מספר and תיק מס׳", () => {
    expect(israeliCaseRecognizer.recognize("תיק מספר 45678")).toHaveLength(1);
    expect(israeliCaseRecognizer.recognize("תיק מס' 987/19")).toHaveLength(1);
  });

  it("does not fire on the bare word תיק with no number", () => {
    expect(israeliCaseRecognizer.recognize("הדיון בתיק נדחה")).toHaveLength(0);
  });

  it("flags case-type-prefixed numbers (ע״א / בג״ץ / ת.פ. / ת״א), number only", () => {
    for (const [text, expected] of [
      ['ע"א 1234/05', "1234/05"],
      ['בג"ץ 5678/20', "5678/20"],
      ["ת.פ. 4587/09", "4587/09"],
      ['ת"א 9999/21', "9999/21"],
    ] as const) {
      const spans = israeliCaseRecognizer.recognize(text);
      expect(spans).toHaveLength(1);
      expect(text.slice(spans[0].start, spans[0].end)).toBe(expected);
    }
  });

  it("does NOT fire on a case prefix used as a plain word (ת״א = תל אביב) with no case number", () => {
    expect(israeliCaseRecognizer.recognize('ת"א רבתי היא עיר גדולה')).toHaveLength(0);
    expect(israeliCaseRecognizer.recognize('רחוב הרצל 12, ת"א 6971022')).toHaveLength(0);
  });
});
