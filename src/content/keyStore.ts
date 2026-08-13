/**
 * Persistent restore key — chrome.storage.local with a sliding 24h expiry.
 * The key (placeholder -> original value) must survive a page reload so a user can restore an AI
 * answer in a later visit within the same day. Values sit in the extension's own profile storage,
 * never a server; the 24h expiry + manual clear are the compensating controls (see extension plan §4).
 */
import type { KeyRow } from "@engine/types";

const STORAGE_KEY = "inlineKey.v1";
const TTL_MS = 24 * 60 * 60 * 1000;

interface StoredKey {
  readonly version: string;
  readonly rows: KeyRow[];
  readonly expiresAt: number;
}

/** Load the key, treating an expired (or missing) record as empty and clearing it lazily. */
export async function loadKey(): Promise<KeyRow[]> {
  const now = Date.now();
  const bag = await chrome.storage.local.get(STORAGE_KEY);
  const stored = bag[STORAGE_KEY] as StoredKey | undefined;
  if (!stored || stored.version !== STORAGE_KEY || stored.expiresAt <= now) {
    if (stored) {
      await chrome.storage.local.remove(STORAGE_KEY);
    }
    return [];
  }
  return stored.rows;
}

/** Persist the key with a refreshed 24h expiry (sliding — an active conversation never expires mid-use). */
export async function saveKey(rows: KeyRow[]): Promise<void> {
  const record: StoredKey = { version: STORAGE_KEY, rows, expiresAt: Date.now() + TTL_MS };
  await chrome.storage.local.set({ [STORAGE_KEY]: record });
}

export async function clearKey(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}
