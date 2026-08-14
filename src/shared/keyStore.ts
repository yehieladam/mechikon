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

/** Merge into the stored key (union by placeholder, keeping the existing mapping on conflict) so a
 *  save from one surface never drops rows another surface added — the fire-and-forget overwrite would
 *  otherwise lose them. Refreshes the sliding 24h expiry. */
export async function saveKey(rows: KeyRow[]): Promise<void> {
  const existing = await loadKey();
  const byPlaceholder = new Map(existing.map((row) => [row.placeholder, row]));
  for (const row of rows) {
    if (!byPlaceholder.has(row.placeholder)) {
      byPlaceholder.set(row.placeholder, row);
    }
  }
  const record: StoredKey = {
    version: STORAGE_KEY,
    rows: [...byPlaceholder.values()],
    expiresAt: Date.now() + TTL_MS,
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: record });
}

export async function clearKey(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}
