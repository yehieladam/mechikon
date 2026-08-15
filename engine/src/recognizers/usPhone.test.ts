import { describe, expect, test } from "vitest";
import { usPhoneRecognizer } from "./usPhone";

const spanText = (text: string) =>
  usPhoneRecognizer.recognize(text).map((s) => text.slice(s.start, s.end));

describe("usPhoneRecognizer", () => {
  test("detects structured NANP numbers", () => {
    expect(spanText("call (415) 555-2671")).toEqual(["(415) 555-2671"]);
    expect(spanText("415-555-2671")).toEqual(["415-555-2671"]);
    expect(spanText("415.555.2671")).toEqual(["415.555.2671"]);
    expect(spanText("+1 415 555 2671")).toEqual(["+1 415 555 2671"]);
  });
  test("does NOT match a bare 10-digit run (too false-positive-prone)", () => {
    expect(spanText("4155552671")).toEqual([]);
  });
  test("rejects area/exchange starting with 0 or 1 (excludes Israeli numbers)", () => {
    expect(spanText("052-123-4567")).toEqual([]); // IL mobile shape
    expect(spanText("03-123-4567")).toEqual([]);
    expect(spanText("115-555-2671")).toEqual([]); // exchange starts with 1
  });
});
