/**
 * File-download gate (H-race). A redacted FILE only has NAMES removed after the model settles AND the
 * names-upgrade re-run commits its upgraded bytes. Between "model ready" and "upgraded bytes set" the
 * `redacted` state still holds the OLD deterministic-only bytes, so enabling the download there hands
 * back a "_מושחר" file with names NOT redacted. This pure predicate decides the download affordance so
 * that window is closed and unit-tested; the App just renders the returned state.
 */
import type { NerStatus } from "../worker/nerController";

export type DownloadGate = "hidden" | "pending" | "retry" | "ready";

export interface DownloadGateInput {
  /** Whether redacted bytes exist to download. */
  readonly hasRedacted: boolean;
  /** Manual-only mode never loads NER, so its result is final immediately. */
  readonly manualOnly: boolean;
  /** Rows in the current key — zero in manual mode means a byte-identical (unredacted) file. */
  readonly keyCount: number;
  readonly sourceKind: "text" | "file" | null;
  readonly nerStatus: NerStatus;
  /** True while the names-upgrade re-run for a file source is in flight (bytes not yet committed). */
  readonly nerUpgrading: boolean;
}

export function fileDownloadGate(input: DownloadGateInput): DownloadGate {
  // Nothing to offer: no bytes yet, or manual mode with zero redactions (the "redacted" file would be
  // byte-identical to the original yet named "_מושחר" — a leak-shaped footgun).
  if (!input.hasRedacted || (input.manualOnly && input.keyCount === 0)) {
    return "hidden";
  }
  // Manual-only never uses NER, so its result is final immediately — skip the NER gate entirely.
  const fileNeedsNer = !input.manualOnly && input.sourceKind === "file";
  if (fileNeedsNer) {
    if (input.nerStatus === "error") {
      // The model failed to load; the deterministic chips are shown, but names can't be added — offer
      // a retry instead of a download that would be missing names.
      return "retry";
    }
    // Withhold while the model is still loading/idle OR while the ready-transition upgrade re-run is
    // still in flight (H-race: `redacted` still holds the pre-names bytes until the upgrade commits).
    if (input.nerStatus === "loading" || input.nerStatus === "idle" || input.nerUpgrading) {
      return "pending";
    }
  }
  return "ready";
}
