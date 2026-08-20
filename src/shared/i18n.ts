/**
 * Tiny, dependency-free i18n for the extension surfaces (content script + popup). The UI language
 * FOLLOWS THE TEXT: `detectLang` looks at what the user is actually writing/pasting (Hebrew vs Latin
 * letters) and picks the matching language, falling back to the browser UI language when there's no
 * text yet. No react-i18next here — a content script must stay lean, and the dict is small.
 */
export type Lang = "he" | "en";

const HEBREW = /[֐-׿]/g;
const LATIN = /[A-Za-z]/g;

/** The browser's UI language, coerced to one of our two. Used as the fallback when there's no text. */
export function defaultLang(): Lang {
  try {
    const ui =
      (typeof chrome !== "undefined" && chrome.i18n?.getUILanguage?.()) ||
      (typeof navigator !== "undefined" && navigator.language) ||
      "he";
    return ui.toLowerCase().startsWith("he") ? "he" : "en";
  } catch {
    return "he";
  }
}

/** Pick the language from the text itself: whichever script has more letters wins; empty -> fallback. */
export function detectLang(text: string, fallback: Lang = defaultLang()): Lang {
  const he = (text.match(HEBREW) ?? []).length;
  const lat = (text.match(LATIN) ?? []).length;
  if (he === 0 && lat === 0) {
    return fallback;
  }
  return he >= lat ? "he" : "en";
}

type Params = Record<string, string | number>;
type Entry = string | ((p: Params) => string);

const he = {
  // --- content: popover + chip buttons ---
  popHide: "הסתר בחירה",
  popRestore: "שחזר בחירה",
  btnHide: "הסתר",
  btnPick: "בחר ידנית",
  btnRestore: "שחזר תשובה",
  pickActive: "● בחירה פעילה",
  pickModeToast: "מצב בחירה: לחצו על מילים להסתרה (Esc ליציאה)",
  // --- content: chip states ---
  detectedCount: (p: Params) => (Number(p.n) === 1 ? "פרט רגיש אחד" : `${p.n} פרטים רגישים`),
  maskingNames: "מסתיר שמות…",
  downloadingModel: (p: Params) => `מוריד מנוע זיהוי שמות… ${p.p}%`,
  modelLoadError: "טעינת מנוע זיהוי השמות נכשלה. פרטים דטרמיניסטיים (ת״ז, טלפון) כן הוסתרו.",
  namesUnavailableShort: "מנוע השמות לא זמין — הסתר שוב לניסיון",
  protectedCount: (p: Params) =>
    Number(p.n) === 1 ? "מוגן · הוסתר פרט אחד" : `מוגן · ${p.n} הוסתרו`,
  protectedLabel: "מוגן",
  pickWhat: "בחר מה להסתיר",
  // --- content: toasts ---
  hiddenValue: (p: Params) => `הוסתר: ${p.v}`,
  notFoundToHide: (p: Params) => `לא נמצא "${p.v}" להסתרה`,
  notFoundInBox: (p: Params) => `לא נמצא "${p.v}" בתיבה`,
  cannotHideSelection: "לא ניתן להסתיר את הבחירה",
  hiddenWithInstruction: (p: Params) =>
    Number(p.n) === 1 ? "הוסתר פרט אחד · נוספה הנחיה" : `הוסתרו ${p.n} פרטים · נוספה הנחיה`,
  scannedWaitingNames: "נסרק — ממתין לזיהוי שמות",
  alsoHidNames: (p: Params) =>
    Number(p.n) === 1 ? "הוסתר גם שם/ארגון אחד" : `הוסתרו גם ${p.n} שמות/ארגונים`,
  nothingToRestore: "אין מה לשחזר עדיין — קודם הסתירו פרטים",
  restoredPlaces: (p: Params) => (Number(p.n) === 1 ? "שוחזר במקום אחד" : `שוחזר ב-${p.n} מקומות`),
  noTokensOnPage: "לא נמצאו סימונים לשחזור בעמוד",
  restoredUnmatched: (p: Params) => `שוחזר — ${p.n} סימונים לא זוהו`,
  restored: "שוחזר",
  nerReady: "מנוע זיהוי השמות מוכן — הסתירו שוב לזיהוי שמות, ארגונים ומקומות",
  sendBlocked: (p: Params) =>
    `נחסמה שליחה — ${p.n} פרטים רגישים לא מוסתרים. הסתירו, או הקישו Enter שוב לשליחה.`,
  // --- popup ---
  noTextInFile: "לא נמצא טקסט בקובץ (ייתכן PDF סרוק — נסו את האתר)",
  unsupportedType: (p: Params) => `סוג קובץ לא נתמך (${p.message}). נתמכים: PDF, Word, טקסט`,
  pdfUnreadable: "לא ניתן לקרוא את ה-PDF כאן (ייתכן שהוא סרוק או מוגן) — נסו את האתר",
  fileProcessError: "שגיאה בעיבוד הקובץ",
  copy: "העתק",
  keyLoaded: "מפתח נטען",
  invalidKeyFile: "קובץ מפתח לא תקין",
  pasteAiAnswer: "הדביקו את תשובת ה-AI",
  noKeyLoadOrMask: "אין מפתח — טענו קובץ מפתח או מסכו קודם",
  restoredUnmatchedDot: (p: Params) => `שוחזר · ${p.n} סימונים לא זוהו`,
  restoredCheck: "שוחזר ✓",
  copiedCheck: "הועתק ✓",
  copyFailed: "ההעתקה נכשלה — סמנו ידנית",
  copyMaskedText: "העתק טקסט מוסתר",
  maskedFileName: (p: Params) => `${p.baseName}-מוסתר.txt`,
  keyFileName: (p: Params) => `${p.baseName}-מפתח-שחזור.json`,
  sameComputerAuto: "השחזור באותו מחשב אוטומטי; הקובץ נחוץ רק כדי לשחזר במחשב אחר",
  keySaved: "מפתח נשמר ✓",
  keyForOtherComputer: "מפתח לשחזור במחשב אחר",
  termToHide: "מונח להסתרה…",
  pastePlaceholder: "הדביקו כאן את תשובת ה-AI (עם הסימונים)…",
  loadOtherKey: "טען מפתח אחר",
  loadKeyFile: "טען קובץ מפתח",
  restoreAnswer: "שחזור תשובה",
  autoMode: "אוטומטי",
  manualMode: "ידני",
  // --- popup: static UI ---
  fileMaskMode: "מיסוך קובץ",
  detectionLabel: "זיהוי:",
  processing: "מעבד…",
  dropHere: "גררו קובץ לכאן או לחצו לבחירה",
  dropTypes: "PDF · Word · טקסט — הכול נשאר במכשיר",
  redactedReady: (p: Params) => `הוסתרו ${p.n} פרטים — מוכן לשליחה ל-AI`,
  downloadTxt: "הורד .txt",
  anotherFile: "קובץ נוסף",
  pickHint: "לחצו על מספר או שם כדי להסתיר אותו (וכל החזרות שלו). או הקלידו מונח.",
  addTermBtn: "הוסף",
  hideNTerms: (p: Params) => `הסתר ${p.n} מונחים`,
  cancel: "ביטול",
  keyLoadedCount: (p: Params) => `מפתח טעון · ${p.n}`,
  restoreOriginals: "שחזר את הערכים המקוריים",
  footerPrivacy: 'המידע הרגיש לא עוזב את הדפדפן. השחזור זמין אוטומטית בלשונית "שחזור תשובה".',
  liveRestoreLabel: "שחזור אוטומטי של תשובות בצ'אט",
  liveRestoreHint: "חושף ערכים אמיתיים בתשובת ה-AI על העמוד. כבוי כברירת מחדל לפרטיות.",
  namesUncertain: "המנוע לזיהוי שמות עדיין נטען — שמות וארגונים אולי לא הוסתרו. נסו שוב עוד רגע.",
  retryNames: "נסה שוב לזהות שמות",
} satisfies Record<string, Entry>;

const en: Record<keyof typeof he, Entry> = {
  popHide: "Hide selection",
  popRestore: "Restore selection",
  btnHide: "Hide",
  btnPick: "Select manually",
  btnRestore: "Restore reply",
  pickActive: "● Picking",
  pickModeToast: "Pick mode: click words to hide (Esc to exit)",
  detectedCount: (p) => `${p.n} sensitive ${Number(p.n) === 1 ? "item" : "items"}`,
  maskingNames: "Masking names…",
  downloadingModel: (p) => `Downloading name detector… ${p.p}%`,
  modelLoadError: "Name detector failed to load. Deterministic details (ID, phone) were still masked.",
  namesUnavailableShort: "Name detector unavailable — Hide to retry",
  protectedCount: (p) => `Protected · ${p.n} hidden`,
  protectedLabel: "Protected",
  pickWhat: "Select what to hide",
  hiddenValue: (p) => `Hidden: ${p.v}`,
  notFoundToHide: (p) => `"${p.v}" not found to hide`,
  notFoundInBox: (p) => `"${p.v}" not found in the box`,
  cannotHideSelection: "Can't hide the selection",
  hiddenWithInstruction: (p) => `Hid ${p.n} ${Number(p.n) === 1 ? "item" : "items"} · instruction added`,
  scannedWaitingNames: "Scanned — waiting for name detection",
  alsoHidNames: (p) => `Also hid ${p.n} ${Number(p.n) === 1 ? "name/org" : "names/orgs"}`,
  nothingToRestore: "Nothing to restore yet — hide details first",
  restoredPlaces: (p) => `Restored in ${p.n} ${Number(p.n) === 1 ? "place" : "places"}`,
  noTokensOnPage: "No tokens to restore on the page",
  restoredUnmatched: (p) => `Restored — ${p.n} ${Number(p.n) === 1 ? "token" : "tokens"} unmatched`,
  restored: "Restored",
  nerReady: "Name detection is ready — hide again to catch names, orgs and places",
  sendBlocked: (p) =>
    `Send blocked — ${p.n} unmasked sensitive ${Number(p.n) === 1 ? "item" : "items"}. Hide them, or press Enter again to send.`,
  noTextInFile: "No text found in the file (a scanned PDF? try the website)",
  unsupportedType: (p) => `Unsupported file type (${p.message}). Supported: PDF, Word, text`,
  pdfUnreadable: "Can't read this PDF here (scanned or protected?) — try the website",
  fileProcessError: "Error processing the file",
  copy: "Copy",
  keyLoaded: "Key loaded",
  invalidKeyFile: "Invalid key file",
  pasteAiAnswer: "Paste the AI's answer",
  noKeyLoadOrMask: "No key — load a key file or mask first",
  restoredUnmatchedDot: (p) => `Restored · ${p.n} unmatched`,
  restoredCheck: "Restored ✓",
  copiedCheck: "Copied ✓",
  copyFailed: "Copy failed — select manually",
  copyMaskedText: "Copy masked text",
  maskedFileName: (p) => `${p.baseName}-redacted.txt`,
  keyFileName: (p) => `${p.baseName}-restore-key.json`,
  sameComputerAuto: "Restoring on the same computer is automatic; the file is only for another computer",
  keySaved: "Key saved ✓",
  keyForOtherComputer: "Key for another computer",
  termToHide: "Term to hide…",
  pastePlaceholder: "Paste the AI's answer here (with the tokens)…",
  loadOtherKey: "Load another key",
  loadKeyFile: "Load key file",
  restoreAnswer: "Restore answer",
  autoMode: "Automatic",
  manualMode: "Manual",
  fileMaskMode: "Mask a file",
  detectionLabel: "Detection:",
  processing: "Processing…",
  dropHere: "Drag a file here or click to choose",
  dropTypes: "PDF · Word · text — everything stays on your device",
  redactedReady: (p) => `Hid ${p.n} ${Number(p.n) === 1 ? "item" : "items"} — ready to send to the AI`,
  downloadTxt: "Download .txt",
  anotherFile: "Another file",
  pickHint: "Click a number or name to hide it (and all its repeats). Or type a term.",
  addTermBtn: "Add",
  hideNTerms: (p) => `Hide ${p.n} ${Number(p.n) === 1 ? "term" : "terms"}`,
  cancel: "Cancel",
  keyLoadedCount: (p) => `Key loaded · ${p.n}`,
  restoreOriginals: "Restore the original values",
  footerPrivacy:
    'Sensitive data never leaves your browser. Restore is available automatically in the "Restore answer" tab.',
  liveRestoreLabel: "Auto-restore answers in chat",
  liveRestoreHint: "Reveals real values in the AI's reply on the page. Off by default for privacy.",
  namesUncertain:
    "The name detector is still loading — names and orgs may not be masked. Try again in a moment.",
  retryNames: "Retry name detection",
};

export type MsgKey = keyof typeof he;

const DICT: Record<Lang, Record<MsgKey, Entry>> = { he, en };

/** Translate `key` into `lang`, interpolating `params` for parameterized messages. */
export function t(lang: Lang, key: MsgKey, params?: Params): string {
  const entry = DICT[lang][key];
  return typeof entry === "function" ? entry(params ?? {}) : entry;
}
