import { describe, expect, it } from "vitest";
import { layerB, layerC, normalizeForLeak } from "./pdfVerify";

const enc = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function deflate(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Wrap payload bytes in a `<< dict >> stream … endstream` object. */
function streamObject(dict: string, payload: Uint8Array): Uint8Array {
  return concat([enc.encode(`1 0 obj\n<< ${dict} >>\nstream\n`), payload, enc.encode("\nendstream\nendobj\n")]);
}

describe("normalizeForLeak", () => {
  it("collapses soft hyphens, dashes and spaces so a split number cannot hide", () => {
    expect(normalizeForLeak("052­1234567")).toBe("0521234567");
    expect(normalizeForLeak("052-1234567")).toBe("0521234567");
    expect(normalizeForLeak("052 123 4567")).toBe("0521234567");
  });
});

describe("layerC", () => {
  it("passes with exactly one %%EOF and one startxref", () => {
    const bytes = enc.encode("%PDF-1.7\n...\nstartxref\n123\n%%EOF\n");
    expect(layerC(bytes)).toMatchObject({ pass: true, eofCount: 1, startxrefCount: 1 });
  });

  it("fails when a prior generation leaves a second %%EOF / startxref", () => {
    const bytes = enc.encode("%PDF\nstartxref\n1\n%%EOF\n...update...\nstartxref\n2\n%%EOF\n");
    expect(layerC(bytes)).toMatchObject({ pass: false, eofCount: 2, startxrefCount: 2 });
  });
});

describe("layerB", () => {
  it("catches a plaintext value in UTF-8", async () => {
    const bytes = enc.encode("BT (Phone: 052-1234567) Tj ET");
    const result = await layerB(bytes, ["052-1234567"]);
    expect(result.pass).toBe(false);
    expect(result.hits.some((h) => h.includes("utf-8"))).toBe(true);
  });

  it("catches a Hebrew value stored in reversed visual order", async () => {
    // File stores the name reversed (as mupdf extracts it); the needle is logical order.
    const bytes = enc.encode("BT (לארשי) Tj ET"); // "לארשי" = reverse("ישראל")
    const result = await layerB(bytes, ["ישראל"]); // "ישראל"
    expect(result.pass).toBe(false);
    expect(result.hits.some((h) => h.includes("reversed"))).toBe(true);
  });

  it("catches a value hidden in a compressed (Flate) content stream", async () => {
    const payload = await deflate("secret 209-leak-value here 052-1234567");
    const bytes = concat([enc.encode("%PDF\n"), streamObject("/Filter /FlateDecode", payload)]);
    const result = await layerB(bytes, ["052-1234567"]);
    expect(result.pass).toBe(false);
  });

  it("does NOT false-positive a numeric needle inside a compressed FONT stream", async () => {
    // A font's glyph table legitimately contains "0123456789"; inflating it must be skipped.
    const payload = await deflate("glyph map 0123456789 abcdef");
    const bytes = concat([
      enc.encode("%PDF\n"),
      streamObject("/Type /Font /FontFile2 100 /Length1 100 /Filter /FlateDecode", payload),
    ]);
    const result = await layerB(bytes, ["0123456789"]);
    expect(result.pass).toBe(true); // skipped — no false leak
  });

  it("passes a clean file with none of the needles present", async () => {
    const bytes = enc.encode("%PDF\nBT (nothing sensitive) Tj ET\nstartxref\n1\n%%EOF");
    const result = await layerB(bytes, ["052-1234567", "ישראל"]);
    expect(result.pass).toBe(true);
  });
});

describe("highConfidenceSurvivors — B2 soft-warn filter (full-value survivals only, no fragment noise)", () => {
  // Owner decision (#90 context): the pdfUnverified warning was removed because layer B's raw-byte
  // SUBSTRING scan fired on short name fragments inside unrelated words. The warning comes back only
  // for HIGH-CONFIDENCE survivors: structured values, or a full multi-token name surface.
  it("keeps a structured value (ID) that hit — a full identifier surviving is always a real signal", async () => {
    const { highConfidenceSurvivors } = await import("./pdfVerify");
    const rows = [{ original: "123456709", type: "ISRAELI_ID" as const }];
    expect(highConfidenceSurvivors(rows, ["123456709"])).toEqual(["123456709"]);
  });

  it("drops a single short PERSON fragment that only substring-matched (the #90 noise)", async () => {
    const { highConfidenceSurvivors } = await import("./pdfVerify");
    const rows = [{ original: "דן", type: "PERSON" as const }];
    // layer B substring-matched "דן" inside "ירדן" — NOT a whole-value survival, never warned.
    expect(highConfidenceSurvivors(rows, ["דן"])).toEqual([]);
  });

  it("keeps a full multi-token PERSON whose complete surface survived", async () => {
    const { highConfidenceSurvivors } = await import("./pdfVerify");
    const rows = [{ original: "ישראל ישראלי", type: "PERSON" as const }];
    expect(highConfidenceSurvivors(rows, ["ישראל ישראלי"])).toEqual(["ישראל ישראלי"]);
  });

  it("treats a digits-only MANUAL term as structured (digit-bounded hits are meaningful)", async () => {
    const { highConfidenceSurvivors } = await import("./pdfVerify");
    const rows = [{ original: "987654321", type: "MANUAL" as const }];
    expect(highConfidenceSurvivors(rows, ["987654321"])).toEqual(["987654321"]);
  });

  it("drops a single-token MANUAL word (same fragment-noise class as a short name)", async () => {
    const { highConfidenceSurvivors } = await import("./pdfVerify");
    const rows = [{ original: "Dan", type: "MANUAL" as const }];
    expect(highConfidenceSurvivors(rows, ["Dan"])).toEqual([]);
  });

  it("only surfaces rows that actually hit", async () => {
    const { highConfidenceSurvivors } = await import("./pdfVerify");
    const rows = [
      { original: "123456709", type: "ISRAELI_ID" as const },
      { original: "052-1234567", type: "IL_PHONE" as const },
    ];
    expect(highConfidenceSurvivors(rows, ["052-1234567"])).toEqual(["052-1234567"]);
  });
});
