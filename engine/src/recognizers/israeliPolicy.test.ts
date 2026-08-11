/**
 * IL_POLICY — number introduced by פוליסה (no national format, so keyword-anchored). Flags the
 * number token only; ignores the keyword with no following number.
 */
import { describe, expect, it } from "vitest";
import { israeliPolicyRecognizer } from "./israeliPolicy";

describe("israeliPolicyRecognizer", () => {
  it("detects a plain policy number", () => {
    const spans = israeliPolicyRecognizer.recognize("פוליסה 12345678");
    expect(spans).toHaveLength(1);
    expect("פוליסה 12345678".slice(spans[0].start, spans[0].end)).toBe("12345678");
    expect(spans[0].type).toBe("IL_POLICY");
  });

  it("handles מספר פוליסה and פוליסה מס׳ and hyphenated tokens", () => {
    expect(israeliPolicyRecognizer.recognize("מספר פוליסה 987654")[0]?.type).toBe("IL_POLICY");
    const hy = israeliPolicyRecognizer.recognize("פוליסה מס' 55-1234567");
    expect(hy).toHaveLength(1);
    expect("פוליסה מס' 55-1234567".slice(hy[0].start, hy[0].end)).toBe("55-1234567");
  });

  it("flags only the number, inside a Hebrew sentence", () => {
    const text = "התביעה הוגשה לפי פוליסה 44556677 של המבוטח";
    const spans = israeliPolicyRecognizer.recognize(text);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("44556677");
  });

  it("ignores the keyword with no following number", () => {
    expect(israeliPolicyRecognizer.recognize("הפוליסה שלי בתוקף")).toHaveLength(0);
  });

  it("handles 'פוליסת ביטוח מס׳' and 'פוליסה שמספרה' phrasings", () => {
    for (const [text, expected] of [
      ["פוליסת ביטוח מס' 98765432", "98765432"],
      ["פוליסה שמספרה 55501", "55501"],
    ] as const) {
      const spans = israeliPolicyRecognizer.recognize(text);
      expect(spans).toHaveLength(1);
      expect(text.slice(spans[0].start, spans[0].end)).toBe(expected);
    }
  });
});
