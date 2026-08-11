/**
 * Scan-key fidelity tagging — the safety-critical part is that a value the engine did NOT actually verify
 * (no checksum, or a checksum-invalid label-gated hit) is never marked "validated" on the OCR path, because
 * "validated" tells the UI to trust the restore without review. Regression guard for the review finding
 * where the old `default: "validated"` mis-tagged passport/bar/DOB/case/land/policy/insured and
 * label-gated-invalid company.
 */
import { describe, expect, it } from "vitest";
import type { EntityType, KeyRow } from "./types";
import { markScanKeySources } from "./scanKey";

function sourceOf(type: EntityType, original: string): KeyRow["source"] {
  const [row] = markScanKeySources([{ placeholder: "[X_1]", original, type }]);
  return row.source;
}

describe("scanKey fidelity tagging", () => {
  it("marks checksum-free numeric types as OCR-quality, never 'validated'", () => {
    for (const type of ["IL_PASSPORT", "IL_BAR", "DATE_OF_BIRTH", "IL_CASE", "IL_LAND", "IL_POLICY", "IL_INSURED"] as const) {
      expect(sourceOf(type, "12345678"), type).toBe("ocr");
    }
  });

  it("marks a label-gated checksum-INVALID company as OCR, a valid one as validated", () => {
    expect(sourceOf("IL_COMPANY", "514872903")).toBe("ocr"); // fails the checksum
    expect(sourceOf("IL_COMPANY", "520013954")).toBe("validated"); // passes
  });

  it("keeps the verified types as 'validated'", () => {
    expect(sourceOf("ISRAELI_ID", "039485768")).toBe("validated"); // valid Luhn
    expect(sourceOf("IL_PHONE", "0523334455")).toBe("validated");
    expect(sourceOf("IL_IBAN", "IL620108000000099999999")).toBe("validated");
    expect(sourceOf("EMAIL_ADDRESS", "a@b.co.il")).toBe("validated");
  });

  it("downgrades a checksum-failing ID/phone to ocr (digit) or unreadable (no digit)", () => {
    expect(sourceOf("ISRAELI_ID", "111111111")).toBe("ocr"); // digits but invalid Luhn
    expect(sourceOf("IL_PASSPORT", "")).toBe("unreadable"); // OCR produced no digit
  });

  it("keeps NER types as OCR-quality", () => {
    for (const type of ["PERSON", "ORGANIZATION", "LOCATION", "IL_NUMBER"] as const) {
      expect(sourceOf(type, "כהן")).toBe("ocr");
    }
  });
});
