/**
 * categories — family/type mapping, localStorage persistence (with validation), and toggle math.
 * Runs under the "node" vitest env, so localStorage is stubbed in-memory per test.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { EntityType } from "@engine/types";
import {
  FAMILY_TYPES,
  familyOf,
  isFamilyDisabled,
  readDisabledTypes,
  toggleFamily,
  writeDisabledTypes,
} from "./categories";

const STORAGE_KEY = "mechikon.disabledCategories";

/** Minimal in-memory localStorage so the persistence functions have a real backing store to hit. */
function installLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  const mock = {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => void store.set(key, value),
    removeItem: (key: string): void => void store.delete(key),
    clear: (): void => store.clear(),
    key: (): string | null => null,
    length: 0,
  };
  Object.defineProperty(globalThis, "localStorage", { value: mock, configurable: true, writable: true });
  return store;
}

describe("familyOf", () => {
  it("maps every member type to its family and MANUAL to null", () => {
    expect(familyOf("ISRAELI_ID")).toBe("identifiers");
    expect(familyOf("IL_CASE")).toBe("financial");
    expect(familyOf("PERSON")).toBe("people");
    expect(familyOf("ORGANIZATION")).toBe("places");
    expect(familyOf("EMAIL_ADDRESS")).toBe("contact");
    expect(familyOf("IL_NUMBER")).toBe("numbers");
    expect(familyOf("MANUAL")).toBeNull();
  });

  it("never places MANUAL in any family", () => {
    const allMembers = Object.values(FAMILY_TYPES).flat();
    expect(allMembers).not.toContain("MANUAL");
  });
});

describe("persistence", () => {
  beforeEach(() => installLocalStorage());

  it("defaults to an empty disabled set (opt-out: everything redacted)", () => {
    expect(readDisabledTypes()).toEqual([]);
  });

  it("round-trips a written set", () => {
    writeDisabledTypes(["IL_PHONE", "EMAIL_ADDRESS"]);
    expect(new Set(readDisabledTypes())).toEqual(new Set<EntityType>(["IL_PHONE", "EMAIL_ADDRESS"]));
  });

  it("drops unknown / corrupted values rather than propagating them", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(["IL_PHONE", "NOT_A_TYPE", 42, null]));
    expect(readDisabledTypes()).toEqual(["IL_PHONE"]);
  });

  it("drops MANUAL even if it was persisted (never disableable)", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(["MANUAL", "PERSON"]));
    expect(readDisabledTypes()).toEqual(["PERSON"]);
  });

  it("returns empty on non-array or malformed JSON", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    expect(readDisabledTypes()).toEqual([]);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ a: 1 }));
    expect(readDisabledTypes()).toEqual([]);
  });
});

describe("toggleFamily", () => {
  it("disables every member type when the family is currently enabled", () => {
    const next = toggleFamily([], "identifiers");
    expect(new Set(next)).toEqual(new Set<EntityType>(["ISRAELI_ID", "IL_COMPANY"]));
  });

  it("re-enables the whole family when every member is already disabled", () => {
    const next = toggleFamily(["ISRAELI_ID", "IL_COMPANY"], "identifiers");
    expect(next).toEqual([]);
  });

  it("disables a partially-disabled family fully (any-enabled -> all-disabled)", () => {
    const next = toggleFamily(["ISRAELI_ID"], "identifiers");
    expect(new Set(next)).toEqual(new Set<EntityType>(["ISRAELI_ID", "IL_COMPANY"]));
  });

  it("does not mutate the input array", () => {
    const input: readonly EntityType[] = ["PERSON"];
    const before = [...input];
    toggleFamily(input, "identifiers");
    expect(input).toEqual(before);
  });

  it("leaves other families untouched", () => {
    const next = toggleFamily(["PERSON"], "contact");
    expect(next).toContain("PERSON");
    expect(new Set(next)).toEqual(new Set<EntityType>(["PERSON", "IL_PHONE", "EMAIL_ADDRESS"]));
  });
});

describe("isFamilyDisabled", () => {
  it("is true only when every member type is disabled", () => {
    expect(isFamilyDisabled(["ISRAELI_ID"], "identifiers")).toBe(false);
    expect(isFamilyDisabled(["ISRAELI_ID", "IL_COMPANY"], "identifiers")).toBe(true);
    expect(isFamilyDisabled(["PERSON"], "people")).toBe(true);
  });
});
