/**
 * Extract plain text from an uploaded file for the popup redactor. Heavy parsers (mammoth, mupdf) are
 * dynamically imported so they load only when a file is processed. Ported from web/src/worker/extract.ts
 * (same proven approach) — kept framework-free.
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
      return new TextDecoder().decode(buffer);
    default:
      throw new Error(`.${ext}`);
  }
}

export const ACCEPTED = ".txt,.csv,.pdf,.docx";
