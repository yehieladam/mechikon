/**
 * Shared in-number separator sets, so the subtle "which whitespace may sit between digit groups" rule
 * lives in ONE place instead of being re-typed (and mis-typed) per recognizer.
 *
 * HWS is the horizontal-whitespace set and is deliberately a POSITIVE allow-list — space, tab, NBSP
 * (U+00A0), narrow-NBSP (U+202F), zero-width-NBSP (U+FEFF). It must NEVER be written as `\s` or as
 * `[^\S\n\r]`: both admit a LINE separator (\n \r \v \f, plus U+2028 LINE SEPARATOR and U+2029 PARAGRAPH
 * SEPARATOR) as an in-number separator, so a number at a line end swallows the next line's leading digit,
 * overflows its format, fails validation, and LEAKS unredacted. Word/PDF-exported Hebrew routinely inserts
 * NBSP / narrow-NBSP between number groups (a "keep-together" space), so those MUST stay separators — a
 * plain `[ \t]` drops them and the number fails to assemble. A positive list satisfies both constraints
 * and can never accidentally gain an exotic line break.
 *
 * The value is a raw fragment meant to be interpolated INSIDE a character class of a `new RegExp(...)`
 * source string, e.g. `` new RegExp(`\\d(?:[-${HWS}]?\\d)+`) ``.
 */
export const HWS = " \\t\\u00A0\\u202F\\uFEFF";
