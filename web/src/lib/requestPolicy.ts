/**
 * The network policy the trust badge enforces by observation: every request the app may make must be
 * either same-origin or to one of the model/runtime hosts. Anything else is an EXFILTRATION signal —
 * the badge turns it into a visible red alarm instead of a silent count. Shared by the main-thread and
 * worker monitors so both classify destinations identically (this is the M1 fix: prove WHERE, not just
 * how many).
 *
 * Hosts (kept in sync with the CSP connect-src in web/vite.config.ts + vercel.json): huggingface.co
 * (model resolve) + *.hf.co (the Xet CDN that serves the model bytes) + cdn.jsdelivr.net (onnxruntime
 * wasm). When the model self-hosts on R2 (P4-02) these collapse to same-origin and this list can go.
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
 */
/**
 * Vercel Web Analytics infrastructure path. Beacons for page views + the file_redacted custom event go
 * here, same-origin, carrying only aggregate labels (never document content). Like the browser-fetched
 * static assets, these are NOT part of the "0 requests carrying your data" promise, so the trust badge
 * EXCLUDES them from its count — while the exfiltration alarm (unexpected host) stays fully in force. The
 * path is same-origin, so it is already `isAllowedRequest`-allowed; this predicate only gates the COUNT.
 */
export function isAnalyticsBeacon(url: string, origin: string): boolean {
  try {
    const parsed = new URL(url, origin);
    return parsed.origin === origin && parsed.pathname.startsWith("/_vercel/insights");
  } catch {
    return false;
  }
}

export function isAllowedRequest(url: string, origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url, origin);
  } catch {
    return false;
  }
  if (parsed.protocol === "blob:" || parsed.protocol === "data:") {
    return true; // in-memory, never leaves the device
  }
  return parsed.origin === origin || isModelHost(parsed.hostname);
}
