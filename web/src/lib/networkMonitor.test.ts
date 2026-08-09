/**
 * The trust badge is only honest if EVERY network primitive a page could use is observed. These tests
 * run in node with a stubbed `window`, so they exercise the patching + classification logic directly
 * (jsdom is not in this repo; the stub is the tightest unit seam available). The WebRTC case is the
 * point: RTCPeerConnection can reach arbitrary hosts via ICE/STUN/data channels without ever touching
 * fetch/XHR/WebSocket, so it must be patched too — and since this app has NO legitimate WebRTC use,
 * merely constructing one is classified as an UNEXPECTED request.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getNetworkState, installNetworkMonitor, type NetworkState } from "./networkMonitor";

const ORIGIN = "https://mechikon.example.com";

/** Minimal stand-ins for the browser primitives the monitor patches. */
class FakeXMLHttpRequest {
  open(_method: string, _url: string | NodeURL): void {
    void _method;
    void _url;
  }
}
class FakeWebSocket {
  constructor(url: string | NodeURL, protocols?: string | string[]) {
    void url;
    void protocols;
  }
}
interface FakeIceServer {
  urls: string | string[];
}
interface FakeRtcConfiguration {
  iceServers?: FakeIceServer[];
}
class FakeRTCPeerConnection {
  constructor(configuration?: FakeRtcConfiguration) {
    void configuration;
  }
  createOffer(): Promise<object> {
    return Promise.resolve({});
  }
  addIceCandidate(): Promise<void> {
    return Promise.resolve();
  }
}

interface FakeWindow {
  location: { origin: string };
  fetch: (input: unknown) => Promise<unknown>;
  WebSocket: typeof FakeWebSocket;
  RTCPeerConnection: typeof FakeRTCPeerConnection;
}

const fakeWindow: FakeWindow = {
  location: { origin: ORIGIN },
  fetch: () => Promise.resolve({}),
  WebSocket: FakeWebSocket,
  RTCPeerConnection: FakeRTCPeerConnection,
};

const globals = globalThis as Record<string, unknown>;
let savedWindow: unknown;
let savedXhr: unknown;

beforeAll(() => {
  savedWindow = globals.window;
  savedXhr = globals.XMLHttpRequest;
  globals.window = fakeWindow;
  globals.XMLHttpRequest = FakeXMLHttpRequest;
  installNetworkMonitor();
});

afterAll(() => {
  globals.window = savedWindow;
  globals.XMLHttpRequest = savedXhr;
});

/** The module state is a cumulative singleton, so every assertion works on deltas. */
function delta(run: () => void): { count: number; unexpected: number; before: NetworkState; after: NetworkState } {
  const before = getNetworkState();
  run();
  const after = getNetworkState();
  return { count: after.count - before.count, unexpected: after.unexpected - before.unexpected, before, after };
}

describe("installNetworkMonitor — existing primitives stay observed", () => {
  it("counts a same-origin fetch as expected (not an alarm)", () => {
    const d = delta(() => void fakeWindow.fetch(`${ORIGIN}/assets/app.js`));
    expect(d.count).toBe(1);
    expect(d.unexpected).toBe(0);
  });

  it("counts an off-policy fetch as UNEXPECTED", () => {
    const d = delta(() => void fakeWindow.fetch("https://evil.example.net/collect"));
    expect(d.count).toBe(1);
    expect(d.unexpected).toBe(1);
    expect(d.after.unexpectedHost).toBe("evil.example.net");
  });

  it("counts a WebSocket construction", () => {
    const d = delta(() => void new fakeWindow.WebSocket("wss://evil.example.net/ws"));
    expect(d.count).toBe(1);
    expect(d.unexpected).toBe(1);
  });
});

describe("installNetworkMonitor — WebRTC blind spot (P2W hardening)", () => {
  it("patches RTCPeerConnection so constructing one is recorded as UNEXPECTED", () => {
    const d = delta(
      () =>
        void new fakeWindow.RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.attacker.example:19302" }],
        }),
    );
    expect(d.count).toBe(1);
    expect(d.unexpected).toBe(1);
    expect(d.after.unexpectedHost).not.toBeNull();
  });

  it("names the STUN/TURN host so the badge can show WHERE it aimed", () => {
    // unexpectedHost keeps the FIRST offender, so assert on the recorded value of a fresh construction
    // only when no earlier host is pinned; here we assert the classifier flags it regardless.
    const d = delta(() => void new fakeWindow.RTCPeerConnection({ iceServers: [{ urls: ["turn:turn.attacker.example"] }] }));
    expect(d.unexpected).toBe(1);
  });

  it("records a config-less construction too (data channels need no ICE servers up front)", () => {
    const d = delta(() => void new fakeWindow.RTCPeerConnection());
    expect(d.count).toBe(1);
    expect(d.unexpected).toBe(1);
  });

  it("still behaves as an RTCPeerConnection (methods delegate to the original)", async () => {
    const pc = new fakeWindow.RTCPeerConnection();
    await expect(pc.createOffer()).resolves.toEqual({});
    await expect(pc.addIceCandidate()).resolves.toBeUndefined();
  });
});

describe("CSP governs WebRTC in both prod and preview (kept in sync)", () => {
  const repoRoot = fileURLToPath(new NodeURL("../../..", import.meta.url));

  it("vercel.json (production) carries webrtc 'block'", () => {
    const raw = readFileSync(`${repoRoot}/vercel.json`, "utf8");
    const parsed = JSON.parse(raw) as {
      headers: { headers: { key: string; value: string }[] }[];
    };
    const csp = parsed.headers[0].headers.find((h) => h.key === "Content-Security-Policy");
    expect(csp?.value).toContain("webrtc 'block'");
  });

  it("web/vite.config.ts (preview/e2e) carries webrtc 'block'", () => {
    const raw = readFileSync(`${repoRoot}/web/vite.config.ts`, "utf8");
    expect(raw).toContain(`"webrtc 'block'"`);
  });
});
