/**
 * Real network monitor — turns the "0 בקשות רשת" trust badge from a hardcoded claim into a LIVE,
 * browser-enforced observation (P2W-04). We patch every primitive a page could use to reach the network
 * and, for each call, count it AND classify its destination: same-origin / model host = expected, any
 * other host = UNEXPECTED (an exfiltration signal the badge surfaces in red). In the deterministic
 * paste/file path the app makes zero requests, so the badge honestly reads 0; if any code (or a
 * compromised dependency) ever tried to phone home, the count climbs and — if it aimed off-policy —
 * the badge alarms with the host. Honesty by observation, not by promise (docs/trust.md).
 *
 * Patch once, as early as possible (imported at the top of main.tsx) so nothing slips through before
 * the wrappers are installed. Same-origin static assets (HTML/JS/CSS, the logo) are fetched by the
 * browser itself, NOT through these JS primitives, so they do not count — only script-initiated
 * requests do, which is exactly what the promise is about.
 *
 * Scope note: this observes the MAIN thread. The engine worker has its own realm and fetch — its
 * one-time model download is monitored + classified separately (worker/workerNetworkMonitor.ts).
 */
import { isAllowedRequest, isAnalyticsBeacon } from "./requestPolicy";

export interface NetworkState {
  /** Total script-initiated requests on this page (must stay 0 on the local paste/file path). */
  readonly count: number;
  /** Requests aimed at a host that is neither same-origin nor a model host — an exfiltration signal. */
  readonly unexpected: number;
  /** The first unexpected host seen, for the badge to name it. */
  readonly unexpectedHost: string | null;
}

let state: NetworkState = { count: 0, unexpected: 0, unexpectedHost: null };
const listeners = new Set<() => void>();
let installed = false;

function urlString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof URL) {
    return value.href;
  }
  if (value && typeof value === "object" && "url" in value && typeof (value as { url: unknown }).url === "string") {
    return (value as { url: string }).url;
  }
  return "";
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function record(rawUrl: unknown): void {
  const url = urlString(rawUrl);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  // Anonymous analytics beacons are infrastructure, not user data — exclude them from the count so the
  // badge keeps reading the true "0 requests carrying your data" on the redact path. The exfil alarm is
  // unaffected: this path is same-origin, so it could never have tripped `unexpected` anyway.
  if (isAnalyticsBeacon(url, origin)) {
    return;
  }
  const ok = isAllowedRequest(url, origin);
  let host: string | null = null;
  if (!ok) {
    try {
      host = new URL(url, origin).hostname;
    } catch {
      host = null;
    }
  }
  state = {
    count: state.count + 1,
    unexpected: state.unexpected + (ok ? 0 : 1),
    unexpectedHost: state.unexpectedHost ?? host,
  };
  notify();
}

/**
 * Record a request that is unexpected BY DEFINITION, regardless of destination — used for WebRTC,
 * which has no legitimate use in this app (no calls, no P2P). ICE/STUN/data channels reach hosts
 * without ever touching fetch/XHR/WebSocket, so a peer connection is an exfiltration signal per se.
 */
function recordUnexpected(host: string): void {
  state = {
    count: state.count + 1,
    unexpected: state.unexpected + 1,
    unexpectedHost: state.unexpectedHost ?? host,
  };
  notify();
}

/** Best-effort name of the first ICE server host, so the badge can say WHERE the connection aimed. */
function webRtcHost(configuration?: RTCConfiguration): string {
  const servers = configuration?.iceServers ?? [];
  for (const server of servers) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    for (const url of urls) {
      // stun:/turn: are non-special schemes — WHATWG URL leaves hostname empty, so parse by hand.
      const match = /^(?:stun|stuns|turn|turns):([^:/?#]+)/i.exec(url);
      if (match) {
        return match[1];
      }
    }
  }
  return "webrtc";
}

export function getNetworkState(): NetworkState {
  return state;
}

export function subscribeNetwork(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Install the wrappers. Idempotent — safe to call more than once (only the first call patches).
 * Each wrapper records the request (count + destination) then delegates to the original, unchanged.
 */
export function installNetworkMonitor(): void {
  if (installed || typeof window === "undefined") {
    return;
  }
  installed = true;

  // Every patch below guards its global with `typeof X !== "undefined"` first. A missing global (SSR,
  // node tests, an odd browser) must be a no-op, never a crash — installNetworkMonitor() must not throw
  // just because, say, `navigator` or `XMLHttpRequest` is absent in the current realm.
  if (typeof window.fetch === "function") {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (...args: Parameters<typeof fetch>): Promise<Response> => {
      record(args[0]);
      return originalFetch(...args);
    };
  }

  if (typeof XMLHttpRequest !== "undefined") {
    // Bind to the 5-arg overload explicitly so `.call` below type-checks against the full signature.
    const originalOpen: (
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null,
    ) => void = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function open(
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      isAsync: boolean = true,
      username?: string | null,
      password?: string | null,
    ): void {
      record(url);
      return originalOpen.call(this, method, url, isAsync, username, password);
    };
  }

  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    const originalBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (...args: Parameters<typeof navigator.sendBeacon>): boolean => {
      record(args[0]);
      return originalBeacon(...args);
    };
  }

  if (typeof window.WebSocket === "function") {
    const OriginalWebSocket = window.WebSocket;
    // reason: subclassing the native WebSocket preserves its constructor signature and prototype;
    // a plain wrapper function would lose `instanceof` and the static readyState constants.
    class MonitoredWebSocket extends OriginalWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        record(url);
        super(url, protocols);
      }
    }
    window.WebSocket = MonitoredWebSocket as typeof WebSocket;
  }

  if (typeof window.EventSource === "function") {
    const OriginalEventSource = window.EventSource;
    class MonitoredEventSource extends OriginalEventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        record(url);
        super(url, init);
      }
    }
    window.EventSource = MonitoredEventSource as typeof EventSource;
  }

  // WebRTC: ICE/STUN/data channels can reach arbitrary hosts WITHOUT fetch/XHR/WebSocket, so an
  // unpatched RTCPeerConnection would be a blind spot the badge never sees. This app has no WebRTC
  // use at all, so ANY construction is classified UNEXPECTED (the CSP `webrtc 'block'` directive is
  // the hard backstop; this is the honest-observation layer). The legacy webkit alias is patched too —
  // Chrome still exposes it, and it would otherwise be a one-word bypass.
  const rtcWindow = window as typeof window & { webkitRTCPeerConnection?: typeof RTCPeerConnection };
  for (const key of ["RTCPeerConnection", "webkitRTCPeerConnection"] as const) {
    const OriginalRtc = rtcWindow[key];
    if (typeof OriginalRtc === "function") {
      class MonitoredRTCPeerConnection extends OriginalRtc {
        constructor(configuration?: RTCConfiguration) {
          recordUnexpected(webRtcHost(configuration));
          super(configuration);
        }
      }
      rtcWindow[key] = MonitoredRTCPeerConnection as typeof RTCPeerConnection;
    }
  }
}
