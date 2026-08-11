/**
 * IL_IBAN — ISO-13616 mod-97 over the Israeli format (IL + 21 digits). The canonical valid
 * Israeli IBAN example is used for the positive; invalids break the checksum, the shape, or the
 * country prefix. Spacing in groups of four must be tolerated.
 */
import { describe, expect, it } from "vitest";
import { isValidIsraeliIban, israeliIbanRecognizer } from "./israeliIban";

const VALID_COMPACT = "IL620108000000099999999"; // canonical IL example
const VALID_SPACED = "IL62 0108 0000 0009 9999 999";

describe("isValidIsraeliIban", () => {
  it("accepts the canonical Israeli IBAN (compact and spaced)", () => {
    expect(isValidIsraeliIban(VALID_COMPACT)).toBe(true);
    expect(isValidIsraeliIban(VALID_SPACED)).toBe(true);
    expect(isValidIsraeliIban(VALID_COMPACT.toLowerCase())).toBe(true);
  });

  it("rejects a broken checksum (one digit changed)", () => {
    expect(isValidIsraeliIban("IL620108000000099999998")).toBe(false);
  });

  it("rejects wrong check digits", () => {
    expect(isValidIsraeliIban("IL000108000000099999999")).toBe(false);
  });

  it("rejects wrong length", () => {
    expect(isValidIsraeliIban("IL6201080000000999999")).toBe(false); // too short
    expect(isValidIsraeliIban("IL6201080000000999999990")).toBe(false); // too long
  });

  it("rejects a non-Israeli IBAN", () => {
    expect(isValidIsraeliIban("DE89370400440532013000")).toBe(false);
  });
});

describe("israeliIbanRecognizer", () => {
  it("detects a compact IBAN as a standalone value", () => {
    const spans = israeliIbanRecognizer.recognize(VALID_COMPACT);
    expect(spans).toHaveLength(1);
    expect(VALID_COMPACT.slice(spans[0].start, spans[0].end)).toBe(VALID_COMPACT);
    expect(spans[0].type).toBe("IL_IBAN");
  });

  it("detects a spaced IBAN including its spaces", () => {
    const spans = israeliIbanRecognizer.recognize(VALID_SPACED);
    expect(spans).toHaveLength(1);
    expect(VALID_SPACED.slice(spans[0].start, spans[0].end)).toBe(VALID_SPACED);
  });

  it("finds an IBAN inside a Hebrew sentence with correct offsets", () => {
    const text = "העבירו לחשבון IL620108000000099999999 עד סוף החודש";
    const spans = israeliIbanRecognizer.recognize(text);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("IL620108000000099999999");
  });

  it("does not detect a checksum-invalid IBAN-shaped string", () => {
    expect(israeliIbanRecognizer.recognize("IL620108000000099999998")).toHaveLength(0);
  });

  it("detects a hyphen-grouped IBAN (M-format)", () => {
    const text = "IL62-0108-0000-0009-9999-999";
    const spans = israeliIbanRecognizer.recognize(text);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe(text);
  });

  it("does not let a newline act as an in-number separator (no cross-line over-match)", () => {
    // The IBAN sits on its own line; the next line starts with digits. A \s separator would consume the
    // newline, overrun 19 groups / fail mod-97, and leak the IBAN. The horizontal-only separator stops it.
    const text = "IL620108000000099999999\n12345 המשך";
    const spans = israeliIbanRecognizer.recognize(text);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("IL620108000000099999999");
  });
});
