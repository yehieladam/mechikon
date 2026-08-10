/**
 * Restore a FILE — the reverse of redaction. The user redacts a document, an AI tool works on the
 * redacted file and returns a new one that still carries the placeholders ([NAME_1] …), and here we put
 * the ORIGINAL values back IN PLACE, preserving the format, so the user can download the reconstructed
 * document. The mapping lives only in the restore key — without it, nothing can be rebuilt.
 *
 * Supports .docx + .xlsx (what AI tools return in practice) + plain .txt. Each text node is restored
 * independently with the tolerant matcher (engine/restore handles gershayim/quote/bidi variants a
 * chat model may introduce). Two accepted limitations: a placeholder an AI split across two runs is not
 * reassembled (ask the model to keep the tag intact); and an xlsx numeric-PII cell that redaction
 * converted to an inline-string placeholder comes back as text, not a number — the value is correct,
 * the cell's stored type is not restored.
 */
import type { KeyRow } from "@engine/types";
import { restore } from "@engine/restore";
import { createInflationBudget, decodeXml, encodeXml, DOCX_PART } from "./officeRedact";

export interface RestoredFile {
  readonly bytes: Uint8Array;
  /** Placeholder tokens that had no matching key row (surfaced to the user). */
  readonly unmatched: readonly string[];
}

/**
 * Restore every `<tag>…</tag>` text node in one XML part in place: decode the inner text, swap
 * placeholders for their originals with the tolerant matcher, re-encode. Runs each tag independently.
 * `<t\b>` never matches `<text>` (word boundary) nor `<a:t>`/`<c:v>` (different leading char), so the
 * xlsx tag set can be applied to every part without cross-tag bleed.
 */
function restoreTextNodes(
  content: string,
  tags: readonly string[],
  key: readonly KeyRow[],
  unmatched: Set<string>,
): string {
  let out = content;
  for (const tag of tags) {
    const nodeRegex = new RegExp(`(<${tag}\\b[^>]*>)([\\s\\S]*?)(</${tag}>)`, "g");
    out = out.replace(nodeRegex, (_match, open: string, inner: string, close: string) => {
      const result = restore(decodeXml(inner), key);
      for (const token of result.unmatched) {
        unmatched.add(token);
      }
      return open + encodeXml(result.restoredText) + close;
    });
  }
  return out;
}

/**
 * Restore an office zip by rewriting the text nodes of the given parts in place, repacking every other
 * part byte-for-byte — the reverse of the overlay redaction (which overwrites masked text with the
 * ORIGINAL text; there is no visual layer to peel, unlike PDF).
 */
async function restoreOffice(
  buffer: ArrayBuffer,
  matchPart: (name: string) => boolean,
  tags: readonly string[],
  key: readonly KeyRow[],
  maxInflatedBytes?: number,
): Promise<RestoredFile> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buffer);
  const unmatched = new Set<string>();
  // Zip-bomb bound (B8): the uploaded file is untrusted — charge every inflated part against one
  // cumulative ceiling (throws ZIP_BOMB over it) instead of inflating gigabytes into the tab.
  const budget = createInflationBudget(maxInflatedBytes);
  const paths = Object.keys(zip.files).filter((name) => !zip.files[name].dir && matchPart(name));

  for (const path of paths) {
    const content = await zip.files[path].async("string");
    budget(content.length);
    zip.file(path, restoreTextNodes(content, tags, key, unmatched));
  }

  const bytes = await zip.generateAsync({ type: "uint8array" });
  return { bytes, unmatched: [...unmatched] };
}

/** Restore a .docx by replacing placeholders with their originals inside each text run (`<w:t>`). */
function restoreDocx(buffer: ArrayBuffer, key: readonly KeyRow[], maxInflatedBytes?: number): Promise<RestoredFile> {
  return restoreOffice(buffer, (name) => DOCX_PART.test(name), ["w:t"], key, maxInflatedBytes);
}

/**
 * Every xlsx part that can carry a placeholder after redaction, across ALL sheets: the shared-string
 * table, each worksheet (inline strings, incl. numeric-PII cells converted to inline strings), comments,
 * threaded comments, drawing textboxes, and chart data caches. The workbook's `<definedName>` constants
 * live in xl/workbook.xml — covered too.
 */
const XLSX_RESTORE_PART =
  /^xl\/(sharedStrings\.xml|workbook\.xml|worksheets\/sheet\d+\.xml|comments\d*\.xml|threadedComments\/threadedComment\d*\.xml|drawings\/drawing\d*\.xml|charts\/chart\d*\.xml)$/;

/** The text-bearing element tags across those xlsx parts (see redaction's XLSX_PART_CLASSES). */
const XLSX_TEXT_TAGS = ["t", "text", "a:t", "c:v", "definedName"] as const;

/** Restore a .xlsx by replacing placeholders with their originals inside every text node, all sheets. */
function restoreXlsx(buffer: ArrayBuffer, key: readonly KeyRow[], maxInflatedBytes?: number): Promise<RestoredFile> {
  return restoreOffice(buffer, (name) => XLSX_RESTORE_PART.test(name), XLSX_TEXT_TAGS, key, maxInflatedBytes);
}

/** Restore a plain-text buffer. */
function restoreText(buffer: ArrayBuffer, key: readonly KeyRow[]): RestoredFile {
  const result = restore(new TextDecoder().decode(buffer), key);
  return { bytes: new TextEncoder().encode(result.restoredText), unmatched: result.unmatched };
}

/** Codes surfaced to the UI for a restore that cannot proceed. */
export const RESTORE_UNSUPPORTED = "RESTORE_UNSUPPORTED";

/**
 * Restore an uploaded file with the key. Routes .docx / .xlsx / .txt / .csv; other types throw
 * RESTORE_UNSUPPORTED (the app tells the user to have the AI return a .docx/.xlsx). .csv rides the same
 * plain-text path as .txt — redaction already accepts .csv, so restore must mirror it.
 */
export async function restoreFile(
  fileName: string,
  buffer: ArrayBuffer,
  key: readonly KeyRow[],
  maxInflatedBytes?: number,
): Promise<RestoredFile> {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "docx":
      return restoreDocx(buffer, key, maxInflatedBytes);
    case "xlsx":
      return restoreXlsx(buffer, key, maxInflatedBytes);
    case "txt":
    case "csv":
      return restoreText(buffer, key);
    default:
      throw new Error(RESTORE_UNSUPPORTED);
  }
}
