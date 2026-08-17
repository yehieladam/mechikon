/**
 * The redaction session — shared by inline chat and the popup. Wraps the real engine and keeps a
 * STABLE value->placeholder map across redactions, persisted to the single shared key store. Because
 * every surface goes through this, a token means one value everywhere and restore works cross-surface.
 *
 * Collision-safe: when minting a new placeholder we skip any index whose token is already present in
 * the output text OR already used by the session — so a masked value pasted from another surface can
 * never be shadowed by a freshly minted identical token (audit finding #2).
 */
import type { EntityType, KeyRow, Span } from "@engine/types";
import {
  anonymizeManualOnly,
  anonymizeWith,
  detectDeterministic,
} from "@engine/pipeline";
import { manualSpans } from "@engine/manual";
import { normalizePlaceholder, normalizedPlaceholdersIn, restore } from "@engine/restore";
import { clearKey, loadKey, saveKey } from "./keyStore";

const TOKEN_RE = /\[[^[\]]+_\d+\]/g;

function labelOf(placeholder: string): string {
  const inner = placeholder.slice(1, -1);
  return inner.slice(0, inner.lastIndexOf("_"));
}

function indexOfToken(placeholder: string): number {
  const inner = placeholder.slice(1, -1);
  return Number(inner.slice(inner.lastIndexOf("_") + 1));
}

function valueKey(type: string, original: string): string {
  return `${type} ${original}`;
}

export class RedactSession {
  private key: KeyRow[] = [];
  private readonly manualTerms: string[] = [];
  private readonly valueToPlaceholder = new Map<string, string>();
  private readonly usedPlaceholders = new Set<string>();
  private readonly labelCounters = new Map<string, number>();

  async hydrate(): Promise<void> {
    const stored = await loadKey();
    // Merge (don't clobber): keep any rows this session added before hydrate's load resolved.
    const byPlaceholder = new Map(stored.map((row) => [row.placeholder, row]));
    for (const row of this.key) {
      if (!byPlaceholder.has(row.placeholder)) {
        byPlaceholder.set(row.placeholder, row);
      }
    }
    this.key = [...byPlaceholder.values()];
    this.reindex();
  }

  private reindex(): void {
    this.valueToPlaceholder.clear();
    this.usedPlaceholders.clear();
    this.labelCounters.clear();
    for (const row of this.key) {
      this.valueToPlaceholder.set(valueKey(row.type, row.original), row.placeholder);
      this.usedPlaceholders.add(row.placeholder);
      const label = labelOf(row.placeholder);
      const idx = indexOfToken(row.placeholder);
      if (Number.isFinite(idx)) {
        this.labelCounters.set(label, Math.max(this.labelCounters.get(label) ?? 0, idx));
      }
    }
  }

  detect(text: string): Span[] {
    return detectDeterministic(text);
  }

  addManualTerm(value: string): void {
    const v = value.trim();
    if (v.length > 0 && !this.manualTerms.includes(v)) {
      this.manualTerms.push(v);
    }
  }

  redact(text: string, nerSpans: readonly Span[] = []): { text: string; newRows: KeyRow[] } {
    const extra: Span[] = [...nerSpans, ...manualSpans(text, this.manualTerms)];
    const result = anonymizeWith(text, extra);
    return this.remap(text, result.anonymizedText, result.key);
  }

  /** Mask ONLY one selected value (no automatic detection) — used by the inline selection popover. */
  redactManualValue(text: string, value: string): { text: string; newRows: KeyRow[] } {
    const result = anonymizeManualOnly(text, [value.trim()]);
    return this.remap(text, result.anonymizedText, result.key);
  }

  /** Mask ONLY the given user-chosen terms (no automatic detection) — used by the popup manual mode. */
  redactManualTerms(text: string, terms: readonly string[]): { text: string; newRows: KeyRow[] } {
    const cleaned = terms.map((t) => t.trim()).filter((t) => t.length > 0);
    if (cleaned.length === 0) {
      return { text, newRows: [] };
    }
    const result = anonymizeManualOnly(text, cleaned);
    return this.remap(text, result.anonymizedText, result.key);
  }

  /** Mask specific NER values inside the current text (inline two-pass augmentation). */
  redactNerValues(
    text: string,
    valued: readonly { value: string; type: EntityType }[],
  ): { text: string; newRows: KeyRow[] } {
    const spans: Span[] = [];
    for (const { value, type } of valued) {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const at = text.indexOf(trimmed);
      if (at >= 0) {
        spans.push({ start: at, end: at + trimmed.length, type, score: 1 });
      }
    }
    if (spans.length === 0) {
      return { text, newRows: [] };
    }
    return this.redact(text, spans);
  }

  private remap(
    sourceText: string,
    outText: string,
    resultKey: readonly KeyRow[],
  ): { text: string; newRows: KeyRow[] } {
    // Tokens ALREADY in the source (e.g. pasted from another surface) must not be re-minted for a
    // different value — that would shadow them. The engine's freshly minted tokens are what we remap,
    // so they are deliberately NOT in this set.
    const present = normalizedPlaceholdersIn(sourceText);
    const rewrite = new Map<string, string>();
    const newRows: KeyRow[] = [];
    for (const row of resultKey) {
      const vk = valueKey(row.type, row.original);
      let placeholder = this.valueToPlaceholder.get(vk);
      if (placeholder === undefined) {
        const label = labelOf(row.placeholder);
        let next = (this.labelCounters.get(label) ?? 0) + 1;
        // Skip an index if its token already sits in the text or is already used by the session.
        while (
          present.has(normalizePlaceholder(`[${label}_${next}]`)) ||
          this.usedPlaceholders.has(`[${label}_${next}]`)
        ) {
          next += 1;
        }
        this.labelCounters.set(label, next);
        placeholder = `[${label}_${next}]`;
        this.valueToPlaceholder.set(vk, placeholder);
        this.usedPlaceholders.add(placeholder);
        const newRow: KeyRow = { placeholder, original: row.original, type: row.type };
        this.key.push(newRow);
        newRows.push(newRow);
      }
      if (placeholder !== row.placeholder) {
        rewrite.set(row.placeholder, placeholder);
      }
    }
    const text =
      rewrite.size > 0 ? outText.replace(TOKEN_RE, (token) => rewrite.get(token) ?? token) : outText;
    if (newRows.length > 0) {
      void saveKey(this.key);
    }
    return { text, newRows };
  }

  restore(text: string): { text: string; unmatched: readonly string[] } {
    const result = restore(text, this.key);
    return { text: result.restoredText, unmatched: result.unmatched };
  }

  async clear(): Promise<void> {
    this.key = [];
    this.manualTerms.length = 0;
    this.reindex();
    await clearKey();
  }

  get hasKey(): boolean {
    return this.key.length > 0;
  }

  /** The full accumulated key (for the popup's downloadable restore-key file). */
  get rows(): readonly KeyRow[] {
    return this.key;
  }
}
