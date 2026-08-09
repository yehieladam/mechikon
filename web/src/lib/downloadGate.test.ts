/**
 * H-race: a redacted FILE must not be downloadable while its names-upgrade re-run is still in flight.
 * The download gate is a pure predicate so the exact window (model ready, but the upgraded bytes not
 * yet committed) is covered headless — the App JSX just renders whatever this returns.
 */
import { describe, expect, it } from "vitest";
import { fileDownloadGate } from "./downloadGate";

const base = {
  hasRedacted: true,
  manualOnly: false,
  keyCount: 2,
  sourceKind: "file" as const,
  nerStatus: "ready" as const,
  nerUpgrading: false,
};

describe("fileDownloadGate", () => {
  it("stays PENDING while the NER-upgrade re-run is in flight, even though the model is ready (H-race)", () => {
    expect(fileDownloadGate({ ...base, nerStatus: "ready", nerUpgrading: true })).toBe("pending");
  });

  it("becomes READY once the model is ready and the upgraded bytes have committed", () => {
    expect(fileDownloadGate({ ...base, nerStatus: "ready", nerUpgrading: false })).toBe("ready");
  });

  it("is PENDING while the model is still loading or idle", () => {
    expect(fileDownloadGate({ ...base, nerStatus: "loading" })).toBe("pending");
    expect(fileDownloadGate({ ...base, nerStatus: "idle" })).toBe("pending");
  });

  it("offers RETRY when the model failed to load", () => {
    expect(fileDownloadGate({ ...base, nerStatus: "error" })).toBe("retry");
  });

  it("hides the download with no redacted bytes", () => {
    expect(fileDownloadGate({ ...base, hasRedacted: false })).toBe("hidden");
  });

  it("hides the download in manual mode with zero redactions (a byte-identical file)", () => {
    expect(fileDownloadGate({ ...base, manualOnly: true, keyCount: 0 })).toBe("hidden");
  });

  it("manual-only never uses NER, so a redaction is final immediately (upgrade flag ignored)", () => {
    expect(
      fileDownloadGate({ ...base, manualOnly: true, keyCount: 1, nerUpgrading: true }),
    ).toBe("ready");
  });

  it("a text source is never gated on the file-download upgrade (copy path)", () => {
    // Text has no downloadable bytes, so the gate is hidden regardless of the upgrade flag.
    expect(
      fileDownloadGate({ ...base, sourceKind: "text", hasRedacted: false, nerUpgrading: true }),
    ).toBe("hidden");
  });
});
