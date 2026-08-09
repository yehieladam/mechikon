/**
 * Worker-side network monitor. The main-thread monitor (lib/networkMonitor.ts) cannot see requests a
 * Web Worker makes — a worker has its own realm and its own `fetch`. The ONLY network the worker ever
 * does is the one-time model download (transformers.js fetching the ONNX + tokenizer + the ORT wasm).
 * Hard rule 2 says that download is the single permitted request and must be surfaced honestly: we
 * classify each request's destination and report the allowed (model-host) count separately from any
 * UNEXPECTED host, which the badge turns into a red exfiltration alarm.
 *
 * Patch `self.fetch` at the very top of the worker, before any dynamic import can fetch, and report to
 * a listener the main thread registers over Comlink. Idempotent.
 */
import { isAllowedRequest } from "../lib/requestPolicy";

export interface WorkerNetworkReport {
  /** Allowed requests (model host or same-origin) — the expected one-time model download. */
  readonly ok: number;
  /** Requests to any other host — should never happen; the badge alarms on it. */
  readonly unexpected: number;
  /** The first unexpected host seen, for the badge to name it. */
  readonly unexpectedHost: string | null;
}

type WorkerFetchListener = (report: WorkerNetworkReport) => void;

interface MonitoredGlobal {
  __workerNetPatched?: boolean;
}

let report: WorkerNetworkReport = { ok: 0, unexpected: 0, unexpectedHost: null };
let listener: WorkerFetchListener | null = null;

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

/** Request method for classification: init.method wins (fetch semantics), then a Request object's
 *  method, else GET (a bare fetch is a GET). Non-GET to a model host = exfiltration signal (B5). */
function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  if (typeof init?.method === "string" && init.method !== "") {
    return init.method;
  }
  if (typeof input === "object" && "method" in input && typeof input.method === "string") {
    return input.method;
  }
  return "GET";
}

/** Patch `self.fetch` to count + classify worker requests and notify the listener. Call first thing. */
export function installWorkerNetworkMonitor(): void {
  const scope = globalThis as typeof globalThis & MonitoredGlobal;
  if (scope.__workerNetPatched || typeof scope.fetch !== "function") {
    return;
  }
  scope.__workerNetPatched = true;

  const origin = scope.location?.origin ?? "";
  const originalFetch = scope.fetch.bind(scope);
  scope.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (isAllowedRequest(url, origin, methodOf(input, init))) {
      report = { ...report, ok: report.ok + 1 };
    } else {
      let host: string | null = null;
      try {
        host = new URL(url, origin).hostname;
      } catch {
        host = null;
      }
      report = { ok: report.ok, unexpected: report.unexpected + 1, unexpectedHost: report.unexpectedHost ?? host };
    }
    listener?.(report);
    return originalFetch(input, init);
  };
}

/** Register the main thread's callback (Comlink-proxied). Immediately replays the current report. */
export function onWorkerNetwork(callback: WorkerFetchListener): void {
  listener = callback;
  callback(report);
}
