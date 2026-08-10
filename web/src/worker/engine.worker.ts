/**
 * Engine Web Worker — runs the framework-free engine off the UI thread (P0I-01). Comlink exposes an
 * async API; the app never touches the engine on the main thread, so a large document + the 185 MB
 * NER model never freeze the UI.
 *
 * Two anonymize modes:
 *  - deterministic (instant, no model) — regex + checksum recognizers only.
 *  - smart — deterministic PLUS Hebrew NER names/orgs/places, but ONLY once the model is loaded. The
 *    model is loaded lazily and explicitly (`loadNer`); until then smart == deterministic.
 *
 * The only network this worker ever does is that one-time model download. It is counted by
 * installWorkerNetworkMonitor (before any import can fetch) and reported to the main thread, so the
 * trust badge stays honest (hard rule 2).
 */
import * as Comlink from "comlink";
// Import from specific engine modules, NOT the @engine/index barrel — the barrel re-exports ner.ts
// (which pulls transformers.js + onnxruntime's wasm). Keeping that out of this graph is what makes
// the deterministic path instant and lets the model lazy-load only when NER is used (P0I-02).
import { anonymizeDeterministic, anonymizeManualOnly, anonymizeWith } from "@engine/pipeline";
import { manualSpans, type ManualInput } from "@engine/manual";
import { restore } from "@engine/restore";
import type { AnonymizeResult, EntityType, KeyRow, Span } from "@engine/types";
import type { RestoreResult } from "@engine/restore";
import type { HebrewNer } from "@engine/ner";
import { redactFile, type FileRedaction } from "./officeRedact";
import { restoreFile, type RestoredFile } from "./restoreFile";
import { buildTokenDocx } from "./textDocx";
import {
  installWorkerNetworkMonitor,
  onWorkerNetwork,
  type WorkerNetworkReport,
} from "./workerNetworkMonitor";

// Patch the worker's fetch at module-eval, well before any loadNer() call reaches the network.
installWorkerNetworkMonitor();

export type NerStatus = "idle" | "loading" | "ready" | "error";

let nerStatus: NerStatus = "idle";
let ner: HebrewNer | null = null;
let nerLoad: Promise<void> | null = null;

// Cache the last NER recognition (keyed by exact text). Re-running the SAME document — a category toggle,
// a manual-term add, a reveal — is a pure post-detection change, so it must not pay the multi-second model
// inference again. Model inference is deterministic for identical text, so returning the cached spans is
// exact. Holds one text + its spans (negligible); a new document's text misses and recomputes.
let lastNerText: string | null = null;
let lastNerSpans: readonly Span[] = [];

/** NER recognition with a single-entry text cache (see above). Returns [] until the model is ready. */
async function recognizeCached(text: string): Promise<readonly Span[]> {
  if (ner === null) {
    return [];
  }
  if (text === lastNerText) {
    return lastNerSpans;
  }
  const spans = await ner.recognize(text);
  lastNerText = text;
  lastNerSpans = spans;
  return spans;
}

/** Multi-threaded ORT needs a crossOriginIsolated context; fall back to 1 thread otherwise. */
function threadCount(): number {
  const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated ?? false;
  const cores = (globalThis.navigator as Navigator | undefined)?.hardwareConcurrency ?? 1;
  return isolated ? Math.min(4, Math.max(1, cores)) : 1;
}

/**
 * Anonymize with NER names when the model is ready, plus any manual user terms — the terms the user
 * added by hand for things the detectors missed (highest priority).
 */
async function anonymizeSmart(
  text: string,
  manualTerms: readonly ManualInput[] = [],
  manualOnly = false,
  excluded: readonly string[] = [],
  disabledTypes: readonly EntityType[] = [],
): Promise<AnonymizeResult> {
  // Manual-only: redact ONLY the user's chosen terms — skip deterministic detection AND NER (no model).
  // No automatic detections exist, so `excluded` and `disabledTypes` (which only drop AUTO spans) are both
  // irrelevant here.
  if (manualOnly) {
    return anonymizeManualOnly(text, manualTerms);
  }
  const nerSpans = await recognizeCached(text);
  return anonymizeWith(text, [...nerSpans, ...manualSpans(text, manualTerms)], excluded, disabledTypes);
}

const api = {
  /** Register the main thread's network listener (Comlink-proxied). See workerNetworkMonitor. */
  onNetwork(callback: (report: WorkerNetworkReport) => void): void {
    onWorkerNetwork(callback);
  },

  /** Current NER load state, for the UI banner. */
  getNerStatus(): NerStatus {
    return nerStatus;
  },

  /**
   * Load the Hebrew NER model (idempotent). `onProgress` receives transformers.js progress events
   * (Comlink-proxied). Resolves when the model is ready; on failure sets status "error" and rethrows.
   */
  async loadNer(onProgress?: (event: unknown) => void): Promise<void> {
    if (nerLoad !== null) {
      return nerLoad;
    }
    nerStatus = "loading";
    nerLoad = (async () => {
      try {
        const { createHebrewNer } = await import("@engine/ner");
        ner = await createHebrewNer({
          device: "wasm",
          numThreads: threadCount(),
          progressCallback: onProgress,
        });
        nerStatus = "ready";
      } catch (error) {
        nerStatus = "error";
        nerLoad = null; // allow a retry
        throw error;
      }
    })();
    return nerLoad;
  },

  /** Deterministic-only anonymize. Instant, no model. */
  anonymize(text: string): AnonymizeResult {
    return anonymizeDeterministic(text);
  },

  /** Deterministic + NER names (when ready) + manual user terms. `manualOnly` redacts ONLY the user's
   *  terms (no auto-detection, no model). */
  anonymizeSmart(
    text: string,
    manualTerms: readonly ManualInput[] = [],
    manualOnly = false,
    excluded: readonly string[] = [],
    disabledTypes: readonly EntityType[] = [],
  ): Promise<AnonymizeResult> {
    return anonymizeSmart(text, manualTerms, manualOnly, excluded, disabledTypes);
  },

  /**
   * Process an uploaded file: overlay-redact the ORIGINAL (docx/xlsx keep logo/layout; txt/csv plain)
   * and return the redacted bytes + detection result. Uses NER names when ready + manual user terms.
   * `scanOcr` (Stage 5, default off) enables the OCR redaction path for a scanned PDF; `onProgress` is a
   * Comlink-proxied callback for the slow OCR op (the App shows per-page progress).
   */
  redactFile(
    fileName: string,
    buffer: ArrayBuffer,
    manualTerms: readonly ManualInput[] = [],
    scanOcr = false,
    onProgress?: (event: { phase: "reading" | "verifying"; page: number; total: number }) => void,
    manualOnly = false,
    excluded: readonly string[] = [],
    disabledTypes: readonly EntityType[] = [],
  ): Promise<FileRedaction> {
    // The category filter rides inside the injected anonymize closure, so every text-based path (docx,
    // xlsx, txt, csv, digital PDF) picks it up with no per-path change. The scan path is NOT filtered in P0
    // — the App passes an empty disabledTypes for scanned PDFs so the OCR self-verify (which re-runs this
    // same closure on the redacted output) can never refuse a deliberately-visible value (that is P1).
    return redactFile(
      fileName,
      buffer,
      (text) => anonymizeSmart(text, manualTerms, manualOnly, excluded, disabledTypes),
      { scanOcr, onProgress, disabledTypes },
    );
  },

  /** Classify a PDF as text-layer vs scanned image (Stage 5) so the App can defer a scan until NER-ready
   * — avoids a wasted deterministic-only OCR pass before names are available. */
  async classifyPdf(buffer: ArrayBuffer): Promise<"text" | "scan"> {
    const { isScannedPdf } = await import("./pdfRedact");
    return (await isScannedPdf(buffer)) ? "scan" : "text";
  },

  /** Put original values back using the key (tolerant matcher). */
  restore(text: string, key: readonly KeyRow[]): RestoreResult {
    return restore(text, key);
  },

  /**
   * Wrap tokenized text in a minimal .docx — the "Word for AI" output for a redacted PDF (whose visual
   * redaction carries no tokens). The tokens are LLM-workable and the file restores via restoreFile.
   */
  buildTokenDocx(text: string): Promise<Uint8Array> {
    return buildTokenDocx(text);
  },

  /** Restore an uploaded file (docx/txt) with the key → reconstructed file bytes to download. */
  restoreFile(fileName: string, buffer: ArrayBuffer, key: readonly KeyRow[]): Promise<RestoredFile> {
    return restoreFile(fileName, buffer, key);
  },
};

export type EngineApi = typeof api;
export type { Span };

Comlink.expose(api);
