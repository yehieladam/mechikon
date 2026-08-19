import { describe, it, expect } from "vitest";
import { wordAround, blocksToText, getText, type Composer } from "./editor";

describe("wordAround — whole word/value under a click", () => {
  it("keeps a hyphenated Hebrew name whole (BUG 1: internal '-' no longer cuts)", () => {
    const text = "היי בן-גוריון שלום";
    // offset lands on the "בן" side; the whole hyphenated unit must come back.
    expect(wordAround(text, 5)).toBe("בן-גוריון");
    // and from the far side of the hyphen too.
    expect(wordAround(text, 10)).toBe("בן-גוריון");
  });

  it("keeps an apostrophe/geresh name whole", () => {
    expect(wordAround("ג'ון סנואו", 1)).toBe("ג'ון");
  });

  it("keeps a dashed phone number whole", () => {
    expect(wordAround("טל 050-1234567 סוף", 6)).toBe("050-1234567");
  });

  it("keeps an email whole (internal '@' and '.')", () => {
    expect(wordAround("מייל dan@gmail.com כאן", 7)).toBe("dan@gmail.com");
  });

  it("trims trailing punctuation from the edge", () => {
    expect(wordAround("שלום.", 0)).toBe("שלום");
    expect(wordAround("(סוגריים)", 3)).toBe("סוגריים");
  });

  it("a click on the right edge (offset past last char) still selects the word", () => {
    expect(wordAround("אבג", 3)).toBe("אבג");
  });

  it("a click on a space selects the word to its left", () => {
    expect(wordAround("אבג דהו", 3)).toBe("אבג");
  });

  it("returns null inside an existing placeholder token (no nested masking)", () => {
    expect(wordAround("[NUM_1]", 2)).toBeNull();
    expect(wordAround("קח [שם_1] עכשיו", 5)).toBeNull();
  });

  it("returns null on empty or whitespace-only input", () => {
    expect(wordAround("", 0)).toBeNull();
    expect(wordAround("   ", 1)).toBeNull();
  });
});

describe("blocksToText — contenteditable round-trip symmetry (BUG 2)", () => {
  // Each block's innerText is what a real browser returns per top-level <p>: a single line, no
  // trailing block break. The old getText read el.innerText (TWO "\n" per block boundary, which
  // insertText re-inflated into empty paragraphs); the fix reads one "\n" per block so read == write.
  it("joins two paragraphs with a single newline (no inflated blank line)", () => {
    expect(blocksToText([{ innerText: "שורה א" }, { innerText: "שורה ב" }])).toBe("שורה א\nשורה ב");
  });

  it("preserves a deliberate empty paragraph as exactly one blank line", () => {
    expect(blocksToText([{ innerText: "א" }, { innerText: "" }, { innerText: "ב" }])).toBe("א\n\nב");
  });

  it("drops a block's own trailing block-break so it cannot compound", () => {
    expect(blocksToText([{ innerText: "שורה\n\n" }, { innerText: "עוד" }])).toBe("שורה\nעוד");
  });
});

describe("getText — plain input branch", () => {
  it("reads a textarea value unchanged (no block round-trip)", () => {
    const ta = { tagName: "TEXTAREA", value: "abc\n\ndef" } as unknown as Composer;
    expect(getText(ta)).toBe("abc\n\ndef");
  });
});
