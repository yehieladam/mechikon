import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import * as Comlink from "comlink";
import type { AnonymizeResult, EntityType, KeyRow } from "@engine/types";
import type { ManualTerm } from "@engine/manual";
import type { RestoreResult } from "@engine/restore";
import { countPlaceholderTokens } from "@engine/restore";
import { toKeyFile, fromKeyFile } from "@engine/key";
import {
  encryptKeyRows,
  decryptKeyRows,
  isEncryptedKeyFile,
  type EncryptedKeyFile,
} from "@engine/keyCrypto";
import { getEngine } from "./worker/engineClient";
import { CategoryLegend } from "./CategoryLegend";
import {
  FAMILY_PILL_CLASS,
  familyOf,
  readDisabledTypes,
  toggleFamily,
  writeDisabledTypes,
  type CategoryFamily,
} from "./lib/categories";
import { useNetwork } from "./lib/useNetworkCount";
import { mimeFor } from "./lib/mime";
import { exceedsKeyFileLimit, exceedsUploadLimit } from "./lib/uploadLimits";
import { isScanOcrEnabled } from "./lib/scanFlag";
import { scanNoticeFor } from "./lib/scanNotice";
import { selectActiveKey, uploadedKeyStateAfterResult } from "./lib/restoreKey";
import { fileDownloadGate } from "./lib/downloadGate";
import { loadNer, useNer } from "./worker/nerController";

/** Progress of the slow scanned-PDF OCR op (Stage 5). "model" = the one-time NER load precedes OCR. */
type ScanProgress = { phase: "model" | "reading" | "verifying"; page?: number; total?: number };

/** What produced the current result — so we can re-run it with NER once the model is ready. `scan` marks
 * a file that classified as a scanned PDF, so EVERY re-run path (NER-ready, manual terms) routes it back
 * through the OCR pass instead of the text path. */
type Source =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "file"; readonly name: string; readonly buffer: ArrayBuffer; readonly scan?: boolean };

const COPIED_RESET_MS = 1500;
const COPY_TOAST_MS = 2000;
/** How long the transient "N names added" notice (M4) stays before it fades out. */
const NER_ADDED_NOTICE_MS = 4000;
const MANUAL_ONLY_KEY = "mechikon.manualOnly";

/** Read the persisted manual-only preference. Manual-only is the DEFAULT: the 185MB automatic-detection
 * model is an explicit opt-in, never a forced first-load download. Only an explicit stored "0" (the user
 * chose automatic) turns it off; an unset or any other value means manual. */
function readManualOnly(): boolean {
  try {
    return localStorage.getItem(MANUAL_ONLY_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Persist the manual-only preference so it survives reloads. */
function writeManualOnly(on: boolean): void {
  try {
    localStorage.setItem(MANUAL_ONLY_KEY, on ? "1" : "0");
  } catch {
    // Private mode / storage disabled — the toggle still works for this session.
  }
}

/** Insert the "redacted" suffix before the extension: report.docx → report_מושחר.docx */
function redactedName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const base = dot === -1 ? fileName : fileName.slice(0, dot);
  const ext = dot === -1 ? "" : fileName.slice(dot);
  return `${base}_מושחר${ext}`;
}

/** Trigger a browser download of a blob under the given filename. */
function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** EntityType → i18n label key, for the per-type count chips. */
const TYPE_LABEL: Record<EntityType, string> = {
  ISRAELI_ID: "entity.id",
  IL_COMPANY: "entity.company",
  IL_PHONE: "entity.phone",
  IL_IBAN: "entity.iban",
  IL_CASE: "entity.case",
  IL_LAND: "entity.land",
  IL_POLICY: "entity.policy",
  IL_INSURED: "entity.insured",
  EMAIL_ADDRESS: "entity.email",
  PERSON: "entity.name",
  ORGANIZATION: "entity.org",
  LOCATION: "entity.place",
  MANUAL: "entity.manual",
  IL_NUMBER: "entity.number",
};

/** Split on placeholder tokens and render each as a subtle pill so the redactions read clearly. */
const TOKEN_SPLIT = /(\[[^[\]]*_\d+\])/g;
const IS_TOKEN = /^\[[^[\]]*_\d+\]$/;

/** Wrap each occurrence of an active-key ORIGINAL value in an emerald pill, so the restored text shows
 *  at a glance which values came back (M2). Values are matched literally (longest first so a longer value
 *  wins over a shorter substring); only values from the active key are highlighted, never arbitrary text. */
function highlightValues(text: string, values: readonly string[]): ReactNode[] {
  const unique = [...new Set(values)].filter((value) => value.length > 0).sort((a, b) => b.length - a.length);
  if (unique.length === 0) {
    return [<span key={0}>{text}</span>];
  }
  const escaped = unique.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const splitter = new RegExp(`(${escaped.join("|")})`, "g");
  const valueSet = new Set(unique);
  return text.split(splitter).map((part, index) =>
    valueSet.has(part) ? (
      <mark
        key={index}
        className="rounded-md bg-emerald-50 px-1 py-0.5 font-medium text-emerald-900"
      >
        {part}
      </mark>
    ) : (
      <span key={index}>{part}</span>
    ),
  );
}

/** A clickable unit: EITHER a letter word (Hebrew/Latin, keeping an internal geresh/gershayim like עו״ד
 *  or טל׳) OR a number (digits with internal separators kept whole, so 052-1234567 / 14.07.1981 stay one
 *  unit). Letters and digits are SEPARATE units — "הרצל47" splits into "הרצל" and "47" — so a house
 *  number can be redacted without the street name and vice versa. */
const WORD_RUN = /[A-Za-z֐-׿]+(?:['’׳״][A-Za-z֐-׿]+)*|\d+(?:[.\-/]\d+)*/g;

/**
 * Render the anonymized text as an INTERACTIVE preview: already-redacted spans show as token pills
 * (a manual one is clickable to UNDO), and every remaining word/number is clickable to redact it.
 * This is how the user hand-picks redactions — clicking a word adds it as a manual term everywhere.
 */
/** Color an automatic token pill by its category family (3 hues x 2 shades); default ink for an unknown
 *  type. MANUAL tokens never reach here — they have their own amber pill. */
function autoPillClass(type: EntityType | undefined): string {
  const family = type ? familyOf(type) : null;
  return family ? FAMILY_PILL_CLASS[family] : "bg-ink/[0.06] text-ink";
}

function renderInteractive(
  text: string,
  manualTokenToTerm: ReadonlyMap<string, string>,
  autoTokenToOriginal: ReadonlyMap<string, string>,
  autoTokenToType: ReadonlyMap<string, EntityType>,
  onPick: (word: string) => void,
  onUndo: (term: string) => void,
  onReveal: (value: string) => void,
  pickTitle: string,
  undoTitle: string,
  revealTitle: string,
  manualAffordance: boolean,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let key = 0;
  for (const part of text.split(TOKEN_SPLIT)) {
    if (IS_TOKEN.test(part)) {
      const manualTerm = manualTokenToTerm.get(part);
      const autoValue = autoTokenToOriginal.get(part);
      if (manualTerm !== undefined) {
        // A manual pick — click to UNDO (remove the term).
        nodes.push(
          <button
            key={key++}
            type="button"
            title={undoTitle}
            onClick={() => onUndo(manualTerm)}
            className="mx-0.5 cursor-pointer rounded-md bg-amber-100 px-1.5 py-0.5 text-[0.92em] font-medium text-amber-800 underline decoration-amber-600/60 decoration-dotted underline-offset-2 transition hover:bg-amber-200"
          >
            {part}
          </button>,
        );
      } else if (autoValue !== undefined) {
        // An automatic detection — click to REVEAL (exclude the value, un-redact it). Pill is colored by
        // the token's category family; the dotted underline inherits the family's text color.
        nodes.push(
          <button
            key={key++}
            type="button"
            title={revealTitle}
            onClick={() => onReveal(autoValue)}
            className={`mx-0.5 cursor-pointer rounded-md px-1.5 py-0.5 text-[0.92em] font-medium underline decoration-dotted underline-offset-2 transition hover:opacity-80 ${autoPillClass(
              autoTokenToType.get(part),
            )}`}
          >
            {part}
          </button>,
        );
      } else {
        nodes.push(
          <mark
            key={key++}
            className={`mx-0.5 rounded-md px-1.5 py-0.5 text-[0.92em] font-medium ${autoPillClass(
              autoTokenToType.get(part),
            )}`}
          >
            {part}
          </mark>,
        );
      }
      continue;
    }
    let last = 0;
    for (const match of part.matchAll(WORD_RUN)) {
      const start = match.index;
      const word = match[0];
      if (start > last) {
        nodes.push(<span key={key++}>{part.slice(last, start)}</span>);
      }
      nodes.push(
        // tabIndex={-1} (G6): there can be hundreds of these per-word buttons; keeping them out of the
        // tab order stops a keyboard user from being trapped tabbing through every word. The manual-add
        // input is the keyboard path for redacting a missed term.
        <button
          key={key++}
          type="button"
          tabIndex={-1}
          title={pickTitle}
          onClick={() => onPick(word)}
          className={
            manualAffordance
              ? // Manual is the default mode: make every word visibly tappable so a first-time user
                // discovers the click-to-hide interaction (a faint dashed underline that darkens on hover).
                "cursor-pointer rounded underline decoration-dotted decoration-zinc-300 underline-offset-4 transition hover:bg-ink/[0.06] hover:decoration-ink"
              : // Automatic mode: clicking a plain word only ADDS a manual redaction on top of detection,
                // so keep it subtle (no affordance noise over already-clean text).
                "rounded transition hover:bg-ink/[0.08] hover:ring-1 hover:ring-ink/20"
          }
        >
          {word}
        </button>,
      );
      last = start + word.length;
    }
    if (last < part.length) {
      nodes.push(<span key={key++}>{part.slice(last)}</span>);
    }
  }
  return nodes;
}

export function App() {
  const { t } = useTranslation();
  const net = useNetwork();
  const ner = useNer();

  const [input, setInput] = useState("");
  // Drag-and-drop onto the input card (F2). Dropped files go through the existing onFile path.
  const [dragging, setDragging] = useState(false);
  const [source, setSource] = useState<Source | null>(null);
  const [status, setStatus] = useState<null | "working" | "reading">(null);
  const [result, setResult] = useState<AnonymizeResult | null>(null);
  // Mirror the current result so the NER-upgrade effect can diff key length across the upgrade (M4)
  // without adding `result` to its deps (which would re-fire the upgrade).
  const resultRef = useRef(result);
  resultRef.current = result;
  const [copied, setCopied] = useState(false);
  const [showCopyToast, setShowCopyToast] = useState(false);
  // Clipboard writes can reject (permissions / no focus); surface a copy-failed hint so the user is not
  // left thinking it worked. Separate flags for the two copy affordances so a message never shows in the
  // wrong place.
  const [copyError, setCopyError] = useState(false);
  const [restoredCopyError, setRestoredCopyError] = useState(false);
  const [fileError, setFileError] = useState(false);
  // Untrusted-input bounds (B8): "size" = the upload is over the byte cap OR a zip that inflates past
  // the decompressed ceiling (a zip bomb); "pages" = a PDF over the page cap. Clear refusals, no crash.
  const [limitNotice, setLimitNotice] = useState<null | "size" | "pages">(null);
  const [scannedNotice, setScannedNotice] = useState(false);
  // Legacy binary .xls (B7): SheetJS removed, so a .xls is refused with a "re-save as .xlsx" hint.
  const [legacyXlsNotice, setLegacyXlsNotice] = useState(false);
  const [formulaNotice, setFormulaNotice] = useState(false);
  const [selfVerifyNotice, setSelfVerifyNotice] = useState(false);
  // Mixed digital+scanned PDF (B3): image-only pages we could not verify clean. The file is still
  // produced and downloadable; this drives a NON-blocking per-page warning. 1-based page numbers.
  const [unverifiedImagePages, setUnverifiedImagePages] = useState<readonly number[]>([]);
  // PDF visual self-verify (B2): HIGH-CONFIDENCE values (full IDs / full multi-token names) the byte-level
  // leak scan could not confirm absent from the redacted PDF. NON-blocking — the download stays enabled;
  // this drives an amber "review these before sharing" notice naming the values. Fragment-substring noise
  // is already filtered out worker-side (engine/pdfVerify highConfidenceSurvivors).
  const [pdfUnverifiedTerms, setPdfUnverifiedTerms] = useState<readonly string[]>([]);
  // Scanned-PDF OCR (Stage 5): a scan awaiting the NER model before its single OCR pass, the live
  // per-page progress, and the two-tier refusal ("lowQuality" = readable-poorly; "unsafe" = the rare
  // internal-safety refusals SCAN_UNMAPPABLE_PII / SCAN_SELFVERIFY_FAILED).
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [scanNotice, setScanNotice] = useState<null | "lowQuality" | "unsafe">(null);
  // The redacted file bytes ready for download (the burned-token PDF / redacted office file).
  const [redacted, setRedacted] = useState<{ bytes: Uint8Array; name: string; mime: string } | null>(
    null,
  );
  const [restoreInput, setRestoreInput] = useState("");
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);
  // Guided restore (D): the panel is controlled so copy can auto-open it; refs let G7 reveal + focus it
  // so an auto-open below the fold is not silent.
  const [restoreOpen, setRestoreOpen] = useState(false);
  // Guided restore step 2: one segmented control picks text vs whole-file, so the two paths are never
  // stacked. restoredCopied drives the restored-box corner copy icon (mirrors the redacted preview).
  const [restoreMode, setRestoreMode] = useState<"text" | "file">("text");
  const [restoredCopied, setRestoredCopied] = useState(false);
  const restoreSectionRef = useRef<HTMLElement>(null);
  const restoreTextareaRef = useRef<HTMLTextAreaElement>(null);
  // Manual redaction — user-added terms the automatic detectors missed.
  const [manualTerms, setManualTerms] = useState<ManualTerm[]>([]);
  const [manualInput, setManualInput] = useState("");
  // Optional custom placeholder name for a typed manual term — ASCII/Latin only (it is burned onto the
  // PDF, where Hebrew won't render), so the input sanitizes to uppercase A–Z as the user types.
  const [manualLabel, setManualLabel] = useState("");
  // Values the user chose to REVEAL (clicked an auto-detected token to un-redact a false positive, e.g.
  // a bank name mis-tagged as a location). A ref mirrors it so the worker-calling callbacks stay stable.
  const [excludedTerms, setExcludedTerms] = useState<string[]>([]);
  const excludedRef = useRef(excludedTerms);
  excludedRef.current = excludedTerms;
  // Category-control layer: EntityTypes the user disabled (never redacted). Persisted (opt-out; default
  // empty = redact everything, as before). A ref mirrors it so the worker-calling callbacks read the
  // latest value without each depending on it (same pattern as excludedTerms / manualOnly).
  const [disabledTypes, setDisabledTypes] = useState<EntityType[]>(() => [...readDisabledTypes()]);
  const disabledTypesRef = useRef(disabledTypes);
  disabledTypesRef.current = disabledTypes;
  // The preview box is capped at ~half the viewport and scrolls internally so a long document does not
  // push the whole page; an expand toggle drops the cap.
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [showManualInput, setShowManualInput] = useState(false);
  // Manual-only mode: redact ONLY the user's chosen terms — no automatic detection, no 185MB model.
  // Persisted so a user who prefers it never triggers a model load. A ref mirrors it so the many
  // worker-calling callbacks read the latest value without each depending on it (no stale closures).
  const [manualOnly, setManualOnly] = useState<boolean>(() => readManualOnly());
  const manualOnlyRef = useRef(manualOnly);
  manualOnlyRef.current = manualOnly;
  // Restore-key download/upload (KEY-01): the key is in-memory by default; download is opt-in and
  // encryption (passphrase) is on by default.
  const [encryptKey, setEncryptKey] = useState(true);
  const [keyPassphrase, setKeyPassphrase] = useState("");
  const [uploadedKey, setUploadedKey] = useState<KeyRow[] | null>(null);
  const [pendingEnc, setPendingEnc] = useState<EncryptedKeyFile | null>(null);
  const [unlockPassphrase, setUnlockPassphrase] = useState("");
  const [keyError, setKeyError] = useState<"wrong" | "invalid" | null>(null);
  // Restore-key download UX (C1): keyDownloaded flips the card to a calm confirmed state (B); it resets
  // on every showResult because a new result mints a new key. keyEverDownloaded persists across that reset
  // so a post-download key change shows a QUIET "key changed" delta (G4) instead of the full guidance
  // again. showPass toggles the passphrase eye; passphraseMissing drives the inline hint when the user
  // clicks download with encryption on and no passphrase (the button is never disabled).
  const [keyDownloaded, setKeyDownloaded] = useState(false);
  const [keyEverDownloaded, setKeyEverDownloaded] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [passphraseMissing, setPassphraseMissing] = useState(false);
  const passphraseRef = useRef<HTMLInputElement>(null);
  // Restore a FILE (docx/txt with placeholders) back to its original values.
  const [restoreFileError, setRestoreFileError] = useState<
    "unsupported" | "nokey" | "toobig" | "generic" | null
  >(null);
  const [restoreUnmatched, setRestoreUnmatched] = useState(0);
  // M4: transient count of names the NER upgrade pass just added, so the silent upgrade is acknowledged.
  const [nerAdded, setNerAdded] = useState<number | null>(null);
  // H-race: true while the names-upgrade re-run for a file source is in flight. The model flipping to
  // "ready" is NOT enough to enable the download — the upgraded bytes are set asynchronously afterwards,
  // and until then `redacted` still holds the pre-names deterministic bytes. This keeps the pending pill
  // (download withheld) through the WHOLE upgrade, not just until ner.status flips.
  const [nerUpgrading, setNerUpgrading] = useState(false);
  // A whole-file restore downloads a file (no on-screen restoredText), so a boolean drives its success
  // confirmation line independently of the unmatched count (which can legitimately be 0).
  const [restoreFileDone, setRestoreFileDone] = useState(false);

  const busy = status !== null;

  const showResult = useCallback((anonymized: AnonymizeResult, isNewDocument = false) => {
    setResult(anonymized);
    // The restore box starts EMPTY (guided flow): the user pastes the AI's answer, not the just-redacted
    // text. The reworded restore.placeholder explains this.
    setRestoreResult(null);
    setRedacted(null);
    setScannedNotice(false);
    setLimitNotice(null); // a fresh result clears any leftover size/page refusal from a prior file
    setScanNotice(null); // a fresh result clears any leftover scan refusal from a prior file
    setUnverifiedImagePages([]); // and any prior mixed-PDF per-page warning
    setPdfUnverifiedTerms([]); // and any prior PDF self-verify warning (B2) — a new result re-verifies
    // Any result mints a NEW key, so an earlier download no longer covers it.
    setKeyDownloaded(false);
    setPassphraseMissing(false);
    // Only a brand-new document (fresh anonymize/upload) forgets that a PRIOR document's key was
    // downloaded, so the first-time key-loss warning shows again. A reprocess / NER-upgrade of the SAME
    // document keeps keyEverDownloaded, so it shows the quiet "key changed" delta (G4).
    if (isNewDocument) {
      setKeyEverDownloaded(false);
      // H-stalekey: a brand-new document owns its OWN restore key. Drop any key uploaded (or being
      // unlocked) for a PRIOR document, otherwise activeKey would keep pointing at the old key and
      // restore this document's tokens against the wrong rows (writing the old originals in, silently).
      const keyState = uploadedKeyStateAfterResult(
        { uploadedKey: null, pendingEnc: null, unlockPassphrase: "" },
        true,
      );
      setUploadedKey(keyState.uploadedKey);
      setPendingEnc(keyState.pendingEnc);
      setUnlockPassphrase(keyState.unlockPassphrase);
      setKeyError(null);
    }
  }, []);

  const onAnonymize = useCallback(async () => {
    const text = input.trim();
    if (text.length === 0 || busy) {
      return;
    }
    setStatus("working");
    setFileError(false);
    setSource({ kind: "text", text });
    setManualTerms([]);
    excludedRef.current = []; // clear the ref synchronously — the call below reads it this tick
    setExcludedTerms([]);
    try {
      // Manual-only: redact just the chosen terms, no model. Otherwise instant deterministic now, then
      // load NER for names (it upgrades the result when ready).
      showResult(
        await getEngine().anonymizeSmart(
          text,
          [],
          manualOnlyRef.current,
          excludedRef.current,
          disabledTypesRef.current,
        ),
        true,
      );
      if (!manualOnlyRef.current) {
        void loadNer();
      }
    } finally {
      setStatus(null);
    }
  }, [input, busy, showResult]);

  // The single OCR pass for a scanned PDF (Stage 5). Runs ONLY once NER is ready (names come from NER on
  // the OCR text) so there is no wasted deterministic-only pass; per-page progress streams from the
  // worker; the three refusal codes map to the two-tier notice; any failure pulls the download (never
  // hand back a scan we could not fully redact + verify).
  const runScanRedaction = useCallback(
    async (
      name: string,
      buffer: ArrayBuffer,
      terms: readonly ManualTerm[],
      isNewDocument = false,
      isCancelled?: () => boolean,
    ) => {
      setStatus("reading");
      setScanNotice(null);
      setFileError(false);
      const onProgress = Comlink.proxy((event: ScanProgress) => {
        if (!isCancelled?.()) setScanProgress(event);
      });
      try {
        const { result, bytes, unverifiedImagePages: unverified } = await getEngine().redactFile(
          name,
          buffer,
          terms,
          true,
          onProgress,
          false,
          excludedRef.current,
          // Scans stay fully unfiltered in P0: the OCR self-verify re-runs this same detection on the
          // redacted output and would refuse any deliberately-visible value. Category control on scans is P1.
          [],
        );
        if (isCancelled?.()) return; // source changed / unmounted during the multi-second OCR
        showResult(result, isNewDocument);
        if (bytes) {
          setRedacted({ bytes, name: redactedName(name), mime: mimeFor(name) });
        }
        setUnverifiedImagePages(unverified ?? []); // after showResult (which cleared it)
      } catch (error) {
        if (isCancelled?.()) return;
        setRedacted(null);
        const kind = scanNoticeFor(error instanceof Error ? error.message : "");
        if (kind) {
          setSource(null);
          setScanNotice(kind);
        } else {
          setFileError(true);
        }
      } finally {
        if (!isCancelled?.()) {
          setScanProgress(null);
          setStatus(null);
        }
      }
    },
    [showResult],
  );

  const onFile = useCallback(
    async (file: File | undefined) => {
      if (!file || busy) {
        return;
      }
      setStatus("reading");
      setFileError(false);
      setScannedNotice(false);
      setLegacyXlsNotice(false);
      setLimitNotice(null);
      setFormulaNotice(false);
      setSelfVerifyNotice(false);
      setScanNotice(null);
      setManualTerms([]);
      excludedRef.current = []; // clear the ref synchronously — the redactFile calls below read it this tick
      setExcludedTerms([]);
      // Size gate (B8) BEFORE arrayBuffer: refuse an oversized upload without ever reading it into
      // memory. Covers the upload button AND drag-drop (the drop handler delegates here).
      if (exceedsUploadLimit(file.size)) {
        setLimitNotice("size");
        setStatus(null);
        return;
      }
      try {
        const buffer = await file.arrayBuffer();
        // Scan route (flag-gated): classify BEFORE committing the source, so a scan is marked
        // `scan:true` atomically (no window where the NER-ready effect sees a scan source without the
        // flag and misroutes it to the text path). OCR runs only after NER is ready (H3 — a name-bearing
        // doc is never redacted/downloadable name-unredacted): run now if ready, else the NER-ready
        // effect runs it on the ready transition.
        if (isScanOcrEnabled() && file.name.toLowerCase().endsWith(".pdf")) {
          const kind = await getEngine().classifyPdf(buffer);
          if (kind === "scan") {
            setSource({ kind: "file", name: file.name, buffer, scan: true });
            if (ner.status === "ready") {
              await runScanRedaction(file.name, buffer, [], true);
            } else {
              void loadNer();
              setStatus(null);
            }
            return;
          }
        }
        setSource({ kind: "file", name: file.name, buffer });
        const {
          result: anonymized,
          bytes,
          unverifiedImagePages: unverified,
          pdfUnverified,
        } = await getEngine().redactFile(
          file.name,
          buffer,
          [],
          false,
          undefined,
          manualOnlyRef.current,
          excludedRef.current,
          disabledTypesRef.current,
        );
        showResult(anonymized, true);
        if (bytes) {
          setRedacted({ bytes, name: redactedName(file.name), mime: mimeFor(file.name) });
        }
        setUnverifiedImagePages(unverified ?? []); // mixed-PDF per-page warning (after showResult cleared it)
        setPdfUnverifiedTerms(pdfUnverified?.terms ?? []); // B2 soft warning (after showResult cleared it)
        if (!manualOnlyRef.current) {
          void loadNer();
        }
      } catch (error) {
        // A scanned/image PDF has no text layer — refuse with a specific notice instead of a falsely
        // "clean" result (the message survives Comlink from the worker).
        if (error instanceof Error && error.message.includes("NO_TEXT_LAYER")) {
          setSource(null);
          setScannedNotice(true);
        } else if (error instanceof Error && error.message.includes("ZIP_BOMB")) {
          // The zip inflates past the decompressed ceiling (B8) — refuse instead of exhausting memory.
          setSource(null);
          setLimitNotice("size");
        } else if (error instanceof Error && error.message.includes("PDF_TOO_MANY_PAGES")) {
          // Absurd page count (B8) — refuse before the per-page loops pin the worker.
          setSource(null);
          setLimitNotice("pages");
        } else if (error instanceof Error && error.message.includes("LEGACY_XLS_UNSUPPORTED")) {
          // Legacy binary .xls (B7) — SheetJS removed; tell the user to re-save as .xlsx.
          setSource(null);
          setLegacyXlsNotice(true);
        } else if (error instanceof Error && error.message.includes("XLSX_FORMULA_PII")) {
          // A number produced by a formula can't be safely overlaid (recalc regenerates it) — refuse.
          setSource(null);
          setFormulaNotice(true);
        } else if (
          error instanceof Error &&
          (error.message.includes("OFFICE_SELFVERIFY_FAILED") || error.message.includes("TEXT_SELFVERIFY_FAILED"))
        ) {
          // A detected value survived in the output (office file) or in the tokenized AI-text (PDF) — the
          // AI-text is machine-consumed with no human review, so a leak there is a HARD refuse of both.
          setSource(null);
          setSelfVerifyNotice(true);
        } else {
          setFileError(true);
        }
      } finally {
        setStatus(null);
      }
    },
    [busy, showResult, ner.status, runScanRedaction],
  );

  // M4: acknowledge the silent NER upgrade by flashing how many keys it added over the deterministic pass.
  const announceNerAdded = useCallback((upgradedKeyLength: number) => {
    const added = upgradedKeyLength - (resultRef.current?.key.length ?? 0);
    if (added > 0) {
      setNerAdded(added);
      window.setTimeout(() => setNerAdded(null), NER_ADDED_NOTICE_MS);
    }
  }, []);

  // When the model finishes loading, re-run whatever is on screen so names get redacted too.
  const previousNerStatus = useRef(ner.status);
  useEffect(() => {
    const wasReady = previousNerStatus.current === "ready";
    previousNerStatus.current = ner.status;
    // Manual-only never loads NER, so there is no names-upgrade pass to run (and the shown result is
    // already final). Guard defensively in case the model was warmed before the user switched modes.
    if (manualOnlyRef.current || ner.status !== "ready" || wasReady || source === null) {
      return;
    }
    // H-race: hold the download through the WHOLE upgrade. ner.status is already "ready" here, so the
    // file-download gate would otherwise enable the button while `redacted` still holds the pre-names
    // deterministic bytes. The flag drops only once the upgraded bytes are committed (finally below).
    setNerUpgrading(true);
    let cancelled = false;
    void (async () => {
      try {
        // A scan deferred until the model was ready: run its single OCR pass now (not the text/office
        // upgrade), sharing this effect's cancellation so a stale pass can't commit after source changes.
        if (source.kind === "file" && source.scan) {
          await runScanRedaction(source.name, source.buffer, manualTerms, false, () => cancelled);
          return;
        }
        if (source.kind === "text") {
          const upgraded = await getEngine().anonymizeSmart(
            source.text,
            manualTerms,
            false,
            excludedRef.current,
            disabledTypesRef.current,
          );
          if (!cancelled) {
            announceNerAdded(upgraded.key.length);
            showResult(upgraded);
          }
          return;
        }
        const { result: upgraded, bytes, pdfUnverified } = await getEngine().redactFile(
          source.name,
          source.buffer,
          manualTerms,
          false,
          undefined,
          false,
          excludedRef.current,
          disabledTypesRef.current,
        );
        if (cancelled) {
          return;
        }
        announceNerAdded(upgraded.key.length);
        showResult(upgraded);
        if (bytes) {
          setRedacted({ bytes, name: redactedName(source.name), mime: mimeFor(source.name) });
        }
        setPdfUnverifiedTerms(pdfUnverified?.terms ?? []); // B2 soft warning (after showResult cleared it)
      } catch {
        // The NER-pass redaction genuinely failed (e.g. the TEXT self-verify refused a leaky AI-text, or
        // an office self-verify). Never leave the earlier deterministic-only download in place — that
        // would hand back a file the user believes is fully redacted. Surface the error and pull it.
        if (!cancelled) {
          setFileError(true);
          setRedacted(null);
        }
      } finally {
        // Re-open the download gate once the upgrade has committed (or failed / been cancelled). The
        // scan branch manages its own bytes via runScanRedaction; clearing here still re-enables the gate.
        setNerUpgrading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ner.status, source, showResult, manualTerms, runScanRedaction, announceNerAdded]);

  // Re-run the current source with a new set of manual terms (add/remove a hand-picked redaction).
  const reprocessManual = useCallback(
    async (terms: ManualTerm[]) => {
      if (!source) {
        return;
      }
      // A scan must re-run through the OCR pass (with scanOcr), never the text path — otherwise the
      // re-run hits NO_TEXT_LAYER and destroys the already-good redacted download.
      if (source.kind === "file" && source.scan) {
        await runScanRedaction(source.name, source.buffer, terms, false);
        return;
      }
      setStatus(source.kind === "file" ? "reading" : "working");
      setFileError(false);
      try {
        if (source.kind === "text") {
          showResult(
            await getEngine().anonymizeSmart(
              source.text,
              terms,
              manualOnlyRef.current,
              excludedRef.current,
              disabledTypesRef.current,
            ),
          );
        } else {
          const { result, bytes, pdfUnverified } = await getEngine().redactFile(
            source.name,
            source.buffer,
            terms,
            false,
            undefined,
            manualOnlyRef.current,
            excludedRef.current,
            disabledTypesRef.current,
          );
          showResult(result);
          if (bytes) {
            setRedacted({ bytes, name: redactedName(source.name), mime: mimeFor(source.name) });
          }
          setPdfUnverifiedTerms(pdfUnverified?.terms ?? []); // B2 soft warning (after showResult cleared it)
        }
      } catch {
        // A manual term re-triggered redaction that failed — pull any stale download so the user never
        // saves a file that is not actually fully redacted.
        setFileError(true);
        setRedacted(null);
      } finally {
        setStatus(null);
      }
    },
    [source, showResult, runScanRedaction],
  );

  // Toggle manual-only mode. Update the ref synchronously so the reprocess below runs under the new
  // mode; persist the choice; warm the model when switching back to automatic; re-run the current doc.
  const onToggleManualOnly = useCallback(() => {
    const next = !manualOnlyRef.current;
    manualOnlyRef.current = next;
    setManualOnly(next);
    writeManualOnly(next);
    if (!next) {
      void loadNer();
    }
    if (source) {
      void reprocessManual(manualTerms);
    }
  }, [source, manualTerms, reprocessManual]);

  // Toggle a whole category family. Update the ref synchronously so the reprocess below runs under the new
  // disabled set; persist the choice; re-run the current doc so the preview + key reflect it immediately.
  const onToggleFamily = useCallback(
    (family: CategoryFamily) => {
      const next = [...toggleFamily(disabledTypesRef.current, family)];
      disabledTypesRef.current = next;
      setDisabledTypes(next);
      writeDisabledTypes(next);
      if (source) {
        void reprocessManual(manualTerms);
      }
    },
    [source, manualTerms, reprocessManual],
  );

  const onAddManual = useCallback(() => {
    const value = manualInput.trim();
    if (value.length === 0 || manualTerms.some((term) => term.value === value)) {
      setManualInput("");
      setManualLabel("");
      return;
    }
    const label = manualLabel.trim(); // already sanitized to uppercase A–Z by the input
    const terms = [...manualTerms, label ? { value, label } : { value }];
    setManualTerms(terms);
    setManualInput("");
    setManualLabel("");
    void reprocessManual(terms);
  }, [manualInput, manualLabel, manualTerms, reprocessManual]);

  const onRemoveManual = useCallback(
    (value: string) => {
      const terms = manualTerms.filter((term) => term.value !== value);
      setManualTerms(terms);
      void reprocessManual(terms);
    },
    [manualTerms, reprocessManual],
  );

  // Click-to-redact: clicking a word/number in the preview adds it as a manual term (redacted at every
  // occurrence). No-op if it is already redacted, so a double-click can't create a duplicate.
  const onPickWord = useCallback(
    (word: string) => {
      const value = word.trim();
      if (value.length === 0 || manualTerms.some((term) => term.value === value)) {
        return;
      }
      const terms = [...manualTerms, { value }];
      setManualTerms(terms);
      void reprocessManual(terms);
    },
    [manualTerms, reprocessManual],
  );

  // Reveal (un-redact) an AUTO-detected value the user judged a false positive — add it to the exclusion
  // list and re-run, so detection no longer grabs it. Its original text reappears (clickable again, so a
  // real miss can be re-redacted by clicking the word).
  const onUnredactAuto = useCallback(
    (value: string) => {
      if (excludedRef.current.includes(value)) {
        return;
      }
      const next = [...excludedRef.current, value];
      excludedRef.current = next;
      setExcludedTerms(next);
      void reprocessManual(manualTerms);
    },
    [manualTerms, reprocessManual],
  );

  // Token → original value, split by source: MANUAL tokens a click UNDOES (removes the term); AUTO
  // tokens a click REVEALS (excludes the value). Every visible token is one or the other.
  const { manualTokenToTerm, autoTokenToOriginal, autoTokenToType } = useMemo(() => {
    const manual = new Map<string, string>();
    const auto = new Map<string, string>();
    const types = new Map<string, EntityType>();
    if (result) {
      for (const row of result.key) {
        (row.type === "MANUAL" ? manual : auto).set(row.placeholder, row.original);
        types.set(row.placeholder, row.type);
      }
    }
    return { manualTokenToTerm: manual, autoTokenToOriginal: auto, autoTokenToType: types };
  }, [result]);

  // Retry loading the names model after it failed — the block is environmental (fetch/WASM), not the
  // file. On the resulting idle→loading→ready transition the re-run effect recomputes with names and
  // the download button reappears.
  const onRetryNer = useCallback(() => {
    void loadNer();
  }, []);

  const onDownload = useCallback(() => {
    // Defense-in-depth: never hand back a file while busy, and never in manual mode with zero redactions
    // (the "redacted" file would be byte-identical to the original yet named "_מושחר"). The JSX also
    // hides this button in that state and disables it while busy.
    if (!redacted || busy || (manualOnlyRef.current && (resultRef.current?.key.length ?? 0) === 0)) {
      return;
    }
    // reason: Comlink returns a Uint8Array<ArrayBufferLike>, which TS 5.7 will not narrow to the
    // ArrayBuffer-backed view BlobPart wants; the bytes are a plain copy, so the cast is safe.
    const blob = new Blob([redacted.bytes as BlobPart], { type: redacted.mime });
    downloadBlob(blob, redacted.name);
  }, [redacted, busy]);

  const onDownloadKey = useCallback(
    async (plain = false) => {
      if (!result || result.key.length === 0) {
        return;
      }
      // Encryption is the safe default. If it is on with no passphrase, do NOT silently block (the old
      // disabled button was a data-loss trap): focus the field and show an inline hint. The "download
      // without encryption" link passes plain=true to take the unencrypted path deliberately.
      if (!plain && encryptKey && keyPassphrase.length === 0) {
        setPassphraseMissing(true);
        passphraseRef.current?.focus();
        return;
      }
      const encrypt = encryptKey && !plain && keyPassphrase.length > 0;
      const content = encrypt
        ? JSON.stringify(await encryptKeyRows(result.key, keyPassphrase), null, 2)
        : toKeyFile(result.key);
      const stamp = new Date().toISOString().slice(0, 10);
      downloadBlob(new Blob([content], { type: "application/json" }), `מפתח-שחזור-${stamp}.json`);
      setPassphraseMissing(false);
      setKeyDownloaded(true);
      setKeyEverDownloaded(true);
    },
    [result, encryptKey, keyPassphrase],
  );

  const onUploadKey = useCallback(async (file: File | undefined) => {
    if (!file) {
      return;
    }
    setKeyError(null);
    setPendingEnc(null);
    // Size gate BEFORE reading: a real key file is at most a few hundred KB; refusing an oversized one
    // here means a hostile multi-GB upload is never read into memory at all.
    if (exceedsKeyFileLimit(file.size)) {
      setKeyError("invalid");
      return;
    }
    try {
      const text = await file.text();
      const parsed: unknown = JSON.parse(text);
      if (isEncryptedKeyFile(parsed)) {
        setPendingEnc(parsed); // needs a passphrase to unlock
        return;
      }
      setUploadedKey(fromKeyFile(text));
    } catch {
      setKeyError("invalid");
    }
  }, []);

  const onUnlockKey = useCallback(async () => {
    if (!pendingEnc) {
      return;
    }
    try {
      const rows = await decryptKeyRows(pendingEnc, unlockPassphrase);
      setUploadedKey(rows);
      setPendingEnc(null);
      setUnlockPassphrase("");
      setKeyError(null);
    } catch {
      setKeyError("wrong");
    }
  }, [pendingEnc, unlockPassphrase]);

  // Open the restore panel and reveal it (G7): after the controlled <details> paints, scroll the section
  // into view and focus the restore textarea so an auto-open (or the bridge link) is never a silent
  // below-the-fold change. Honor prefers-reduced-motion for the scroll.
  const openRestore = useCallback(() => {
    // Always land on the text tab: every caller (copy, bridge, the returned-from-AI offer) brings text
    // to restore, and the G7 focus below targets the text textarea.
    setRestoreMode("text");
    setRestoreOpen(true);
    requestAnimationFrame(() => {
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      restoreSectionRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
      restoreTextareaRef.current?.focus({ preventScroll: true });
    });
  }, []);

  const onCopy = useCallback(async () => {
    // Defense-in-depth: never copy while busy, and never in manual mode with zero redactions (the text
    // would be the untouched original). The JSX also hides the button + disables it while busy.
    if (!result || busy || (manualOnlyRef.current && result.key.length === 0)) {
      return;
    }
    setCopyError(false);
    // The user is mid-round-trip: open the restore flow regardless of whether the clipboard write below
    // succeeds, so a clipboard rejection does not also swallow the navigation.
    openRestore();
    try {
      await navigator.clipboard.writeText(t("result.promptPrefix") + result.anonymizedText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPIED_RESET_MS);
      // The AI-instruction disclosure pops as a short toast instead of sitting as permanent clutter.
      setShowCopyToast(true);
      window.setTimeout(() => setShowCopyToast(false), COPY_TOAST_MS);
    } catch {
      setCopyError(true);
    }
  }, [result, busy, t, openRestore]);

  // Prefer an uploaded key (restore in a later/fresh session) over the in-memory session key.
  const activeKey = selectActiveKey(uploadedKey, result?.key ?? null);

  // M1: text pasted into the MAIN input that carries 2+ placeholder tokens is almost certainly an AI
  // answer coming back, not a document to redact. Offer to route it into the restore flow instead of
  // silently re-redacting the tokens.
  const looksReturnedFromAi = useMemo(() => countPlaceholderTokens(input) >= 2, [input]);

  const onRestore = useCallback(async () => {
    const restored = await getEngine().restore(restoreInput, activeKey ?? []);
    setRestoreResult(restored);
  }, [restoreInput, activeKey]);

  // Copy the restored (real-value) text — a plain copy, no AI-prompt prefix, since this is the final
  // output for the user. Mirrors the redacted preview's corner icon.
  const onCopyRestored = useCallback(async () => {
    if (!restoreResult) {
      return;
    }
    setRestoredCopyError(false);
    try {
      await navigator.clipboard.writeText(restoreResult.restoredText);
      setRestoredCopied(true);
      window.setTimeout(() => setRestoredCopied(false), COPIED_RESET_MS);
    } catch {
      setRestoredCopyError(true);
    }
  }, [restoreResult]);

  // M2 climax count: how many tokens in the pasted text were actually restored (placeholders present
  // minus the ones with no key match). Clamped at 0.
  const restoredCount = useMemo(() => {
    if (!restoreResult) {
      return 0;
    }
    return Math.max(0, countPlaceholderTokens(restoreInput) - restoreResult.unmatched.length);
  }, [restoreResult, restoreInput]);

  const onRestoreFile = useCallback(
    async (file: File | undefined) => {
      if (!file) {
        return;
      }
      setRestoreFileError(null);
      setRestoreUnmatched(0);
      setRestoreFileDone(false);
      if (!activeKey || activeKey.length === 0) {
        setRestoreFileError("nokey");
        return;
      }
      // Size gate (B8) BEFORE arrayBuffer — same ceiling as the redaction upload.
      if (exceedsUploadLimit(file.size)) {
        setRestoreFileError("toobig");
        return;
      }
      try {
        const buffer = await file.arrayBuffer();
        const { bytes, unmatched } = await getEngine().restoreFile(file.name, buffer, activeKey);
        const dot = file.name.lastIndexOf(".");
        const name =
          dot === -1
            ? `${file.name}_משוחזר`
            : `${file.name.slice(0, dot)}_משוחזר${file.name.slice(dot)}`;
        downloadBlob(new Blob([bytes as BlobPart], { type: mimeFor(file.name) }), name);
        setRestoreUnmatched(unmatched.length);
        setRestoreFileDone(true);
      } catch (error) {
        setRestoreFileError(
          error instanceof Error && error.message.includes("RESTORE_UNSUPPORTED")
            ? "unsupported"
            : error instanceof Error && error.message.includes("ZIP_BOMB")
              ? "toobig" // the docx inflates past the decompressed ceiling (B8)
              : "generic",
        );
      }
    },
    [activeKey],
  );

  const chips = useMemo(() => {
    if (!result) {
      return [];
    }
    const counts = new Map<EntityType, number>();
    for (const row of result.key) {
      counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
    }
    return [...counts.entries()];
  }, [result]);

  const statusLine =
    status === "reading"
      ? t("input.reading")
      : status === "working"
        ? t("input.working")
        : fileError
          ? t("input.fileError")
          : t("input.uploadHint");

  const faqItems = ["security", "workflow", "key", "detection", "cost"] as const;

  return (
    <div dir="rtl" className="min-h-screen overflow-x-hidden bg-white text-ink">
      {showCopyToast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed inset-x-0 bottom-6 z-50 flex justify-center px-4 animate-[fadeIn_0.2s_ease]"
        >
          <div className="max-w-md rounded-2xl bg-ink px-4 py-3 text-center text-[13px] leading-relaxed text-white shadow-card">
            {t("result.bridge")}
          </div>
        </div>
      )}
      <header className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-6 py-5">
        <a
          href="https://www.bai-solutions.com/lawyers/suite"
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-[44px] items-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
        >
          <img src="/bai-logo.png" alt="BAI Solutions" className="h-[72px] w-auto object-contain" />
        </a>
        {(() => {
          // The badge proves DESTINATION, not just count: a request to any host that is not same-origin
          // or a model host is an exfiltration signal → red alarm naming the host. Otherwise emerald
          // (0 main requests) or amber (some benign main request), plus the one-time model count.
          const unexpected = net.unexpected + ner.unexpectedRequests;
          const unexpectedHost = net.unexpectedHost ?? ner.unexpectedHost;
          const dotColor = unexpected > 0 ? "bg-red-500" : net.count === 0 ? "bg-emerald-500" : "bg-amber-500";
          // Quiet badge: emerald TEXT (no filled pill) only at a true zero; benign counts stay zinc; the
          // exfiltration alarm stays red. Links to the privacy section. The destination-verification
          // logic (unexpected host) and the model-loaded status are preserved exactly.
          const tone =
            unexpected > 0 ? "text-red-600" : net.count === 0 ? "text-emerald-700" : "text-zinc-500";
          return (
            <a
              href="#faq"
              className={`inline-flex min-h-[44px] max-w-full items-center gap-1.5 rounded text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20 ${tone}`}
              aria-live="polite"
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColor}`} aria-hidden="true" />
              {unexpected > 0 ? (
                <span className="truncate font-medium">
                  {t("trust.badge.unexpected", { host: unexpectedHost ?? "?" })}
                </span>
              ) : (
                <span className={net.count === 0 ? "font-medium" : "tnum"}>
                  {net.count === 0
                    ? t("trust.badge.count")
                    : t("trust.badge.countN", { count: net.count })}
                  {/* Once the model is loaded, show a STATUS, not a rising request count: the count
                      includes cache-served requests on reload and misreads as a re-download (it is not —
                      the model is fetched once and served from the browser cache thereafter). */}
                  {ner.status === "ready" ? (
                    <span className="text-zinc-500"> · {t("trust.badge.modelLoaded")}</span>
                  ) : (
                    ner.modelRequests > 0 && (
                      <span className="text-zinc-500"> · {t("trust.badge.model", { count: ner.modelRequests })}</span>
                    )
                  )}
                </span>
              )}
            </a>
          );
        })()}
      </header>

      <main className="mx-auto max-w-2xl px-6">
        <section className="pt-12 text-center sm:pt-16">
          <img
            src="/logo.png"
            alt=""
            className="mx-auto h-24 w-24 object-contain sm:h-28 sm:w-28"
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
          />
          <div className="mt-3 text-xl font-semibold tracking-tight text-ink" dir="ltr" lang="en">
            Mechikon
          </div>
          <h1 className="mt-6 text-4xl font-semibold leading-[1.1] tracking-tight sm:text-[3.25rem]">
            {t("hero.title")}
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-zinc-500">
            {t("hero.subtitle")}
          </p>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed">
            <span className="marker-highlight text-zinc-700">{t("hero.subtitleSmall")}</span>
          </p>
          <p className="mt-3 text-[15px] font-medium text-ink">{t("hero.taglineStrong")}</p>
        </section>

        <section className="mt-12">
          <div className="mb-3 flex flex-col items-start gap-1 px-1">
            <div
              className="inline-flex rounded-full border border-hairline bg-surface p-0.5"
              role="group"
              aria-label={t("input.modeLabel")}
            >
              <button
                type="button"
                onClick={() => {
                  if (manualOnly) onToggleManualOnly();
                }}
                disabled={busy}
                aria-pressed={!manualOnly}
                className={`min-h-[44px] rounded-full px-4 text-[13px] font-medium transition disabled:opacity-40 ${
                  !manualOnly ? "bg-ink text-white" : "text-zinc-600 hover:text-ink"
                }`}
              >
                {t("input.modeAuto")}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!manualOnly) onToggleManualOnly();
                }}
                disabled={busy}
                aria-pressed={manualOnly}
                className={`min-h-[44px] rounded-full px-4 text-[13px] font-medium transition disabled:opacity-40 ${
                  manualOnly ? "bg-ink text-white" : "text-zinc-600 hover:text-ink"
                }`}
              >
                {t("input.modeManual")}
              </button>
            </div>
            {manualOnly && <p className="px-1 text-xs text-zinc-500">{t("input.modeManualHint")}</p>}
          </div>
          <div
            onDragOver={(event) => {
              if (busy) return;
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              if (busy) return; // ignore drops while a redaction is in flight, like the upload button
              void onFile(event.dataTransfer.files?.[0]);
            }}
            className={`rounded-3xl border bg-white p-2 shadow-card transition focus-within:shadow-[0_1px_2px_rgba(0,0,0,0.05),0_16px_40px_-16px_rgba(0,0,0,0.18)] ${
              dragging ? "border-dashed border-ink bg-surface" : "border-hairline"
            }`}
          >
            <textarea
              dir="rtl"
              lang="he"
              spellCheck={false}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              aria-label={t("input.paste.placeholder")}
              className="min-h-[168px] w-full resize-none rounded-2xl bg-transparent p-4 text-[17px] leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ink/20 placeholder:text-zinc-500"
              placeholder={t("input.paste.placeholder")}
            />
            <div className="flex flex-wrap items-center justify-between gap-3 px-2 pb-1">
              <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-full border border-hairline px-4 text-[14px] font-medium text-zinc-600 transition hover:border-zinc-300 hover:bg-surface">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M12 16V4m0 0L7 9m5-5 5 5M5 20h14"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {t("input.upload")}
                <input
                  type="file"
                  accept=".docx,.xlsx,.csv,.pdf,.txt"
                  className="hidden"
                  disabled={busy}
                  onChange={(event) => {
                    void onFile(event.target.files?.[0]);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
              <button
                type="button"
                onClick={onAnonymize}
                disabled={busy || input.trim().length === 0}
                className="min-h-[44px] rounded-full bg-ink px-6 text-[15px] font-medium text-white transition hover:opacity-90 active:scale-[0.98] disabled:opacity-30"
              >
                {t("input.submit")}
              </button>
            </div>
          </div>
          {input.length === 0 && !result && (
            <p className="mt-2 px-2 text-xs text-zinc-500">{t("input.dropHint")}</p>
          )}
          {looksReturnedFromAi && (
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 px-2 text-[13px] text-zinc-500">
              <span>{t("restore.reopenPrompt")}</span>
              <button
                type="button"
                onClick={() => {
                  // Move the pasted text into the restore flow as-is. Do NOT re-redact: these tokens are
                  // already placeholders to be turned back into originals. openRestore forces the text tab.
                  setRestoreInput(input);
                  openRestore();
                }}
                className="inline-flex min-h-[44px] items-center font-medium text-ink underline decoration-zinc-300 underline-offset-2 transition hover:decoration-ink"
              >
                {t("restore.title")}
              </button>
            </div>
          )}
          <p
            className={`mt-1 px-2 text-xs ${fileError ? "text-amber-700" : "text-zinc-500"}`}
            role="status"
            aria-live="polite"
          >
            {statusLine}
          </p>
          {scannedNotice && (
            <div
              className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] leading-relaxed text-amber-800"
              role="alert"
            >
              {t("input.scannedPdf")}
            </div>
          )}
          {limitNotice && (
            <div
              className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] leading-relaxed text-amber-800"
              role="alert"
            >
              {limitNotice === "pages" ? t("input.pdfTooManyPages") : t("input.fileTooLarge")}
            </div>
          )}
          {legacyXlsNotice && (
            <div
              className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] leading-relaxed text-amber-800"
              role="alert"
            >
              {t("input.legacyXls")}
            </div>
          )}
          {formulaNotice && (
            <div
              className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] leading-relaxed text-amber-800"
              role="alert"
            >
              {t("input.formulaPii")}
            </div>
          )}
          {selfVerifyNotice && (
            <div
              className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] leading-relaxed text-amber-800"
              role="alert"
            >
              {t("input.selfVerifyFailed")}
            </div>
          )}
          {scanNotice && (
            <div
              className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] leading-relaxed text-amber-800"
              role="alert"
            >
              {scanNotice === "lowQuality" ? t("input.scanLowQuality") : t("input.scanUnsafe")}
            </div>
          )}
          {unverifiedImagePages.length > 0 && (
            <div
              className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] leading-relaxed text-amber-800"
              role="alert"
            >
              {t("result.unverifiedImagePages", { pages: unverifiedImagePages.join(", ") })}
            </div>
          )}
          {pdfUnverifiedTerms.length > 0 && (
            <div
              className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] leading-relaxed text-amber-800"
              role="alert"
            >
              {t("result.pdfUnverified", { terms: pdfUnverifiedTerms.join(", ") })}
            </div>
          )}
          {scanProgress && (
            <div className="mt-3 rounded-2xl border border-hairline bg-surface px-4 py-3" aria-live="polite">
              <div className="flex items-center gap-2 text-xs text-zinc-600">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-hairline border-t-ink" aria-hidden />
                <span>
                  {scanProgress.phase === "verifying"
                    ? t("input.scanVerifying", { page: scanProgress.page ?? 1, total: scanProgress.total ?? 1 })
                    : t("input.scanReading", { page: scanProgress.page ?? 1, total: scanProgress.total ?? 1 })}
                </span>
              </div>
            </div>
          )}
          {source?.kind === "file" && source.scan && ner.status === "error" && !redacted && (
            <div
              className="mt-3 flex items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] leading-relaxed text-amber-800"
              role="alert"
            >
              <span>{t("input.scanNamesBlocked")}</span>
              <button
                type="button"
                onClick={onRetryNer}
                className="inline-flex min-h-[44px] shrink-0 items-center rounded-full border border-amber-300 px-4 text-xs font-medium hover:bg-amber-100"
              >
                {t("result.retryNames")}
              </button>
            </div>
          )}
          {ner.status === "loading" && (
            <div className="mt-3 rounded-2xl border border-hairline bg-surface px-4 py-3" aria-live="polite">
              <div className="flex items-center justify-between gap-3 text-xs text-zinc-600">
                <span>{t(ner.cachedBefore ? "ner.loadingCached" : "ner.loading")}</span>
                <span className="tabular-nums text-zinc-500">{ner.progress}%</span>
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-hairline">
                <div
                  className="h-full rounded-full bg-ink transition-[width] duration-300"
                  style={{ width: `${ner.progress}%` }}
                />
              </div>
            </div>
          )}
          {ner.status === "error" && (
            <p className="mt-3 px-2 text-xs text-amber-700" role="alert">{t("ner.error")}</p>
          )}
        </section>

        {result && (
          <section className="mt-8 animate-[fadeIn_200ms_ease-out]">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-ink" role="status" aria-live="polite">
                  {result.key.length > 0
                    ? t("result.found", { count: result.key.length })
                    : manualOnly
                      ? t("result.manualEmpty")
                      : t("result.none")}
                </span>
                {!manualOnly && !(source?.kind === "file" && source.scan) ? (
                  // Category-control legend (automatic mode, non-scan sources). Scans keep the plain count
                  // chips in P0 — their category filter is P1 (the OCR self-verify constraint).
                  <div className="w-full">
                    <CategoryLegend
                      counts={new Map(chips)}
                      disabled={disabledTypes}
                      busy={busy}
                      isScan={false}
                      onToggleFamily={onToggleFamily}
                    />
                  </div>
                ) : (
                  chips.map(([type, count]) => (
                    <span
                      key={type}
                      className="inline-flex items-center gap-1 rounded-full bg-surface px-2.5 py-1 text-xs text-zinc-600"
                    >
                      {t(TYPE_LABEL[type])}
                      <span className="tabular-nums text-zinc-600">{count}</span>
                    </span>
                  ))
                )}
                <button
                  type="button"
                  onClick={() => setShowManualInput((v) => !v)}
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition ${
                    showManualInput
                      ? "bg-ink text-white"
                      : "border border-hairline bg-white text-ink shadow-sm hover:bg-surface"
                  }`}
                >
                  {t("manual.add")}
                </button>
              </div>
              <div className="flex items-center gap-2">
                {/* The download affordance is decided by a single pure predicate (fileDownloadGate):
                    hidden (manual mode, zero redactions -> a byte-identical "_מושחר" file), pending (a
                    file whose names-upgrade has not settled -> withhold the download, incl. the H-race
                    window where the model is ready but the upgraded bytes are not yet committed), retry
                    (the model failed to load) or ready. */}
                {(() => {
                  const gate = fileDownloadGate({
                    hasRedacted: redacted !== null,
                    manualOnly,
                    keyCount: result.key.length,
                    sourceKind: source?.kind ?? null,
                    nerStatus: ner.status,
                    nerUpgrading,
                  });
                  if (gate === "hidden") {
                    return null;
                  }
                  if (gate === "pending") {
                    return (
                      <span className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full border border-hairline px-4 text-[13px] font-medium text-zinc-500">
                        {t("result.downloadPending")}
                      </span>
                    );
                  }
                  if (gate === "retry") {
                    return (
                      <button
                        type="button"
                        onClick={onRetryNer}
                        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full border border-red-300 bg-red-50 px-4 text-[13px] font-medium text-red-700 transition hover:bg-red-100"
                      >
                        {t("result.retryNames")}
                      </button>
                    );
                  }
                  return (
                    <button
                      type="button"
                      onClick={onDownload}
                      disabled={busy}
                      className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full bg-ink px-4 text-[13px] font-medium text-white transition hover:opacity-90 disabled:opacity-40"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path
                          d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14"
                          stroke="currentColor"
                          strokeWidth="1.9"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      {t("result.download")}
                    </button>
                  );
                })()}
              </div>
            </div>

            {nerAdded !== null && nerAdded > 0 && (
              <p
                className="mb-3 inline-flex animate-[fadeIn_200ms_ease-out] items-center gap-1.5 text-[13px] font-medium text-emerald-700"
                aria-live="polite"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M12 5v14M5 12h14"
                    stroke="currentColor"
                    strokeWidth="1.9"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {t("result.nerAdded", { count: nerAdded })}
              </p>
            )}

            {(showManualInput || manualTerms.length > 0) && (
              <div className="mb-3 rounded-2xl border border-hairline bg-surface p-3">
                {showManualInput && (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        dir="rtl"
                        value={manualInput}
                        onChange={(event) => setManualInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            onAddManual();
                          }
                        }}
                        placeholder={t("manual.placeholder")}
                        aria-label={t("manual.placeholder")}
                        className="min-h-[44px] w-full rounded-xl border border-hairline bg-white px-3 text-[16px] outline-none focus-visible:ring-2 focus-visible:ring-ink/20 placeholder:text-zinc-500 sm:w-auto sm:flex-1"
                      />
                      <input
                        dir="ltr"
                        value={manualLabel}
                        // ASCII/Latin only — sanitize to uppercase A–Z so the token renders on the PDF
                        // and the user physically cannot enter a name that would break.
                        onChange={(event) =>
                          setManualLabel(event.target.value.replace(/[^A-Za-z]/g, "").toUpperCase())
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            onAddManual();
                          }
                        }}
                        placeholder={t("manual.labelPlaceholder")}
                        aria-label={t("manual.labelPlaceholder")}
                        maxLength={20}
                        className="min-h-[44px] w-28 rounded-xl border border-hairline bg-white px-3 text-[16px] uppercase outline-none focus-visible:ring-2 focus-visible:ring-ink/20 placeholder:normal-case placeholder:text-zinc-500"
                      />
                      <button
                        type="button"
                        onClick={onAddManual}
                        disabled={manualInput.trim().length === 0}
                        className="min-h-[44px] rounded-full bg-ink px-4 text-[14px] font-medium text-white transition hover:opacity-90 disabled:opacity-30"
                      >
                        {t("manual.submit")}
                      </button>
                    </div>
                    <p className="px-1 text-[11px] text-zinc-500">{t("manual.labelHint")}</p>
                  </div>
                )}
                {manualTerms.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {manualTerms.map((mt) => (
                      <span
                        key={mt.value}
                        className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-xs text-ink"
                      >
                        {mt.label ? `${mt.value} → [${mt.label}]` : mt.value}
                        <button
                          type="button"
                          onClick={() => onRemoveManual(mt.value)}
                          aria-label={t("manual.remove")}
                          className="-me-2 inline-flex min-h-[44px] min-w-[44px] items-center justify-center text-zinc-500 transition hover:text-ink"
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {result.anonymizedText.trim().length > 0 && (
              <div
                role="note"
                className="mb-2 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[13px] font-semibold leading-relaxed text-emerald-800"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                  className="shrink-0 text-emerald-600"
                >
                  <path
                    d="M5 3l14 8-6 1.5L11 19 5 3z"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinejoin="round"
                  />
                </svg>
                <span>{t("result.manualClickBanner")}</span>
              </div>
            )}

            <div className="relative">
              {result.anonymizedText.trim().length > 0 && (
                <div className="absolute end-3 top-3 z-10 flex gap-1.5">
                  {/* Safety (manual mode, zero redactions): the copy would hand back untouched content, so
                      hide it until the user has hidden at least one value. */}
                  {!(manualOnly && result.key.length === 0) && (
                    <button
                      type="button"
                      onClick={onCopy}
                      disabled={busy}
                      title={t("result.copy")}
                      aria-label={copied ? t("result.copied") : t("result.copy")}
                      className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-hairline bg-white/80 text-zinc-500 backdrop-blur transition hover:bg-white hover:text-ink disabled:opacity-40"
                    >
                    {copied ? (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path
                          d="M5 12l4.5 4.5L19 7"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
                        <path
                          d="M5 15V5a2 2 0 0 1 2-2h8"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                        />
                      </svg>
                    )}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setPreviewExpanded((v) => !v)}
                    title={t(previewExpanded ? "result.collapse" : "result.expand")}
                    aria-label={t(previewExpanded ? "result.collapse" : "result.expand")}
                    className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-hairline bg-white/80 text-zinc-500 backdrop-blur transition hover:bg-white hover:text-ink"
                  >
                    {previewExpanded ? (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path
                          d="M4 10h4a2 2 0 0 0 2-2V4M20 10h-4a2 2 0 0 1-2-2V4M4 14h4a2 2 0 0 1 2 2v4M20 14h-4a2 2 0 0 0-2 2v4"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                        />
                      </svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path
                          d="M9 3H5a2 2 0 0 0-2 2v4M15 3h4a2 2 0 0 1 2 2v4M9 21H5a2 2 0 0 1-2-2v-4M15 21h4a2 2 0 0 0 2-2v-4"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                        />
                      </svg>
                    )}
                  </button>
                </div>
              )}
              <div
                dir="rtl"
                className={`whitespace-pre-wrap break-words rounded-2xl border border-hairline bg-surface p-5 pt-12 text-[17px] leading-loose ${
                  previewExpanded ? "" : "max-h-[50vh] overflow-y-auto"
                }`}
              >
                {renderInteractive(
                  result.anonymizedText,
                  manualTokenToTerm,
                  autoTokenToOriginal,
                  autoTokenToType,
                  onPickWord,
                  onRemoveManual,
                  onUnredactAuto,
                  t("result.clickRedact"),
                  t("result.clickUndo"),
                  t("result.clickReveal"),
                  manualOnly,
                )}
              </div>
            </div>
            {copyError && <p className="mt-2 px-2 text-xs text-amber-700" role="alert">{t("result.copyFailed")}</p>}
            {manualOnly ? (
              <p className="mt-3 rounded-xl bg-amber-50/60 px-3 py-2 text-xs leading-relaxed text-zinc-600">
                {t("result.noteManual")}
              </p>
            ) : source?.kind === "file" && ner.status === "error" ? (
              // Names detection failed for a file — the authoritative message is the hard block, not
              // the ordinary "loading…" note (which would read as if a file is on its way).
              <p
                className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-800"
                role="alert"
              >
                {t("result.downloadBlockedNoNames")}
              </p>
            ) : (
              <p className="mt-3 rounded-xl bg-amber-50/60 px-3 py-2 text-xs leading-relaxed text-zinc-600">
                {ner.status === "ready" ? t("result.noteNames") : t("result.note")}
              </p>
            )}

            {/* The AI-instruction disclosure pops as a short toast on copy (see onCopy) instead of sitting
                here as permanent clutter. Restore auto-opens on copy via openRestore. */}

            {result.key.length > 0 && (
              <div
                className={`mt-4 rounded-2xl border border-hairline bg-surface p-4 ${
                  keyDownloaded ? "" : "border-s-[3px] border-s-amber-300"
                }`}
              >
                {keyDownloaded ? (
                  // State B: calm confirmation. The key is saved; no more warnings.
                  <div className="flex items-start gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path
                          d="M5 12l4.5 4.5L19 7"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </div>
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium text-ink">{t("key.title")}</div>
                      <p className="mt-1 text-xs leading-relaxed text-ink">{t("key.downloaded")}</p>
                    </div>
                  </div>
                ) : (
                  // State A: guidance. One amber-weight irreversibility sentence, the rest zinc. When the
                  // key CHANGED after a prior download (G4), show only the quiet delta, not the full wall.
                  <div className="flex items-start gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-700">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <circle cx="8" cy="8" r="4" stroke="currentColor" strokeWidth="1.7" />
                        <path
                          d="M11 11l8 8m-3 0 3-3"
                          stroke="currentColor"
                          strokeWidth="1.7"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </div>
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium text-ink">{t("key.createTitle")}</div>
                      {keyEverDownloaded ? (
                        <p className="mt-1 text-xs font-medium leading-relaxed text-amber-800">
                          {t("key.changed")}
                        </p>
                      ) : (
                        <>
                          <p className="mt-1 text-xs leading-relaxed text-zinc-600">
                            {t("key.meaningless")}
                          </p>
                          <p className="mt-1 text-xs leading-relaxed text-zinc-600">
                            {t("key.sessionActive")}
                          </p>
                          <p className="mt-1 text-xs font-medium leading-relaxed text-amber-800">
                            {t("key.warning")}
                          </p>
                        </>
                      )}
                      {ner.status === "loading" && (
                        <p className="mt-1 text-xs leading-relaxed text-zinc-600">{t("key.notFinal")}</p>
                      )}
                    </div>
                  </div>
                )}

                <label className="mt-3 flex min-h-[44px] cursor-pointer items-center gap-2 py-2 text-[13px] text-zinc-700">
                  <input
                    type="checkbox"
                    checked={encryptKey}
                    onChange={(event) => setEncryptKey(event.target.checked)}
                    className="h-4 w-4 accent-ink"
                  />
                  {t("key.encrypt")}
                </label>
                {encryptKey && (
                  <div className="relative mt-2">
                    <input
                      ref={passphraseRef}
                      type={showPass ? "text" : "password"}
                      value={keyPassphrase}
                      onChange={(event) => {
                        setKeyPassphrase(event.target.value);
                        setPassphraseMissing(false);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void onDownloadKey();
                        }
                      }}
                      placeholder={t("key.passphrase")}
                      aria-label={t("key.passphrase")}
                      className="min-h-[44px] w-full rounded-xl border border-hairline bg-white px-3 py-2 pe-12 text-[16px] outline-none focus-visible:ring-2 focus-visible:ring-ink/20 placeholder:text-zinc-500"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPass((v) => !v)}
                      aria-label={t(showPass ? "key.hidePass" : "key.showPass")}
                      className="absolute inset-y-0 end-0 inline-flex min-h-[44px] min-w-[44px] items-center justify-center text-zinc-500 transition hover:text-ink"
                    >
                      {showPass ? (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <path
                            d="M3 3l18 18M10.6 10.6a3 3 0 0 0 4.2 4.2M9.9 5.2A9.6 9.6 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.1 6.1A17 17 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 3-.5"
                            stroke="currentColor"
                            strokeWidth="1.7"
                            strokeLinecap="round"
                          />
                        </svg>
                      ) : (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <path
                            d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"
                            stroke="currentColor"
                            strokeWidth="1.7"
                          />
                          <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7" />
                        </svg>
                      )}
                    </button>
                  </div>
                )}
                {passphraseMissing && (
                  <p className="mt-1 text-xs text-amber-700">{t("key.passphraseHint")}</p>
                )}
                <button
                  type="button"
                  onClick={() => void onDownloadKey()}
                  className="mt-3 inline-flex min-h-[44px] items-center gap-1.5 rounded-full bg-ink px-5 text-[14px] font-medium text-white transition hover:opacity-90 active:scale-[0.98]"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14"
                      stroke="currentColor"
                      strokeWidth="1.9"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {t(keyDownloaded ? "key.downloadAgain" : "key.download")}
                </button>
                {encryptKey && keyPassphrase.length === 0 && (
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => void onDownloadKey(true)}
                      className="text-xs text-zinc-600 underline decoration-zinc-300 underline-offset-2 transition hover:text-ink"
                    >
                      {t("key.downloadPlain")}
                    </button>
                    <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
                      {t("key.plainWarning")}
                    </p>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        <section className="mt-8" ref={restoreSectionRef}>
          <details
            open={restoreOpen}
            onToggle={(event) => setRestoreOpen(event.currentTarget.open)}
            className="group rounded-2xl border border-hairline bg-white transition hover:border-zinc-300"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between p-5 text-sm font-medium text-ink">
              {t("restore.title")}
              <span className="text-zinc-500 transition group-open:rotate-180" aria-hidden="true">
                ⌄
              </span>
            </summary>
            <div className="px-5 pb-5">
              <p className="text-xs leading-relaxed text-zinc-500">{t("restore.subtitle")}</p>

              {/* Step 1 — key. A live key shows a green done line + a quiet replace link; otherwise a
                  blocking upload step, since without a key there is nothing to restore. An encrypted key
                  that is uploaded but not yet unlocked (pendingEnc) leaves activeKey null, so it stays in
                  the upload state with the passphrase field below. */}
              {activeKey && activeKey.length > 0 ? (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2">
                  <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-emerald-800">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path
                        d="M5 12l4.5 4.5L19 7"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    {t("restore.keyActive", { count: activeKey.length })}
                  </span>
                  <label className="inline-flex min-h-[44px] cursor-pointer items-center text-xs font-medium text-emerald-700 underline underline-offset-2 transition hover:text-emerald-900">
                    {t("key.replace")}
                    <input
                      type="file"
                      accept=".json"
                      className="hidden"
                      onChange={(event) => {
                        void onUploadKey(event.target.files?.[0]);
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>
                </div>
              ) : (
                <div className="mt-3 rounded-xl border border-hairline bg-surface px-3 py-3">
                  <p className="text-[13px] text-zinc-600">{t("restore.keyStep")}</p>
                  <label className="mt-2 inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-full border border-hairline bg-white px-5 text-[14px] font-medium text-ink transition hover:bg-surface">
                    {uploadedKey ? t("key.loaded", { count: uploadedKey.length }) : t("key.upload")}
                    <input
                      type="file"
                      accept=".json"
                      className="hidden"
                      onChange={(event) => {
                        void onUploadKey(event.target.files?.[0]);
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>
                </div>
              )}
              {pendingEnc && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input
                    type="password"
                    value={unlockPassphrase}
                    onChange={(event) => setUnlockPassphrase(event.target.value)}
                    placeholder={t("key.passphrase")}
                    aria-label={t("key.passphrase")}
                    className="min-w-[200px] flex-1 rounded-xl border border-hairline bg-surface px-3 py-2 text-[16px] outline-none focus-visible:ring-2 focus-visible:ring-ink/20 placeholder:text-zinc-500"
                  />
                  <button
                    type="button"
                    onClick={onUnlockKey}
                    className="min-h-[44px] rounded-full bg-ink px-5 text-[14px] font-medium text-white transition hover:opacity-90"
                  >
                    {t("key.unlock")}
                  </button>
                </div>
              )}
              {keyError && (
                <p className="mt-2 text-xs text-amber-700" role="alert">
                  {keyError === "wrong" ? t("key.wrongPassphrase") : t("key.invalid")}
                </p>
              )}

              {/* Step 2 — what to restore: one segmented control, only one path shown at a time. */}
              <div
                className="mt-4 inline-flex rounded-full border border-hairline p-0.5"
                role="group"
                aria-label={t("restore.title")}
              >
                {(["text", "file"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setRestoreMode(mode)}
                    aria-pressed={restoreMode === mode}
                    className={`min-h-[44px] rounded-full px-4 text-[13px] font-medium transition ${
                      restoreMode === mode ? "bg-ink text-white" : "text-zinc-600 hover:text-ink"
                    }`}
                  >
                    {t(mode === "text" ? "restore.modeText" : "restore.modeFile")}
                  </button>
                ))}
              </div>

              {restoreMode === "text" ? (
                <>
                  <textarea
                    ref={restoreTextareaRef}
                    dir="rtl"
                    lang="he"
                    spellCheck={false}
                    value={restoreInput}
                    onChange={(event) => setRestoreInput(event.target.value)}
                    aria-label={t("restore.placeholder")}
                    className="mt-3 min-h-[120px] w-full resize-none rounded-2xl border border-hairline bg-surface p-4 text-[16px] leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ink/20 placeholder:text-zinc-500"
                    placeholder={t("restore.placeholder")}
                  />
                  <button
                    type="button"
                    onClick={onRestore}
                    disabled={restoreInput.trim().length === 0}
                    className="mt-3 min-h-[44px] rounded-full border border-hairline px-5 text-[15px] font-medium text-ink transition hover:bg-surface disabled:opacity-30"
                  >
                    {t("restore.submit")}
                  </button>

                  {/* Step 3 — output (M2 climax). */}
                  {restoreResult && (
                    <div className="mt-4" role="status" aria-live="polite">
                      {restoredCount > 0 && (
                        <p className="mb-2 inline-flex items-center gap-1.5 text-[13px] font-medium text-emerald-800">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                            <path
                              d="M5 12l4.5 4.5L19 7"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                          {t("restore.restoredCount", { count: restoredCount })}
                        </p>
                      )}
                      <div className="relative">
                        {restoreResult.restoredText.trim().length > 0 && (
                          <button
                            type="button"
                            onClick={onCopyRestored}
                            title={t("restore.copyRestored")}
                            aria-label={restoredCopied ? t("result.copied") : t("restore.copyRestored")}
                            className="absolute end-3 top-3 z-10 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-hairline bg-white/80 text-zinc-500 backdrop-blur transition hover:bg-white hover:text-ink"
                          >
                            {restoredCopied ? (
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                <path
                                  d="M5 12l4.5 4.5L19 7"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            ) : (
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
                                <path
                                  d="M5 15V5a2 2 0 0 1 2-2h8"
                                  stroke="currentColor"
                                  strokeWidth="1.8"
                                  strokeLinecap="round"
                                />
                              </svg>
                            )}
                          </button>
                        )}
                        <div
                          dir="rtl"
                          className="whitespace-pre-wrap break-words rounded-2xl border border-hairline bg-surface p-5 pt-12 text-[17px] leading-loose"
                        >
                          {highlightValues(
                            restoreResult.restoredText,
                            (activeKey ?? []).map((row) => row.original),
                          )}
                        </div>
                      </div>
                      {restoredCopyError && (
                        <p className="mt-2 text-xs text-amber-700">{t("result.copyFailed")}</p>
                      )}
                      {restoreResult.unmatched.length > 0 && (
                        <p className="mt-2 text-xs text-amber-700">
                          {t("restore.unmatched", { count: restoreResult.unmatched.length })}
                        </p>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <div className="mt-3">
                  <p className="text-xs leading-relaxed text-zinc-500">{t("restoreFile.explain")}</p>
                  <label className="mt-3 inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-full border border-hairline bg-white px-5 text-[14px] font-medium text-ink transition hover:bg-surface">
                    {t("restoreFile.upload")}
                    <input
                      type="file"
                      accept=".docx,.xlsx,.txt,.csv"
                      className="hidden"
                      onChange={(event) => {
                        void onRestoreFile(event.target.files?.[0]);
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>
                  {restoreFileDone && (
                    <p className="mt-2 inline-flex items-center gap-1.5 text-[13px] font-medium text-emerald-800">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path
                          d="M5 12l4.5 4.5L19 7"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      {t("restore.fileSuccess")}
                    </p>
                  )}
                  {restoreFileError && (
                    <p className="mt-2 text-xs text-amber-700" role="alert">
                      {restoreFileError === "nokey"
                        ? t("restoreFile.noKey")
                        : restoreFileError === "unsupported"
                          ? t("restoreFile.unsupported")
                          : restoreFileError === "toobig"
                            ? t("restoreFile.tooLarge")
                            : t("restoreFile.generic")}
                    </p>
                  )}
                  {restoreUnmatched > 0 && (
                    <p className="mt-2 text-xs text-amber-700">
                      {t("restore.unmatched", { count: restoreUnmatched })}
                    </p>
                  )}
                </div>
              )}
            </div>
          </details>
        </section>

        <section id="faq" className="mx-auto mt-24 max-w-2xl scroll-mt-6 px-1">
          <h2 className="text-center text-lg font-semibold tracking-tight">{t("faq.heading")}</h2>
          <div className="mt-6 space-y-3">
            {faqItems.map((key) => (
              <details
                key={key}
                className="group rounded-2xl border border-hairline bg-white px-5 open:shadow-card"
              >
                <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-3 py-4 text-[15px] font-semibold leading-snug marker:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20">
                  <span>{t(`faq.${key}.q`)}</span>
                  <svg
                    className="h-4 w-4 shrink-0 text-zinc-500 transition-transform group-open:rotate-180"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </summary>
                <p className="whitespace-pre-line pb-5 text-[13px] leading-relaxed text-zinc-600">{t(`faq.${key}.a`)}</p>
              </details>
            ))}
          </div>
        </section>
      </main>

      <footer className="mx-auto mt-24 max-w-2xl px-6 pb-16 text-center text-xs leading-relaxed text-zinc-500">
        <p className="text-sm text-zinc-600">
          {t("contact.lawyersCta")}{" "}
          <a
            href="https://www.bai-solutions.com/#contact"
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-[44px] items-center font-semibold text-ink underline decoration-zinc-300 underline-offset-4 transition hover:decoration-ink"
          >
            {t("contact.link")}
          </a>
        </p>
        <p className="mt-6 text-zinc-500">{t("trust.tagline")}</p>
        <p className="mx-auto mt-3 max-w-xl">{t("legal.notAdvice")}</p>
        <p className="mx-auto mt-3 max-w-xl">{t("legal.asIs")}</p>
        <p className="mt-4">{t("legal.brand")}</p>
        <p className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1">
          <a
            href="/terms.html"
            className="inline-flex min-h-[44px] items-center text-ink underline decoration-zinc-300 underline-offset-4 transition hover:decoration-ink"
          >
            {t("terms.link")}
          </a>
          <a
            href="/accessibility.html"
            className="inline-flex min-h-[44px] items-center text-ink underline decoration-zinc-300 underline-offset-4 transition hover:decoration-ink"
          >
            {t("accessibility.link")}
          </a>
        </p>
      </footer>
    </div>
  );
}
