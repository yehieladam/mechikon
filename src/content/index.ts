/**
 * Inline redaction content script — hybrid UX.
 *  - AUTO: the deterministic engine scans the composer as you type; a status chip shows how many
 *    sensitive values were found, one click redacts them all.
 *  - MANUAL: select any text the engine missed -> a popover offers "הסתר בחירה" (added as a manual term).
 *  - RESTORE: select an AI answer containing tokens -> the popover offers "שחזר בחירה".
 *  - On the first redaction an instruction is appended telling the AI to keep the tokens verbatim.
 *
 * Deterministic only for now (instant, no model). NER (names/orgs) arrives later via an offscreen doc.
 */
import type { Span } from "@engine/types";
import { RedactSession } from "./session";
import {
  currentSelection,
  focusedComposer,
  getText,
  replaceSelection,
  setWholeText,
  type Composer,
} from "./editor";

const session = new RedactSession();
let lastComposer: Composer | null = null;

const INSTRUCTION =
  "\n\n[הנחיה למערכת: ערכים בסוגריים מרובעים כמו [ID_1] או [NAME_1] הם מסכות למידע רגיש. " +
  "התייחס אליהם בתשובתך והשאר אותם בדיוק כפי שהם, ללא שינוי, כדי שנוכל לשחזר את המידע המקורי.]";
const INSTRUCTION_MARKER = "[הנחיה למערכת:";

// ---- UI (shadow DOM, immune to host page CSS) ---------------------------------------
const ui = mountUi();

function mountUi() {
  const host = document.createElement("div");
  host.id = "mechikon-root";
  const shadow = host.attachShadow({ mode: "open" });

  // Design language mirrors the mechikon site: Apple system font, white translucent glass
  // (backdrop blur), near-black ink (#0a0a0a), emerald action, yellow detection accent, pill buttons.
  const style = document.createElement("style");
  style.textContent = `
    :host {
      --ink: #0a0a0a;
      --emerald: #10b981;
      --emerald-press: #059669;
      --accent: #facc15;
      --glass: rgba(255,255,255,.72);
      --hairline: rgba(0,0,0,.08);
      --shadow: 0 8px 30px rgba(0,0,0,.12), 0 1px 2px rgba(0,0,0,.06);
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    }
    .chip, .pop, .toast { position: fixed; z-index: 2147483647; direction: rtl; font-family: var(--font); }
    button { font-family: var(--font); cursor: pointer; border: 0; }

    .chip {
      bottom: 22px; inset-inline-start: 22px; display: none; align-items: center; gap: 12px;
      background: var(--glass); -webkit-backdrop-filter: blur(20px) saturate(180%);
      backdrop-filter: blur(20px) saturate(180%); color: var(--ink);
      padding: 10px 12px 10px 16px; border-radius: 16px; border: .5px solid var(--hairline);
      box-shadow: var(--shadow); animation: pop .28s cubic-bezier(.2,.8,.2,1);
    }
    .chip .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent);
      box-shadow: 0 0 0 4px rgba(250,204,21,.22); flex: 0 0 auto; }
    .chip .txt { display: flex; flex-direction: column; line-height: 1.25; }
    .chip .brand { font-size: 11px; font-weight: 600; letter-spacing: .01em; color: rgba(10,10,10,.5); }
    .chip .label { font-size: 14px; font-weight: 500; }
    .chip button {
      background: var(--emerald); color: #fff; font-size: 14px; font-weight: 600;
      padding: 0 18px; height: 44px; border-radius: 999px; transition: background .15s, transform .1s;
    }
    .chip button:hover { background: var(--emerald-press); }
    .chip button:active { transform: scale(.97); }

    .pop { display: none; transform: translate(-50%, -100%); animation: pop .18s cubic-bezier(.2,.8,.2,1); }
    .pop button {
      background: var(--ink); color: #fff; font-size: 13px; font-weight: 600; white-space: nowrap;
      padding: 0 16px; height: 40px; border-radius: 999px; box-shadow: var(--shadow);
    }
    .pop button:active { transform: scale(.96); }

    .toast {
      bottom: 80px; inset-inline-start: 22px; display: none; max-width: 380px;
      background: var(--glass); -webkit-backdrop-filter: blur(20px) saturate(180%);
      backdrop-filter: blur(20px) saturate(180%); color: var(--ink); font-size: 14px; font-weight: 500;
      padding: 12px 16px; border-radius: 14px; border: .5px solid var(--hairline);
      box-shadow: var(--shadow); white-space: pre-wrap; animation: pop .28s cubic-bezier(.2,.8,.2,1);
    }
    @keyframes pop { from { opacity: 0; transform: translateY(6px) scale(.98); } }
    @media (prefers-reduced-motion: reduce) { .chip, .pop, .toast { animation: none !important; } }
  `;

  const chip = document.createElement("div");
  chip.className = "chip";
  const dot = document.createElement("span");
  dot.className = "dot";
  const txt = document.createElement("span");
  txt.className = "txt";
  const brand = document.createElement("span");
  brand.className = "brand";
  brand.textContent = "מחיקון";
  const chipLabel = document.createElement("span");
  chipLabel.className = "label";
  txt.append(brand, chipLabel);
  const chipBtn = document.createElement("button");
  chipBtn.textContent = "הסתר";
  keepFocus(chipBtn);
  chipBtn.addEventListener("click", redactAll);
  chip.append(dot, txt, chipBtn);

  const pop = document.createElement("div");
  pop.className = "pop";
  const popBtn = document.createElement("button");
  keepFocus(popBtn);
  pop.append(popBtn);

  const toast = document.createElement("div");
  toast.className = "toast";

  shadow.append(style, chip, pop, toast);
  document.documentElement.appendChild(host);

  return { chipLabel, chip, pop, popBtn, toast };
}

/** Stop a UI button from stealing focus / clearing the page selection when pressed. */
function keepFocus(btn: HTMLElement) {
  btn.addEventListener("mousedown", (e) => e.preventDefault());
}

function showToast(text: string) {
  ui.toast.textContent = text;
  ui.toast.style.display = "block";
  window.setTimeout(() => (ui.toast.style.display = "none"), 4000);
}

// ---- auto-detect: watch the composer -------------------------------------------------
let detectTimer = 0;
document.addEventListener(
  "input",
  (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) {
      return;
    }
    const composer = focusedComposer();
    if (composer) {
      lastComposer = composer;
    }
    window.clearTimeout(detectTimer);
    detectTimer = window.setTimeout(updateChip, 350);
  },
  true,
);

function updateChip() {
  const composer = focusedComposer() ?? lastComposer;
  if (!composer) {
    ui.chip.style.display = "none";
    return;
  }
  const text = getText(composer);
  const distinct = new Set(session.detect(text).map((s) => text.slice(s.start, s.end)));
  if (distinct.size === 0) {
    ui.chip.style.display = "none";
    return;
  }
  ui.chipLabel.textContent = `זוהו ${distinct.size} פרטים רגישים`;
  ui.chip.style.display = "flex";
}

// ---- redact-all (the chip) -----------------------------------------------------------
async function redactAll() {
  const composer = focusedComposer() ?? lastComposer;
  if (!composer) {
    return;
  }
  const text = getText(composer);
  // NER (names/orgs) runs in the offscreen model via the background worker. If the model is still
  // loading it times out fast and we redact deterministically now; names get caught next time.
  const nerSpans = await requestNer(text);
  const { text: redacted, newRows } = session.redact(text, nerSpans);
  const withInstruction =
    redacted.includes(INSTRUCTION_MARKER) || newRows.length === 0
      ? redacted
      : redacted + INSTRUCTION;
  setWholeText(composer, withInstruction);
  updateChip();
  showToast(newRows.length > 0 ? `הוסתרו ${newRows.length} פרטים` : "לא נמצאו פרטים חדשים להסתרה");
}

/** Ask the offscreen NER model (via the SW) for name/org/location spans; empty on timeout/not-ready. */
function requestNer(text: string): Promise<Span[]> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (spans: Span[]) => {
      if (!done) {
        done = true;
        resolve(spans);
      }
    };
    const timer = window.setTimeout(() => finish([]), 8000);
    try {
      chrome.runtime.sendMessage({ type: "ner:request", text }, (resp) => {
        window.clearTimeout(timer);
        finish(resp?.ok ? (resp.spans as Span[]) : []);
      });
    } catch {
      window.clearTimeout(timer);
      finish([]);
    }
  });
}

// ---- selection popover: manual redact / restore --------------------------------------
document.addEventListener("selectionchange", () => window.setTimeout(refreshPopover, 0));
document.addEventListener("mouseup", () => window.setTimeout(refreshPopover, 0), true);

function refreshPopover() {
  const ctx = currentSelection();
  if (!ctx || ctx.value.trim().length === 0) {
    ui.pop.style.display = "none";
    return;
  }
  if (ctx.inEditable) {
    ui.popBtn.textContent = "הסתר בחירה";
    ui.popBtn.onclick = () => {
      session.addManualTerm(ctx.value);
      redactAll();
      ui.pop.style.display = "none";
    };
  } else if (session.hasKey) {
    ui.popBtn.textContent = "שחזר בחירה";
    ui.popBtn.onclick = () => {
      const { text, unmatched } = session.restore(ctx.value);
      replaceSelection(text);
      ui.pop.style.display = "none";
      showToast(unmatched.length > 0 ? `שוחזר — ${unmatched.length} טוקנים לא זוהו` : "שוחזר");
    };
  } else {
    ui.pop.style.display = "none";
    return;
  }
  ui.pop.style.left = `${ctx.rect.left + ctx.rect.width / 2}px`;
  ui.pop.style.top = `${ctx.rect.top - 6}px`;
  ui.pop.style.display = "block";
}

// Restore the key from storage (survives reload within the 24h window) before the user acts.
void session.hydrate();

// eslint-disable-next-line no-console
console.log("[mechikon] inline content script ready on", location.host);
