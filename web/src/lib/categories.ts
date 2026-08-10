/**
 * Category-control layer — groups the 14 engine EntityTypes into 6 toggleable color FAMILIES (plus MANUAL,
 * which is never toggleable). The user disables families they do not want redacted; the disabled set is
 * persisted and threaded into the engine as `disabledTypes`. Framework-free (no React) so it stays unit-
 * testable and reusable. Colors are 3 base hues x 2 shades — see tailwind.config.js `cat-*` tokens.
 */
import type { EntityType } from "@engine/types";

/** The six toggleable families. MANUAL has no family (it is always redacted, never a toggle). */
export type CategoryFamily =
  | "identifiers"
  | "financial"
  | "people"
  | "places"
  | "contact"
  | "numbers";

/** Family -> its member EntityTypes. MANUAL is intentionally absent (never toggleable). */
export const FAMILY_TYPES: Readonly<Record<CategoryFamily, readonly EntityType[]>> = {
  identifiers: ["ISRAELI_ID", "IL_COMPANY"],
  financial: ["IL_IBAN", "IL_POLICY", "IL_INSURED", "IL_CASE", "IL_LAND"],
  people: ["PERSON"],
  places: ["LOCATION", "ORGANIZATION"],
  contact: ["IL_PHONE", "EMAIL_ADDRESS"],
  numbers: ["IL_NUMBER"],
};

/** Display order of the families in the legend (most sensitive first). */
export const FAMILY_ORDER: readonly CategoryFamily[] = [
  "identifiers",
  "financial",
  "people",
  "places",
  "contact",
  "numbers",
];

const TYPE_TO_FAMILY: ReadonlyMap<EntityType, CategoryFamily> = new Map(
  (Object.entries(FAMILY_TYPES) as [CategoryFamily, readonly EntityType[]][]).flatMap(
    ([family, types]) => types.map((type) => [type, family] as const),
  ),
);

/** The family an EntityType belongs to, or null for MANUAL (which has no toggleable family). */
export function familyOf(type: EntityType): CategoryFamily | null {
  return TYPE_TO_FAMILY.get(type) ?? null;
}

/**
 * Family -> Tailwind pill classes. STATIC string literals only (no interpolation) so Tailwind's JIT scanner
 * keeps the classes. The family is conveyed by the BACKGROUND tint (3 base hues x 2 shades: rose = hard
 * identifiers, blue = who/where, teal = contact & loose numbers); the text stays near-black `text-ink`.
 * This is deliberate for accessibility: the result panel fades in (opacity animation), so an axe scan can
 * land mid-transition — near-black text keeps a passing contrast ratio against every tint even at partial
 * opacity, whereas a colored foreground goes marginal. All tint backgrounds clear AA with ink text (>=10:1
 * at full opacity). MANUAL keeps its own amber pill and never uses these.
 */
export const FAMILY_PILL_CLASS: Readonly<Record<CategoryFamily, string>> = {
  identifiers: "bg-cat-rose-dark-bg text-ink",
  financial: "bg-cat-rose-light-bg text-ink",
  people: "bg-cat-blue-dark-bg text-ink",
  places: "bg-cat-blue-light-bg text-ink",
  contact: "bg-cat-teal-dark-bg text-ink",
  numbers: "bg-cat-teal-light-bg text-ink",
};

/** Family -> swatch background class (the small color chip beside each legend label). */
export const FAMILY_SWATCH_CLASS: Readonly<Record<CategoryFamily, string>> = {
  identifiers: "bg-cat-rose-dark-bg",
  financial: "bg-cat-rose-light-bg",
  people: "bg-cat-blue-dark-bg",
  places: "bg-cat-blue-light-bg",
  contact: "bg-cat-teal-dark-bg",
  numbers: "bg-cat-teal-light-bg",
};

/** Family -> its i18n label key. */
export const FAMILY_LABEL_KEY: Readonly<Record<CategoryFamily, string>> = {
  identifiers: "category.familyIdentifiers",
  financial: "category.familyFinancial",
  people: "category.familyPeople",
  places: "category.familyPlaces",
  contact: "category.familyContact",
  numbers: "category.familyNumbers",
};

const DISABLED_CATEGORIES_KEY = "mechikon.disabledCategories";

/**
 * Read the persisted disabled-categories set. Default is EMPTY (opt-out): everything is redacted, exactly
 * as before this feature. Never trusts storage blindly — parses JSON and keeps only values that map to a
 * real toggleable family (`familyOf` returns null for MANUAL and for any unknown/renamed type), so a
 * corrupted, stale, or MANUAL value can never weaken the engine filter. Validating against the family map
 * (the single source of truth) means a newly-added family member is accepted automatically — no parallel
 * allow-list to keep in sync.
 */
export function readDisabledTypes(): readonly EntityType[] {
  try {
    const raw = localStorage.getItem(DISABLED_CATEGORIES_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (value): value is EntityType =>
        typeof value === "string" && familyOf(value as EntityType) !== null,
    );
  } catch {
    return [];
  }
}

/** Persist the disabled-categories set so the choice survives reloads and applies to the next document. */
export function writeDisabledTypes(types: readonly EntityType[]): void {
  try {
    localStorage.setItem(DISABLED_CATEGORIES_KEY, JSON.stringify(types));
  } catch {
    // Private mode / storage disabled — the toggle still works for this session.
  }
}

/**
 * Toggle a whole family in the disabled set. If ANY member type is currently enabled, the family flips to
 * fully disabled (all its types added); if every member is already disabled, the family flips back on (all
 * its types removed). Pure — returns a new array, never mutates the input. MANUAL is never a member, so it
 * can never be disabled through this path.
 */
export function toggleFamily(
  disabled: readonly EntityType[],
  family: CategoryFamily,
): readonly EntityType[] {
  const members = FAMILY_TYPES[family];
  const disabledSet = new Set(disabled);
  const fullyDisabled = members.every((type) => disabledSet.has(type));
  if (fullyDisabled) {
    for (const type of members) {
      disabledSet.delete(type);
    }
  } else {
    for (const type of members) {
      disabledSet.add(type);
    }
  }
  return [...disabledSet];
}

/** Whether every member type of a family is in the disabled set (the family reads as OFF in the legend). */
export function isFamilyDisabled(
  disabled: readonly EntityType[],
  family: CategoryFamily,
): boolean {
  const disabledSet = new Set(disabled);
  return FAMILY_TYPES[family].every((type) => disabledSet.has(type));
}
