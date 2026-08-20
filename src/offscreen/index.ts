/**
 * Offscreen NER host. Loads a NER model on demand (WASM, single-threaded — extension pages are not
 * crossOriginIsolated) using the LOCALLY vendored ORT runtime, and answers name/org/location requests.
 *
 * Lazy, per-language: the model is chosen from the request text's own language and loaded only when
 * first needed, so a Hebrew-only user never downloads the English weights and vice versa. Weights
 * download once from HF and are Cache-Storage cached; no sensitive text ever leaves the device — only
 * the model code is fetched.
 */
import { createHebrewNer, createEnglishNer, type Ner, type NerLoadOptions } from "@engine/ner";
import type { Span } from "@engine/types";
import { detectTextLang } from "../shared/instruction";
import { chunkText } from "../shared/chunk";
import type { Lang } from "../shared/i18n";

const loaders: Record<Lang, (options?: NerLoadOptions) => Promise<Ner>> = {
  he: createHebrewNer,
  en: createEnglishNer,
};

const nerByLang: Partial<Record<Lang, Promise<Ner>>> = {};
const announced = new Set<Lang>();

/** A transformers.js download-progress event (only the fields we use). Byte counts are per file; the
 *  model weights file dominates, but we aggregate across all files so the percentage is accurate. */
interface ProgressEvent {
  readonly status?: string;
  readonly file?: string;
  readonly loaded?: number;
  readonly total?: number;
}

/** Build a progress_callback that aggregates per-file byte counts and broadcasts a monotonic 0-100 %
 *  (throttled to whole-percent increases) so the UI can show "downloading model 45%". Failures to
 *  send (no receiver) are ignored — progress is best-effort. */
function makeProgressCallback(lang: Lang): (event: unknown) => void {
  const byFile = new Map<string, { loaded: number; total: number }>();
  let lastPct = -1;
  return (event: unknown) => {
    const e = event as ProgressEvent;
    if (!e || !e.file || typeof e.total !== "number" || e.total <= 0) {
      return;
    }
    byFile.set(e.file, { loaded: e.loaded ?? 0, total: e.total });
    let loaded = 0;
    let total = 0;
    for (const entry of byFile.values()) {
      loaded += entry.loaded;
      total += entry.total;
    }
    const pct = Math.max(0, Math.min(100, Math.round((loaded / total) * 100)));
    // Emit on ANY change, not only increases: files are discovered incrementally, so a small early
    // file can hit 100% of the bytes-seen-so-far and the aggregate then DROPS when the large weights
    // file appears. A monotonic gate would latch that premature 100% and suppress every later update,
    // freezing the UI. Reporting the (occasionally dipping) real aggregate keeps progress moving.
    if (pct !== lastPct) {
      lastPct = pct;
      void chrome.runtime.sendMessage({ type: "ner:progress", lang, pct }).catch(() => undefined);
    }
  };
}

function getNer(lang: Lang): Promise<Ner> {
  let promise = nerByLang[lang];
  if (!promise) {
    promise = loaders[lang]({
      device: "wasm",
      numThreads: 1,
      wasmPaths: chrome.runtime.getURL("vendor/ort/"),
      progressCallback: makeProgressCallback(lang),
    });
    nerByLang[lang] = promise;
    // Announce readiness once this model finishes loading so the UI can flip its "protected" indicator.
    void promise
      .then(() => {
        if (!announced.has(lang)) {
          announced.add(lang);
          void chrome.runtime.sendMessage({ type: "ner:ready", lang }).catch(() => undefined);
        }
      })
      .catch((err) => {
        // Drop the cached rejection so a later request can retry the download.
        if (nerByLang[lang] === promise) {
          delete nerByLang[lang];
        }
        // Surface the failure to the UI (the offscreen console is invisible to users), so the chip can
        // stop spinning and tell the user instead of hanging on "masking names…" forever.
        void chrome.runtime
          .sendMessage({ type: "ner:error", lang, message: err instanceof Error ? err.message : String(err) })
          .catch(() => undefined);
        // eslint-disable-next-line no-console
        console.error("[mechikon] NER load failed", lang, err);
      });
  }
  return promise;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "ner:detect") {
    return undefined;
  }
  void (async () => {
    try {
      const text = String(msg.text ?? "");
      // Pick the model from the text's own dominant script (tokens + instruction stripped first).
      const lang = detectTextLang(text, "he");
      const ner = await getNer(lang);
      // Chunk so the 512-wordpiece tokenizer cap doesn't silently drop names past the first ~2 KB of a
      // long document. Shift each chunk's spans back into full-text coordinates and concatenate.
      const spans: Span[] = [];
      for (const chunk of chunkText(text)) {
        const chunkSpans = await ner.recognize(chunk.text);
        for (const span of chunkSpans) {
          spans.push({ ...span, start: span.start + chunk.offset, end: span.end + chunk.offset });
        }
      }
      sendResponse({ ok: true, spans });
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
  return true; // keep the message channel open for the async sendResponse
});

// eslint-disable-next-line no-console
console.log("[mechikon] offscreen NER document loaded");
