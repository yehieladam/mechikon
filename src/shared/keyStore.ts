/**
 * The ONE persistent restore key, shared by every surface (inline chat + popup files) so a token
 * always means the same value everywhere and restore works across surfaces. chrome.storage.local,
 * sliding 24h expiry; an expired record reads as empty AND is deleted (no stale PII lingering).
 */
import type { KeyRow } from "@engine/types";

const STORAGE_KEY = "sessionKey.v1";
const TTL_MS = 24 * 60 * 60 * 1000;

interface StoredKey {
  readonly version: string;
  readonly rows: KeyRow[];
  readonly expiresAt: number;
}

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

export async function saveKey(rows: KeyRow[]): Promise<void> {
  const record: StoredKey = { version: STORAGE_KEY, rows, expiresAt: Date.now() + TTL_MS };
  await chrome.storage.local.set({ [STORAGE_KEY]: record });
}

export async function clearKey(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}
