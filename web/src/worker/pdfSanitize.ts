/**
 * PDF sanitization (PDF-06) — redaction removes PII from the visible page; sanitization removes it
 * from the INVISIBLE channels where it also hides. Measured (2026-08-04): `sanitize:true` does NOT
 * clear the Info dict, annotation contents, or outlines — exactly where a legal PDF carries party
 * names. We strip those explicitly here. Outlines are handled by the caller (they are user-visible
 * navigation and go through the same anonymize pass + key for coherence); this module handles the
 * pure-metadata channels.
 *
 * mupdf's WASM object API is untyped — narrowly used, behind a dynamic import at the call site.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

/** A live PDFObject that is a real (non-null) container. */
function isReal(obj: any): boolean {
  return Boolean(obj) && typeof obj.get === "function" && !(obj.isNull?.() ?? false);
}

/** Malformed /Kids trees can cycle; cap the walk depth instead of trusting the file. */
const MAX_FIELD_TREE_DEPTH = 32;

/** Delete the Info dictionary (Author/Title/Subject/Keywords + timestamps) from the trailer. */
export function stripInfo(doc: any): void {
  doc.getTrailer().delete("Info");
}

/** Delete the XMP metadata stream from the document catalog. */
export function stripXmp(doc: any): void {
  const root = doc.getTrailer().get("Root");
  if (root && root.isDictionary && root.isDictionary()) {
    root.delete("Metadata");
  }
}

/** Delete every embedded file / attachment (which can carry PII in its bytes or filename). */
export function stripEmbeddedFiles(doc: any): void {
  const names: string[] = doc.getEmbeddedFiles ? Object.keys(doc.getEmbeddedFiles() ?? {}) : [];
  for (const name of names) {
    try {
      doc.deleteEmbeddedFile(name);
    } catch {
      /* best effort */
    }
  }
}

/**
 * Clear the free-text metadata on every remaining annotation (Contents + Author). Redaction
 * annotations have already been consumed by applyRedactions; what remains is notes/comments whose
 * text can carry PII. We do not delete the annotation (it may be a visual mark) — just its PII text.
 */
export function clearAnnotationText(doc: any): void {
  const pageCount: number = doc.countPages();
  for (let i = 0; i < pageCount; i += 1) {
    const page = doc.loadPage(i);
    const annots = page.getAnnotations ? page.getAnnotations() : [];
    for (const annot of annots) {
      try {
        if (annot.setContents) {
          annot.setContents("");
        }
        if (annot.hasAuthor && annot.hasAuthor() && annot.setAuthor) {
          annot.setAuthor("");
        }
        if (annot.update) {
          annot.update();
        }
      } catch {
        /* best effort */
      }
    }
  }
}

/**
 * Strip form-field side channels that duplicate or shadow the field VALUE, on EVERY field (fail-closed
 * — we cannot rewrite these coherently, so they must not survive at all):
 *  - /DV (reset-form default) and /RV (rich-text duplicate of /V) can carry the typed PII verbatim;
 *  - /XFA on the AcroForm dict is a full XML duplicate of all field data (rewrite not implemented).
 * The /V values themselves are NOT stripped here — they go through the unified anonymize pass in
 * redactPdf (collectFormFields below) so the user keeps a filled, restorable form.
 */
export function stripFormFieldExtras(doc: any): void {
  const root = doc.getTrailer().get("Root");
  const acroForm = isReal(root) ? root.get("AcroForm") : null;
  if (!isReal(acroForm)) {
    return;
  }
  acroForm.delete("XFA");
  const visit = (node: any, depth: number): void => {
    if (!isReal(node) || depth > MAX_FIELD_TREE_DEPTH) {
      return;
    }
    node.delete("DV");
    node.delete("RV");
    const kids = node.get("Kids");
    if (isReal(kids) && kids.isArray?.()) {
      for (let i = 0; i < kids.length; i += 1) {
        visit(kids.get(i), depth + 1);
      }
    }
  };
  const fields = acroForm.get("Fields");
  if (isReal(fields) && fields.isArray?.()) {
    for (let i = 0; i < fields.length; i += 1) {
      visit(fields.get(i), 0);
    }
  }
}

/** Strip all pure-metadata leak channels (Info, XMP, embedded files, annotation text, field extras). */
export function sanitizeMetadata(doc: any): void {
  stripInfo(doc);
  stripXmp(doc);
  stripEmbeddedFiles(doc);
  clearAnnotationText(doc);
  stripFormFieldExtras(doc);
}

/** One AcroForm field with a string value (/V) — readable and rewritable. */
export interface FormFieldValue {
  readonly value: string;
  /** Rewrite /V and drop the now-stale appearance streams (/AP under this field and its widget kids)
   * so the OLD value can neither render nor survive in the bytes; viewers regenerate the appearance
   * from the new /V (NeedAppearances is set by the caller when any field was rewritten). */
  readonly setValue: (value: string) => void;
}

/**
 * Walk the AcroForm field tree (Fields + nested Kids) and return every field carrying a STRING value,
 * with a setter that rewrites /V in place. The caller anonymizes the values through the same unified
 * pass as the body text, so a form value gets the same placeholder as its body mentions. Non-string
 * values (checkbox/radio name states like /Yes) carry no free text and are skipped.
 */
export function collectFormFields(doc: any): FormFieldValue[] {
  const items: FormFieldValue[] = [];
  const deleteAppearances = (node: any, depth: number): void => {
    if (!isReal(node) || depth > MAX_FIELD_TREE_DEPTH) {
      return;
    }
    node.delete("AP");
    const kids = node.get("Kids");
    if (isReal(kids) && kids.isArray?.()) {
      for (let i = 0; i < kids.length; i += 1) {
        deleteAppearances(kids.get(i), depth + 1);
      }
    }
  };
  const visit = (node: any, depth: number): void => {
    if (!isReal(node) || depth > MAX_FIELD_TREE_DEPTH) {
      return;
    }
    const value = node.get("V");
    if (value && !(value.isNull?.() ?? false) && (value.isString?.() ?? false)) {
      items.push({
        value: value.asString(),
        setValue: (next: string) => {
          node.put("V", doc.newString(next));
          deleteAppearances(node, depth);
        },
      });
    }
    const kids = node.get("Kids");
    if (isReal(kids) && kids.isArray?.()) {
      for (let i = 0; i < kids.length; i += 1) {
        visit(kids.get(i), depth + 1);
      }
    }
  };
  const root = doc.getTrailer().get("Root");
  const acroForm = isReal(root) ? root.get("AcroForm") : null;
  const fields = isReal(acroForm) ? acroForm.get("Fields") : null;
  if (isReal(fields) && fields.isArray?.()) {
    for (let i = 0; i < fields.length; i += 1) {
      visit(fields.get(i), 0);
    }
  }
  return items;
}

/** Ask viewers to regenerate field appearances from the rewritten /V values. */
export function setNeedAppearances(doc: any): void {
  const root = doc.getTrailer().get("Root");
  const acroForm = isReal(root) ? root.get("AcroForm") : null;
  if (isReal(acroForm)) {
    acroForm.put("NeedAppearances", doc.newBoolean(true));
  }
}

/** One outline (bookmark) node with a mutable Title. */
export interface OutlineItem {
  readonly setTitle: (title: string) => void;
  readonly title: string;
}

/**
 * Walk the outline (bookmark) tree and return every node with a getter for its title and a setter to
 * rewrite it. The caller anonymizes the titles (coherently with the body key) and writes them back.
 */
export function collectOutlineItems(doc: any): OutlineItem[] {
  const items: OutlineItem[] = [];
  const root = doc.getTrailer().get("Root");
  const outlines = isReal(root) ? root.get("Outlines") : null;
  if (!isReal(outlines)) {
    return items;
  }
  const visit = (node: any): void => {
    for (let current = node; isReal(current); current = current.get("Next")) {
      const titleObj = current.get("Title");
      if (titleObj && !(titleObj.isNull?.() ?? false) && titleObj.asString) {
        const node2 = current;
        items.push({
          title: titleObj.asString(),
          setTitle: (title: string) => node2.put("Title", doc.newString(title)),
        });
      }
      const child = current.get("First");
      if (isReal(child)) {
        visit(child);
      }
    }
  };
  visit(outlines.get("First"));
  return items;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
