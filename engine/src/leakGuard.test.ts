/**
 * Integration guard: the output leak-scan (pdfVerify.textLeaks) must find NO surviving key value after
 * anonymizeWith — otherwise the app refuses the whole file ("selfVerifyFailed"). This pins the exact
 * production regression where a label-gated value that recurs in the document was tokenized at its label
 * but survived elsewhere, tripping the scan and blocking output.
 */
import { describe, expect, it } from "vitest";
import { anonymizeWith, anonymizeDeterministic } from "./pipeline";
import { anonymize } from "./anonymize";
import { resolveOverlaps } from "./resolve";
import { leakSpans } from "./heal";
import { textLeaks } from "./pdfVerify";

const neutralize = (text: string): string => text.replace(/[[\]]/g, "x");

/** Values from the key that still appear in the output (empty = the file is produced). */
function survivors(text: string): string[] {
  const result = anonymizeWith(text, [], [], []);
  const needles = [...new Set(result.key.map((row) => row.original))];
  return textLeaks(neutralize(result.anonymizedText), "", needles);
}

/** Survivors remaining AFTER the worker self-heal (locate + span the survivor, re-anonymize). */
function survivorsAfterHeal(text: string): string[] {
  let result = anonymizeWith(text, [], [], []);
  let leaked = textLeaks(neutralize(result.anonymizedText), "", result.key.map((r) => r.original));
  if (leaked.length > 0) {
    const rows = result.key.filter((r) => leaked.includes(r.original));
    const heal = leakSpans(text, rows);
    result = anonymize(text, resolveOverlaps([...result.spans, ...heal]));
    leaked = textLeaks(neutralize(result.anonymizedText), "", result.key.map((r) => r.original));
  }
  return leaked;
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

describe("office path (anonymizeDeterministic) — occurrence-completion + concat self-heal", () => {
  /** Survivors on the deterministic (docx/xlsx) path, after its occurrence-completion. */
  function detSurvivors(text: string): string[] {
    const r = anonymizeDeterministic(text);
    return textLeaks(neutralize(r.anonymizedText), "", r.key.map((row) => row.original));
  }
  /** Survivors on the office path AFTER the redactParts concat self-heal. */
  function detSurvivorsAfterHeal(text: string): string[] {
    let r = anonymizeDeterministic(text);
    let leaked = textLeaks(neutralize(r.anonymizedText), "", r.key.map((row) => row.original));
    if (leaked.length > 0) {
      const rows = r.key.filter((row) => leaked.includes(row.original));
      const heal = leakSpans(text, rows);
      r = anonymize(text, resolveOverlaps([...r.spans, ...heal]));
      leaked = textLeaks(neutralize(r.anonymizedText), "", r.key.map((row) => row.original));
    }
    return leaked;
  }

  it("a repeated same-format label-gated value is globalized (occurrence-completion)", () => {
    // Before completion on this path, "31847205" was caught only at the דרכון label and the repeat survived.
    expect(detSurvivors("דרכון 31847205 של הנתבע, ובהמשך 31847205 שוב")).toEqual([]);
  });

  it("a formatting-variant repeat is cleared by the concat self-heal", () => {
    const doc = "דרכון 31847205 של הנתבע, ובהמשך 31-847-205 שוב";
    expect(detSurvivors(doc)).toEqual(["31847205"]); // variant survives completion
    expect(detSurvivorsAfterHeal(doc)).toEqual([]); // healed
  });
});

describe("self-heal clears a formatting-variant survivor instead of refusing the file", () => {
  it("a label-gated passport that reappears in a different format is healed, not refused", () => {
    // "31847205" is caught only at the דרכון label; the reformatted "31-847-205" survives exact-surface
    // completion → old behavior threw TEXT_SELFVERIFY_FAILED and black-holed the file. Self-heal redacts it.
    const doc = "דרכון 31847205 של הנתבע. מופיע שוב: 31-847-205 בהמשך.";
    expect(survivors(doc)).toEqual(["31847205"]); // would have refused
    expect(survivorsAfterHeal(doc)).toEqual([]); // healed → file produced
  });
});
