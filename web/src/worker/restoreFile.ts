/**
 * Restore a FILE — the reverse of redaction. The user redacts a document, an AI tool works on the
 * redacted file and returns a new one that still carries the placeholders ([NAME_1] …), and here we put
 * the ORIGINAL values back IN PLACE, preserving the format, so the user can download the reconstructed
 * document. The mapping lives only in the restore key — without it, nothing can be rebuilt.
 *
 * v1 supports .docx (what AI tools return in practice) + plain .txt. Each `<w:t>` run is restored
 * independently with the tolerant matcher (engine/restore handles gershayim/quote/bidi variants a
 * chat model may introduce). A placeholder that an AI split across two runs is not reassembled — an
 * accepted v1 limitation; ask the model to return the document as .docx with the tags intact.
 */
import type { KeyRow } from "@engine/types";
import { restore } from "@engine/restore";
import { createInflationBudget, decodeXml, encodeXml, DOCX_PART } from "./officeRedact";

export interface RestoredFile {
  readonly bytes: Uint8Array;
  /** Placeholder tokens that had no matching key row (surfaced to the user). */
  readonly unmatched: readonly string[];
}

/** Restore a .docx by replacing placeholders with their originals inside each text run. */
async function restoreDocx(
  buffer: ArrayBuffer,
  key: readonly KeyRow[],
  maxInflatedBytes?: number,
): Promise<RestoredFile> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buffer);
  const unmatched = new Set<string>();
  // Zip-bomb bound (B8): the uploaded docx is untrusted — charge every inflated part against one
  // cumulative ceiling (throws ZIP_BOMB over it) instead of inflating gigabytes into the tab.
  const budget = createInflationBudget(maxInflatedBytes);
  const paths = Object.keys(zip.files).filter((name) => !zip.files[name].dir && DOCX_PART.test(name));

  for (const path of paths) {
    const content = await zip.files[path].async("string");
    budget(content.length);
    const rewritten = content.replace(
      /(<w:t\b[^>]*>)([\s\S]*?)(<\/w:t>)/g,
      (_match, open: string, inner: string, close: string) => {
        const result = restore(decodeXml(inner), key);
        for (const token of result.unmatched) {
          unmatched.add(token);
        }
        return open + encodeXml(result.restoredText) + close;
      },
    );
    zip.file(path, rewritten);
  }

  const bytes = await zip.generateAsync({ type: "uint8array" });
  return { bytes, unmatched: [...unmatched] };
}

/** Restore a plain-text buffer. */
function restoreText(buffer: ArrayBuffer, key: readonly KeyRow[]): RestoredFile {
  const result = restore(new TextDecoder().decode(buffer), key);
  return { bytes: new TextEncoder().encode(result.restoredText), unmatched: result.unmatched };
}

/** Codes surfaced to the UI for a restore that cannot proceed. */
export const RESTORE_UNSUPPORTED = "RESTORE_UNSUPPORTED";

/**
 * Restore an uploaded file with the key. Routes .docx / .txt; other types throw RESTORE_UNSUPPORTED
 * (the app tells the user to have the AI return a .docx).
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
    case "txt":
      return restoreText(buffer, key);
    default:
      throw new Error(RESTORE_UNSUPPORTED);
  }
}
