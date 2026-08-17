// Phase-0 spike service worker. One job: a "redact" context menu on a selection,
// scoped to the AI-chat sites, that tells the content script to replace in place.
const MENU_ID = "mechikon-spike-redact";

const SITES = [
  "https://chatgpt.com/*",
  "https://chat.openai.com/*",
  "https://claude.ai/*",
  "https://gemini.google.com/*",
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "מחיקון spike — הסתר בחירה",
    contexts: ["selection"],
    documentUrlPatterns: SITES,
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || tab.id == null) {
    return;
  }
  chrome.tabs.sendMessage(tab.id, { type: "SPIKE_REPLACE" });
});
