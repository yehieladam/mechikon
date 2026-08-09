/**
 * PDF-03 mapped-extraction gate (Vitest, node — mupdf runs there). Asserts the walk-only design on
 * BOTH fixtures:
 *  - the REAL Chromium/HarfBuzz-shaped PDF (what users upload) is the representative gate;
 *  - the SYNTHETIC logical-authored PDF documents the trap (name comes out reversed) + covers Type0.
 *
 * Encodes Fable's requirements: contiguity of PII values after mupdf's reorder, span→rect merging, and
 * a test proving a sort-by-x reconstruction (rejected option A) would REVERSE the real fixture.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { extractPdfMapped, redactPdf, NO_TEXT_LAYER } from "./pdfRedact";
import { collectOutlineItems } from "./pdfSanitize";
import { anonymizeDeterministic, anonymizeFull, detectDeterministic } from "@engine/pipeline";
import type { AnonymizeResult } from "@engine/types";
import { quadsForSpan, refsToRects } from "@engine/pdfText";
import { layerB, layerC } from "@engine/pdfVerify";

function readAsArrayBuffer(relPath: string): ArrayBuffer {
  const abs = fileURLToPath(new URL(`../../../${relPath}`, import.meta.url));
  return new Uint8Array(fs.readFileSync(abs)).buffer;
}

describe("extractPdfMapped — real (Chromium-shaped) fixture", () => {
  it("yields Hebrew names in logical order and deterministic PII, all contiguous", async () => {
    const mapped = await extractPdfMapped(
      readAsArrayBuffer("web/test-fixtures/pdf/chromium-hebrew.pdf"),
    );
    // mupdf's bidi gives the name in logical order — and it is CONTIGUOUS (safety-net assumption).
    expect(mapped.text).toContain("ישראל ישראלי");
    // Deterministic PII stays a contiguous LTR run regardless of the mixed-line reorder.
    expect(mapped.text).toContain("123456709");
    expect(mapped.text).toContain("052-1234567");
  });

  it("detects ID + phone and maps each to a single merged rect on the page", async () => {
    const mapped = await extractPdfMapped(
      readAsArrayBuffer("web/test-fixtures/pdf/chromium-hebrew.pdf"),
    );
    const spans = detectDeterministic(mapped.text);
    const id = spans.find((s) => s.type === "ISRAELI_ID");
    const phone = spans.find((s) => s.type === "IL_PHONE");
    expect(id).toBeDefined();
    expect(phone).toBeDefined();

    const idRects = refsToRects(quadsForSpan(mapped, id!.start, id!.end));
    expect(idRects).toHaveLength(1); // one line → one box
    expect(idRects[0].pageIndex).toBe(0);
    expect(idRects[0].x1).toBeGreaterThan(idRects[0].x0);
    expect(idRects[0].y1).toBeGreaterThan(idRects[0].y0);
  });

  it("a sort-by-x reconstruction (rejected option A) would REVERSE the name here", async () => {
    const mapped = await extractPdfMapped(
      readAsArrayBuffer("web/test-fixtures/pdf/chromium-hebrew.pdf"),
    );
    const at = mapped.text.indexOf("ישראל");
    expect(at).toBeGreaterThanOrEqual(0);
    const xs: number[] = [];
    for (let i = at; i < at + "ישראל".length; i += 1) {
      xs.push(mapped.refs[i]!.quad[0]);
    }
    // Logical order on a real RTL PDF runs right-to-left → DESCENDING x. So sorting by ascending x
    // (option A) would reverse the letters into a wrong, undetectable name. This guards the decision.
    expect(xs).toEqual([...xs].sort((a, b) => b - a));
    expect(xs).not.toEqual([...xs].sort((a, b) => a - b));
  });
});

describe("redactPdf — true removal + in-production self-verify (real fixture)", () => {
  it("removes detected ID + phone, and the redacted bytes pass all three layers", async () => {
    // redactPdf self-verifies internally: if it returns, the 3-layer check already passed.
    const { bytes, result } = await redactPdf(
      readAsArrayBuffer("web/test-fixtures/pdf/chromium-hebrew.pdf"),
      anonymizeDeterministic,
    );
    const originals = result.key.map((r) => r.original);
    expect(originals).toContain("123456709"); // ID was detected...
    expect(originals).toContain("052-1234567"); // ...and phone

    // Re-extract the redacted PDF: the values are gone from the readable text.
    const reExtracted = await extractPdfMapped(bytes.buffer.slice(0) as ArrayBuffer);
    expect(reExtracted.text).not.toContain("123456709");
    expect(reExtracted.text).not.toContain("052-1234567");

    // BURN: each value's Latin token is now part of the page TEXT (AI-extractable, not an annotation),
    // and adjacent tokens extract as separate tokens (not interleaved into garbage).
    expect(reExtracted.text).toContain("[ID_1]");
    expect(reExtracted.text).toContain("[PHONE_1]");
    for (const row of result.key) {
      expect(reExtracted.text).toContain(row.placeholder);
      expect(row.placeholder).toMatch(/^\[[A-Z]+_\d+\]$/); // Latin vocab, renders in the stamped font
    }

    // And gone from the raw bytes (incl. inflated streams) — the true gate.
    const b = await layerB(bytes, originals);
    expect(b.pass).toBe(true);
  });

  it("proves an incremental save would FAIL the byte scan — guards SAFE_SAVE_OPTIONS", async () => {
    // Replicate the redaction but save INCREMENTALLY; the append keeps the pre-redaction objects
    // recoverable and layer B catches the PII. This is why SAFE_SAVE_OPTIONS (full rewrite + garbage)
    // must never be weakened.
    // reason: mupdf's WASM surface is untyped; narrowly used to build a leaky-save counter-example.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const mupdf = (await import("mupdf")) as any;
    const src = new Uint8Array(
      fs.readFileSync(fileURLToPath(new URL("../../../web/test-fixtures/pdf/chromium-hebrew.pdf", import.meta.url))),
    );
    const doc = mupdf.PDFDocument.openDocument(src, "application/pdf");
    const mapped = await extractPdfMapped(src.buffer.slice(0) as ArrayBuffer);
    const result = anonymizeDeterministic(mapped.text);
    const rects = result.spans.flatMap((s) => refsToRects(quadsForSpan(mapped, s.start, s.end)));
    const P = mupdf.PDFPage;
    for (const r of rects) {
      const page = doc.loadPage(r.pageIndex);
      const annot = page.createAnnotation("Redact");
      annot.setRect([r.x0, r.y0, r.x1, r.y1]);
      annot.update();
    }
    doc.loadPage(0).applyRedactions(true, P.REDACT_IMAGE_PIXELS, P.REDACT_LINE_ART_NONE, P.REDACT_TEXT_REMOVE);
    const leaky = new Uint8Array(doc.saveToBuffer({ incremental: true }).asUint8Array());
    // An incremental save appends a second body+xref, leaving the pre-redaction generation
    // recoverable — layer C sees more than one %%EOF/startxref and rejects it. redactPdf's
    // self-verify runs exactly this check, so it can never return an incrementally-saved file.
    const c = layerC(leaky);
    expect(c.pass).toBe(false);
    expect(c.eofCount).toBeGreaterThan(1);
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });
});

describe("redactPdf — strips hidden metadata + anonymizes the outline coherently (dirty.pdf)", () => {
  it("removes the body ID, strips the Info dict, and gives the outline the body's placeholder", async () => {
    // Model-free move of the old pdf-sanitize BROWSER gate: redactPdf self-verifies the Info dict and
    // outline titles, so if it returns, those channels are clean of the key's originals. We also assert
    // the observable results on the bytes. (The Hebrew NAME in the outline needs NER — that fidelity is
    // the @model spec's job; here the deterministic ID is the needle.)
    const ID = "123456709";
    const { bytes } = await redactPdf(
      readAsArrayBuffer("web/test-fixtures/pdf/dirty.pdf"),
      anonymizeDeterministic,
    );
    // reason: mupdf's WASM surface is untyped; used here to read back the redacted document.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mupdf = (await import("mupdf")) as any;
    const doc = mupdf.PDFDocument.openDocument(bytes, "application/pdf");

    const reExtracted = await extractPdfMapped(bytes.buffer.slice(0) as ArrayBuffer);
    expect(reExtracted.text).not.toContain(ID); // body

    const info = doc.getTrailer().get("Info"); // Info dict stripped
    expect(info === null || (info.isNull?.() ?? false)).toBe(true);

    const items = collectOutlineItems(doc); // outline carries the body's placeholder (unified key)
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0].title).not.toContain(ID);
    expect(items[0].title).toMatch(/\[.+_\d+\]/);
  });
});

describe("redactPdf — NER name spans are truly removed (model-free, via injected anonymize)", () => {
  it("removes a Hebrew PERSON name from the PDF when a name span is detected", async () => {
    const NAME = "ישראל ישראלי";
    // Stand in for the NER pass: mark the name as a PERSON span, merged with deterministic detection.
    // (NER detection itself is proven separately; this isolates the PDF name-redaction path from the
    // 185 MB model download so it runs offline in CI.)
    const withName = (text: string) => {
      // Every occurrence — the name appears on more than one line, and self-verify (correctly) fails
      // if any mention survives. Real NER returns all mentions too.
      const spans = [];
      for (let at = text.indexOf(NAME); at >= 0; at = text.indexOf(NAME, at + NAME.length)) {
        spans.push({ start: at, end: at + NAME.length, type: "PERSON" as const, score: 0.99 });
      }
      return anonymizeFull(text, spans);
    };
    const { bytes, result } = await redactPdf(
      readAsArrayBuffer("web/test-fixtures/pdf/chromium-hebrew.pdf"),
      withName,
    );
    expect(result.key.some((r) => r.type === "PERSON" && r.original === NAME)).toBe(true);
    // Re-extract: the name is gone (redactPdf would have thrown on self-verify otherwise).
    const reExtracted = await extractPdfMapped(bytes.buffer.slice(0) as ArrayBuffer);
    expect(reExtracted.text).not.toContain(NAME);
  });
});

describe("redactPdf refuses a PDF with no text layer (scanned/image)", () => {
  it("throws NO_TEXT_LAYER instead of returning a falsely-clean file", async () => {
    // A page with graphics but NO text — mimics a scanned/image PDF (no extractable text layer).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mupdf WASM surface is untyped
    const mupdf = (await import("mupdf")) as any;
    const doc = new mupdf.PDFDocument();
    doc.insertPage(-1, doc.addPage([0, 0, 200, 200], 0, doc.newDictionary(), "1 0 0 rg 0 0 200 200 re f"));
    const bytes = new Uint8Array(doc.saveToBuffer({}).asUint8Array()).buffer;
    await expect(redactPdf(bytes, anonymizeDeterministic)).rejects.toThrow(NO_TEXT_LAYER);
  });
});

describe("redactPdf — pdfUnverified soft warning is HIGH-CONFIDENCE only (B2)", () => {
  // Build a minimal text PDF in-process (Helvetica simple font → the content stream carries the
  // literal ASCII text, which is exactly what layer B's raw-byte scan sees after inflating).
  async function latinPdf(text: string): Promise<ArrayBuffer> {
    // reason: mupdf's WASM surface is untyped; narrowly used to author a crafted test PDF.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mupdf = (await import("mupdf")) as any;
    const doc = new mupdf.PDFDocument();
    const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
    const fonts = doc.newDictionary();
    fonts.put("F1", font);
    const resources = doc.newDictionary();
    resources.put("Font", fonts);
    const contents = `BT /F1 12 Tf 50 700 Td (${text}) Tj ET`;
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resources, contents));
    return new Uint8Array(doc.saveToBuffer({}).asUint8Array()).buffer as ArrayBuffer;
  }

  /** An anonymize stub that CLAIMS the value is redacted (clean AI-text + key row) but supplies NO
   * span — so the quad redaction never removes it from the page and it must survive into self-verify.
   * Models the exact B2 leak: redaction quads missed a value the key says was handled. */
  const claimRedacted =
    (original: string, type: "ISRAELI_ID" | "PERSON", placeholder: string) =>
    (text: string): AnonymizeResult => ({
      anonymizedText: text.split(original).join(placeholder),
      spans: [],
      key: [{ placeholder, original, type }],
    });

  it("WARNS when a full ID survives the redaction quads — pdfUnverified names it, bytes still produced", async () => {
    const buf = await latinPdf("hello 123456709 world");
    const { bytes, pdfUnverified } = await redactPdf(buf, claimRedacted("123456709", "ISRAELI_ID", "[ID_1]"));
    expect(bytes.length).toBeGreaterThan(0); // NON-blocking: the download stays available
    expect(pdfUnverified).toBeDefined();
    expect(pdfUnverified!.terms).toContain("123456709");
  });

  it("WARNS when a full multi-token PERSON surface survives whole", async () => {
    const buf = await latinPdf("contract of Israel Israeli signed here");
    const { bytes, pdfUnverified } = await redactPdf(
      buf,
      claimRedacted("Israel Israeli", "PERSON", "[NAME_1]"),
    );
    expect(bytes.length).toBeGreaterThan(0);
    expect(pdfUnverified).toBeDefined();
    expect(pdfUnverified!.terms).toContain("Israel Israeli");
  });

  it("does NOT warn when a short name fragment only substring-matches inside another word (no noise)", async () => {
    // "Dan" was (per the key) redacted; the page text only contains "Danube", whose raw bytes
    // substring-match "Dan" in layer B. That is the #90 false positive — it must NOT resurface.
    const buf = await latinPdf("the Danube river flows east");
    const { bytes, pdfUnverified } = await redactPdf(buf, claimRedacted("Dan", "PERSON", "[NAME_1]"));
    expect(bytes.length).toBeGreaterThan(0);
    expect(pdfUnverified).toBeUndefined(); // no warning, no noise — the value did not survive whole
  });
});

describe("redactPdf — AcroForm field values (/V) are redacted and verified", () => {
  /** A one-page PDF with body text plus a filled AcroForm text field (an ID typed into the form). */
  async function formPdf(fieldValue: string): Promise<ArrayBuffer> {
    // reason: mupdf's WASM surface is untyped; narrowly used to author a crafted form PDF.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mupdf = (await import("mupdf")) as any;
    const doc = new mupdf.PDFDocument();
    const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
    const fonts = doc.newDictionary();
    fonts.put("F1", font);
    const resources = doc.newDictionary();
    resources.put("Font", fonts);
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resources, "BT /F1 12 Tf 50 700 Td (application form) Tj ET"));
    const pageObj = doc.loadPage(0).getObject();
    const field = doc.addObject(doc.newDictionary());
    field.put("FT", doc.newName("Tx"));
    field.put("T", doc.newString("idNumber"));
    field.put("V", doc.newString(fieldValue));
    field.put("Type", doc.newName("Annot"));
    field.put("Subtype", doc.newName("Widget"));
    const rect = doc.newArray();
    for (const n of [50, 600, 300, 620]) {
      rect.push(n);
    }
    field.put("Rect", rect);
    field.put("P", pageObj);
    const annots = doc.newArray();
    annots.push(field);
    pageObj.put("Annots", annots);
    const acroFields = doc.newArray();
    acroFields.push(field);
    const acroForm = doc.newDictionary();
    acroForm.put("Fields", acroFields);
    doc.getTrailer().get("Root").put("AcroForm", acroForm);
    return new Uint8Array(doc.saveToBuffer({}).asUint8Array()).buffer as ArrayBuffer;
  }

  /** Read the first AcroForm field's /V from raw structure (independent of the implementation). */
  // reason: mupdf's WASM surface is untyped.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function firstFieldValue(doc: any): string {
    return doc.getTrailer().get("Root").get("AcroForm").get("Fields").get(0).get("V").asString();
  }

  it("rewrites a field /V holding an ID to the placeholder; the ID is gone from the bytes", async () => {
    const ID = "123456709";
    const buf = await formPdf(ID);
    const { bytes, result, pdfUnverified } = await redactPdf(buf, anonymizeDeterministic);
    expect(result.key.map((r) => r.original)).toContain(ID); // the form value WAS detected
    // reason: mupdf's WASM surface is untyped.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mupdf = (await import("mupdf")) as any;
    const doc = mupdf.PDFDocument.openDocument(bytes, "application/pdf");
    const value = firstFieldValue(doc);
    expect(value).not.toContain(ID);
    expect(value).toMatch(/\[ID_\d+\]/); // same unified key as the body
    const b = await layerB(bytes, [ID]); // physically gone (incl. any appearance stream)
    expect(b.pass).toBe(true);
    expect(pdfUnverified).toBeUndefined(); // verified clean, no warning needed
  });

  it("self-verify READS field values: a /V survivor is caught and warned, not shipped silently", async () => {
    const ID = "123456709";
    const buf = await formPdf(ID);
    // An anonymize that CLAIMS the ID was handled (clean AI-text + key row) but supplies no span —
    // if the /V rewrite channel regressed, the value would survive; the verify channel must catch it.
    const claim = (text: string): AnonymizeResult => ({
      anonymizedText: text.split(ID).join("[ID_1]"),
      spans: [],
      key: [{ placeholder: "[ID_1]", original: ID, type: "ISRAELI_ID" }],
    });
    const { pdfUnverified } = await redactPdf(buf, claim);
    expect(pdfUnverified).toBeDefined();
    expect(pdfUnverified!.terms).toContain(ID);
  });
});

describe("redactPdf — strips /A /URI link actions and document JavaScript (invisible PII channels)", () => {
  const EMAIL = "dan.cohen@example.com";
  const JS_ID = "123456709";

  /** A one-page PDF with a mailto: link action carrying an email, and doc-level /Names /JavaScript
   * whose script embeds PII. Neither is part of the page text, so redaction never sees them. */
  async function linkJsPdf(): Promise<ArrayBuffer> {
    // reason: mupdf's WASM surface is untyped; narrowly used to author a crafted test PDF.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mupdf = (await import("mupdf")) as any;
    const doc = new mupdf.PDFDocument();
    const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
    const fonts = doc.newDictionary();
    fonts.put("F1", font);
    const resources = doc.newDictionary();
    resources.put("Font", fonts);
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resources, "BT /F1 12 Tf 50 700 Td (contact us) Tj ET"));
    const pageObj = doc.loadPage(0).getObject();

    const link = doc.addObject(doc.newDictionary());
    link.put("Type", doc.newName("Annot"));
    link.put("Subtype", doc.newName("Link"));
    const rect = doc.newArray();
    for (const n of [50, 690, 150, 710]) {
      rect.push(n);
    }
    link.put("Rect", rect);
    const action = doc.newDictionary();
    action.put("S", doc.newName("URI"));
    action.put("URI", doc.newString(`mailto:${EMAIL}`));
    link.put("A", action);
    const annots = doc.newArray();
    annots.push(link);
    pageObj.put("Annots", annots);

    const jsAction = doc.newDictionary();
    jsAction.put("S", doc.newName("JavaScript"));
    jsAction.put("JS", doc.newString(`app.alert("id ${JS_ID}");`));
    const namesArray = doc.newArray();
    namesArray.push(doc.newString("init"));
    namesArray.push(doc.addObject(jsAction));
    const jsTree = doc.newDictionary();
    jsTree.put("Names", namesArray);
    const names = doc.newDictionary();
    names.put("JavaScript", jsTree);
    doc.getTrailer().get("Root").put("Names", names);
    return new Uint8Array(doc.saveToBuffer({}).asUint8Array()).buffer as ArrayBuffer;
  }

  it("the mailto: email and the script PII are gone from the redacted bytes", async () => {
    const buf = await linkJsPdf();
    const { bytes } = await redactPdf(buf, anonymizeDeterministic);
    // reason: mupdf's WASM surface is untyped.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mupdf = (await import("mupdf")) as any;
    const doc = mupdf.PDFDocument.openDocument(bytes, "application/pdf");
    // The URI action is stripped from the link annotation.
    const annots = doc.getTrailer().get("Root").get("Pages").get("Kids").get(0).get("Annots");
    if (annots && !(annots.isNull?.() ?? false) && annots.length > 0) {
      const a = annots.get(0).get("A");
      expect(a === null || (a.isNull?.() ?? false)).toBe(true);
    }
    // Document JavaScript is deleted wholesale.
    const namesDict = doc.getTrailer().get("Root").get("Names");
    const js = namesDict && !(namesDict.isNull?.() ?? false) ? namesDict.get("JavaScript") : null;
    expect(js === null || (js.isNull?.() ?? false)).toBe(true);
    // And the PII is physically gone from the bytes (the real gate).
    const b = await layerB(bytes, [EMAIL, JS_ID]);
    expect(b.pass).toBe(true);
  });
});

describe("extractPdfMapped — synthetic (logical-authored) fixture documents the trap", () => {
  it("finds the ID but extracts the Hebrew name REVERSED (the PDF-03 pitfall)", async () => {
    const mapped = await extractPdfMapped(readAsArrayBuffer("web/test-fixtures/hebrew.pdf"));
    expect(mapped.text).toContain("123456709"); // deterministic PII still findable
    // Authored logical-LTR → mupdf extracts the name reversed; NER would miss it without the real
    // shaping. This is exactly why the representative gate is the Chromium fixture, not this one.
    expect(mapped.text).not.toContain("ישראל ישראלי");
  });
});
