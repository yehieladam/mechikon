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
  closestEditable,
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

  // Modern glass, black & white. State lives in one dot: ORANGE while sensitive values are detected,
  // GREEN once redacted. Buttons are frosted black glass. Matches the mechikon site (ink on white,
  // pill buttons, hairline borders) with an Apple-grade glass treatment.
  const style = document.createElement("style");
  style.textContent = `
    :host {
      --ink: #0a0a0a;
      --orange: #ff9500;   /* detected  */
      --green: #34c759;    /* protected */
      --glass-card: rgba(255,255,255,.62);
      --glass-btn: rgba(12,12,12,.84);
      --hairline: rgba(0,0,0,.10);
      --shadow: 0 1px 2px rgba(0,0,0,.06), 0 14px 36px -10px rgba(0,0,0,.26);
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
      --ease: cubic-bezier(.22,.9,.3,1);
    }
    * { box-sizing: border-box; }
    .chip, .pop, .toast { position: fixed; z-index: 2147483647; direction: rtl; font-family: var(--font); }
    button { font-family: var(--font); cursor: pointer; border: 0; -webkit-font-smoothing: antialiased; }

    .chip {
      bottom: 24px; inset-inline-start: 24px; display: none; align-items: center; gap: 13px;
      background: var(--glass-card); -webkit-backdrop-filter: blur(28px) saturate(200%);
      backdrop-filter: blur(28px) saturate(200%); border: .5px solid var(--hairline);
      border-radius: 20px; padding: 11px 12px 11px 18px; box-shadow: var(--shadow);
      animation: rise .34s var(--ease);
    }
    /* glass sheen */
    .chip::before {
      content: ""; position: absolute; inset: 0; border-radius: 20px; pointer-events: none;
      background: linear-gradient(180deg, rgba(255,255,255,.55), rgba(255,255,255,0) 42%);
    }
    .dot {
      width: 10px; height: 10px; border-radius: 50%; flex: 0 0 auto; background: var(--orange);
      box-shadow: 0 0 0 4px rgba(255,149,0,.16), 0 0 10px rgba(255,149,0,.55);
      transition: background .35s var(--ease), box-shadow .35s var(--ease);
    }
    .dot.green {
      background: var(--green);
      box-shadow: 0 0 0 4px rgba(52,199,89,.16), 0 0 10px rgba(52,199,89,.55);
    }
    .info { display: flex; flex-direction: column; gap: 1px; line-height: 1.2; }
    .brand { font-size: 10px; font-weight: 700; letter-spacing: .1em; color: rgba(10,10,10,.4); }
    .label { font-size: 14px; font-weight: 600; color: var(--ink); letter-spacing: -.01em;
      font-variant-numeric: tabular-nums; }

    .cta {
      position: relative; background: var(--glass-btn); color: #fff;
      -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
      border: .5px solid rgba(255,255,255,.18); font-size: 14px; font-weight: 600; letter-spacing: -.01em;
      height: 42px; padding: 0 20px; border-radius: 999px;
      box-shadow: 0 1px 2px rgba(0,0,0,.28), inset 0 1px 0 rgba(255,255,255,.22);
      transition: transform .12s var(--ease), box-shadow .2s var(--ease);
    }
    .cta:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(0,0,0,.26), inset 0 1px 0 rgba(255,255,255,.3); }
    .cta:active { transform: translateY(0) scale(.97); }
    /* secondary (restore): light glass, ink text */
    .cta.ghost {
      background: rgba(255,255,255,.5); color: var(--ink); border: .5px solid var(--hairline);
      box-shadow: inset 0 1px 0 rgba(255,255,255,.7), 0 1px 2px rgba(0,0,0,.06);
    }
    .cta.ghost:hover { background: rgba(255,255,255,.72); box-shadow: inset 0 1px 0 rgba(255,255,255,.8), 0 4px 12px rgba(0,0,0,.1); }
    .actions { display: flex; align-items: center; gap: 8px; }

    .pop { display: none; transform: translate(-50%, -100%); animation: rise .2s var(--ease); }
    .pop .cta { height: 38px; padding: 0 16px; font-size: 13px; white-space: nowrap; }

    .toast {
      bottom: 90px; inset-inline-start: 24px; display: none; align-items: center; gap: 10px; max-width: 360px;
      background: var(--glass-card); -webkit-backdrop-filter: blur(28px) saturate(200%);
      backdrop-filter: blur(28px) saturate(200%); border: .5px solid var(--hairline);
      border-radius: 14px; padding: 12px 16px; box-shadow: var(--shadow);
      color: var(--ink); font-size: 14px; font-weight: 500; animation: rise .34s var(--ease);
    }
    .toast::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--green); flex: 0 0 auto; }

    @keyframes rise { from { opacity: 0; transform: translateY(8px) scale(.98); } }
    @media (prefers-reduced-motion: reduce) {
      .chip, .pop, .toast { animation: none; }
      .cta, .dot { transition: none; }
    }
  `;

  const chip = document.createElement("div");
  chip.className = "chip";
  const dot = document.createElement("span");
  dot.className = "dot";
  const info = document.createElement("span");
  info.className = "info";
  const brand = document.createElement("span");
  brand.className = "brand";
  brand.dir = "ltr";
  brand.textContent = "MECHIKON";
  const chipLabel = document.createElement("span");
  chipLabel.className = "label";
  info.append(brand, chipLabel);
  const actions = document.createElement("div");
  actions.className = "actions";
  const chipBtn = document.createElement("button");
  chipBtn.className = "cta";
  chipBtn.textContent = "הסתר";
  keepFocus(chipBtn);
  chipBtn.addEventListener("click", redactAll);
  const restoreBtn = document.createElement("button");
  restoreBtn.className = "cta ghost";
  restoreBtn.textContent = "שחזר";
  keepFocus(restoreBtn);
  restoreBtn.addEventListener("click", restoreVisible);
  actions.append(chipBtn, restoreBtn);
  chip.append(dot, info, actions);

  const pop = document.createElement("div");
  pop.className = "pop";
  const popBtn = document.createElement("button");
  popBtn.className = "cta";
  keepFocus(popBtn);
  pop.append(popBtn);

  const toast = document.createElement("div");
  toast.className = "toast";

  shadow.append(style, chip, pop, toast);
  document.documentElement.appendChild(host);

  return { chipLabel, chip, dot, chipBtn, restoreBtn, pop, popBtn, toast };
}

/** Stop a UI button from stealing focus / clearing the page selection when pressed. */
function keepFocus(btn: HTMLElement) {
  btn.addEventListener("mousedown", (e) => e.preventDefault());
}

function showToast(text: string) {
  ui.toast.textContent = text;
  ui.toast.style.display = "flex";
  window.setTimeout(() => (ui.toast.style.display = "none"), 4000);
}

/** Sensitive values found but not yet redacted: orange dot + count + הסתר (and שחזר if a key exists). */
function setChipDetected(count: number) {
  ui.dot.classList.remove("green");
  ui.chipLabel.textContent = `${count} פרטים רגישים`;
  ui.chipBtn.style.display = "";
  ui.restoreBtn.style.display = session.hasKey ? "" : "none";
  ui.chip.style.display = "flex";
}

/** Everything redacted: green dot, "protected", only שחזר (nothing left to hide). */
function setChipProtected(count: number) {
  ui.dot.classList.add("green");
  ui.chipLabel.textContent = count > 0 ? `מוגן · ${count} הוסתרו` : "מוגן";
  ui.chipBtn.style.display = "none";
  ui.restoreBtn.style.display = "";
  ui.chip.style.display = "flex";
}

function hideChip() {
  ui.chip.style.display = "none";
}

/** Restore every placeholder token visible on the page (the AI's answer) back to its real value,
 *  in place. Skips the composer and script/style. Robust across sites (no per-site selectors). */
function restoreVisible() {
  if (!session.hasKey) {
    showToast("אין מפתח שחזור עדיין — קודם הסתר פרטים");
    return;
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) {
        return NodeFilter.FILTER_REJECT;
      }
      const tag = parent.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || closestEditable(parent)) {
        return NodeFilter.FILTER_REJECT;
      }
      return node.nodeValue && node.nodeValue.indexOf("[") !== -1
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP;
    },
  });
  const nodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    nodes.push(node as Text);
  }
  let changed = 0;
  for (const textNode of nodes) {
    const original = textNode.nodeValue ?? "";
    const { text } = session.restore(original);
    if (text !== original) {
      textNode.nodeValue = text;
      changed += 1;
    }
  }
  showToast(changed > 0 ? `שוחזר ב-${changed} מקומות` : "לא נמצאו טוקנים לשחזור בעמוד");
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
    // Keep the chip (with שחזר) available once a key exists, even when the composer isn't focused.
    if (session.hasKey) {
      setChipProtected(0);
    } else {
      hideChip();
    }
    return;
  }
  const text = getText(composer);
  const distinct = new Set(session.detect(text).map((s) => text.slice(s.start, s.end)));
  if (distinct.size === 0) {
    if (session.hasKey) {
      setChipProtected(0);
    } else {
      hideChip();
    }
    return;
  }
  setChipDetected(distinct.size);
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
  setChipProtected(newRows.length);
  showToast(
    newRows.length > 0
      ? `הוסתרו ${newRows.length} פרטים · נוספה הנחיה ל-AI לשמור על האסימונים`
      : "לא נמצאו פרטים חדשים להסתרה",
  );
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

// Restore the key from storage (survives reload within the 24h window); then show the chip's שחזר
// affordance if a key from earlier today is still around.
void session.hydrate().then(() => updateChip());

// eslint-disable-next-line no-console
console.log("[mechikon] inline content script ready on", location.host);
