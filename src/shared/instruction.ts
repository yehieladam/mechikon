/**
 * The note appended to masked text before it goes to the AI — shared by inline and popup so the AI
 * gets the SAME "keep the tokens verbatim" guidance everywhere (otherwise the popup's masked text is
 * weaker and the model may mangle tokens). Reassures the model the text is already anonymized (no PII)
 * so it answers normally instead of refusing; the digit-free [סוג_מספר]/[type_number] example is
 * untouched by the restore matcher (which needs [..._<digits>]). Clearly delimited by a dashed rule.
 *
 * Bilingual: the instruction MATCHES THE TEXT'S language so a Hebrew draft gets a Hebrew note and an
 * English draft an English one. Idempotency checks BOTH markers, so switching language (or re-running)
 * never stacks two instructions.
 */
import { defaultLang, detectLang, type Lang } from "./i18n";

const RULE = "\n\n———————————————\n";

const INSTRUCTION_HE =
  RULE +
  "🔒 הנחיה ל-AI (מחיקון): הטקסט שמעל עבר אנונימיזציה ואינו מכיל מידע אישי אמיתי. הסימונים בסוגריים מרובעים (בתבנית [סוג_מספר], למשל שם או מספר) הם תחליפים אנונימיים — התייחס אליהם כאל ערכים רגילים, ענה על הבקשה כרגיל, והשאר כל סימון בתשובתך בדיוק כפי שהוא כדי שנוכל לשחזר.";

const INSTRUCTION_EN =
  RULE +
  "🔒 Note to the AI (Mechikon): the text above has been anonymized and contains no real personal data. The bracketed tokens (in the form [type_number], e.g. a name or a number) are anonymous placeholders — treat them as ordinary values, answer the request normally, and keep every token in your reply exactly as-is so we can restore them.";

const MARKER_HE = "הנחיה ל-AI (מחיקון)";
const MARKER_EN = "Note to the AI (Mechikon)";

export const INSTRUCTION = INSTRUCTION_HE; // back-compat default (Hebrew-first product)
export const INSTRUCTION_MARKER = MARKER_HE;

/** True if the text already carries either language's instruction. */
function hasInstruction(text: string): boolean {
  return text.includes(MARKER_HE) || text.includes(MARKER_EN);
}

/** Append the instruction once (idempotent across both languages), in `lang`. */
export function withInstruction(text: string, lang: Lang = "he"): string {
  if (hasInstruction(text)) {
    return text;
  }
  return text + (lang === "en" ? INSTRUCTION_EN : INSTRUCTION_HE);
}

/** Remove an already-appended instruction block (from its dashed rule to the end), if present. */
export function stripInstruction(text: string): string {
  // The instruction always begins with the em-dash rule (see RULE) followed by the lock emoji.
  return text.replace(/\n*—{3,}[\s\S]*$/, "");
}

// Our placeholder tokens are Latin (e.g. [NAME_1]) — they must NOT count toward language detection,
// or a Hebrew message with several masked values would be misread as English once redacted.
const TOKEN_RE = /\[[A-Za-z]+_\d+\]/g;

/**
 * Language of the user's ACTUAL content: strips the appended instruction and our Latin tokens before
 * detecting, so neither the tokens nor a burned note can flip a Hebrew draft to English (or vice versa).
 * Use this everywhere the language of composer/redacted text is needed — never raw `detectLang` on
 * text that may already carry tokens or an instruction.
 */
export function detectTextLang(text: string, fallback: Lang = defaultLang()): Lang {
  return detectLang(stripInstruction(text).replace(TOKEN_RE, " "), fallback);
}
