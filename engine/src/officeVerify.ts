/**
 * Office self-verify - the office analogue of pdfVerify's layer scan, and the load-bearing guarantee
 * for docx/xlsx redaction: after redaction, NO original PII value may survive in ANY text part of the
 * output zip, including parts the redactor never rewrote (docProps metadata, comments, settings...).
 * Framework-free and JSZip-free: the caller hands us the already-decompressed parts, so this stays a
 * pure, node-testable function that mirrors engine/pdfVerify.
 *
 * Office XML is always UTF-8, and JSZip gives us decompressed text - so, unlike the PDF raw-byte scan,
 * there is no stream inflation and no UTF-16/hex-string decoding to do. We only decode XML entities
 * (a name written `Cohen &amp; Levi` must still be caught) before running the shared leak matcher.
 *
 * The leak standard is the SAME two-track matcher the PDF self-verify uses (engine/pdfVerify.textLeaks):
 * a NAME needle counts only as a WHOLE WORD (so a short name inside a longer word is not a false leak),
 * and a NUMERIC needle counts when it is bounded by non-digits on the separator-stripped form. On top of
 * that shared standard, MULTI-WORD names get one extra track here (see multiWordNameMatcher): a name whose
 * INTERNAL separators were swapped or dropped in the output ("Dana Cohen" -> "Dana-Cohen" / merged) must
 * still refuse, which whole-word matching alone would miss.
 */
import { decodeXml } from "./xml";
import { textLeaks, normalizeForLeak, stripControls } from "./pdfVerify";

export interface OfficeLeakResult {
  readonly pass: boolean;
  /** `"<path>: <needle>"` for each surviving value - a debuggable throw message. */
  readonly hits: readonly string[];
}

/** Only text-bearing OOXML parts are scanned; media/fonts/printer blobs would false-positive on digits. */
function isTextPart(path: string): boolean {
  return /\.(xml|rels)$/i.test(path);
}

/** Separators a multi-word name may be written with: spaces (incl. NBSP), hyphen/dash variants. */
const NAME_SEPARATORS = "[\\s\\u2010-\\u2015-]*";
/** Hebrew + Latin letters and digits - the "word char" class used for the outer whole-name boundary. */
const NAME_BOUNDARY = "[A-Za-z0-9\\u0590-\\u05FF]";
/** Separators (space/NBSP, hyphen/dash, soft hyphen) used to split a needle into its words. */
const NEEDLE_SPLIT = /[\s‐-―­-]+/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A NAME needle of two+ words whose INTERNAL separators may have been swapped or dropped in the output.
 * `textLeaks` matches a name only as a whole word with its EXACT separators, so a two-word name written
 * back with a hyphen, an NBSP, or fully merged would slip past it (the old substring verify caught these).
 * Build a matcher that allows any separator run BETWEEN the words while still requiring non-word chars on
 * the OUTER boundary - so the merged form refuses only as a standalone token, never glued inside a longer
 * word. Single-word names return null and keep pure whole-word matching (so a short name inside a longer
 * word never false-refuses). Numeric needles are left to textLeaks' digit-bounded track.
 */
function multiWordNameMatcher(needle: string): RegExp | null {
  const compact = normalizeForLeak(needle);
  if (compact.length === 0 || /^\d+$/.test(compact)) {
    return null;
  }
  const tokens = stripControls(needle)
    .trim()
    .split(NEEDLE_SPLIT)
    .filter((token) => token.length > 0);
  if (tokens.length < 2) {
    return null;
  }
  const body = tokens.map(escapeRegExp).join(NAME_SEPARATORS);
  return new RegExp(`(?<!${NAME_BOUNDARY})${body}(?!${NAME_BOUNDARY})`, "u");
}

/**
 * Scan every text part for any needle (the redaction key's original values), decoding XML entities first
 * and applying the shared whole-word/digit-bounded matcher so the office leak standard never drifts from
 * the redaction standard (and short names inside longer words no longer false-refuse). For MULTI-WORD
 * names we ALSO match the name with any internal separator run (bounded by non-word chars) so a name whose
 * separators were swapped or removed in the output still refuses.
 */
export function officeLeakScan(
  parts: ReadonlyMap<string, string>,
  needles: readonly string[],
): OfficeLeakResult {
  if (needles.length === 0) {
    return { pass: true, hits: [] };
  }
  const multiWord = needles
    .map((original) => ({ original, matcher: multiWordNameMatcher(original) }))
    .filter((probe): probe is { original: string; matcher: RegExp } => probe.matcher !== null);

  const hits: string[] = [];
  for (const [path, content] of parts) {
    if (!isTextPart(path)) {
      continue;
    }
    const decoded = decodeXml(content);
    const caught = new Set(textLeaks(decoded, "", needles));
    for (const survivor of caught) {
      hits.push(`${path}: ${survivor}`);
    }
    if (multiWord.length > 0) {
      const bounded = stripControls(decoded);
      for (const probe of multiWord) {
        if (!caught.has(probe.original) && probe.matcher.test(bounded)) {
          hits.push(`${path}: ${probe.original}`);
        }
      }
    }
  }
  return { pass: hits.length === 0, hits };
}
