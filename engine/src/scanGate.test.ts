/**
 * Scan-quality gate — one layer of the OCR track's defense-in-depth (NOT the sole guarantee; confident
 * misreads are handled at the content layer — see docs/ocr-calibration.md). These tests pin the
 * Stage-1-calibrated whole-page bar: lowRatio is the primary separator (MAX 0.12), meanConf is a weak
 * backstop (FLOOR 75), an unreadable page is refused, whitespace never skews the numbers, and the
 * bounds are inclusive.
 */
import { describe, expect, it } from "vitest";
import { evaluateScanQuality, SCAN_LOW_CONFIDENCE } from "./scanGate";
import type { OcrPageResult, OcrWord } from "./ocrTypes";

const box = { x0: 0, y0: 0, x1: 10, y1: 10 };
const word = (confidence: number, text = "מ"): OcrWord => ({ text, confidence, bbox: box });

function page(words: OcrWord[]): OcrPageResult {
  const nonEmpty = words.filter((w) => w.text.trim().length > 0);
  const mean = nonEmpty.length ? nonEmpty.reduce((s, w) => s + w.confidence, 0) / nonEmpty.length : 0;
  return { words, meanConfidence: mean, imageWidth: 1000, imageHeight: 1400 };
}

describe("evaluateScanQuality", () => {
  it("1. passes a clean page (all words high, mean 91, lowRatio 0)", () => {
    expect(evaluateScanQuality(page([word(91), word(91), word(91)])).ok).toBe(true);
  });

  it("2. accepts the corpus clean-max lowRatio (.091) — must not false-refuse a clean scan", () => {
    // 1 low(<60) of 11 → ratio 0.0909 (<= 0.12), mean ~91 (>= 75). This is the observed clean-max; the
    // MAX threshold is set with headroom above it precisely so real clean scans pass.
    const words = [...Array(10).fill(word(95)), word(55)];
    expect(evaluateScanQuality(page(words)).ok).toBe(true);
  });

  it("3. refuses the corpus fail-min lowRatio (.167) even when the mean passes", () => {
    // 5 low(<60) of 30 → ratio 0.1667 (> 0.12); mean 88.3 (>= 75). lowRatio fires alone — this is where
    // real recall failures begin, so the gate must refuse.
    const words = [...Array(25).fill(word(95)), ...Array(5).fill(word(55))];
    const result = evaluateScanQuality(page(words));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe(SCAN_LOW_CONFIDENCE);
  });

  it("4. meanConf FLOOR (75) is the illegible-collapse backstop: mean < 75 refuses", () => {
    // All words conf 70 → lowRatio 0 (70 >= LOW_CONF_WORD_FLOOR 60) so lowRatio passes; mean 70 < 75
    // must still refuse. This isolates the meanConf backstop from lowRatio.
    expect(evaluateScanQuality(page([word(70), word(70), word(70)])).ok).toBe(false);
    // And a good-mean clean page above the floor passes (mean 79.4 was the lowest corpus pass).
    expect(evaluateScanQuality(page([word(80), word(80), word(80)])).ok).toBe(true);
  });

  it("5. lowRatio boundary is inclusive at exactly 0.12 and refuses just above", () => {
    const highs = (n: number) => Array(n).fill(word(95));
    const lows = (n: number) => Array(n).fill(word(55));
    // 12 low of 100 → ratio exactly 0.12 → accept (inclusive <=); mean 90.2 >= 75.
    expect(evaluateScanQuality(page([...highs(88), ...lows(12)])).ok).toBe(true);
    // 13 low of 100 → ratio 0.13 → refuse.
    expect(evaluateScanQuality(page([...highs(87), ...lows(13)])).ok).toBe(false);
  });

  it("6. refuses an unreadable page (no text words)", () => {
    expect(evaluateScanQuality(page([])).ok).toBe(false);
    expect(evaluateScanQuality(page([word(99, "   ")])).ok).toBe(false);
  });

  it("7. excludes whitespace-only words from the mean and ratio", () => {
    // Three real high words (mean 95) plus whitespace tokens with junk confidence that would sink a
    // naive average — the gate must ignore them and pass.
    const words = [word(95), word(95), word(95), word(1, " "), word(1, "\t")];
    expect(evaluateScanQuality(page(words)).ok).toBe(true);
  });

  it("8. refuses a page with near-zero recognized words (a lone token cannot certify a page)", () => {
    // The gate scores only words OCR actually FOUND, so ink tesseract cannot read at all (handwriting,
    // stamps) contributes nothing. A page that collapses to a single high-confidence token is not
    // "clean" — it is near-zero recognized text with unread ink, and must fail closed on the strength of
    // that one token's confidence. Two clean words remain the pass floor (a genuinely sparse page).
    expect(evaluateScanQuality(page([word(95)])).ok).toBe(false);
    expect(evaluateScanQuality(page([word(95), word(95)])).ok).toBe(true);
  });
});
