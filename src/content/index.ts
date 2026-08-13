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

  const style = document.createElement("style");
  style.textContent = `
    .chip, .pop button, .toast {
      font: 14px/1.2 system-ui, sans-serif; direction: rtl; box-sizing: border-box;
    }
    .chip {
      position: fixed; bottom: 20px; inset-inline-start: 20px; z-index: 2147483647;
      display: none; align-items: center; gap: 10px; background: #2C1608; color: #F7F4EF;
      padding: 10px 14px; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,.3);
    }
    .chip button {
      font: 600 14px/1 system-ui; background: #1b8a5a; color: #fff; border: 0;
      padding: 10px 14px; min-height: 40px; border-radius: 8px; cursor: pointer;
    }
    .pop {
      position: fixed; z-index: 2147483647; display: none; transform: translate(-50%, -100%);
    }
    .pop button {
      background: #2C1608; color: #fff; border: 0; padding: 8px 12px; min-height: 40px;
      border-radius: 8px; cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.3); white-space: nowrap;
    }
    .toast {
      position: fixed; bottom: 74px; inset-inline-start: 20px; z-index: 2147483647;
      background: #1b8a5a; color: #fff; padding: 12px 16px; border-radius: 10px;
      max-width: 380px; box-shadow: 0 4px 16px rgba(0,0,0,.3); white-space: pre-wrap; display: none;
    }
  `;

  const chip = document.createElement("div");
  chip.className = "chip";
  const chipLabel = document.createElement("span");
  const chipBtn = document.createElement("button");
  chipBtn.textContent = "הסתר";
  keepFocus(chipBtn);
  chipBtn.addEventListener("click", redactAll);
  chip.append(chipLabel, chipBtn);

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
function redactAll() {
  const composer = focusedComposer() ?? lastComposer;
  if (!composer) {
    return;
  }
  const text = getText(composer);
  const { text: redacted, newRows } = session.redact(text);
  const withInstruction =
    redacted.includes(INSTRUCTION_MARKER) || newRows.length === 0
      ? redacted
      : redacted + INSTRUCTION;
  setWholeText(composer, withInstruction);
  updateChip();
  showToast(newRows.length > 0 ? `הוסתרו ${newRows.length} פרטים` : "לא נמצאו פרטים חדשים להסתרה");
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

// eslint-disable-next-line no-console
console.log("[mechikon] inline content script ready on", location.host);
