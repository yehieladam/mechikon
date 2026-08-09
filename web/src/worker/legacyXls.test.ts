/**
 * Legacy .xls refusal (B7): the SheetJS (`xlsx`) parser carried unpatched Prototype-Pollution + ReDoS
 * advisories and was the ONLY reader of the legacy binary .xls format. It is removed; a .xls upload must
 * now be refused with a clear, deterministic error — never routed into a vulnerable parser, never a crash.
 */
import { describe, expect, it } from "vitest";
import { redactFile, LEGACY_XLS_UNSUPPORTED } from "./officeRedact";
import { extractText } from "./extract";

describe("legacy .xls is refused (SheetJS removed)", () => {
  it("redactFile('*.xls') rejects with the LEGACY_XLS_UNSUPPORTED message", async () => {
    const buffer = new TextEncoder().encode("legacy binary excel bytes").buffer as ArrayBuffer;
    await expect(redactFile("book.xls", buffer)).rejects.toThrow("LEGACY_XLS_UNSUPPORTED");
  });

  it("exports the LEGACY_XLS_UNSUPPORTED code", () => {
    expect(LEGACY_XLS_UNSUPPORTED).toBe("LEGACY_XLS_UNSUPPORTED");
  });

  it("extractText no longer resolves .xls (no SheetJS parse path)", async () => {
    const buffer = new TextEncoder().encode("legacy binary excel bytes").buffer as ArrayBuffer;
    await expect(extractText("book.xls", buffer)).rejects.toThrow();
  });
});
