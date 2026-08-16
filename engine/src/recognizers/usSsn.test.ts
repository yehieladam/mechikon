import { describe, expect, test } from "vitest";
import { usSsnRecognizer } from "./usSsn";

const spanText = (text: string) =>
  usSsnRecognizer.recognize(text).map((s) => text.slice(s.start, s.end));

describe("usSsnRecognizer", () => {
  test("detects grouped SSNs (hyphen or space)", () => {
    expect(spanText("SSN 123-45-6789 here")).toEqual(["123-45-6789"]);
    expect(spanText("123 45 6789")).toEqual(["123 45 6789"]);
  });
  test("rejects SSA-invalid area/group/serial", () => {
    expect(spanText("000-45-6789")).toEqual([]);
    expect(spanText("666-45-6789")).toEqual([]);
    expect(spanText("900-45-6789")).toEqual([]);
    expect(spanText("123-00-6789")).toEqual([]);
    expect(spanText("123-45-0000")).toEqual([]);
  });
  test("does NOT match a bare 9-digit run (that is Israeli-ID shape)", () => {
    expect(spanText("203458179")).toEqual([]);
    expect(spanText("ת.ז. 123456789")).toEqual([]);
  });
  test("requires a consistent separator", () => {
    expect(spanText("123-45 6789")).toEqual([]); // mixed separators -> no match
  });
});
