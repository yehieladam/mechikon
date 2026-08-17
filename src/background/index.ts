/**
 * Service worker — owns the offscreen NER document and relays detection requests to it.
 * A content script cannot create an offscreen document (only an extension worker can), so it sends
 * "ner:request" here; we ensure the offscreen doc exists and forward the text to it, then relay the
 * spans back. Deterministic detection stays in the content script (instant, no model); this is only
 * the name/org/location augmentation path.
 */

const OFFSCREEN_URL = "src/offscreen/offscreen.html";
let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const has = await chrome.offscreen.hasDocument();
  if (has) {
    return;
  }
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: "Runs the local Hebrew NER model (WASM), which a service worker cannot host.",
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // The offscreen doc announces model readiness; content scripts can't hear runtime broadcasts,
  // so relay it to every tab (failures on non-extension tabs are ignored).
  if (msg && msg.type === "ner:ready") {
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        if (tab.id != null) {
          void chrome.tabs.sendMessage(tab.id, { type: "ner:ready" }).catch(() => undefined);
        }
      }
    });
    return undefined;
  }
  if (!msg || msg.type !== "ner:request") {
    return undefined;
  }
  void (async () => {
    try {
      await ensureOffscreen();
      const resp = await chrome.runtime.sendMessage({ type: "ner:detect", text: msg.text });
      sendResponse(resp ?? { ok: false, error: "offscreen returned nothing" });
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
  return true; // async sendResponse
});
