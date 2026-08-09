/**
 * Reversible key serialization — the mapping between placeholders and original values.
 * Canonical form is versioned JSON (`key.v1`); CSV is the human/Excel export (RFC-4180). The key
 * lives only in the browser and, if downloaded, only on the user's device (KEY-01) — it never
 * touches a server. `docId` (a hash of the source, set by the caller) lets restore warn when a key
 * belongs to a different document.
 */
import type { EntityType, KeyRow } from "./types";

const CSV_HEADER = "placeholder,original,type";
const KEY_VERSION = "key.v1";
/**
 * Untrusted-input bounds for an UPLOADED key file: a real key has at most a few thousand rows (one per
 * distinct PII value in one document) with short values, while a hostile file can carry millions of
 * rows / megabyte strings that later feed UI regex construction (App highlightValues). Reject over the
 * cap rather than truncate — a silently truncated key would restore incompletely.
 */
const MAX_KEY_ROWS = 50_000;
const MAX_KEY_FIELD_CHARS = 10_000;

export interface KeyFile {
  readonly version: typeof KEY_VERSION;
  readonly docId?: string;
  readonly createdAt?: string;
  readonly rows: readonly KeyRow[];
}

/** Formula-trigger prefixes that Excel/Sheets would execute if a cell starts with one. */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * Escape a CSV field: neutralise spreadsheet formula injection, then quote per RFC-4180.
 * The key holds ORIGINAL PII from the pasted document (attacker-influenceable), and Israeli phones
 * start with `+`, so a value like `+972…` or `=HYPERLINK(...)` would run as a formula when the key
 * CSV is opened in Excel/Sheets. We prefix such values with a single quote; `csvUnguard` strips it
 * back on parse so the round-trip stays lossless.
 */
function csvEscape(field: string): string {
  const guarded = FORMULA_PREFIX.test(field) ? `'${field}` : field;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** Reverse `csvEscape`'s formula guard: drop a leading `'` only when it precedes a formula char. */
function csvUnguard(field: string): string {
  return /^'[=+\-@\t\r]/.test(field) ? field.slice(1) : field;
}

/** KeyRow[] → RFC-4180 CSV (with header). No BOM here — the download layer adds it. */
export function toCsv(rows: readonly KeyRow[]): string {
  const body = rows
    .map((r) => [r.placeholder, r.original, r.type].map(csvEscape).join(","))
    .join("\r\n");
  return body.length > 0 ? `${CSV_HEADER}\r\n${body}` : CSV_HEADER;
}

/** Minimal RFC-4180 parser (handles quoted fields with commas/quotes/newlines). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** CSV → KeyRow[] (drops the header; ignores malformed short rows). */
export function fromCsv(csv: string): KeyRow[] {
  const rows = parseCsv(csv);
  if (rows.length <= 1) {
    return [];
  }
  return rows
    .slice(1)
    .filter((r) => r.length >= 3)
    .map((r) => ({
      placeholder: csvUnguard(r[0]),
      original: csvUnguard(r[1]),
      type: csvUnguard(r[2]) as EntityType,
    }));
}

/** KeyRow[] → canonical `key.v1` JSON (pretty). `meta` (docId/createdAt) is optional. */
export function toKeyFile(
  rows: readonly KeyRow[],
  meta?: { docId?: string; createdAt?: string },
): string {
  const file: KeyFile = {
    version: KEY_VERSION,
    ...(meta?.docId ? { docId: meta.docId } : {}),
    ...(meta?.createdAt ? { createdAt: meta.createdAt } : {}),
    rows,
  };
  return JSON.stringify(file, null, 2);
}

/** Parse a `key.v1` JSON file back to rows; throws on an unrecognized shape. */
export function fromKeyFile(json: string): KeyRow[] {
  const parsed: unknown = JSON.parse(json);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== KEY_VERSION ||
    !Array.isArray((parsed as { rows?: unknown }).rows)
  ) {
    throw new Error("Unrecognized key file (expected version key.v1).");
  }
  const rawRows = (parsed as { rows: KeyRow[] }).rows;
  if (rawRows.length > MAX_KEY_ROWS) {
    throw new Error(`Key file exceeds the row cap (${MAX_KEY_ROWS}).`);
  }
  return rawRows.map((r) => {
    const placeholder = String(r.placeholder);
    const original = String(r.original);
    if (placeholder.length > MAX_KEY_FIELD_CHARS || original.length > MAX_KEY_FIELD_CHARS) {
      throw new Error("Key file row exceeds the per-field length cap.");
    }
    return { placeholder, original, type: r.type };
  });
}
