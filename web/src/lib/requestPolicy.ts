/**
 * The network policy the trust badge enforces by observation: every request the app may make must be
 * either same-origin or to one of the model/runtime hosts. Anything else is an EXFILTRATION signal —
 * the badge turns it into a visible red alarm instead of a silent count. Shared by the main-thread and
 * worker monitors so both classify destinations identically (this is the M1 fix: prove WHERE, not just
 * how many).
 *
 * Hosts (kept in sync with the CSP connect-src in web/vite.config.ts + vercel.json — the CSP entry
 * for huggingface.co is additionally path-narrowed to the one model repo; this observer classifies by
 * host + method): huggingface.co (model resolve) + *.hf.co (the Xet CDN that serves the model bytes)
 * + cdn.jsdelivr.net (onnxruntime wasm). When the model self-hosts on R2 (P4-02) these collapse to
 * same-origin and this list can go.
 */
const MODEL_HOSTS = ["huggingface.co", "hf.co", "jsdelivr.net"] as const;

export function isModelHost(host: string): boolean {
  return MODEL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * True when a request URL is allowed: same-origin, an allowed model host, or in-memory blob:/data:
 * (onnxruntime-web's threaded backend fetches its wasm and worker bootstrap via blob: URLs — CSP
 * `connect-src blob:` mirrors this). An UNPARSEABLE URL fails CLOSED: we cannot prove where it aims,
 * so it counts as unexpected. A crafted/odd URL must alarm, not slip through — a false alarm is
 * recoverable; a silent exfiltration path is not (the CSP remains the hard backstop either way).
 *
 * `method` (B5): the model path is READ-ONLY — transformers.js and onnxruntime-web only ever GET from
 * these hosts, so a non-GET request (POST/PUT/...) aimed at a model host carries a request body and is
 * an exfiltration signal, not a model fetch: it is classified unexpected. Same-origin requests are not
 * method-gated (they never leave the device). Callers that cannot know the method omit it; GET is the
 * default because every observed primitive without an explicit method (WebSocket handshake,
 * EventSource, bare fetch) issues a GET.
 */
export function isAllowedRequest(url: string, origin: string, method: string = "GET"): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url, origin);
  } catch {
    return false;
  }
  if (parsed.protocol === "blob:" || parsed.protocol === "data:") {
    return true; // in-memory, never leaves the device
  }
  if (parsed.origin === origin) {
    return true;
  }
  return isModelHost(parsed.hostname) && method.toUpperCase() === "GET";
}
