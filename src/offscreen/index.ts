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
import { detectTextLang } from "../shared/instruction";
import type { Lang } from "../shared/i18n";

const loaders: Record<Lang, (options?: NerLoadOptions) => Promise<Ner>> = {
  he: createHebrewNer,
  en: createEnglishNer,
};

const nerByLang: Partial<Record<Lang, Promise<Ner>>> = {};
const announced = new Set<Lang>();

function getNer(lang: Lang): Promise<Ner> {
  let promise = nerByLang[lang];
  if (!promise) {
    promise = loaders[lang]({
      device: "wasm",
      numThreads: 1,
      wasmPaths: chrome.runtime.getURL("vendor/ort/"),
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
      const spans = await ner.recognize(text);
      sendResponse({ ok: true, spans });
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
  return true; // keep the message channel open for the async sendResponse
});

// eslint-disable-next-line no-console
console.log("[mechikon] offscreen NER document loaded");
