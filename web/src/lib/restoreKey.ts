/**
 * Restore-key ownership (H-stalekey). Restore resolves a document's placeholder tokens against a key.
 * Two decisions live here, extracted so they are unit-testable without a React component harness:
 *
 *  1. WHICH key drives restore — an uploaded key (for restoring in a later/fresh session) wins over the
 *     in-memory session key.
 *  2. WHEN an uploaded key stops being valid — a brand-new document owns its OWN restore key, so a key
 *     uploaded (or being unlocked) for a PRIOR document must be dropped when a new document is produced.
 *     Leaving it in place would resolve the new document's tokens against the old document's rows,
 *     writing the previous document's originals into this one with unmatched===0 and no warning.
 */
import type { KeyRow } from "@engine/types";
import type { EncryptedKeyFile } from "@engine/keyCrypto";

/** The uploaded-key + pending-unlock state that a new document must be able to reset atomically. */
export interface UploadedKeyState {
  readonly uploadedKey: KeyRow[] | null;
  readonly pendingEnc: EncryptedKeyFile | null;
  readonly unlockPassphrase: string;
}

/** Prefer an uploaded key (restore in a later/fresh session) over the in-memory session key. */
export function selectActiveKey(
  uploadedKey: readonly KeyRow[] | null,
  resultKey: readonly KeyRow[] | null,
): readonly KeyRow[] | null {
  return uploadedKey ?? resultKey ?? null;
}

/**
 * The uploaded-key state after a result is shown. A brand-new document (isNewDocument=true) drops any
 * key uploaded / mid-unlock for a PRIOR document; a same-document re-run or NER-upgrade
 * (isNewDocument=false) keeps it untouched.
 */
export function uploadedKeyStateAfterResult(
  prev: UploadedKeyState,
  isNewDocument: boolean,
): UploadedKeyState {
  if (!isNewDocument) {
    return prev;
  }
  return { uploadedKey: null, pendingEnc: null, unlockPassphrase: "" };
}
