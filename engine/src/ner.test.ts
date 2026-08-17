/**
 * NER post-processing — tag mapping + offset/## reconstruction, tested against RECORDED dictabert
 * outputs (browser-poc/browser_result.json). The live model is never loaded here (CI won't pull
 * 185 MB); createHebrewNer is exercised by the manual recall harness.
 */
import { describe, expect, it } from "vitest";
import { mapNerTag, reconstructNerSpans, type RawNerSpan } from "./ner";

describe("mapNerTag", () => {
  it("maps model tags server-style", () => {
    expect(mapNerTag("PER")).toBe("PERSON");
    expect(mapNerTag("ORG")).toBe("ORGANIZATION");
    expect(mapNerTag("GPE")).toBe("LOCATION");
    expect(mapNerTag("LOC")).toBe("LOCATION");
    expect(mapNerTag("FAC")).toBe("LOCATION");
  });

  it("drops unknown tags", () => {
    expect(mapNerTag("MISC")).toBeNull();
    expect(mapNerTag("")).toBeNull();
  });
});

describe("reconstructNerSpans — recorded clean output", () => {
  const text = "דוד כהן הגיש בקשה למשרד הפנים בירושלים.";
  const raw: RawNerSpan[] = [
    { raw: "PER", surface: "דוד כהן", score: 0.9999 },
    { raw: "ORG", surface: "למשרד הפנים", score: 0.9999 },
    { raw: "GPE", surface: "בירושלים", score: 0.9993 },
  ];

  it("aligns each surface to correct offsets and types", () => {
    const spans = reconstructNerSpans(text, raw);
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual([
      "דוד כהן",
      "למשרד הפנים",
      "בירושלים",
    ]);
    expect(spans.map((s) => s.type)).toEqual(["PERSON", "ORGANIZATION", "LOCATION"]);
  });
});

describe("reconstructNerSpans — the ## hyphenated-name artifact (the real port fix)", () => {
  it("rebuilds the full name truncated at a ## wordpiece", () => {
    const text = "עורכת הדין רחל לוי-אברמוביץ ייצגה את חברת אלביט מערכות בתיק האזרחי.";
    const spans = reconstructNerSpans(text, [{ raw: "PER", surface: "רחל לוי ##-", score: 0.9999 }]);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("רחל לוי-אברמוביץ");
    expect(spans[0].type).toBe("PERSON");
  });

  it("rebuilds an org truncated at ## with a leading preposition", () => {
    const text = "המחקר נעשה באוניברסיטת בן-גוריון בנגב בשנה שעברה.";
    const spans = reconstructNerSpans(text, [
      { raw: "ORG", surface: "באוניברסיטת בן ##-", score: 0.99 },
    ]);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("באוניברסיטת בן-גוריון");
  });
});

describe("reconstructNerSpans — English (Latin continuation class)", () => {
  const LATIN = /[A-Za-z]/;

  it("aligns English person/org surfaces with the Latin continuation", () => {
    const text = "Hello, my name is John Smith and my client is Jane Doe from Acme Corporation.";
    const spans = reconstructNerSpans(
      text,
      [
        { raw: "PER", surface: "John Smith", score: 0.999 },
        { raw: "PER", surface: "Jane Doe", score: 0.999 },
        { raw: "ORG", surface: "Acme Corporation", score: 0.99 },
      ],
      LATIN,
    );
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual([
      "John Smith",
      "Jane Doe",
      "Acme Corporation",
    ]);
    expect(spans.map((s) => s.type)).toEqual(["PERSON", "PERSON", "ORGANIZATION"]);
  });

  it("rebuilds a hyphenated Latin name truncated at a ## wordpiece", () => {
    const text = "The report by Anne-Marie Slaughter was cited.";
    const spans = reconstructNerSpans(text, [{ raw: "PER", surface: "Anne ##-", score: 0.99 }], /[A-Za-z]/);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("Anne-Marie");
  });

  it("drops the model's MISC tag for English too", () => {
    const text = "The Israeli delegation attended.";
    expect(reconstructNerSpans(text, [{ raw: "MISC", surface: "Israeli", score: 1 }], /[A-Za-z]/)).toEqual(
      [],
    );
  });
});

describe("reconstructNerSpans — alignment behaviour", () => {
  it("skips a span whose surface is not in the text", () => {
    expect(reconstructNerSpans("טקסט ללא הישות", [{ raw: "PER", surface: "משה כהן", score: 1 }])).toEqual(
      [],
    );
  });

  it("skips unmapped tags before alignment", () => {
    const text = "משה כהן דיבר";
    expect(reconstructNerSpans(text, [{ raw: "MISC", surface: "משה כהן", score: 1 }])).toEqual([]);
  });

  it("maps repeated identical surfaces to successive positions via the cursor", () => {
    const text = "דוד כהן פגש את דוד כהן";
    const spans = reconstructNerSpans(text, [
      { raw: "PER", surface: "דוד כהן", score: 1 },
      { raw: "PER", surface: "דוד כהן", score: 1 },
    ]);
    expect(spans).toHaveLength(2);
    expect(spans[0].start).toBeLessThan(spans[1].start);
    expect(text.slice(spans[1].start, spans[1].end)).toBe("דוד כהן");
  });
});

describe("reconstructNerSpans — H-nerspan (whitespace-flexible + niqqud-stripped matching)", () => {
  it("matches a name split across a line break", () => {
    const text = "רחל\nלוי הגישה";
    const spans = reconstructNerSpans(text, [{ raw: "PER", surface: "רחל לוי", score: 1 }]);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("רחל\nלוי");
  });

  it("matches a name split by a double space", () => {
    const text = "רחל  לוי הגישה";
    const spans = reconstructNerSpans(text, [{ raw: "PER", surface: "רחל לוי", score: 1 }]);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("רחל  לוי");
  });

  it("matches a niqqud-bearing name when the model seed has no niqqud", () => {
    const text = "החתן יוֹסֵף עלה"; // text carries niqqud; model surface does not
    const spans = reconstructNerSpans(text, [{ raw: "PER", surface: "יוסף", score: 1 }]);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("יוֹסֵף");
  });

  it("still refuses to guess when there is no real occurrence", () => {
    expect(reconstructNerSpans("טקסט אחר לגמרי", [{ raw: "PER", surface: "רחל לוי", score: 1 }])).toEqual(
      [],
    );
  });
});
