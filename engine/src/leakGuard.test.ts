/**
 * Integration guard: the output leak-scan (pdfVerify.textLeaks) must find NO surviving key value after
 * anonymizeWith — otherwise the app refuses the whole file ("selfVerifyFailed"). This pins the exact
 * production regression where a label-gated value that recurs in the document was tokenized at its label
 * but survived elsewhere, tripping the scan and blocking output.
 */
import { describe, expect, it } from "vitest";
import { anonymizeWith } from "./pipeline";
import { textLeaks } from "./pdfVerify";

/** Values from the key that still appear in the output (empty = the file is produced). */
function survivors(text: string): string[] {
  const result = anonymizeWith(text, [], [], []);
  const needles = [...new Set(result.key.map((row) => row.original))];
  return textLeaks(result.anonymizedText, "", needles);
}

describe("output leak-scan is clean after anonymizeWith (no self-verify refusal)", () => {
  it("recurring label-gated values (ID / passport / bar) are redacted at every occurrence", () => {
    const doc =
      "הנתבע ת.ז. 037541239, דרכון 31847205, מ.ר. 42817.\n" +
      "בהמשך: ת.ז. 037541239 שוב, דרכון 31847205 שוב, מ.ר. 42817.";
    expect(survivors(doc)).toEqual([]);
  });

  it("a recurring bare year does not survive as a leak (bare year is not tokenized)", () => {
    // The value that caused the production refusal: "יליד 1969 … ילידי 1969".
    expect(survivors("הנתבע יליד 1969, ובהמשך ילידי 1969 בארץ")).toEqual([]);
  });

  it("a recurring full birth date is redacted everywhere it appears", () => {
    expect(survivors("יליד 14.07.1981, הפגישה נקבעה ל-14.07.1981")).toEqual([]);
  });
});
