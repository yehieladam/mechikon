/**
 * Anonymize — replace resolved spans with typed Hebrew placeholders and emit a reversible key.
 * Port of the server's anonymize.py.
 *
 * Placeholders are ASCII/Latin (`[NAME_1]`, `[ID_2]`, `[PHONE_3]`) — the locked alphabet
 * (owner decision 2026-08-06). The PDF deliverable now BURNS the token onto each redaction so the
 * file itself is AI-sendable; Hebrew glyphs do NOT render in the stamped font and RTL reorders them
 * to gibberish, and Latin also sidesteps the ChatGPT smart-quote hazard that the old Hebrew gershayim
 * labels were chosen to avoid. Numbering is per entity type, in reading order of first appearance.
 * restore.ts matches any `[label_digits]` token, so old Hebrew-labeled key files still restore.
 *
 * CONSISTENCY: the same exact surface value of the same type always maps to the same placeholder,
 * and the key stores that exact value — so `restore(anonymize(text))` reproduces the input byte
 * for byte. (Tolerance for LLM-mangled placeholder TOKENS lives in restore.ts, not here; we never
 * collapse two different surface values into one placeholder, which would make restore lossy.)
 */
import type { AnonymizeResult, EntityType, KeyRow, Span } from "./types";
import { normalizePlaceholder, normalizedPlaceholdersIn } from "./restore";

/** Short Latin labels used inside `[LABEL_n]`. No spaces/underscores/slashes in a label; ASCII only
 *  so the token renders in the stamped PDF font and survives ChatGPT/RTL round-trips unmangled. */
const LABELS: Readonly<Record<EntityType, string>> = {
  ISRAELI_ID: "ID",
  IL_COMPANY: "COMPANY",
  IL_PASSPORT: "PASSPORT",
  IL_BAR: "BAR",
  DATE_OF_BIRTH: "DOB",
  IL_PHONE: "PHONE",
  IL_IBAN: "IBAN",
  IL_CASE: "CASE",
  IL_LAND: "LAND",
  IL_POLICY: "POLICY",
  IL_INSURED: "INSURED",
  EMAIL_ADDRESS: "EMAIL",
  CREDIT_CARD: "CARD",
  US_SSN: "SSN",
  US_PHONE: "USPHONE", // distinct from IL_PHONE's "PHONE" so the two never share a [PHONE_n] token
  PERSON: "NAME",
  ORGANIZATION: "ORG",
  LOCATION: "LOC",
  MANUAL: "TERM",
  IL_NUMBER: "NUM",
};

/** The placeholder label for a span: its custom label (a user-named manual term) or the type default. */
function labelFor(span: Span): string {
  return span.label ?? LABELS[span.type];
}

/** Build the placeholder for the nth distinct value of a type, e.g. `[NAME_1]`. */
export function placeholderFor(type: EntityType, index: number): string {
  return `[${LABELS[type]}_${index}]`;
}

/**
 * Replace `spans` in `text` with typed placeholders. Spans should already be non-overlapping
 * (run resolveOverlaps first); any span starting before the running cursor is skipped defensively
 * so offsets can never corrupt. Pure — does not mutate inputs.
 */
export function anonymize(text: string, spans: readonly Span[]): AnonymizeResult {
  const ordered = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  // Numbering is per LABEL (the type default, or a manual term's custom label) — so [CLIENT_1] and
  // [TENANT_1] number independently. Identical to per-type for automatic detections (each type has a
  // unique label), so it is a pure extension.
  const counters = new Map<string, number>();
  const placeholderByKey = new Map<string, string>();
  const rows: KeyRow[] = [];
  const usedSpans: Span[] = [];
  // Placeholder tokens already in the source, in the SAME tolerant/normalized form restore matches on —
  // so a minted token never collides even with a spaced/mangled pre-existing token (M-4).
  const sourcePlaceholders = normalizedPlaceholdersIn(text);

  let out = "";
  let cursor = 0;

  for (const span of ordered) {
    if (span.start < cursor) {
      continue; // defensive: overlaps should have been resolved away already
    }
    const value = text.slice(span.start, span.end);
    const label = labelFor(span);
    const dedupeKey = `${label} ${value}`;
    let placeholder = placeholderByKey.get(dedupeKey);
    if (placeholder === undefined) {
      // Skip any counter whose token already occurs in the source (M1 + M-4): minting a placeholder that
      // collides with a `[LABEL_n]`-shaped string already in the prose would make restore inject the value
      // into text that never held it. Match TOLERANTLY (normalized), the same way restore does, so a spaced
      // or mangled pre-existing token (e.g. `[ID_1 ]`) is caught too.
      let next = (counters.get(label) ?? 0) + 1;
      while (sourcePlaceholders.has(normalizePlaceholder(`[${label}_${next}]`))) {
        next += 1;
      }
      counters.set(label, next);
      placeholder = `[${label}_${next}]`;
      placeholderByKey.set(dedupeKey, placeholder);
      rows.push({ placeholder, original: value, type: span.type });
    }
    out += text.slice(cursor, span.start) + placeholder;
    cursor = span.end;
    usedSpans.push(span);
  }
  out += text.slice(cursor);

  return { anonymizedText: out, spans: usedSpans, key: rows };
}
