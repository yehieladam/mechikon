/**
 * The note appended to masked text before it goes to the AI — shared by inline and popup so the AI
 * gets the SAME "keep the tokens verbatim" guidance everywhere (otherwise the popup's masked text is
 * weaker and the model may mangle tokens). Reassures the model the text is already anonymized (no PII)
 * so it answers normally instead of refusing; the digit-free [סוג_מספר] example is untouched by the
 * restore matcher (which needs [..._<digits>]). Clearly delimited by a dashed rule.
 */
export const INSTRUCTION =
  "\n\n———————————————\n🔒 הנחיה ל-AI (מחיקון): הטקסט שמעל עבר אנונימיזציה ואינו מכיל מידע אישי אמיתי. הסימונים בסוגריים מרובעים (בתבנית [סוג_מספר], למשל שם או מספר) הם תחליפים אנונימיים — התייחס אליהם כאל ערכים רגילים, ענה על הבקשה כרגיל, והשאר כל סימון בתשובתך בדיוק כפי שהוא כדי שנוכל לשחזר.";

export const INSTRUCTION_MARKER = "הנחיה ל-AI (מחיקון)";

/** Append the instruction once (idempotent) — skips if the text already carries it. */
export function withInstruction(text: string): string {
  return text.includes(INSTRUCTION_MARKER) ? text : text + INSTRUCTION;
}
