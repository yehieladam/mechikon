/**
 * Live-restore setting: default OFF (privacy), round-trips through chrome.storage.local, and only a
 * literal `true` counts as enabled (a stray/legacy value is treated as off, never fail-open).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { loadLiveRestore, saveLiveRestore, LIVE_RESTORE_STORAGE_KEY } from "./settings";

beforeEach(() => {
  const mem = new Map<string, unknown>();
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

describe("live-restore setting", () => {
  it("defaults to OFF when nothing is stored", async () => {
    expect(await loadLiveRestore()).toBe(false);
  });

  it("round-trips an enabled value", async () => {
    await saveLiveRestore(true);
    expect(await loadLiveRestore()).toBe(true);
    await saveLiveRestore(false);
    expect(await loadLiveRestore()).toBe(false);
  });

  it("treats any non-true stored value as OFF (never fail-open)", async () => {
    await chrome.storage.local.set({ [LIVE_RESTORE_STORAGE_KEY]: "yes" });
    expect(await loadLiveRestore()).toBe(false);
  });
});
