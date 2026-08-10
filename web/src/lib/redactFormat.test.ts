/**
 * redactFormat feeds the ONLY payload of the anonymous file_redacted event, so it must stay a fixed,
 * content-free bucket: extension in, coarse label out. These tests pin the mapping (including the
 * .xls→xlsx / .doc→docx legacy folds) and prove nothing identifying leaks through.
 */
import { describe, expect, it } from "vitest";
import { redactFormat } from "./redactFormat";

describe("redactFormat", () => {
  it("maps known extensions to their bucket (case-insensitive)", () => {
    expect(redactFormat("report.pdf")).toBe("pdf");
    expect(redactFormat("SHEET.XLSX")).toBe("xlsx");
    expect(redactFormat("legacy.xls")).toBe("xlsx");
    expect(redactFormat("data.csv")).toBe("csv");
    expect(redactFormat("letter.docx")).toBe("docx");
    expect(redactFormat("old.doc")).toBe("docx");
    expect(redactFormat("notes.txt")).toBe("txt");
  });

  it("falls back to 'other' for unknown or missing extensions", () => {
    expect(redactFormat("archive.zip")).toBe("other");
    expect(redactFormat("noextension")).toBe("other");
    expect(redactFormat("trailingdot.")).toBe("other");
  });

  it("uses only the extension — the filename body never affects the label", () => {
    expect(redactFormat("חוזה-של-דוד-כהן-ת.ז-123456789.pdf")).toBe("pdf");
  });
});
