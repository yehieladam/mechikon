import { describe, expect, it } from "vitest";
import { israeliOrgRecognizer } from "./israeliOrg";

/** The org surface strings the recognizer flagged in `text`. */
function orgs(text: string): string[] {
  return israeliOrgRecognizer.recognize(text).map((span) => text.slice(span.start, span.end));
}

describe("israeliOrgRecognizer (private-org booster, suffix-anchored)", () => {
  it("flags a multi-word company name ending in בע״מ", () => {
    expect(orgs('אורלייט טכנולוגיות בע"מ הגישה')).toEqual(['אורלייט טכנולוגיות בע"מ']);
  });

  it("flags a single-word company and stops at the preceding stopword (נגד)", () => {
    expect(orgs("התובע נגד פלאפון בע\"מ")).toEqual(['פלאפון בע"מ']);
  });

  it("stops at a colon boundary, not swallowing the role word before it", () => {
    // "הנתבעת: אורלייט בע״מ" → the name only, never "הנתבעת".
    expect(orgs('הנתבעת: אורלייט בע"מ')).toEqual(['אורלייט בע"מ']);
  });

  it("does NOT swallow a trailing verb (suffix is a hard right anchor)", () => {
    expect(orgs('בנק הפועלים בע"מ אישר את הבקשה')).toEqual(['בנק הפועלים בע"מ']);
  });

  it("flags a registered amuta (ע״ר)", () => {
    expect(orgs('עמותת לתת ע"ר פעלה')).toEqual(['עמותת לתת ע"ר']);
  });

  it("does NOT flag public bodies (no private suffix)", () => {
    for (const text of ["משרד הבריאות פרסם", "עיריית תל אביב אישרה", "בית משפט השלום דן", "רשות המסים"]) {
      expect(orgs(text)).toEqual([]);
    }
  });

  it("does NOT flag a bare/generic suffix with no name", () => {
    expect(orgs('חברה בע"מ אחת')).toEqual([]);
    expect(orgs('התאגדה כ בע"מ')).toEqual([]);
  });

  it("does not cross a newline into the previous line", () => {
    expect(orgs('שורה ראשונה\nאורלייט בע"מ')).toEqual(['אורלייט בע"מ']);
  });

  it("drops a leading clause-opening verb / connective (no punctuation before the name)", () => {
    expect(orgs('לפיכך פנתה אורלייט בע"מ לבית המשפט')).toEqual(['אורלייט בע"מ']);
    expect(orgs('הודיעה חברת פלאפון בע"מ כי')).toEqual(['חברת פלאפון בע"מ']);
  });

  it("does NOT flag a generic 'company' even with a prefix (ה/ל/מ)", () => {
    for (const text of ['החברה בע"מ התחייבה', 'לחברה בע"מ אין רישיון', 'מהחברה בע"מ נדרש תשלום', 'מדובר בחברה בע"מ']) {
      expect(orgs(text)).toEqual([]);
    }
  });

  it("keeps a real name that CONTAINS the word חברה (not entirely generic)", () => {
    expect(orgs('מגדל חברה לביטוח בע"מ שילמה')).toEqual(['מגדל חברה לביטוח בע"מ']);
  });
});
