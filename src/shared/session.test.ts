/**
 * RedactSession — the inline session over the real engine. Proves token consistency across
 * successive redactions, manual terms, NER span passthrough, and a byte-exact restore round-trip.
 * chrome.storage is faked so the fire-and-forget persist inside redact() doesn't throw.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { Span } from "@engine/types";
import { RedactSession } from "./session";

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

describe("RedactSession", () => {
  it("redacts a phone and restores it byte-for-byte", () => {
    const session = new RedactSession();
    const { text, newRows } = session.redact("צור קשר 050-1234567");
    expect(text).toContain("[PHONE_1]");
    expect(newRows).toHaveLength(1);
    expect(session.restore(text).text).toBe("צור קשר 050-1234567");
  });

  it("maps the same value to the same token across occurrences", () => {
    const session = new RedactSession();
    const { text } = session.redact("050-1234567 וגם 050-1234567");
    expect(text).toBe("[PHONE_1] וגם [PHONE_1]");
  });

  it("continues numbering for a new value in a second redact pass", () => {
    const session = new RedactSession();
    const first = session.redact("טלפון 050-1234567");
    const second = session.redact(`${first.text} ועוד 052-7654321`);
    expect(second.text).toContain("[PHONE_2]");
    const restored = session.restore(second.text).text;
    expect(restored).toContain("050-1234567");
    expect(restored).toContain("052-7654321");
  });

  it("redacts a manual term the automatic engine would miss", () => {
    const session = new RedactSession();
    session.addManualTerm("פרויקט הנץ");
    const { text } = session.redact("המסמך על פרויקט הנץ סודי");
    expect(text).toContain("[TERM_1]");
    expect(session.restore(text).text).toBe("המסמך על פרויקט הנץ סודי");
  });

  it("accepts NER spans as extra redactions", () => {
    const session = new RedactSession();
    const text = "דוד כהן הגיע";
    const nerSpans: Span[] = [{ start: 0, end: 7, type: "PERSON", score: 0.99 }];
    const { text: redacted } = session.redact(text, nerSpans);
    expect(redacted).toContain("[NAME_1]");
    expect(session.restore(redacted).text).toBe(text);
  });

  it("never reuses a token index for a different value after the first was edited out (restore stays correct)", () => {
    const session = new RedactSession();
    const first = session.redact("טלפון 050-1234567");
    expect(first.text).toContain("[PHONE_1]");
    // The user deleted the token, then redacts a DIFFERENT phone in fresh text with no [PHONE_1] present.
    const second = session.redact("טלפון 052-7654321");
    expect(second.text).toContain("[PHONE_2]"); // must NOT collide on [PHONE_1]
    expect(second.text).not.toContain("[PHONE_1]");
    // Both originals restore correctly — no silent corruption.
    expect(session.restore(second.text).text).toBe("טלפון 052-7654321");
    expect(session.restore("[PHONE_1]").text).toBe("050-1234567");
  });

  it("redactNerValues masks the given values in the current text", () => {
    const session = new RedactSession();
    const { text, newRows } = session.redactNerValues("דוד כהן הגיע עם דוד כהן", [
      { value: "דוד כהן", type: "PERSON" },
    ]);
    expect(newRows).toHaveLength(1);
    expect(text).toBe("[NAME_1] הגיע עם [NAME_1]");
  });

  it("redactManualValue masks ONLY the selected value, leaving other PII untouched", () => {
    const session = new RedactSession();
    const { text, newRows } = session.redactManualValue('דוד כהן ת"ז 040493384', "דוד כהן");
    expect(newRows).toHaveLength(1);
    expect(text).toContain("[TERM_1]");
    expect(text).toContain("040493384"); // the ID is NOT auto-redacted in manual-only mode
  });

  it("shares the key across sessions: a second session restores the first's tokens (cross-surface)", async () => {
    const chat = new RedactSession();
    const { text } = chat.redact("טלפון 050-1234567"); // [PHONE_1], persisted to the shared store
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the fire-and-forget save flush
    const popup = new RedactSession();
    await popup.hydrate();
    expect(popup.hasKey).toBe(true);
    expect(popup.restore(text).text).toBe("טלפון 050-1234567");
  });

  it("does not re-mint a token that already sits in the text (pasted from another surface)", () => {
    const session = new RedactSession();
    // Text already contains [PHONE_1] (from elsewhere); redacting a NEW phone must not reuse index 1.
    const { text } = session.redact("קודם [PHONE_1] ועכשיו 050-1234567");
    expect(text).toContain("[PHONE_2]");
    expect(session.restore(text).text).toContain("050-1234567");
  });

  it("reports no key until something is redacted", () => {
    const session = new RedactSession();
    expect(session.hasKey).toBe(false);
    session.redact("050-1234567");
    expect(session.hasKey).toBe(true);
  });
});
