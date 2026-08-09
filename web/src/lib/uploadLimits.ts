/**
 * Upload size boundaries — checked against `File.size` BEFORE any bytes are read into memory, so an
 * oversized upload is refused without ever allocating for it. Pure guards (no DOM) so the boundary is
 * unit-testable even though the React handlers are not.
 */

/** Ceiling for a DOCUMENT upload (redact or whole-file restore). Real business documents are far
 * smaller; anything bigger cannot be processed in a browser tab without freezing it. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Is an uploaded document too large to even read? */
export function exceedsUploadLimit(sizeBytes: number): boolean {
  return sizeBytes > MAX_UPLOAD_BYTES;
}

/** A restore-key file (key.v1 JSON or an encrypted envelope) is at most a few hundred KB in practice. */
export const MAX_KEY_FILE_BYTES = 2 * 1024 * 1024;

/** Is an uploaded restore-key file too large to even read? */
export function exceedsKeyFileLimit(sizeBytes: number): boolean {
  return sizeBytes > MAX_KEY_FILE_BYTES;
}
