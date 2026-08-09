/**
 * Overlay redaction for Office files (.docx / .xlsx). A document the user uploads is an official file
 * with a logo, letterhead and styling — we must NOT rebuild it from extracted text. Instead we open
 * the original zip, rewrite only the visible text nodes with their PII replaced in place, and repack
 * every other part (media, styles, headers) byte-for-byte. The engine's overlay core (engine/overlay)
 * does the pure text math; this module is only the zip + XML plumbing, which needs a browser/worker.
 *
 * One detection pass runs over the whole document's concatenated text, so the placeholder numbering
 * ([NAME_1] …) and the restore key are coherent across body, headers and footers. Values split across
 * several runs (Word does this constantly) are handled by the overlay char-walk.
 *
 * xlsx cell text is handled in every form: the shared-string table (`<si><t>`), inline worksheet
 * strings (`<c t="inlineStr"><is><t>`), AND NUMERIC cells (`<c><v>040493384</v></c>` — an Israeli ID /
 * phone / company number typed as a number). A numeric PII cell is rewritten to an inline-string cell
 * carrying the placeholder. Leading zeros dropped by numeric storage are restored via the real
 * recognizers (an 8-digit stored value is tested as "0"+value). A numeric cell whose value comes from
 * a FORMULA (`<f>`) is refused (throw XLSX_FORMULA_PII) rather than under-redacted — recalculation
 * would regenerate the cached value and the formula/source may itself hold the PII. Numbers Excel
 * never uses for 9-digit integers (scientific notation) are the remaining documented non-case.
 */
import type { AnonymizeResult, Span } from "@engine/types";
import { anonymizeDeterministic, detectDeterministic } from "@engine/pipeline";
import { applyOverlay, toReplacements, type Segment } from "@engine/overlay";
import { decodeXml, encodeXml } from "@engine/xml";
import { officeLeakScan } from "@engine/officeVerify";
import { layerB } from "@engine/pdfVerify";
import { sanitizeOfficeMetadata } from "./officeSanitize";
import { extractText } from "./extract";
// Type-only (erased at runtime) — avoids an officeRedact <-> scanRedact require cycle.
import type { ScanOcr, ScanDetect, ScanProgress } from "./scanRedact";

// Re-export so existing importers (restoreFile) keep working through this module.
export { decodeXml, encodeXml } from "@engine/xml";

/**
 * How to anonymize the document's text. Injected so the caller decides deterministic-only vs full
 * (with NER names) — when the model is loaded, files get names redacted too. May be async (NER is).
 */
export type Anonymize = (text: string) => AnonymizeResult | Promise<AnonymizeResult>;

export interface RedactedFile {
  readonly bytes: Uint8Array;
  readonly result: AnonymizeResult;
  /** Set by the PDF path when the visual redaction could not be fully VERIFIED clean — the bytes are
   * still returned (they pass the byte/structure checks), and the App offers the download with a warning
   * that NAMES the unverified `terms` so the user does a targeted 2-second check (owner decision: informed
   * choice, not a silent block). The AI-text/token deliverable stays hard-gated by its own text verify. */
  readonly pdfUnverified?: PdfUnverified;
  /** 1-based page numbers of image-only pages that were NOT verified clean, on a MIXED digital+scanned
   * PDF (owner decision: produce + per-page warn, never refuse for containing image pages). Text path
   * (OCR off): every image-only page — our glyph detection is blind to it. OCR path (on): pages that
   * failed the scan-quality gate. Absent/empty when there is nothing to warn about. */
  readonly unverifiedImagePages?: readonly number[];
}

export interface PdfUnverified {
  readonly reason: string; // the layerA/B/C detail (for logs)
  readonly terms: readonly string[]; // the specific terms to eyeball in the rendered PDF
}

/**
 * Result of processing an uploaded file: always the detection result (drives the on-screen chips and
 * restore key); `bytes` is the redacted file to download, present only for types we can rewrite
 * (docx/xlsx overlay, txt/csv plain). For pdf/xls we still detect and preview, but there is no
 * download here yet (PDF is the separate mupdf redaction track).
 */
export interface FileRedaction {
  readonly result: AnonymizeResult;
  readonly bytes?: Uint8Array;
  readonly pdfUnverified?: PdfUnverified; // see RedactedFile.pdfUnverified
  readonly unverifiedImagePages?: readonly number[]; // see RedactedFile.unverifiedImagePages
}

/** Thrown when an xlsx has PII in a FORMULA cell — refused rather than under-redacted (surfaced in UI). */
export const XLSX_FORMULA_PII = "XLSX_FORMULA_PII";

/** Thrown when an original PII value still appears in ANY text part of the output — refuse, never ship. */
export const OFFICE_SELFVERIFY_FAILED = "OFFICE_SELFVERIFY_FAILED";

/**
 * Embedded objects (B4) are copied through verbatim — the overlay never opens them and the office
 * self-verify only scans XML/rels parts, so an embed's bytes are otherwise un-scanned. Refusing on mere
 * PRESENCE was too broad: Word stores EVERY native chart's data as an embedded `.xlsx` and legacy
 * equations as `oleObject*.bin`, so a presence guard rejected most real business documents with a
 * misleading "PII survived" notice. Instead we look INSIDE (see assertEmbedsClean) and refuse only on
 * actual PII, so a clean chart/equation embed passes through byte-identical.
 */
const OOXML_EMBED = /(^|\/)embeddings\/[^/]*\.(xlsx|docx|pptx|xlsm|docm|pptm)$/i;
const OLE_EMBED = /(^|\/)embeddings\/[^/]*\.bin$|(^|\/)oleobject\d*\.bin$/i;

/** A region of one XML part to rewrite in place. "text" = a text-node's inner; "numcell" = a whole `<c>`. */
interface Edit {
  readonly path: string;
  readonly kind: "text" | "numcell";
  readonly start: number;
  readonly end: number;
  /** Group id — a separator is inserted between different groups so detection never bridges them. */
  readonly group: string;
  /** Decoded text fed to detection (for a numeric cell, its leading-zero-restored value). */
  readonly text: string;
  /** numcell only: the original `<c>` attributes with any `t="…"` removed (we set t="inlineStr"). */
  readonly cellAttrs?: string;
  /** numcell only: the value comes from a formula — refuse rather than under-redact. */
  readonly isFormula?: boolean;
}

/**
 * Collect every `<tag>…</tag>` text node in a part as an Edit (kind "text"), tagging each with a group
 * id from the part order and the number of `groupTag` openings before it (paragraph in docx, `<si>` /
 * `<c>` in xlsx). Nodes in the same group are one logical line; different groups get a newline.
 */
function collectTextEdits(part: string, path: string, order: number, tag: string, groupTag: string): Edit[] {
  const nodeRegex = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  const groupRegex = new RegExp(`<${groupTag}\\b`, "g");
  const groupStarts: number[] = [];
  for (let match = groupRegex.exec(part); match !== null; match = groupRegex.exec(part)) {
    groupStarts.push(match.index);
  }
  const edits: Edit[] = [];
  for (let match = nodeRegex.exec(part); match !== null; match = nodeRegex.exec(part)) {
    const inner = match[1];
    const innerStart = match.index + (match[0].length - inner.length - (tag.length + 3));
    edits.push({
      path,
      kind: "text",
      start: innerStart,
      end: innerStart + inner.length,
      group: `${order}:${countBefore(groupStarts, match.index)}`,
      text: decodeXml(inner),
    });
  }
  return edits;
}

/** Number of ascending `starts` strictly less than `pos` (binary search). */
function countBefore(starts: readonly number[], pos: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (starts[mid] < pos) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/** Whether the deterministic recognizers fully cover `value` (a whole-value match). */
function fullyCovered(value: string): boolean {
  return detectDeterministic(value).some((s: Span) => s.start === 0 && s.end === value.length);
}

/**
 * A numeric cell's value is PII iff a deterministic recognizer covers it whole. Numeric storage drops
 * leading zeros, so an 8-or-9-digit value is also tested as "0"+value (a stored 8-digit ID is a valid
 * 9-digit ID; a stored 9-digit mobile is a valid 10-digit phone). Returns the value to redact (zero-
 * restored when that is the form that matches), or null when the cell is an ordinary number.
 */
function numericPii(raw: string): string | null {
  const candidates = /^\d{8,9}$/.test(raw) ? [`0${raw}`, raw] : [raw];
  for (const candidate of candidates) {
    if (fullyCovered(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Collect the numeric PII cells of a worksheet part as Edits (kind "numcell"). */
function collectNumericEdits(part: string, path: string, order: number): Edit[] {
  const cellRegex = /<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g;
  const edits: Edit[] = [];
  let index = 0;
  for (let match = cellRegex.exec(part); match !== null; match = cellRegex.exec(part)) {
    const full = match[0];
    if (full.endsWith("/>")) {
      continue; // self-closing empty cell
    }
    const gt = full.indexOf(">");
    const attrs = full.slice(2, gt); // after "<c"
    const inner = full.slice(gt + 1, full.length - "</c>".length);
    const valueMatch = /<v>([\s\S]*?)<\/v>/.exec(inner);
    if (valueMatch === null) {
      continue; // no value (e.g. inline-string cell, handled by the text path)
    }
    const typeMatch = /\bt="([^"]*)"/.exec(attrs);
    if (typeMatch !== null && typeMatch[1] === "s") {
      continue; // shared-string index — must stay byte-identical
    }
    const isFormula = /<f[\s>/]/.test(inner);
    const contributed = numericPii(decodeXml(valueMatch[1]));
    if (contributed === null && !isFormula) {
      continue; // ordinary number
    }
    // A numeric-PII match feeds its (leading-zero-restored) value; a formula with no whole-value numeric
    // match still feeds its FULL cached <v> text, so the whole injected anonymize runs over it — a name,
    // a mixed string, or an external-workbook cache that hides PII trips the isFormula guard (fail closed)
    // in redactParts. A formula with no PII stays byte-identical (the region is left unchanged).
    edits.push({
      path,
      kind: "numcell",
      start: match.index,
      end: match.index + full.length,
      group: `${order}:num:${index}`,
      text: contributed ?? decodeXml(valueMatch[1]),
      cellAttrs: attrs.replace(/\s+t="[^"]*"/g, ""),
      isFormula,
    });
    index += 1;
  }
  return edits;
}

/**
 * Core: collect every editable region across the ordered parts, run ONE detection pass over their
 * concatenated text, then splice each redaction back in place. Returns the new part strings plus the
 * AnonymizeResult (for the UI chips + restore key).
 */
async function redactParts(
  parts: ReadonlyArray<{ path: string; content: string; tags: readonly string[]; groupTag: string; numeric: boolean }>,
  anonymize: Anonymize,
): Promise<{ updated: Map<string, string>; result: AnonymizeResult }> {
  const perPart = parts.map((part, order) => {
    // A part can carry text in more than one element kind (docx: visible <w:t> PLUS deleted-but-retained
    // <w:delText> and field <w:instrText>; xlsx worksheet: cell <t> PLUS print headers). All are collected
    // into the same detection stream so hidden text is redacted AND covered by the self-verify.
    const text = part.tags.flatMap((tag) => collectTextEdits(part.content, part.path, order, tag, part.groupTag));
    const numeric = part.numeric ? collectNumericEdits(part.content, part.path, order) : [];
    return [...text, ...numeric].sort((a, b) => a.start - b.start);
  });

  const allEdits: Edit[] = [];
  const segments: Segment[] = [];
  let concat = "";
  let previousGroup: string | null = null;
  for (const edits of perPart) {
    for (const edit of edits) {
      if (previousGroup !== null && edit.group !== previousGroup) {
        concat += "\n";
      }
      previousGroup = edit.group;
      const start = concat.length;
      concat += edit.text;
      segments.push({ start, end: concat.length });
      allEdits.push(edit);
    }
  }

  const result = await anonymize(concat);
  const rewritten = applyOverlay(concat, segments, toReplacements(concat, result));

  // Splice per part, from the last region to the first so earlier offsets stay valid.
  const updated = new Map<string, string>(parts.map((part) => [part.path, part.content]));
  const byPath = new Map<string, { edit: Edit; text: string }[]>();
  allEdits.forEach((edit, i) => {
    const list = byPath.get(edit.path) ?? [];
    list.push({ edit, text: rewritten[i] });
    byPath.set(edit.path, list);
  });

  for (const [path, list] of byPath) {
    list.sort((a, b) => b.edit.start - a.edit.start);
    let content = updated.get(path) as string;
    for (const { edit, text } of list) {
      if (text === edit.text) {
        continue; // unchanged region
      }
      if (edit.kind === "text") {
        content = content.slice(0, edit.start) + encodeXml(text) + content.slice(edit.end);
      } else {
        if (edit.isFormula) {
          throw new Error(XLSX_FORMULA_PII);
        }
        const cell = `<c${edit.cellAttrs} t="inlineStr"><is><t xml:space="preserve">${encodeXml(text)}</t></is></c>`;
        content = content.slice(0, edit.start) + cell + content.slice(edit.end);
      }
    }
    updated.set(path, content);
  }
  return { updated, result };
}

/** docx: body + headers + footers + notes + comment bodies, in reading order. */
export const DOCX_PART = /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/;

async function loadZip(buffer: ArrayBuffer) {
  const JSZip = (await import("jszip")).default;
  return JSZip.loadAsync(buffer);
}

async function redactOffice(
  buffer: ArrayBuffer,
  matchPart: (name: string) => boolean,
  order: (name: string) => number,
  tagsFor: (name: string) => readonly string[],
  groupTagFor: (name: string) => string,
  numericFor: (name: string) => boolean,
  anonymize: Anonymize,
): Promise<RedactedFile> {
  const zip = await loadZip(buffer);

  const paths = Object.keys(zip.files)
    .filter((name) => !zip.files[name].dir && matchPart(name))
    .sort((a, b) => order(a) - order(b));
  const parts = await Promise.all(
    paths.map(async (path) => ({
      path,
      content: await zip.files[path].async("string"),
      tags: tagsFor(path),
      groupTag: groupTagFor(path),
      numeric: numericFor(path),
    })),
  );
  const { updated, result } = await redactParts(parts, anonymize);
  for (const [path, content] of updated) {
    zip.file(path, content);
  }

  // Blank the metadata leak channels (author, company, custom DMS props, comment authors) BEFORE the
  // self-verify, so a detected body name that also appears in metadata no longer trips the backstop.
  await sanitizeOfficeMetadata(zip);

  // Self-verify (fail closed): re-scan EVERY text part of the final zip — including parts the redactor
  // never rewrote (docProps metadata, comments, settings) — and refuse if any original value survives.
  // This is the office analogue of the PDF three-layer self-verify: the guarantee, not best-effort.
  const scanMap = new Map<string, string>();
  for (const name of Object.keys(zip.files)) {
    if (!zip.files[name].dir && /\.(xml|rels)$/i.test(name)) {
      scanMap.set(name, await zip.files[name].async("string"));
    }
  }
  const scan = officeLeakScan(
    scanMap,
    result.key.map((row) => row.original),
  );
  if (!scan.pass) {
    throw new Error(`${OFFICE_SELFVERIFY_FAILED}: ${scan.hits.join(", ")}`);
  }

  // B4: inspect embedded objects for actual PII (see assertEmbedsClean) — refuse only on a hit, so a
  // clean chart-data workbook / legacy-equation blob passes through byte-identical instead of being
  // refused on presence.
  await assertEmbedsClean(
    zip,
    result.key.map((row) => row.original),
    anonymize,
  );

  const bytes = await zip.generateAsync({ type: "uint8array" });
  return { bytes, result };
}

async function tryLoadZip(buffer: ArrayBuffer): Promise<Awaited<ReturnType<typeof loadZip>> | undefined> {
  try {
    return await loadZip(buffer);
  } catch {
    return undefined; // not a zip (or corrupt) — caller falls back to an opaque byte-scan
  }
}

/**
 * Fail-closed check on embedded objects, scanning CONTENT rather than refusing on presence:
 *  - a nested OOXML zip (`embeddings/*.xlsx|docx|pptx|…`) is opened and its text parts run through the
 *    same injected detection; refuse only if the embed itself holds PII. A chart's data workbook with
 *    no PII passes through untouched.
 *  - an opaque OLE `.bin` (or an OOXML embed that would not open) is byte-scanned in UTF-8 AND UTF-16LE
 *    (pdfVerify layer B) for the OUTER document's detected values; refuse only on a hit.
 */
async function assertEmbedsClean(
  zip: Awaited<ReturnType<typeof loadZip>>,
  needles: readonly string[],
  anonymize: Anonymize,
): Promise<void> {
  for (const name of Object.keys(zip.files)) {
    const file = zip.files[name];
    if (file.dir) {
      continue;
    }
    const isOoxml = OOXML_EMBED.test(name);
    if (!isOoxml && !OLE_EMBED.test(name)) {
      continue;
    }
    const buffer = await file.async("arraybuffer");
    if (isOoxml) {
      const inner = await tryLoadZip(buffer);
      if (inner) {
        const texts: string[] = [];
        for (const innerName of Object.keys(inner.files)) {
          if (!inner.files[innerName].dir && /\.(xml|rels)$/i.test(innerName)) {
            texts.push(decodeXml(await inner.files[innerName].async("string")));
          }
        }
        const detected = await anonymize(texts.join("\n"));
        if (detected.key.length > 0) {
          throw new Error(`${OFFICE_SELFVERIFY_FAILED}: embedded ${name} contains PII`);
        }
        continue; // opened + scanned clean
      }
      // fell through: unparseable OOXML embed — treat as opaque and byte-scan below
    }
    if (needles.length > 0) {
      const layer = await layerB(new Uint8Array(buffer), needles);
      if (!layer.pass) {
        throw new Error(`${OFFICE_SELFVERIFY_FAILED}: embedded ${name} contains PII (${layer.hits.join(", ")})`);
      }
    }
  }
}

/** Body first, then header1, header2…, then footers, then notes — a stable reading order. */
function docxOrder(name: string): number {
  if (name === "word/document.xml") return 0;
  if (name.includes("header")) return 100 + numberIn(name);
  if (name.includes("footer")) return 200 + numberIn(name);
  return 300;
}

function numberIn(name: string): number {
  const match = name.match(/(\d+)/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

/**
 * docx text-bearing elements: visible runs `<w:t>`, deleted-but-retained tracked-change text
 * `<w:delText>`, and field instructions `<w:instrText>` (a HYPERLINK/MERGEFIELD instruction can carry an
 * email or id). All three feed detection so hidden text is redacted in place and covered by the self-verify.
 */
const DOCX_TEXT_TAGS = ["w:t", "w:delText", "w:instrText"] as const;

/** A docx chart part — its data cache (`<c:v>`) copies cell values (incl. names/labels) into the doc. */
const DOCX_CHART = /^word\/charts\/chart\d*\.xml$/;

/** Redact a .docx by overlaying placeholders onto its text runs (incl. tracked changes + fields) and its
 * embedded-chart data caches (`word/charts/* <c:v>`, the xlsx side already covers `xl/charts/`). */
export function redactDocx(buffer: ArrayBuffer, anonymize: Anonymize = anonymizeDeterministic): Promise<RedactedFile> {
  return redactOffice(
    buffer,
    (name) => DOCX_PART.test(name) || DOCX_CHART.test(name),
    docxOrder,
    (name) => (DOCX_CHART.test(name) ? ["c:v"] : DOCX_TEXT_TAGS),
    (name) => (DOCX_CHART.test(name) ? "c:pt" : "w:p"),
    () => false,
    anonymize,
  );
}

/** A worksheet part (holds inline strings and numeric cells). */
const XLSX_SHEET = /^xl\/worksheets\/sheet\d+\.xml$/;

/**
 * Redact a .xlsx by overlaying placeholders onto its text `<t>` nodes AND its numeric PII cells. Excel/
 * Sheets store cell text in the shared-string table (`xl/sharedStrings.xml`, `<si><t>`), but some
 * generators write INLINE strings into the worksheet (`<c t="inlineStr"><is><t>`), and IDs/phones/
 * company numbers are frequently stored as NUMBERS (`<c><v>…</v></c>`). All three are handled — see the
 * file header. The `t="inlineStr"` attribute is never mistaken for a `<t>` element (`<t\b` needs `<t`).
 */
const XLSX_COMMENTS = /^xl\/comments\d*\.xml$/;
const XLSX_THREADED = /^xl\/threadedComments\/threadedComment\d*\.xml$/;
const XLSX_DRAWING = /^xl\/drawings\/drawing\d*\.xml$/;
const XLSX_CHART = /^xl\/charts\/chart\d*\.xml$/;
const XLSX_WORKBOOK = "xl/workbook.xml";

/**
 * Print headers/footers live in the worksheet part (`<headerFooter><oddHeader>…`), NOT in a `<t>` node —
 * so they need their own tags on the worksheet, alongside cell text. All three odd/even/first variants.
 */
const XLSX_HEADER_FOOTER_TAGS = [
  "oddHeader",
  "evenHeader",
  "firstHeader",
  "oddFooter",
  "evenFooter",
  "firstFooter",
] as const;

/**
 * Every text-bearing xlsx part class, with the element tag(s) that carry its text and the element that
 * delimits one logical group (a newline is inserted between groups so detection never bridges them).
 * Beyond the cell text (shared strings, inline worksheet strings) this now also covers the hidden
 * surfaces that previously shipped un-scanned: worksheet print headers/footers, textboxes in drawings
 * (`<a:t>`), threaded comments (`<text>`), `<definedName>` constants in the workbook, and chart data
 * caches (`<c:v>`). Anything not listed here is still swept by the fail-closed self-verify.
 *
 * Documented residual: PIVOT caches (`xl/pivotCache/*`) store shared items as ATTRIBUTES (`<s v="…"/>`),
 * not element text — a value there that also appears in a redacted cell is caught by the self-verify
 * (which scans raw part content, attributes included); a name existing ONLY in a pivot cache is the one
 * remaining gap and is left to a follow-up.
 */
interface XlsxPartClass {
  readonly match: (name: string) => boolean;
  readonly order: (name: string) => number;
  readonly tags: readonly string[];
  readonly groupTag: string;
  readonly numeric: boolean;
}

const XLSX_PART_CLASSES: readonly XlsxPartClass[] = [
  { match: (n) => n === "xl/sharedStrings.xml", order: () => 0, tags: ["t"], groupTag: "si", numeric: false },
  {
    match: (n) => XLSX_SHEET.test(n),
    order: (n) => 1 + numberIn(n),
    tags: ["t", ...XLSX_HEADER_FOOTER_TAGS],
    groupTag: "c",
    numeric: true,
  },
  { match: (n) => XLSX_COMMENTS.test(n), order: (n) => 1000 + numberIn(n), tags: ["t"], groupTag: "comment", numeric: false },
  { match: (n) => XLSX_THREADED.test(n), order: (n) => 2000 + numberIn(n), tags: ["text"], groupTag: "threadedComment", numeric: false },
  { match: (n) => XLSX_DRAWING.test(n), order: (n) => 3000 + numberIn(n), tags: ["a:t"], groupTag: "a:p", numeric: false },
  { match: (n) => XLSX_CHART.test(n), order: (n) => 4000 + numberIn(n), tags: ["c:v"], groupTag: "c:pt", numeric: false },
  { match: (n) => n === XLSX_WORKBOOK, order: () => 5000, tags: ["definedName"], groupTag: "definedName", numeric: false },
];

function xlsxClass(name: string): XlsxPartClass | undefined {
  return XLSX_PART_CLASSES.find((cls) => cls.match(name));
}

export function redactXlsx(buffer: ArrayBuffer, anonymize: Anonymize = anonymizeDeterministic): Promise<RedactedFile> {
  return redactOffice(
    buffer,
    (name) => xlsxClass(name) !== undefined,
    (name) => xlsxClass(name)?.order(name) ?? 0,
    (name) => xlsxClass(name)?.tags ?? ["t"],
    (name) => xlsxClass(name)?.groupTag ?? "c",
    (name) => xlsxClass(name)?.numeric ?? false,
    anonymize,
  );
}

/** Anonymize a plain-text buffer and return it as bytes (txt / csv — no formatting to preserve). */
async function redactPlainText(buffer: ArrayBuffer, anonymize: Anonymize): Promise<FileRedaction> {
  const result = await anonymize(new TextDecoder().decode(buffer));
  return { result, bytes: new TextEncoder().encode(result.anonymizedText) };
}

/**
 * Process an uploaded file: overlay-redact when we can rewrite the format, otherwise fall back to
 * detection-only (still shows PII + enables restore). Routed by extension. `anonymize` is injected so
 * files pick up NER names once the model is loaded (defaults to deterministic-only).
 */
/** Scan-track wiring (Stage 5). `scanOcr` gates OCR redaction of a scanned PDF (default OFF — the App
 * reads the runtime flag and passes it); `ocr`/`detect` are injectable for model-free tests; `onProgress`
 * drives the slow-OCR UI. When off, a scanned PDF hits redactPdf's NO_TEXT_LAYER refusal as before. */
export interface RedactOptions {
  readonly scanOcr?: boolean;
  readonly ocr?: ScanOcr;
  readonly detect?: ScanDetect;
  readonly onProgress?: ScanProgress;
}

export async function redactFile(
  fileName: string,
  buffer: ArrayBuffer,
  anonymize: Anonymize = anonymizeDeterministic,
  options: RedactOptions = {},
): Promise<FileRedaction> {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "docx":
      return redactDocx(buffer, anonymize);
    case "xlsx":
      return redactXlsx(buffer, anonymize);
    case "txt":
    case "csv":
      return redactPlainText(buffer, anonymize);
    case "pdf": {
      // Route text-vs-scan (Stage 5). scanOcr is set by the App ONLY after classifyPdf already identified
      // this buffer as a scan, so we trust it here rather than re-parsing the whole document a second time
      // (isScannedPdf is a full per-page text extraction). The OCR path's own quality gate + self-verify
      // are the real safety net; redactPdf keeps its NO_TEXT_LAYER refusal for the scanOcr-off path. Lazy
      // imports so mupdf/tesseract load only when a PDF is actually processed (P0I-02).
      if (options.scanOcr) {
        const { redactScan } = await import("./scanRedact");
        return redactScan(buffer, anonymize, options.ocr, options.detect, options.onProgress);
      }
      const { redactPdf } = await import("./pdfRedact");
      return redactPdf(buffer, anonymize);
    }
    default:
      // xls (legacy binary, not a zip): detect + preview only, no redacted download.
      return { result: await anonymize(await extractText(fileName, buffer)) };
  }
}
