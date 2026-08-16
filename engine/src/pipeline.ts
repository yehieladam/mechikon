/**
 * Detection pipeline — orchestrates the deterministic recognizers into a single anonymize call.
 * Framework-free, so the Web Worker (web) and the extension both reuse it unchanged. NER is added
 * separately (it is async + needs the model): `anonymizeFull` merges NER spans when available.
 */
import type { AnonymizeResult, EntityType, Recognizer, Span } from "./types";
import { resolveOverlaps, resolveOverlapsPreservingRemainders } from "./resolve";
import { completeOccurrences } from "./occurrences";
import { anonymize } from "./anonymize";
import { normalizeForDetection, mapShadowSpan } from "./normalize";
import { manualSpans, type ManualInput } from "./manual";
import { israeliIdRecognizer } from "./recognizers/israeliId";
import { israeliPhoneRecognizer } from "./recognizers/israeliPhone";
import { israeliCompanyRecognizer } from "./recognizers/israeliCompany";
import { labeledRecognizer } from "./recognizers/labeled";
import { israeliOrgRecognizer } from "./recognizers/israeliOrg";
import { israeliIbanRecognizer } from "./recognizers/israeliIban";
import { israeliCaseRecognizer } from "./recognizers/israeliCase";
import { israeliLandRecognizer } from "./recognizers/israeliLand";
import { israeliPolicyRecognizer } from "./recognizers/israeliPolicy";
import { israeliInsuredRecognizer } from "./recognizers/israeliInsured";
import { emailRecognizer } from "./recognizers/email";
import { creditCardRecognizer } from "./recognizers/creditCard";
import { usSsnRecognizer } from "./recognizers/usSsn";
import { usPhoneRecognizer } from "./recognizers/usPhone";

/** All deterministic (regex + checksum / context) recognizers — never the NER model (hard rule 1). */
export const DETERMINISTIC_RECOGNIZERS: readonly Recognizer[] = [
  israeliIdRecognizer,
  israeliCompanyRecognizer,
  labeledRecognizer,
  israeliIbanRecognizer,
  israeliPhoneRecognizer,
  israeliCaseRecognizer,
  israeliLandRecognizer,
  israeliPolicyRecognizer,
  israeliInsuredRecognizer,
  emailRecognizer,
  israeliOrgRecognizer,
  // International (deterministic, validated) — shared by web + extension.
  creditCardRecognizer,
  usSsnRecognizer,
  usPhoneRecognizer,
];

/**
 * Run every deterministic recognizer and return the raw (possibly overlapping) spans.
 *
 * Recognizers run on a NORMALIZED shadow (invisible bidi/format marks stripped, digit variants folded)
 * so a value split by an embedded RLM / written in fullwidth digits is still found (B1 + L2); spans map
 * back to EXACT original offsets, so the original text (and its tokenized positions) is never mutated.
 * When nothing normalizes (the common case), the shadow equals the text and we skip the mapping.
 */
export function detectDeterministic(text: string): Span[] {
  const { shadow, map } = normalizeForDetection(text);
  const rawSpans = DETERMINISTIC_RECOGNIZERS.flatMap((recognizer) => recognizer.recognize(shadow));
  if (shadow === text) {
    return rawSpans;
  }
  return rawSpans.map((span) => {
    const { start, end } = mapShadowSpan(map, span.start, span.end, text.length);
    return { ...span, start, end };
  });
}

/**
 * Deterministic-only anonymize: detect → complete occurrences → resolve → anonymize. Instant (no model).
 * Occurrence-completion matters here too: a label-gated value (passport/bar/checksum-invalid id/company) is
 * detected only AT its label, so a second occurrence WITHOUT the label would otherwise survive — and on a
 * path without completion (docx/xlsx) that survivor trips the output leak-scan and refuses the file. Redact
 * every whole-word occurrence of each detected value so a repeat is covered, exactly like anonymizeWith.
 */
export function anonymizeDeterministic(text: string): AnonymizeResult {
  const base = resolveOverlaps(detectDeterministic(text));
  const completed = completeOccurrences(text, base);
  return anonymize(text, resolveOverlaps([...base, ...completed]));
}

/**
 * Full anonymize: deterministic spans + already-computed NER spans, resolved together (deterministic
 * outranks NER via PRIORITY) then anonymized. Callers run NER (async) and pass its spans in.
 */
export function anonymizeFull(text: string, nerSpans: readonly Span[]): AnonymizeResult {
  return anonymizeWith(text, nerSpans);
}

/**
 * Deterministic detection PLUS any caller-supplied spans (NER, and/or manual user terms), resolved
 * together and anonymized. Manual spans (PRIORITY 4) win overlaps; deterministic outranks NER.
 *
 * `excluded` holds surface values the user chose to REVEAL (un-redact a false-positive auto detection,
 * e.g. a bank name mis-tagged as a location). Any AUTOMATIC span whose exact value is excluded is
 * dropped before + after occurrence-completion, so it never re-appears. A MANUAL term is never excluded
 * (an explicit human choice always wins).
 *
 * `disabledTypes` holds entity CATEGORIES the user chose NOT to redact (the category-control layer that
 * sits below automatic detection). Any AUTOMATIC span of a disabled type is dropped at the same points as
 * an excluded value, so those values are never tokenized and never enter the key. A MANUAL term is never
 * disabled (an explicit human choice always wins) even if its underlying type were listed.
 */
export function anonymizeWith(
  text: string,
  extraSpans: readonly Span[],
  excluded: readonly string[] = [],
  disabledTypes: readonly EntityType[] = [],
): AnonymizeResult {
  const excludedSet = new Set(excluded);
  const disabledSet = new Set(disabledTypes);
  // A span drops out of redaction if the user revealed its exact value OR disabled its category. MANUAL is
  // immune to both — an explicit human choice always wins. Same predicate is applied at every filter point
  // below so a dropped span can never be resurrected by occurrence-completion or remainder synthesis.
  const isDropped = (span: Span): boolean =>
    span.type !== "MANUAL" &&
    (excludedSet.has(text.slice(span.start, span.end)) || disabledSet.has(span.type));
  // Preserve remainders (H-manual): a shorter high-priority span (a manual term) overlapping a longer NER
  // name must not erase the name's other words. Winners are identical to resolveOverlaps; only the
  // non-overlapping remainder of a dropped span is added back.
  // Re-filter the resolved set through isDropped: resolveOverlapsPreservingRemainders can synthesize a
  // remainder from a non-dropped parent whose surface value IS excluded (a revealed word that is the tail
  // of an overlapped name), and that remainder would otherwise be re-redacted despite the user's reveal.
  const base = resolveOverlapsPreservingRemainders(
    text,
    [...detectDeterministic(text), ...extraSpans].filter((span) => !isDropped(span)),
  ).filter((span) => !isDropped(span));
  // Redact every whole-word occurrence of each confirmed value, not only the tagged ones — otherwise a
  // name NER caught in one place but missed in another (or tagged only half of) leaks the rest.
  const completed = completeOccurrences(text, base).filter((span) => !isDropped(span));
  const resolved = resolveOverlaps([...base, ...completed]);
  return anonymize(text, resolved);
}

/**
 * MANUAL-ONLY anonymize: redact ONLY the user's chosen terms — NO automatic detection (no
 * deterministic recognizers, no NER). For users who want full control and zero over-redaction, and it
 * needs no model, so it is instant. `manualSpans` already covers every occurrence of each term, so no
 * occurrence-completion pass is needed.
 */
export function anonymizeManualOnly(
  text: string,
  terms: readonly ManualInput[],
): AnonymizeResult {
  return anonymize(text, resolveOverlaps(manualSpans(text, terms)));
}
