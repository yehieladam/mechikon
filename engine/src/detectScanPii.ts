/**
 * Scan-mode PII detection (OCR Stage 3 + 6) — the SEPARATE entrypoint for the scanned-PDF path. Pure and
 * framework-free (no mupdf/tesseract), consuming OCR words+bboxes rather than glyph quads, so the
 * scan-only relaxations here can NEVER leak into the digital-text path (structural isolation).
 *
 * THE UNIFIED SPAN SET (Stage 6, the invariant): one canonical typed span set over the OCR text drives
 * BOTH channels — the pixel rects AND the tokenized "Word for AI" text. So "the text hides everything the
 * pixels hide" is true by construction, not by discipline. Three contributors, merged + overlap-resolved:
 *   (A) STANDARD — the injected anonymize (NER names + deterministic valid-ID/phone) → typed char-spans.
 *   (B) DIGIT-RUN RELAX — 8-10-digit runs, checksum-optional, page-wide → `IL_NUMBER` ([NUM_N]),
 *       restorable to the OCR-read digits (over-redacted dates/amounts round-trip on restore).
 *   (C) LABEL-ANCHOR — a PII label (lexicon) + its value, typed by the label ([ID_N]/[NAME_N]/[PHONE_N]),
 *       content-blind (closes the all-1s-ID-read-as-letters case).
 * Overlaps resolve by PRIORITY (validated A/labeled C = 3 > generic B = 1), so a doubly-caught value is
 * ONE token. Boxes derive from the SAME spans (span char-range → covering words → union box). The caller
 * (redactScan) tokenizes the document-level concatenation of these spans via `anonymize` for one unified
 * key + numbering. See docs/ocr-calibration.md.
 */
import { PRIORITY, type AnonymizeResult, type EntityType, type Span } from "./types";
import type { OcrBox, OcrPageResult, OcrWord } from "./ocrTypes";
import { buildOcrText, unionRect, wordsForRange, type WordRange } from "./ocrMap";
import { HWS } from "./recognizers/separators";

/** Thrown when a detection span maps to zero word boxes — a PII we cannot locate to redact. */
export const SCAN_UNMAPPABLE_PII = "SCAN_UNMAPPABLE_PII";

/** Injected detector: standard anonymize over the OCR text (deterministic, plus NER when loaded). */
export type Anonymize = (text: string) => AnonymizeResult | Promise<AnonymizeResult>;

/** Per-page detection: the pixel boxes, the unified typed spans over `text`, and this page's OCR text.
 * redactScan redacts `boxes` per page and concatenates (`text`, shifted `spans`) for the document key. */
export interface ScanDetection {
  readonly boxes: readonly OcrBox[];
  readonly spans: readonly Span[];
  readonly text: string;
}

// --- (C) label lexicon (each label typed so the anchored value tokenizes as the right entity) --------

const LABELS: ReadonlyArray<{ readonly text: string; readonly type: EntityType }> = [
  { text: "שם", type: "PERSON" }, { text: "שם הלקוח", type: "PERSON" }, { text: "שם המבקש", type: "PERSON" },
  { text: "שם מלא", type: "PERSON" }, { text: "שם התובע", type: "PERSON" }, { text: "שם הנתבע", type: "PERSON" },
  { text: 'תעודת זהות', type: "ISRAELI_ID" }, { text: 'ת"ז', type: "ISRAELI_ID" }, { text: "ת.ז", type: "ISRAELI_ID" },
  { text: "מספר זהות", type: "ISRAELI_ID" }, { text: "מס' זהות", type: "ISRAELI_ID" }, { text: "מ.ז", type: "ISRAELI_ID" },
  { text: "טלפון", type: "IL_PHONE" }, { text: "טל'", type: "IL_PHONE" }, { text: "נייד", type: "IL_PHONE" },
  { text: "פלאפון", type: "IL_PHONE" }, { text: "פקס", type: "IL_PHONE" }, { text: "מס' טלפון", type: "IL_PHONE" },
];
const LABEL_MAX_WORDS = 2;
const VALUE_MAX_WORDS = 3;
const GAP_FACTOR = 1.5;

function stripBidi(text: string): string {
  return text.replace(/[‎‏‪-‮⁦-⁩]/g, "");
}
const norm = (text: string): string => stripBidi(text.normalize("NFC")).trim();
const noSpace = (text: string): string => norm(text).replace(/\s+/g, "");
const LABEL_KEYS: ReadonlyArray<{ readonly key: string; readonly type: EntityType }> = LABELS.map((l) => ({
  key: noSpace(l.text),
  type: l.type,
}));

/** If the token starts with a label key and carries extra content, the merged label+value type. */
function mergedLabelType(tokenText: string): EntityType | null {
  const t = noSpace(tokenText);
  return LABEL_KEYS.find((l) => t.length > l.key.length && t.startsWith(l.key))?.type ?? null;
}
/** If the (single- or multi-word) text IS a label (allowing a trailing colon), its type. */
function exactLabelType(text: string): EntityType | null {
  const t = noSpace(text).replace(/:$/, "");
  return LABEL_KEYS.find((l) => l.key === t)?.type ?? null;
}
const looksLikeLabel = (text: string): boolean => exactLabelType(text) !== null || mergedLabelType(text) !== null;

// --- geometry (image-pixel space) --------------------------------------------------------------------

const boxHeight = (b: OcrBox): number => b.y1 - b.y0;
function sameLine(a: OcrBox, b: OcrBox): boolean {
  const overlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return overlap > 0.5 * Math.min(boxHeight(a), boxHeight(b));
}
function horizontalGap(a: OcrBox, b: OcrBox): number {
  return Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1));
}
const nonEmpty = (word: OcrWord | undefined): boolean => !!word && word.text.trim().length > 0;

function contiguousRun(indices: readonly number[], words: readonly OcrWord[]): boolean {
  for (let k = 1; k < indices.length; k += 1) {
    const a = words[indices[k - 1]].bbox;
    const b = words[indices[k]].bbox;
    if (!sameLine(a, b) || horizontalGap(a, b) > GAP_FACTOR * Math.max(boxHeight(a), boxHeight(b))) {
      return false;
    }
  }
  return true;
}
function valueNeighbors(labelBox: OcrBox, labelSet: ReadonlySet<number>, words: readonly OcrWord[]): number[] {
  const gapMax = GAP_FACTOR * boxHeight(labelBox);
  const cand = words
    .map((word, index) => ({ word, index }))
    .filter(({ word, index }) => !labelSet.has(index) && nonEmpty(word) && sameLine(labelBox, word.bbox));
  const left = cand.filter((c) => c.word.bbox.x1 <= labelBox.x0).sort((a, b) => b.word.bbox.x1 - a.word.bbox.x1);
  const right = cand.filter((c) => c.word.bbox.x0 >= labelBox.x1).sort((a, b) => a.word.bbox.x0 - b.word.bbox.x0);
  const picked: number[] = [];
  const chase = (chain: { word: OcrWord; index: number }[]): void => {
    let prev = labelBox;
    for (const { word, index } of chain) {
      if (picked.length >= VALUE_MAX_WORDS || looksLikeLabel(word.text) || horizontalGap(prev, word.bbox) > gapMax) return;
      picked.push(index);
      prev = word.bbox;
    }
  };
  chase(right);
  chase(left);
  return picked;
}

// --- span builders -----------------------------------------------------------------------------------

const WEAK_SCORE = 0.5;
/** Char-range span covering the given word indices (min start .. max end over their char ranges). */
function spanOfWords(indices: readonly number[], ranges: readonly WordRange[], type: EntityType): Span {
  const starts = indices.map((i) => ranges[i].start);
  const ends = indices.map((i) => ranges[i].end);
  return { start: Math.min(...starts), end: Math.max(...ends), type, score: WEAK_SCORE };
}

/**
 * (C) label-anchored runs. `label` = the label word indices, `value` = its value word indices, typed by
 * the label. The VALUE drives the text token (so the same phone dedups regardless of a טלפון/נייד label);
 * the LABEL+VALUE drives the pixel box (whiting the label too, so re-OCR sees a blank block and cannot
 * re-anchor — self-verify idempotency). A lone label with no readable value is NOT a run (not PII, and it
 * avoids a false re-anchor on the label alone).
 */
function labelAnchorRuns(words: readonly OcrWord[]): Array<{ label: number[]; value: number[]; type: EntityType }> {
  const runs: Array<{ label: number[]; value: number[]; type: EntityType }> = [];
  for (let i = 0; i < words.length; i += 1) {
    if (!nonEmpty(words[i])) continue;
    const mergedType = mergedLabelType(words[i].text);
    if (mergedType) {
      runs.push({ label: [], value: [i], type: mergedType }); // merged token = label+value inseparable
      continue;
    }
    for (let span = Math.min(LABEL_MAX_WORDS, words.length - i); span >= 1; span -= 1) {
      const label = Array.from({ length: span }, (_, k) => i + k);
      if (!label.every((j) => nonEmpty(words[j])) || !contiguousRun(label, words)) continue;
      const type = exactLabelType(label.map((j) => words[j].text).join(" "));
      if (!type) continue;
      const labelBox = unionRect(label.map((j) => words[j].bbox));
      const value = valueNeighbors(labelBox, new Set(label), words);
      if (value.length > 0) {
        runs.push({ label, value, type });
      }
      i += span - 1;
      break;
    }
  }
  return runs;
}

/** Exported for isolated testing: the label-anchor pixel boxes (label+value unions, idempotency extent). */
export function labelAnchorBoxes(words: readonly OcrWord[]): OcrBox[] {
  return labelAnchorRuns(words).map((run) => unionRect([...run.label, ...run.value].map((i) => words[i].bbox)));
}

/** (B) 8-10 digits with optional single horizontal-space/hyphen/dot separators, not touching more digits or
 *  a slash. Separator uses the shared HWS set, not `\s`: a `\s` admits a newline, so a run at a line end
 *  would join the next line's digits into one token/box (distorting layout). See separators.ts. */
const DIGIT_RUN = new RegExp(`(?<![\\d/])\\d(?:[${HWS}.-]?\\d){7,9}(?![\\d/])`, "g");

/**
 * Merge the A∪B∪C spans into a non-overlapping set by UNION (never drop-the-loser like resolveOverlaps):
 * overlapping spans extend to cover both, typed by the highest-PRIORITY (score-tiebreak) member. This is
 * the scan invariant's guarantee — a value caught by two mechanisms is one token AND its coverage is never
 * reduced (so the pixel box, derived from the same span, can't lose a region a weaker span alone covered).
 */
function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Span[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last && span.start < last.end) {
      const better =
        PRIORITY[span.type] > PRIORITY[last.type] ||
        (PRIORITY[span.type] === PRIORITY[last.type] && span.score > last.score);
      out[out.length - 1] = {
        start: last.start,
        end: Math.max(last.end, span.end),
        type: better ? span.type : last.type,
        score: Math.max(last.score, span.score),
      };
    } else {
      out.push({ ...span });
    }
  }
  return out;
}

/**
 * Detect PII on an OCR page → the unified typed span set + the pixel boxes derived from it + the page's
 * OCR text. A span mapping to zero word boxes throws SCAN_UNMAPPABLE_PII (a PII we cannot cover).
 */
export async function detectScanPii(page: OcrPageResult, anonymize: Anonymize): Promise<ScanDetection> {
  const words = page.words;
  const { text, ranges } = buildOcrText(words);

  // (A) standard detection — typed, resolved char-spans (deterministic + NER + occurrence-completion).
  const aResult = await anonymize(text);
  const aSpans: Span[] = [...aResult.spans];

  // (B) unlabeled digit-run relax → generic [NUM_N] spans.
  const bSpans: Span[] = [];
  for (const match of text.matchAll(DIGIT_RUN)) {
    bSpans.push({ start: match.index, end: match.index + match[0].length, type: "IL_NUMBER", score: WEAK_SCORE });
  }

  // (C) label-anchored runs → VALUE-only spans (for the text token + dedup), plus LABEL+VALUE boxes below.
  const cRuns = labelAnchorRuns(words);
  const cSpans: Span[] = cRuns.map((run) => spanOfWords(run.value, ranges, run.type));

  // Unify by UNION-merge so a value caught by two mechanisms is ONE token and coverage is never reduced.
  // The tokenized text derives from this VALUE span set.
  const spans = mergeSpans([...aSpans, ...bSpans, ...cSpans]);

  // Pixel boxes: the value boxes from the unified spans, PLUS each C run's label+value box (idempotency).
  const boxes: OcrBox[] = spans.map((span) => {
    const indices = wordsForRange(ranges, span.start, span.end);
    if (indices.length === 0) {
      throw new Error(SCAN_UNMAPPABLE_PII);
    }
    return unionRect(indices.map((i) => words[i].bbox));
  });
  for (const run of cRuns) {
    boxes.push(unionRect([...run.label, ...run.value].map((i) => words[i].bbox)));
  }

  return { boxes, spans, text };
}
