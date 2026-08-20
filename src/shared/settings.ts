/**
 * User-facing extension settings, shared across surfaces (popup + content) via chrome.storage.local.
 *
 * `liveRestore` controls whether the content script auto-reveals [TOKEN]s back to their real values
 * inside AI answers as they stream in. It defaults to OFF: a privacy tool must never repaint real
 * sensitive values into a third-party page's DOM without an explicit opt-in (other page scripts can
 * read that DOM). The manual "restore" affordances (chip button + selection popover + popup tab) stay
 * available regardless, so nothing is lost by keeping this off.
 */
export const LIVE_RESTORE_STORAGE_KEY = "liveRestore.v1";

/** Whether auto live-restore of AI answers is enabled. Defaults to false (any non-true stored value). */
export async function loadLiveRestore(): Promise<boolean> {
  try {
    const bag = await chrome.storage.local.get(LIVE_RESTORE_STORAGE_KEY);
    return bag[LIVE_RESTORE_STORAGE_KEY] === true;
  } catch {
    return false;
  }
}

export async function saveLiveRestore(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [LIVE_RESTORE_STORAGE_KEY]: enabled });
}
