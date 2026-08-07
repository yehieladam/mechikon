/**
 * Office metadata sanitizer (the office analogue of pdfSanitize). A redacted body is not enough: an
 * Office file carries names in metadata channels Word/Explorer surface — the author, the firm, revision
 * history, DMS custom properties, comment authors. These are data ABOUT the document, so a placeholder
 * is meaningless: we BLANK them. Comment BODY text is different — it is authored prose that can hold a
 * client name also in the body, so it is routed through the same detection pass in officeRedact (not
 * here), producing a coherent [NAME_N] that restores.
 *
 * We blank inner text / attribute values and never delete the element itself — an empty element
 * (`<dc:creator></dc:creator>`) is schema-valid, deleting it may not be. Blanking custom string
 * properties can drop DMS round-trip fields (matter id, client name); that is intended — those are
 * exactly the covert PII channels a legal tool must clear.
 *
 * Out of scope for now (left to the self-verify backstop, documented follow-up): xlsx threaded comments
 * (`xl/threadedComments/*`), which use a different `<text>` shape.
 */
import type JSZip from "jszip";

/** Blank the inner text of each named element: `<tag …>X</tag>` → `<tag …></tag>`. */
function blankElementText(xml: string, tags: readonly string[]): string {
  let out = xml;
  for (const tag of tags) {
    out = out.replace(new RegExp(`(<${tag}\\b[^>]*>)[\\s\\S]*?(</${tag}>)`, "g"), "$1$2");
  }
  return out;
}

/** Blank the value of each named attribute: `attr="X"` → `attr=""`. */
function blankAttr(xml: string, attrs: readonly string[]): string {
  let out = xml;
  for (const attr of attrs) {
    out = out.replace(new RegExp(`${attr}="[^"]*"`, "g"), `${attr}=""`);
  }
  return out;
}

/** Core document properties that name people/organisations or echo the content. Timestamps are kept. */
const CORE_TAGS = [
  "dc:creator",
  "cp:lastModifiedBy",
  "dc:title",
  "dc:subject",
  "dc:description",
  "cp:keywords",
  "cp:category",
  "cp:contentStatus",
] as const;

/** Extended app properties that carry the firm / manager. Structural props (Application…) are kept. */
const APP_TAGS = ["Company", "Manager"] as const;

/** Custom-property STRING values only — numeric/bool/date typed nodes must stay untouched (schema). */
const CUSTOM_STRING_TAGS = ["vt:lpwstr", "vt:bstr"] as const;

/** Apply `fn` to a part if it exists in the zip. */
async function editPart(zip: JSZip, path: string, fn: (xml: string) => string): Promise<void> {
  const file = zip.file(path);
  if (file) {
    zip.file(path, fn(await file.async("string")));
  }
}

/** Apply `fn` to every part whose name matches `pattern`. */
async function editMatching(zip: JSZip, pattern: RegExp, fn: (xml: string) => string): Promise<void> {
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir && pattern.test(name));
  for (const name of names) {
    zip.file(name, fn(await zip.files[name].async("string")));
  }
}

/**
 * Blank the metadata leak channels of an open docx/xlsx zip, in place. Comment BODY text is NOT touched
 * here (it goes through the redaction pass); only the comment AUTHOR metadata is blanked.
 */
export async function sanitizeOfficeMetadata(zip: JSZip): Promise<void> {
  await editPart(zip, "docProps/core.xml", (xml) => blankElementText(xml, CORE_TAGS));
  await editPart(zip, "docProps/app.xml", (xml) => blankElementText(xml, APP_TAGS));
  await editPart(zip, "docProps/custom.xml", (xml) => blankElementText(xml, CUSTOM_STRING_TAGS));
  await editMatching(zip, /^word\/comments\.xml$/, (xml) => blankAttr(xml, ["w:author", "w:initials"]));
  await editMatching(zip, /^xl\/comments\d*\.xml$/, (xml) => blankElementText(xml, ["author"]));
  await editMatching(zip, /^xl\/persons\/person\d*\.xml$/, (xml) => blankAttr(xml, ["displayName"]));
  await removeThumbnail(zip);
}

/** Drop a `<Relationship …>` whose Target points at docProps/thumbnail, keeping every other relationship. */
function stripThumbnailRel(xml: string): string {
  return xml.replace(/<Relationship\b[^>]*Target="[^"]*docProps\/thumbnail[^"]*"[^>]*\/>/gi, "");
}

/**
 * Delete `docProps/thumbnail.*` and its package relationship. The thumbnail is a rendered raster preview
 * of the original page 1 — a picture of the un-redacted content that no text pass can clean — so it is
 * removed outright, not blanked. The relationship in `_rels/.rels` is stripped too so the package stays
 * consistent (a dangling rel to a missing part makes Office flag the file as corrupt).
 */
async function removeThumbnail(zip: JSZip): Promise<void> {
  const thumbs = Object.keys(zip.files).filter((name) => /^docProps\/thumbnail\.[^/]+$/i.test(name));
  if (thumbs.length === 0) {
    return;
  }
  for (const name of thumbs) {
    zip.remove(name);
  }
  await editPart(zip, "_rels/.rels", stripThumbnailRel);
}
