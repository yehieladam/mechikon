/**
 * Restore-key encryption (KEY-01). The key maps placeholders back to the original PII. By default it
 * lives only in the tab's memory and dies when the tab closes — the differentiation claim. Download is
 * opt-in, and on download we offer passphrase encryption (a checkbox that is CHECKED by default), so a
 * key file at rest on the user's disk is useless without the passphrase.
 *
 * Crypto is the platform's own: PBKDF2-SHA256 (600k iterations) derives an AES-256-GCM key from the
 * passphrase. No dependency, no server, framework-free — `crypto.subtle`, `btoa`/`atob` and
 * `TextEncoder` are all available in the browser and in Node 20 (so this stays unit-testable headless).
 */
import type { KeyRow } from "./types";
import { toKeyFile, fromKeyFile } from "./key";

const ENC_VERSION = "mechikon-key-enc.v1";
const KDF_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
/**
 * A restore-key file is untrusted input (the user uploads it). Bound the PBKDF2 iteration count so a
 * hostile file cannot pin the tab's CPU (a 2-billion-iteration derive would freeze it). We REJECT out
 * of range rather than clamp-and-derive: our own files always carry exactly KDF_ITERATIONS (in range),
 * and a hostile value is refused BEFORE deriveKey ever runs.
 */
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 10_000_000;

/** Thrown when an uploaded key envelope is malformed or out of bounds (distinct from a wrong passphrase). */
export const INVALID_KEY_FILE = "INVALID_KEY_FILE";

function isValidIterations(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_ITERATIONS &&
    value <= MAX_ITERATIONS
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export interface EncryptedKeyFile {
  readonly version: typeof ENC_VERSION;
  readonly kdf: {
    readonly algo: "PBKDF2-SHA256";
    readonly iterations: number;
    readonly salt: string; // base64
  };
  readonly nonce: string; // base64 (AES-GCM IV)
  readonly ciphertext: string; // base64
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function deriveAesKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  // NFC-normalize BEFORE encoding: the same visible passphrase can arrive precomposed (NFC) on one
  // device and decomposed (NFD, e.g. macOS input) on another. Without this, the correct passphrase
  // derives a DIFFERENT key on the other device — a permanent decrypt failure (data loss).
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase.normalize("NFC")),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt the key rows under a passphrase into a self-describing envelope (safe to write to disk). */
export async function encryptKeyRows(
  rows: readonly KeyRow[],
  passphrase: string,
): Promise<EncryptedKeyFile> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const aesKey = await deriveAesKey(passphrase, salt, KDF_ITERATIONS);
  const plaintext = new TextEncoder().encode(toKeyFile(rows));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, aesKey, plaintext),
  );
  return {
    version: ENC_VERSION,
    kdf: { algo: "PBKDF2-SHA256", iterations: KDF_ITERATIONS, salt: toBase64(salt) },
    nonce: toBase64(nonce),
    ciphertext: toBase64(ciphertext),
  };
}

/** Decrypt an envelope back to key rows. Throws `WRONG_PASSPHRASE` on a bad passphrase / tampered file. */
export async function decryptKeyRows(
  envelope: EncryptedKeyFile,
  passphrase: string,
): Promise<KeyRow[]> {
  // Validate the untrusted envelope BEFORE any key derivation — a hostile iteration count must never
  // reach deriveKey (that is the freeze), and a malformed file is a clear, distinct error.
  if (!isEncryptedKeyFile(envelope)) {
    throw new Error(INVALID_KEY_FILE);
  }
  const salt = fromBase64(envelope.kdf.salt);
  const nonce = fromBase64(envelope.nonce);
  const ciphertext = fromBase64(envelope.ciphertext);
  if (salt.length !== SALT_BYTES || nonce.length !== NONCE_BYTES) {
    throw new Error(INVALID_KEY_FILE);
  }
  const aesKey = await deriveAesKey(passphrase, salt, envelope.kdf.iterations);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource },
      aesKey,
      ciphertext as BufferSource,
    );
  } catch {
    // AES-GCM authentication failure — wrong passphrase or a corrupted/tampered file.
    throw new Error("WRONG_PASSPHRASE");
  }
  return fromKeyFile(new TextDecoder().decode(plaintext));
}

/**
 * Is this parsed JSON a WELL-FORMED encrypted key envelope (vs a plain key.v1 file or hostile JSON)?
 * A full structural guard: the version, the KDF block (algo + in-range iterations + salt), the nonce
 * and the ciphertext must all be present and well-typed. This is the gate that keeps a malformed or
 * DoS-crafted upload out of the crypto path.
 */
export function isEncryptedKeyFile(value: unknown): value is EncryptedKeyFile {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const env = value as Record<string, unknown>;
  if (env.version !== ENC_VERSION || !isNonEmptyString(env.nonce) || !isNonEmptyString(env.ciphertext)) {
    return false;
  }
  const kdf = env.kdf;
  if (typeof kdf !== "object" || kdf === null) {
    return false;
  }
  const k = kdf as Record<string, unknown>;
  return k.algo === "PBKDF2-SHA256" && isValidIterations(k.iterations) && isNonEmptyString(k.salt);
}
