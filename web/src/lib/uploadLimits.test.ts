/**
 * Upload size boundaries — untrusted-input caps checked BEFORE a file is ever read into memory.
 * The App handlers consult these pure guards, so the boundary itself is unit-tested even though the
 * React handlers are not.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_KEY_FILE_BYTES,
  MAX_UPLOAD_BYTES,
  exceedsKeyFileLimit,
  exceedsUploadLimit,
} from "./uploadLimits";

describe("uploadLimits — document upload", () => {
  it("caps a document upload at 50MB", () => {
    expect(MAX_UPLOAD_BYTES).toBe(50 * 1024 * 1024);
  });

  it("accepts a file at the cap and refuses one byte over", () => {
    expect(exceedsUploadLimit(MAX_UPLOAD_BYTES)).toBe(false);
    expect(exceedsUploadLimit(MAX_UPLOAD_BYTES + 1)).toBe(true);
  });
});

describe("uploadLimits — key file", () => {
  it("caps a restore-key upload at 2MB", () => {
    expect(MAX_KEY_FILE_BYTES).toBe(2 * 1024 * 1024);
  });

  it("accepts a file at the cap and refuses one byte over", () => {
    expect(exceedsKeyFileLimit(MAX_KEY_FILE_BYTES)).toBe(false);
    expect(exceedsKeyFileLimit(MAX_KEY_FILE_BYTES + 1)).toBe(true);
    expect(exceedsKeyFileLimit(0)).toBe(false);
  });
});
