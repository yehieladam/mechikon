/**
 * Shared NER request — one copy of the ner:request message contract, used by both the content script
 * and the popup. Asks the offscreen model (via the service worker) for name/org/location spans, and
 * resolves [] on timeout so a slow/cold model never blocks the caller.
 */
import type { Span } from "@engine/types";

export function requestNer(text: string, timeoutMs = 8000): Promise<Span[]> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (spans: Span[]) => {
      if (!done) {
        done = true;
        resolve(spans);
      }
    };
    const timer = setTimeout(() => finish([]), timeoutMs);
    try {
      chrome.runtime.sendMessage({ type: "ner:request", text }, (resp) => {
        clearTimeout(timer);
        void chrome.runtime.lastError; // read to silence "Unchecked runtime.lastError"
        finish(resp?.ok ? (resp.spans as Span[]) : []);
      });
    } catch {
      clearTimeout(timer);
      finish([]);
    }
  });
}
