/**
 * keyStore — persistence + sliding 24h expiry over a fake chrome.storage.local.
 * Verifies an expired record reads as empty AND is cleared, so a stale key never lingers.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { KeyRow } from "@engine/types";

let mem: Map<string, unknown>;

beforeEach(() => {
  mem = new Map<string, unknown>();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string) => (mem.has(key) ? { [key]: mem.get(key) } : {}),
        set: async (obj: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(obj)) {
            mem.set(k, v);
          }
        },
        remove: async (key: string) => {
          mem.delete(key);
        },
      },
    },
  };
});

const rows: KeyRow[] = [{ placeholder: "[ID_1]", original: "040493384", type: "ISRAELI_ID" }];

describe("keyStore", () => {
  it("round-trips saved rows", async () => {
    const { loadKey, saveKey } = await import("./keyStore");
    await saveKey(rows);
    expect(await loadKey()).toEqual(rows);
  });

  it("returns empty and clears the record when expired", async () => {
    const { loadKey } = await import("./keyStore");
    mem.set("sessionKey.v1", { version: "sessionKey.v1", rows, expiresAt: Date.now() - 1000 });
    expect(await loadKey()).toEqual([]);
    expect(mem.has("sessionKey.v1")).toBe(false);
  });

  it("returns empty when nothing is stored", async () => {
    const { loadKey } = await import("./keyStore");
    expect(await loadKey()).toEqual([]);
  });

  it("clearKey removes the record", async () => {
    const { loadKey, saveKey, clearKey } = await import("./keyStore");
    await saveKey(rows);
    await clearKey();
    expect(await loadKey()).toEqual([]);
  });
});
