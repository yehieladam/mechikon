/**
 * H-stalekey: restore must resolve a document's tokens against ITS OWN key. These pure helpers encode
 * the two decisions the App makes around the restore key, so the wrong-document-restore bug is covered
 * headless (the React handlers themselves have no component harness).
 */
import { describe, expect, it } from "vitest";
import type { KeyRow } from "@engine/types";
import { selectActiveKey, uploadedKeyStateAfterResult } from "./restoreKey";

const keyA: KeyRow[] = [{ placeholder: "[ID_1]", original: "111111118", type: "ISRAELI_ID" }];
const keyB: KeyRow[] = [{ placeholder: "[ID_1]", original: "222222226", type: "ISRAELI_ID" }];

describe("selectActiveKey — which key drives restore", () => {
  it("prefers an uploaded key over the in-memory result key", () => {
    expect(selectActiveKey(keyA, keyB)).toBe(keyA);
  });

  it("falls back to the result key when nothing was uploaded", () => {
    expect(selectActiveKey(null, keyB)).toBe(keyB);
  });

  it("is null when there is neither an uploaded nor a result key", () => {
    expect(selectActiveKey(null, null)).toBeNull();
  });
});

describe("uploadedKeyStateAfterResult — key ownership across documents", () => {
  it("drops a PRIOR document's uploaded key when a brand-new document is produced (H-stalekey)", () => {
    const next = uploadedKeyStateAfterResult(
      { uploadedKey: keyA, pendingEnc: null, unlockPassphrase: "secret" },
      true,
    );
    expect(next.uploadedKey).toBeNull();
    expect(next.pendingEnc).toBeNull();
    expect(next.unlockPassphrase).toBe("");
  });

  it("keeps the uploaded key on a same-document re-run / NER-upgrade (isNewDocument=false)", () => {
    const prev = { uploadedKey: keyA, pendingEnc: null, unlockPassphrase: "" };
    expect(uploadedKeyStateAfterResult(prev, false)).toBe(prev);
  });

  it("end to end: doc B restores against B's key, not A's, after A's key was uploaded first", () => {
    // The user uploaded A's key and could restore doc A immediately.
    let uploaded: KeyRow[] | null = keyA;
    expect(selectActiveKey(uploaded, null)).toBe(keyA);

    // Then a NEW document B is redacted. The prior-document key must be dropped so B's tokens do NOT
    // resolve against A's rows (which would write A's originals into B with no unmatched warning).
    uploaded = uploadedKeyStateAfterResult(
      { uploadedKey: uploaded, pendingEnc: null, unlockPassphrase: "" },
      true,
    ).uploadedKey;
    expect(selectActiveKey(uploaded, keyB)).toBe(keyB);
  });
});
