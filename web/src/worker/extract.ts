/**
 * Extract plain text from an uploaded file, inside the worker. The heavy parsers (mammoth, mupdf) are
 * DYNAMICALLY imported so they load only when a file is actually processed (P0I-02) and never weigh down
 * the paste path. The extracted text is then anonymized like any pasted text.
 *
 * Legacy binary .xls is NOT handled here: its only reader was SheetJS (`xlsx`), removed for unpatched
 * Prototype-Pollution + ReDoS advisories (B7). Modern .xlsx uses the JSZip overlay path (officeRedact);
 * a .xls upload is refused upstream in redactFile with a "re-save as .xlsx" hint.
 *
 * NOTE: PDF text order for Hebrew can be reversed (MuPDF returns visual order) — full bidi handling
 * is PDF-03; this first pass extracts and anonymizes, which already redacts the structured PII.
 */

// reason: the CJS/ESM interop shape of these third-party parsers is not worth modelling in the type
// system; each is narrowly used and wrapped in try/catch at the call site.
/* eslint-disable @typescript-eslint/no-explicit-any */
function pick<T>(mod: any, key: string): T {
  return (mod?.[key] ?? mod?.default?.[key]) as T;
}

async function fromDocx(buffer: ArrayBuffer): Promise<string> {
  const mammoth: any = await import("mammoth");
  const extractRawText = pick<(o: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }>>(
    mammoth,
    "extractRawText",
  );
  const { value } = await extractRawText({ arrayBuffer: buffer });
  return value;
}

async function fromPdf(buffer: ArrayBuffer): Promise<string> {
  const mupdf: any = await import("mupdf");
  const doc = mupdf.Document.openDocument(new Uint8Array(buffer), "application/pdf");
  const pages: string[] = [];
  const count: number = doc.countPages();
  for (let i = 0; i < count; i += 1) {
    const page = doc.loadPage(i);
    pages.push(page.toStructuredText("preserve-whitespace").asText() as string);
  }
  return pages.join("\n");
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Route by extension and return the file's plain text. Throws on an unsupported type. */
export async function extractText(fileName: string, buffer: ArrayBuffer): Promise<string> {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "docx":
      return fromDocx(buffer);
    case "pdf":
      return fromPdf(buffer);
    case "csv":
    case "txt":
      return new TextDecoder().decode(buffer); // plain text — no parser needed
    default:
      throw new Error(`Unsupported file type: .${ext}`);
  }
}
