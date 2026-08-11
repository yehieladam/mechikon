/**
 * Private-organization booster (ORGANIZATION) — deterministic, structural cue only, no NER.
 *
 * The neural NER model is the primary org detector, but ORGANIZATION is its documented weak spot
 * (~72% recall vs ~95% for PERSON). This recognizer covers the structurally-marked PRIVATE entities the
 * model most often misses in legal documents — companies and non-profits — WITHOUT touching public bodies
 * (ministries, municipalities, courts): those carry no privacy value and redacting them only hurts
 * readability (owner decision). It complements the model; resolve.ts merges the overlap.
 *
 * Cue: a corporate SUFFIX token — "בע״מ" (Ltd) or "ע״ר" (registered amuta) — is a HARD right anchor. We
 * walk LEFT from it over space-joined name words to the boundary and flag "<name> בע״מ" as the org. Only
 * the suffix form is used: a prefix like "בנק <name>" has no reliable right boundary (it would swallow the
 * following verb, "בנק לאומי סירב"), so that is left to the model + manual-add rather than risk over-
 * redaction. Precision over recall.
 *
 * The left walk stops at punctuation (comma, colon, newline, digit, paren, period — anything that is not a
 * plain space between two name words) AND at a STOPWORD set of litigation lead-ins (נגד, הנתבעת, בשם …), so
 * "נגד אורלייט בע״מ" captures "אורלייט בע״מ", never the verb before it. A bare suffix with no name is skipped.
 */
import type { Recognizer, Span } from "../types";

/** A name word: a Hebrew or Latin letter run, keeping internal geresh/gershayim/hyphen (בן-גוריון, עו״ד). */
const NAME_WORD = /^[A-Za-zא-ת][A-Za-zא-ת'׳"״־-]*$/;

/**
 * Words that can abut a name with only a space yet are NOT part of it, so the left walk must stop at them.
 * Two kinds: (a) prepositions / function words and litigation lead-ins, (b) the frequent clause-opening
 * verbs of a legal document ("הגישה/הודיעה/טענה … <שם הנתבעת>"). This is a lexicon band-aid, not a full
 * verb list — Hebrew has no capitalization to mark a proper noun, so a rare verb before a name can still be
 * swallowed; that is over-redaction (a readability cost), never a leak, and the model is the primary org
 * detector. The common openers below cover the bulk of real filings.
 */
const STOP = new Set([
  // Prepositions / connectives / litigation lead-ins
  "נגד", "כנגד", "וכנגד", "של", "את", "עם", "בין", "לבין", "מול", "כלפי", "אצל", "לפי", "בגין", "בעניין",
  "התובע", "התובעת", "התובעים", "הנתבע", "הנתבעת", "הנתבעים", "בשם", "מטעם", "ידי", "וכן", "וגם",
  "אל", "על", "אשר", "כי", "היא", "הוא", "זו", "זה", "לפיכך", "לכן", "ולכן", "משכך", "ומשכך", "לאור",
  "בהתאם", "כאמור", "מאחר", "הואיל", "אולם", "ברם", "כאשר", "כמו", "ואילו", "וכ", "כן",
  // Frequent clause-opening verbs (fem/masc/plural) — the subject org follows them
  "הגיש", "הגישה", "הגישו", "הודיע", "הודיעה", "הודיעו", "פנה", "פנתה", "פנו", "טען", "טענה", "טענו",
  "שילם", "שילמה", "שילמו", "ביקש", "ביקשה", "ביקשו", "דרש", "דרשה", "דרשו", "רכש", "רכשה", "רכשו",
  "מכר", "מכרה", "מכרו", "התחייב", "התחייבה", "סירב", "סירבה", "אישר", "אישרה", "הסכים", "הסכימה",
  "קבע", "קבעה", "חתם", "חתמה", "הצהיר", "הצהירה", "קיבל", "קיבלה", "מדובר", "נמסר", "נטען", "נחתם", "נקבע",
]);

/** Generic "company/entity" words (with the common ה/ב/ל/מ/ו prefixes). A captured run that is ENTIRELY
 *  generic ("החברה בע״מ") is not a named org — skip it — but the same word INSIDE a longer name
 *  ("מגדל חברה לביטוח בע״מ") is legitimate, so this is a post-check, not a mid-walk stop. */
const GENERIC = new Set([
  "חברה", "החברה", "בחברה", "לחברה", "מחברה", "מהחברה", "וחברה",
  "תאגיד", "התאגיד", "עסק", "העסק", "הגוף", "הצד", "הצדדים",
]);

/** Ltd / amuta suffix as a standalone token: בע״מ (any geresh/gershayim, or none) or ע״ר. */
const SUFFIX = /(?<![A-Za-zא-ת])(?:בע["'׳״]?מ|ע["'׳״]ר)(?![A-Za-zא-ת])/g;

const MAX_WORDS = 4;
/** How far left of the suffix to consider (a few words of Hebrew). */
const LOOKBACK = 80;

/** Split a slice into [word, absoluteStart] tokens (letter runs only; punctuation/space are separators). */
function tokenize(text: string, from: number, to: number): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const re = /[A-Za-zא-ת][A-Za-zא-ת'׳"״־-]*/g;
  const slice = text.slice(from, to);
  for (const m of slice.matchAll(re)) {
    out.push([m[0], from + m.index]);
  }
  return out;
}

/** True if only spaces/tabs separate the two offsets (a name stays one org; a newline/comma breaks it). */
function joinedBySpace(text: string, gapStart: number, gapEnd: number): boolean {
  if (gapEnd <= gapStart) return true;
  return /^[ \t]+$/.test(text.slice(gapStart, gapEnd));
}

/** Flags "<name> בע״מ" / "<name> ע״ר" private-organization mentions (suffix-anchored, left-bounded). */
export const israeliOrgRecognizer: Recognizer = {
  name: "IsraeliOrgRecognizer",
  entity: "ORGANIZATION",
  recognize(text: string): readonly Span[] {
    const spans: Span[] = [];
    for (const suffix of text.matchAll(SUFFIX)) {
      const suffixStart = suffix.index;
      const suffixEnd = suffixStart + suffix[0].length;
      const words = tokenize(text, Math.max(0, suffixStart - LOOKBACK), suffixStart);
      let start = suffixStart;
      let prevStart = suffixStart;
      const taken: string[] = [];
      for (let i = words.length - 1; i >= 0 && taken.length < MAX_WORDS; i -= 1) {
        const [word, wordStart] = words[i];
        const wordEnd = wordStart + word.length;
        // A single-letter token is a preposition/initial (כ, ו, ל, ב), never an org-name anchor — stop.
        if (
          !joinedBySpace(text, wordEnd, prevStart) ||
          !NAME_WORD.test(word) ||
          STOP.has(word) ||
          word.length === 1
        ) {
          break;
        }
        start = wordStart;
        prevStart = wordStart;
        taken.unshift(word);
      }
      // Require at least one name word before the suffix, and reject a run that is ENTIRELY generic
      // ("החברה בע״מ") — that is not a named organization.
      if (taken.length > 0 && !taken.every((word) => GENERIC.has(word))) {
        spans.push({ start, end: suffixEnd, type: "ORGANIZATION", score: 0.9 });
      }
    }
    return spans;
  },
};
