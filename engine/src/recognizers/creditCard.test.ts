import { describe, expect, test } from "vitest";
import { creditCardRecognizer, luhnValid } from "./creditCard";

const spanText = (text: string) =>
  creditCardRecognizer.recognize(text).map((s) => text.slice(s.start, s.end));

describe("luhnValid", () => {
  test("accepts known-good PANs", () => {
    expect(luhnValid("4111111111111111")).toBe(true); // Visa test
    expect(luhnValid("5500005555555559")).toBe(true); // Mastercard test
    expect(luhnValid("378282246310005")).toBe(true); // Amex test (15)
  });
  test("rejects bad checksum / wrong length", () => {
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(luhnValid("123456789012")).toBe(false); // 12 digits
    expect(luhnValid("12345678901234567890")).toBe(false); // 20 digits
  });
});

describe("creditCardRecognizer", () => {
  test("detects a Luhn-valid card, plain and grouped", () => {
    expect(spanText("card 4111111111111111 ok")).toEqual(["4111111111111111"]);
    expect(spanText("4111 1111 1111 1111")).toEqual(["4111 1111 1111 1111"]);
    expect(spanText("4111-1111-1111-1111")).toEqual(["4111-1111-1111-1111"]);
  });
  test("ignores a number that fails Luhn", () => {
    expect(spanText("not a card 4111111111111112")).toEqual([]);
  });
  test("does not fire on a 9-digit Israeli ID or a 21-digit IBAN body", () => {
    expect(spanText("ת.ז. 203458179")).toEqual([]);
    expect(spanText("IL620108000000099999999")).toEqual([]);
  });
});
