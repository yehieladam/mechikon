import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptKeyRows, encryptKeyRows, isEncryptedKeyFile, INVALID_KEY_FILE } from "./keyCrypto";
import type { EncryptedKeyFile } from "./keyCrypto";
import type { KeyRow } from "./types";

/** base64 of `n` zero bytes — a well-formed base64 string that decodes to the wrong length. */
function base64Bytes(n: number): string {
  let binary = "";
  for (let i = 0; i < n; i += 1) {
    binary += "\0";
  }
  return btoa(binary);
}

/** A valid envelope to mutate into malformed cases. */
async function validEnvelope(): Promise<EncryptedKeyFile> {
  return encryptKeyRows([{ placeholder: "[ID_1]", original: "123456709", type: "ISRAELI_ID" }], "pw");
}

/** Cast a mutated object to the envelope type for the untrusted-input tests. */
function asEnvelope(value: unknown): EncryptedKeyFile {
  return value as EncryptedKeyFile;
}

const ROWS: KeyRow[] = [
  { placeholder: "[ID_1]", original: "123456709", type: "ISRAELI_ID" },
  { placeholder: "[NAME_1]", original: "ישראל ישראלי", type: "PERSON" },
  { placeholder: "[PHONE_1]", original: "052-1234567", type: "IL_PHONE" },
];

describe("keyCrypto", () => {
  it("round-trips key rows through encrypt → decrypt with the right passphrase", async () => {
    const envelope = await encryptKeyRows(ROWS, "correct horse battery staple");
    const restored = await decryptKeyRows(envelope, "correct horse battery staple");
    expect(restored).toEqual(ROWS);
  });

  it("produces a self-describing envelope with no plaintext PII in it", async () => {
    const envelope = await encryptKeyRows(ROWS, "pw");
    expect(isEncryptedKeyFile(envelope)).toBe(true);
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain("123456709");
    expect(serialized).not.toContain("ישראל ישראלי");
    expect(envelope.kdf.iterations).toBeGreaterThanOrEqual(600_000);
  });

  it("fails cleanly (WRONG_PASSPHRASE) on a wrong passphrase", async () => {
    const envelope = await encryptKeyRows(ROWS, "right");
    await expect(decryptKeyRows(envelope, "wrong")).rejects.toThrow("WRONG_PASSPHRASE");
  });

  it("fails cleanly on a tampered ciphertext", async () => {
    const envelope = await encryptKeyRows(ROWS, "pw");
    const tampered = { ...envelope, ciphertext: envelope.ciphertext.slice(0, -4) + "AAAA" };
    await expect(decryptKeyRows(tampered, "pw")).rejects.toThrow("WRONG_PASSPHRASE");
  });

  it("isEncryptedKeyFile distinguishes an envelope from a plain key file", () => {
    expect(isEncryptedKeyFile({ version: "key.v1", rows: [] })).toBe(false);
    expect(isEncryptedKeyFile(null)).toBe(false);
    expect(isEncryptedKeyFile("nope")).toBe(false);
  });
});

describe("keyCrypto — passphrase Unicode normalization (NFC)", () => {
  it("decrypts with the NFC form of a passphrase that was encrypted in NFD form (cross-device)", async () => {
    // macOS-style input can produce the DECOMPOSED form (NFD) of the same visible passphrase another
    // device types PRECOMPOSED (NFC). Both must derive the SAME key, or the correct passphrase fails
    // permanently on the other device (data loss).
    const nfd = "café שָׁלוֹם".normalize("NFD");
    const nfc = nfd.normalize("NFC");
    expect(nfd).not.toBe(nfc); // the two forms genuinely differ code-point-wise
    const envelope = await encryptKeyRows(ROWS, nfd);
    const restored = await decryptKeyRows(envelope, nfc);
    expect(restored).toEqual(ROWS);
  });

  it("decrypts with the NFD form of a passphrase that was encrypted in NFC form", async () => {
    const nfc = "café".normalize("NFC");
    const nfd = nfc.normalize("NFD");
    const envelope = await encryptKeyRows(ROWS, nfc);
    const restored = await decryptKeyRows(envelope, nfd);
    expect(restored).toEqual(ROWS);
  });
});

describe("keyCrypto — untrusted-envelope hardening (M2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses a DoS iteration count WITHOUT ever calling deriveKey (no freeze)", async () => {
    const env = asEnvelope({ ...(await validEnvelope()), kdf: { ...(await validEnvelope()).kdf, iterations: 2_000_000_000 } });
    const spy = vi.spyOn(crypto.subtle, "deriveKey");
    await expect(decryptKeyRows(env, "pw")).rejects.toThrow(INVALID_KEY_FILE);
    expect(spy).toHaveBeenCalledTimes(0); // the real proof the tab cannot freeze
  });

  it("rejects non-integer / out-of-type iteration values", async () => {
    const base = await validEnvelope();
    for (const bad of [0, -1, 1.5, Number.NaN, "600000"]) {
      const env = asEnvelope({ ...base, kdf: { ...base.kdf, iterations: bad } });
      await expect(decryptKeyRows(env, "pw")).rejects.toThrow(INVALID_KEY_FILE);
    }
  });

  it("rejects a missing/empty salt, nonce, or ciphertext, wrong algo, or missing kdf", async () => {
    const base = await validEnvelope();
    const cases = [
      { ...base, kdf: { ...base.kdf, salt: "" } },
      { ...base, nonce: "" },
      { ...base, ciphertext: "" },
      { ...base, kdf: { ...base.kdf, algo: "MD5" } },
      { version: base.version, nonce: base.nonce, ciphertext: base.ciphertext }, // no kdf
    ];
    for (const bad of cases) {
      await expect(decryptKeyRows(asEnvelope(bad), "pw")).rejects.toThrow(INVALID_KEY_FILE);
    }
  });

  it("rejects a salt/nonce that decode to the wrong byte length", async () => {
    const base = await validEnvelope();
    const shortSalt = asEnvelope({ ...base, kdf: { ...base.kdf, salt: base64Bytes(8) } }); // want 16
    const shortNonce = asEnvelope({ ...base, nonce: base64Bytes(6) }); // want 12
    await expect(decryptKeyRows(shortSalt, "pw")).rejects.toThrow(INVALID_KEY_FILE);
    await expect(decryptKeyRows(shortNonce, "pw")).rejects.toThrow(INVALID_KEY_FILE);
  });

  it("isEncryptedKeyFile: true for a well-formed envelope, false for each malformed case", async () => {
    const base = await validEnvelope();
    expect(isEncryptedKeyFile(base)).toBe(true);
    expect(isEncryptedKeyFile({ ...base, kdf: { ...base.kdf, iterations: 2_000_000_000 } })).toBe(false);
    expect(isEncryptedKeyFile({ ...base, kdf: { ...base.kdf, iterations: "600000" } })).toBe(false);
    expect(isEncryptedKeyFile({ ...base, nonce: "" })).toBe(false);
    expect(isEncryptedKeyFile({ version: "key.v1" })).toBe(false);
  });

  it("accepts the iteration boundaries and rejects just outside them", async () => {
    const base = await validEnvelope();
    const withIter = (n: number) => ({ ...base, kdf: { ...base.kdf, iterations: n } });
    expect(isEncryptedKeyFile(withIter(100_000))).toBe(true);
    expect(isEncryptedKeyFile(withIter(10_000_000))).toBe(true);
    expect(isEncryptedKeyFile(withIter(99_999))).toBe(false);
    expect(isEncryptedKeyFile(withIter(10_000_001))).toBe(false);
  });
});
