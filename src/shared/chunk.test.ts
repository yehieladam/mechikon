/**
 * chunkText: bounds each piece, never loses characters (concatenation reconstructs the source), keeps
 * absolute offsets accurate, and prefers whitespace boundaries so words/names aren't cut.
 */
import { describe, it, expect } from "vitest";
import { chunkText } from "./chunk";

describe("chunkText", () => {
  it("returns a single chunk when the text fits", () => {
    expect(chunkText("short text", 800)).toEqual([{ text: "short text", offset: 0 }]);
  });

  it("returns nothing for empty text", () => {
    expect(chunkText("", 800)).toEqual([]);
  });

  it("reconstructs the exact source when concatenated, with correct offsets", () => {
    const text = Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkText(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.text).join("")).toBe(text);
    for (const chunk of chunks) {
      expect(text.slice(chunk.offset, chunk.offset + chunk.text.length)).toBe(chunk.text);
      expect(chunk.text.length).toBeLessThanOrEqual(40);
    }
  });

  it("breaks on whitespace, not mid-word", () => {
    const text = "aaaa bbbb cccc dddd eeee ffff";
    const chunks = chunkText(text, 12);
    // Every chunk except possibly the last ends at a space boundary (word kept whole).
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.text.endsWith(" ")).toBe(true);
    }
    expect(chunks.map((c) => c.text).join("")).toBe(text);
  });

  it("still makes progress on a single token longer than the limit", () => {
    const text = "x".repeat(2000);
    const chunks = chunkText(text, 800);
    expect(chunks.map((c) => c.text).join("")).toBe(text);
    expect(chunks.every((c) => c.text.length <= 800)).toBe(true);
  });
});
