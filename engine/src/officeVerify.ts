/**
 * Office self-verify — the office analogue of pdfVerify's layer scan, and the load-bearing guarantee
 * for docx/xlsx redaction: after redaction, NO original PII value may survive in ANY text part of the
 * output zip, including parts the redactor never rewrote (docProps metadata, comments, settings…).
 * Framework-free and JSZip-free: the caller hands us the already-decompressed parts, so this stays a
 * pure, node-testable function that mirrors engine/pdfVerify.
 *
 * Office XML is always UTF-8, and JSZip gives us decompressed text — so, unlike the PDF raw-byte scan,
 * there is no stream inflation and no UTF-16/hex-string decoding to do. We only decode XML entities
 * (a name written `Cohen &amp; Levi` must still be caught) before running the shared leak matcher.
 *
 * The leak standard is the SAME two-track matcher the PDF self-verify uses (engine/pdfVerify.textLeaks):
 * a NAME needle counts only as a WHOLE WORD (so "כהן" inside "מכהן" is not a false leak), and a NUMERIC
 * needle counts when it is bounded by non-digits on the separator-stripped form (so "052-123 4567" is
 * still caught). A plain space-stripped substring `.includes` used to both false-refuse (short name in a
 * longer word) and over-match; reusing textLeaks keeps the office leak standard aligned with redaction.
 */
import { decodeXml } from "./xml";
import { textLeaks } from "./pdfVerify";

export interface OfficeLeakResult {
  readonly pass: boolean;
  /** `"<path>: <needle>"` for each surviving value — a debuggable throw message. */
  readonly hits: readonly string[];
}

/** Only text-bearing OOXML parts are scanned; media/fonts/printer blobs would false-positive on digits. */
function isTextPart(path: string): boolean {
  return /\.(xml|rels)$/i.test(path);
}

/**
 * Scan every text part for any needle (the redaction key's original values), decoding XML entities first
 * and applying the shared whole-word/digit-bounded matcher so the office leak standard never drifts from
 * the redaction standard (and short names inside longer words no longer false-refuse).
 */
export function officeLeakScan(
  parts: ReadonlyMap<string, string>,
  needles: readonly string[],
): OfficeLeakResult {
  if (needles.length === 0) {
    return { pass: true, hits: [] };
  }
  const hits: string[] = [];
  for (const [path, content] of parts) {
    if (!isTextPart(path)) {
      continue;
    }
    for (const survivor of textLeaks(decodeXml(content), "", needles)) {
      hits.push(`${path}: ${survivor}`);
    }
  }
  return { pass: hits.length === 0, hits };
}
