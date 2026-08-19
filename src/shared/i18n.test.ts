import { describe, expect, test } from "vitest";
import { detectLang, t } from "./i18n";

describe("detectLang", () => {
  test("returns he for Hebrew-dominant text", () => {
    expect(detectLang("שלום קוראים לי דוד", "en")).toBe("he");
  });

  test("returns en for Latin-dominant text", () => {
    expect(detectLang("Hello my name is David", "he")).toBe("en");
  });

  test("falls back to the given default when there are no letters", () => {
    expect(detectLang("   123 !!! ", "en")).toBe("en");
    expect(detectLang("", "he")).toBe("he");
  });

  test("mixed text picks the script with more letters", () => {
    // more Hebrew letters than Latin -> he
    expect(detectLang("דוד כהן David", "en")).toBe("he");
    // more Latin letters than Hebrew -> en
    expect(detectLang("David Cohen כהן", "he")).toBe("en");
  });
});

describe("t", () => {
  test("returns plain strings per language", () => {
    expect(t("he", "btnHide")).toBe("הסתר");
    expect(t("en", "btnHide")).toBe("Hide");
  });

  test("interpolates parameters", () => {
    expect(t("he", "hiddenValue", { v: "דוד" })).toContain("דוד");
    expect(t("en", "hiddenValue", { v: "David" })).toBe("Hidden: David");
  });

  test("pluralizes English count messages", () => {
    expect(t("en", "detectedCount", { n: 1 })).toBe("1 sensitive item");
    expect(t("en", "detectedCount", { n: 3 })).toBe("3 sensitive items");
  });

  test("uses correct Hebrew singular grammar (not '1 X' with a plural noun/verb)", () => {
    expect(t("he", "detectedCount", { n: 1 })).toBe("פרט רגיש אחד");
    expect(t("he", "detectedCount", { n: 3 })).toBe("3 פרטים רגישים");

    expect(t("he", "protectedCount", { n: 1 })).toBe("מוגן · הוסתר פרט אחד");
    expect(t("he", "protectedCount", { n: 3 })).toBe("מוגן · 3 הוסתרו");

    expect(t("he", "hiddenWithInstruction", { n: 1 })).toBe("הוסתר פרט אחד · נוספה הנחיה");
    expect(t("he", "hiddenWithInstruction", { n: 3 })).toBe("הוסתרו 3 פרטים · נוספה הנחיה");

    expect(t("he", "alsoHidNames", { n: 1 })).toBe("הוסתר גם שם/ארגון אחד");
    expect(t("he", "alsoHidNames", { n: 3 })).toBe("הוסתרו גם 3 שמות/ארגונים");

    expect(t("he", "restoredPlaces", { n: 1 })).toBe("שוחזר במקום אחד");
    expect(t("he", "restoredPlaces", { n: 3 })).toBe("שוחזר ב-3 מקומות");
  });
});
