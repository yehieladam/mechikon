/**
 * The redaction session for one page. Wraps the REAL engine (deterministic recognizers today; NER
 * is added later via an offscreen model) and accumulates the restore key across successive redactions
 * so the same conversation restores end to end.
 *
 * Imports are from SPECIFIC engine modules, never the @engine barrel — the barrel re-exports ner.ts,
 * which pulls transformers.js + onnxruntime into the bundle. Everything used here is pure JS, no model.
 */
import type { KeyRow, Span } from "@engine/types";
import { anonymizeWith, detectDeterministic } from "@engine/pipeline";
import { manualSpans } from "@engine/manual";
import { restore } from "@engine/restore";
import { clearKey, loadKey, saveKey } from "./keyStore";

export class RedactSession {
  private key: KeyRow[] = [];
  private readonly manualTerms: string[] = [];

  /** Hydrate the key from storage (survives reload within the 24h window). Call once on startup. */
  async hydrate(): Promise<void> {
    this.key = await loadKey();
  }

  /** Distinct sensitive values the deterministic engine sees in `text` right now (for the live indicator). */
  detect(text: string): Span[] {
    return detectDeterministic(text);
  }

  /** Add a value the user selected by hand (engine miss). Redacted on the next redact pass. */
  addManualTerm(value: string): void {
    const v = value.trim();
    if (v.length > 0 && !this.manualTerms.includes(v)) {
      this.manualTerms.push(v);
    }
  }

  /**
   * Redact `text` with the real engine + any manual terms. Re-running on already-tokenized text is
   * safe: existing [LABEL_n] tokens are not re-detected, and anonymize skips indices already present,
   * so numbering stays consistent. New key rows are merged into the session key (deduped by placeholder).
   */
  redact(text: string): { text: string; newRows: KeyRow[] } {
    const extra: Span[] = manualSpans(text, this.manualTerms);
    const result = anonymizeWith(text, extra);
    const known = new Set(this.key.map((row) => row.placeholder));
    const newRows = result.key.filter((row) => !known.has(row.placeholder));
    this.key.push(...newRows);
    if (newRows.length > 0) {
      void saveKey(this.key); // persist with a refreshed 24h expiry (fire-and-forget)
    }
    return { text: result.anonymizedText, newRows };
  }

  /** Forget everything (key + storage). */
  async clear(): Promise<void> {
    this.key = [];
    this.manualTerms.length = 0;
    await clearKey();
  }

  /** Put original values back into an AI answer using the accumulated key. Tolerant to LLM token mangling. */
  restore(text: string): { text: string; unmatched: readonly string[] } {
    const result = restore(text, this.key);
    return { text: result.restoredText, unmatched: result.unmatched };
  }

  get hasKey(): boolean {
    return this.key.length > 0;
  }
}
