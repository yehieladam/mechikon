/**
 * Offscreen NER host. Loads the Hebrew NER model once (WASM, single-threaded — extension pages are
 * not crossOriginIsolated) using the LOCALLY vendored ORT runtime, and answers name/org/location
 * detection requests. The 185MB model weights download once from HF and are Cache-Storage cached;
 * no sensitive text ever leaves the device — only the model code is fetched.
 */
import { createHebrewNer, type HebrewNer } from "@engine/ner";

let nerPromise: Promise<HebrewNer> | null = null;

function getNer(): Promise<HebrewNer> {
  if (!nerPromise) {
    nerPromise = createHebrewNer({
      device: "wasm",
      numThreads: 1,
      wasmPaths: chrome.runtime.getURL("vendor/ort/"),
    });
  }
  return nerPromise;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "ner:detect") {
    return undefined;
  }
  void (async () => {
    try {
      const ner = await getNer();
      const spans = await ner.recognize(String(msg.text ?? ""));
      sendResponse({ ok: true, spans });
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
  return true; // keep the message channel open for the async sendResponse
});

// Warm the model on load so the first real request is fast; announce readiness for the UI indicator.
void getNer()
  .then(() => chrome.runtime.sendMessage({ type: "ner:ready" }).catch(() => undefined))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[mechikon] NER load failed", err);
  });

// eslint-disable-next-line no-console
console.log("[mechikon] offscreen NER document loaded");
