/**
 * Shared NER request — one copy of the ner:request contract for content + popup. Returns whether the
 * model actually answered (`ok`) so callers can tell a genuine "no names here" (ok:true, spans:[]) from
 * "the model didn't respond in time" (ok:false) — the latter must NOT be shown as fully protected.
 */
import type { Span } from "@engine/types";

export interface NerResult {
  readonly spans: Span[];
  /** True only if the offscreen model responded; false on timeout / no receiver / error. */
  readonly ok: boolean;
}

export function requestNer(text: string, timeoutMs = 8000): Promise<NerResult> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: NerResult) => {
      if (!done) {
        done = true;
        resolve(result);
      }
    };
    const timer = setTimeout(() => finish({ spans: [], ok: false }), timeoutMs);
    try {
      chrome.runtime.sendMessage({ type: "ner:request", text }, (resp) => {
        clearTimeout(timer);
        void chrome.runtime.lastError; // read to silence "Unchecked runtime.lastError"
        finish(resp?.ok ? { spans: (resp.spans as Span[]) ?? [], ok: true } : { spans: [], ok: false });
      });
    } catch {
      clearTimeout(timer);
      finish({ spans: [], ok: false });
    }
  });
}
