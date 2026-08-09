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
 * Action types whose payload can carry PII outward and cannot be rewritten coherently: /URI (a
 * mailto:/https URL embedding a name or email), /JavaScript (arbitrary script text), /SubmitForm (a
 * submission URL), /Launch and /GoToR (external file paths). Internal /GoTo navigation carries no
 * text and is kept.
 */
const PII_ACTION_TYPES: ReadonlySet<string> = new Set(["URI", "JavaScript", "SubmitForm", "Launch", "GoToR"]);

/** True when an action dict must be stripped: a PII-capable /S type, or ANY /Next chain (a nested
 * action list can hide a URI/JS behind an innocent first action — unverifiable, so fail-closed). */
function isPiiAction(action: any): boolean {
  if (!isReal(action)) {
    return false;
  }
  const s = action.get("S");
  const name: string = s && (s.isName?.() ?? false) ? s.asName() : "";
  return PII_ACTION_TYPES.has(name) || isReal(action.get("Next"));
}

/**
 * Strip annotation ACTIONS that can carry PII in their payload — a link's `/A /URI` (e.g. a mailto:
 * with the person's address) survives redaction of the visible text, because the URI lives in the
 * annotation dict, not the content stream. `/AA` (additional actions) is deleted outright on every
 * annotation: it is a JS-only channel. Fail-closed: strip rather than rewrite.
 */
export function stripAnnotationActions(doc: any): void {
  const pageCount: number = doc.countPages();
  for (let i = 0; i < pageCount; i += 1) {
    const annots = doc.loadPage(i).getObject().get("Annots");
    if (!isReal(annots) || !(annots.isArray?.() ?? false)) {
      continue;
    }
    for (let j = 0; j < annots.length; j += 1) {
      const annot = annots.get(j);
      if (!isReal(annot)) {
        continue;
      }
      try {
        if (isPiiAction(annot.get("A"))) {
          annot.delete("A");
        }
        annot.delete("AA");
      } catch {
        /* best effort per annotation; the byte-level self-verify is the backstop */
      }
    }
  }
}

/**
 * Delete document-level JavaScript: the `/Names /JavaScript` name tree (scripts run on open and can
 * embed any document data verbatim) and the catalog's `/AA` additional-actions (JS-only). A
 * JavaScript `/OpenAction` is deleted too; a plain GoTo open destination is kept.
 */
export function stripDocJavaScript(doc: any): void {
  const root = doc.getTrailer().get("Root");
  if (!isReal(root)) {
    return;
  }
  const names = root.get("Names");
  if (isReal(names)) {
    names.delete("JavaScript");
  }
  root.delete("AA");
  if (isPiiAction(root.get("OpenAction"))) {
    root.delete("OpenAction");
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
    node.delete("DV"); // reset-form default (verbatim value duplicate)
    node.delete("RV"); // rich-text duplicate of /V
    node.delete("I"); // choice-field selected INDICES — positional signal of the chosen option
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

/** Strip all pure-metadata leak channels (Info, XMP, embedded files, annotation text + actions,
 * document JavaScript, field extras). */
export function sanitizeMetadata(doc: any): void {
  stripInfo(doc);
  stripXmp(doc);
  stripEmbeddedFiles(doc);
  clearAnnotationText(doc);
  stripAnnotationActions(doc);
  stripOutlineActions(doc);
  stripDocJavaScript(doc);
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

/** True when a PDFObject is a live, non-null string. */
function isStringObj(obj: any): boolean {
  return Boolean(obj) && !(obj.isNull?.() ?? false) && (obj.isString?.() ?? false);
}

/**
 * Walk the AcroForm field tree (Fields + nested Kids) and return every readable/rewritable STRING
 * value a field carries — with a setter that rewrites it in place. The caller anonymizes these
 * through the same unified pass as the body text, so a form value gets the same placeholder as its
 * body mentions. Covered channels:
 *  - a string /V (text field, single-select choice);
 *  - each string element of an ARRAY /V (a MULTI-select choice — otherwise skipped as non-string);
 *  - each option in /Opt (choice field option labels: a string, or a [exportValue, displayText]
 *    pair — both sub-strings), where the selected value is duplicated AND non-selected options can
 *    themselves be PII (a dropdown of names).
 * Non-string states (checkbox/radio names like /Yes) carry no free text and are skipped. Every setter
 * also drops the field's stale appearance streams (/AP) so the OLD value cannot render or survive.
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
  /** Surface a string that lives at `array[index]`, rewritten in place. */
  const pushArrayString = (node: any, depth: number, array: any, index: number): void => {
    const element = array.get(index);
    if (isStringObj(element)) {
      items.push({
        value: element.asString(),
        setValue: (next: string) => {
          array.put(index, doc.newString(next));
          deleteAppearances(node, depth);
        },
      });
    }
  };
  const visit = (node: any, depth: number): void => {
    if (!isReal(node) || depth > MAX_FIELD_TREE_DEPTH) {
      return;
    }
    const value = node.get("V");
    if (isStringObj(value)) {
      items.push({
        value: value.asString(),
        setValue: (next: string) => {
          node.put("V", doc.newString(next));
          deleteAppearances(node, depth);
        },
      });
    } else if (isReal(value) && (value.isArray?.() ?? false)) {
      // Multi-select /V: an array of the selected export strings.
      for (let i = 0; i < value.length; i += 1) {
        pushArrayString(node, depth, value, i);
      }
    }
    // Choice-field options: /Opt entries are strings, or [exportValue, displayText] pairs.
    const opt = node.get("Opt");
    if (isReal(opt) && (opt.isArray?.() ?? false)) {
      for (let i = 0; i < opt.length; i += 1) {
        const entry = opt.get(i);
        if (isStringObj(entry)) {
          pushArrayString(node, depth, opt, i);
        } else if (isReal(entry) && (entry.isArray?.() ?? false)) {
          for (let j = 0; j < entry.length; j += 1) {
            pushArrayString(node, depth, entry, j);
          }
        }
      }
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
/** Visit every outline (bookmark) node once (Next siblings + First children, depth-capped). */
function walkOutline(doc: any, fn: (node: any) => void): void {
  const root = doc.getTrailer().get("Root");
  const outlines = isReal(root) ? root.get("Outlines") : null;
  if (!isReal(outlines)) {
    return;
  }
  const visit = (node: any, depth: number): void => {
    if (depth > MAX_FIELD_TREE_DEPTH) {
      return;
    }
    for (let current = node; isReal(current); current = current.get("Next")) {
      fn(current);
      const child = current.get("First");
      if (isReal(child)) {
        visit(child, depth + 1);
      }
    }
  };
  visit(outlines.get("First"), 0);
}

export function collectOutlineItems(doc: any): OutlineItem[] {
  const items: OutlineItem[] = [];
  walkOutline(doc, (current) => {
    const titleObj = current.get("Title");
    if (titleObj && !(titleObj.isNull?.() ?? false) && titleObj.asString) {
      items.push({
        title: titleObj.asString(),
        setTitle: (title: string) => current.put("Title", doc.newString(title)),
      });
    }
  });
  return items;
}

/**
 * Strip PII-capable /A actions on outline (bookmark) items — a bookmark's `/A << /S /URI ... >>` can
 * carry a mailto: with an email, and it lives in the outline tree, NOT among page annotations (so
 * stripAnnotationActions never touched it). /Dest (an internal page destination) carries no text and
 * is kept. Fail-closed: same isPiiAction test as page annotations (URI/JS/SubmitForm/Launch/GoToR/
 * any /Next chain).
 */
export function stripOutlineActions(doc: any): void {
  walkOutline(doc, (current) => {
    if (isPiiAction(current.get("A"))) {
      current.delete("A");
    }
  });
}

/** Decoded URIs on outline /A /URI actions — read into the verify channel so a survivor is caught. */
export function collectOutlineUris(doc: any): string[] {
  const uris: string[] = [];
  walkOutline(doc, (current) => {
    const action = current.get("A");
    const uri = isReal(action) ? action.get("URI") : null;
    if (isStringObj(uri)) {
      uris.push(uri.asString());
    }
  });
  return uris;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
