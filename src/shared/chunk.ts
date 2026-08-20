/**
 * Split long text into NER-sized chunks. The BERT tokenizer truncates its input at 512 wordpieces, so
 * a single recognize() call on a multi-page document silently drops every name past the first ~2 KB.
 * We slice the text into bounded pieces (on whitespace boundaries, never mid-word) and record each
 * piece's absolute start offset, so the caller can shift the per-chunk spans back into full-text
 * coordinates and concatenate them.
 *
 * A name that straddles a chunk boundary can still be missed; slicing on the LAST whitespace before the
 * limit keeps boundaries between words, which makes that rare. Kept deliberately simple (KISS) — a
 * bounded char budget well under the token cap is the safe, model-agnostic default.
 */
export interface TextChunk {
  readonly text: string;
  /** Absolute index in the original text where this chunk starts. */
  readonly offset: number;
}

/** ~Chars per chunk. Kept conservative because multilingual-BERT tokenizers split Hebrew aggressively
 *  (often 2-4 wordpieces per word), so a generous char budget can still blow past the 512-wordpiece cap
 *  and silently drop names inside the chunk. ~400 chars ≈ 60-90 Hebrew words, comfortably under 512
 *  wordpieces even at the aggressive end, while still amortizing per-call model overhead. */
export const DEFAULT_CHUNK_CHARS = 400;

export function chunkText(text: string, maxChars: number = DEFAULT_CHUNK_CHARS): TextChunk[] {
  if (text.length <= maxChars) {
    return text.length > 0 ? [{ text, offset: 0 }] : [];
  }
  const chunks: TextChunk[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + maxChars, text.length);
    if (end < text.length) {
      // Back up to the last whitespace so we never cut through a word/name. Only accept a boundary in
      // the latter half of the window, or a single very long token would collapse the chunk to nothing.
      const slice = text.slice(i, end);
      const lastBreak = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
      if (lastBreak > maxChars * 0.5) {
        end = i + lastBreak + 1;
      }
    }
    chunks.push({ text: text.slice(i, end), offset: i });
    i = end;
  }
  return chunks;
}
