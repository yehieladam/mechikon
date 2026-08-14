import { describe, expect, test } from "vitest";
import { detectTextLang, stripInstruction, withInstruction } from "./instruction";

describe("stripInstruction", () => {
  test("removes an appended instruction block", () => {
    const body = "שלום, קוראים לי [NAME_1]";
    expect(stripInstruction(withInstruction(body, "he"))).toBe(body);
    expect(stripInstruction(withInstruction(body, "en"))).toBe(body);
  });

  test("leaves text without an instruction untouched", () => {
    expect(stripInstruction("plain text")).toBe("plain text");
  });
});

describe("detectTextLang", () => {
  test("Hebrew text with Latin tokens is still Hebrew (tokens don't count)", () => {
    // Heavily masked: more Latin letters live in the tokens than Hebrew letters in the body.
    const redacted = "[NAME_1], [ID_1], טל [PHONE_1], מייל [EMAIL_1], ח.פ. [COMPANY_1]";
    expect(detectTextLang(redacted, "he")).toBe("he");
  });

  test("Hebrew source with an English instruction appended is still Hebrew", () => {
    const redacted = withInstruction("שלום דוד כהן, מה שלומך היום", "en");
    expect(detectTextLang(redacted, "en")).toBe("he");
  });

  test("English source with tokens is still English", () => {
    expect(detectTextLang("Hello [NAME_1], your id is [ID_1]", "he")).toBe("en");
  });

  test("empty / token-only falls back to the default", () => {
    expect(detectTextLang("[NAME_1] [ID_2]", "en")).toBe("en");
    expect(detectTextLang("", "he")).toBe("he");
  });
});
