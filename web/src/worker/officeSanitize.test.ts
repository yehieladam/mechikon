/**
 * Office metadata sanitizer: blanks the author/company/custom/comment-author channels while keeping
 * schema-required nodes (timestamps, structural props, numeric custom values) intact.
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { sanitizeOfficeMetadata } from "./officeSanitize";

async function run(parts: Record<string, string>): Promise<Record<string, string>> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(parts)) {
    zip.file(path, content);
  }
  await sanitizeOfficeMetadata(zip);
  const out: Record<string, string> = {};
  for (const path of Object.keys(parts)) {
    out[path] = await zip.file(path)!.async("string");
  }
  return out;
}

describe("sanitizeOfficeMetadata", () => {
  it("1. blanks dc:creator + cp:lastModifiedBy, keeps dcterms:created", async () => {
    const core = `<cp:coreProperties xmlns:cp="c" xmlns:dc="d" xmlns:dcterms="t"><dc:creator>יעל כהן</dc:creator><cp:lastModifiedBy>משה לוי</cp:lastModifiedBy><dcterms:created>2026-01-01T00:00:00Z</dcterms:created></cp:coreProperties>`;
    const out = (await run({ "docProps/core.xml": core }))["docProps/core.xml"];
    expect(out).toContain("<dc:creator></dc:creator>");
    expect(out).toContain("<cp:lastModifiedBy></cp:lastModifiedBy>");
    expect(out).toContain("<dcterms:created>2026-01-01T00:00:00Z</dcterms:created>");
    expect(out).not.toContain("יעל כהן");
    expect(out).not.toContain("משה לוי");
  });

  it("2. blanks dc:title / dc:subject / cp:keywords", async () => {
    const core = `<cp:coreProperties xmlns:cp="c" xmlns:dc="d"><dc:title>תיק סודי</dc:title><dc:subject>לקוח פלוני</dc:subject><cp:keywords>ת״ז</cp:keywords></cp:coreProperties>`;
    const out = (await run({ "docProps/core.xml": core }))["docProps/core.xml"];
    expect(out).not.toContain("תיק סודי");
    expect(out).not.toContain("לקוח פלוני");
    expect(out).toContain("<dc:title></dc:title>");
  });

  it("3. blanks Company + Manager, keeps Application/DocSecurity", async () => {
    const app = `<Properties><Application>Microsoft Word</Application><DocSecurity>0</DocSecurity><Company>משרד עו״ד כהן</Company><Manager>דנה</Manager></Properties>`;
    const out = (await run({ "docProps/app.xml": app }))["docProps/app.xml"];
    expect(out).toContain("<Application>Microsoft Word</Application>");
    expect(out).toContain("<DocSecurity>0</DocSecurity>");
    expect(out).toContain("<Company></Company>");
    expect(out).not.toContain("משרד עו״ד כהן");
    expect(out).not.toContain("דנה");
  });

  it("4. blanks string custom props, leaves a numeric-typed value intact", async () => {
    const custom = `<Properties xmlns:vt="v"><property name="Client"><vt:lpwstr>ישראל ישראלי</vt:lpwstr></property><property name="Year"><vt:i4>2026</vt:i4></property></Properties>`;
    const out = (await run({ "docProps/custom.xml": custom }))["docProps/custom.xml"];
    expect(out).toContain("<vt:lpwstr></vt:lpwstr>");
    expect(out).not.toContain("ישראל ישראלי");
    expect(out).toContain("<vt:i4>2026</vt:i4>"); // numeric untouched
  });

  it("5. blanks docx comment @w:author and @w:initials", async () => {
    const comments = `<w:comments xmlns:w="w"><w:comment w:id="1" w:author="יעל כהן" w:initials="יכ"><w:p><w:r><w:t>לבדוק סעיף</w:t></w:r></w:p></w:comment></w:comments>`;
    const out = (await run({ "word/comments.xml": comments }))["word/comments.xml"];
    expect(out).toContain('w:author=""');
    expect(out).toContain('w:initials=""');
    expect(out).not.toContain("יעל כהן");
    // Comment BODY text is left for the redaction pass — not blanked here.
    expect(out).toContain("לבדוק סעיף");
  });

  it("6. blanks xlsx <author> text", async () => {
    const comments = `<comments><authors><author>משה לוי</author></authors><commentList/></comments>`;
    const out = (await run({ "xl/comments1.xml": comments }))["xl/comments1.xml"];
    expect(out).toContain("<author></author>");
    expect(out).not.toContain("משה לוי");
  });

  it("8. blanks w:author/w:initials on a tracked revision in document.xml (not only comments.xml)", async () => {
    // A tracked insertion/deletion stamps the reviewer's name as w:author on <w:ins>/<w:del> in the body.
    const doc = `<w:document xmlns:w="w"><w:body><w:p><w:ins w:id="1" w:author="יעל כהן" w:initials="יכ" w:date="2026-01-01T00:00:00Z"><w:r><w:t>x</w:t></w:r></w:ins></w:p></w:body></w:document>`;
    const out = (await run({ "word/document.xml": doc }))["word/document.xml"];
    expect(out).toContain('w:author=""');
    expect(out).toContain('w:initials=""');
    expect(out).not.toContain("יעל כהן");
    expect(out).toContain('w:date="2026-01-01T00:00:00Z"'); // timestamp kept
  });

  it("9. blanks author + display names in word/people.xml (revision-author registry)", async () => {
    const people = `<w15:people xmlns:w15="w15"><w15:person w15:author="משה לוי"><w15:presenceInfo w15:providerId="None" w15:userId="משה לוי"/></w15:person></w15:people>`;
    const out = (await run({ "word/people.xml": people }))["word/people.xml"];
    expect(out).not.toContain("משה לוי");
    expect(out).toContain('w15:author=""');
  });

  it("7. removes docProps/thumbnail.* (a rendered image of the original page 1) and its relationship", async () => {
    const zip = new JSZip();
    zip.file("docProps/thumbnail.jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    zip.file(
      "_rels/.rels",
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="docProps/thumbnail.jpeg"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    );
    await sanitizeOfficeMetadata(zip);
    expect(zip.file("docProps/thumbnail.jpeg")).toBeNull();
    const rels = await zip.file("_rels/.rels")!.async("string");
    expect(rels).not.toContain("thumbnail");
    expect(rels).toContain('Target="word/document.xml"'); // other relationships preserved
  });
});
