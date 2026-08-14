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
import { requestNer } from "../shared/ner";
import {
  closestEditable,
  currentSelection,
  focusedComposer,
  getText,
  highlightTokens,
  replaceSelection,
  setWholeText,
  type Composer,
} from "./editor";

const session = new RedactSession();
let lastComposer: Composer | null = null;

// Clearly SEPARATED from the user's message: a dashed rule delimits it. The rule survives even if the
// editor collapses the newlines, so the note never blends into the message. Wording reassures the model
// the text is ALREADY anonymized (no PII) so it answers normally instead of refusing; the digit-free
// [סוג_מספר] example is untouched by the restore matcher (which needs [..._<digits>]).
const INSTRUCTION =
  "\n\n———————————————\n🔒 הנחיה ל-AI (מחיקון): הטקסט שמעל עבר אנונימיזציה ואינו מכיל מידע אישי אמיתי. הסימונים בסוגריים מרובעים (בתבנית [סוג_מספר], למשל שם או מספר) הם תחליפים אנונימיים — התייחס אליהם כאל ערכים רגילים, ענה על הבקשה כרגיל, והשאר כל סימון בתשובתך בדיוק כפי שהוא כדי שנוכל לשחזר.";
const INSTRUCTION_MARKER = "הנחיה ל-AI (מחיקון)";

// ---- UI (shadow DOM, immune to host page CSS) ---------------------------------------
// The selection popover's current action, invoked on the button's mousedown (set in refreshPopover).
let popAction: (() => void) | null = null;
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
      --glass-card: rgba(255,255,255,.4);
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
      background: var(--glass-card); -webkit-backdrop-filter: blur(34px) saturate(200%);
      backdrop-filter: blur(34px) saturate(200%); border: .5px solid var(--hairline);
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
      position: relative; color: #fff; font-size: 13.5px; font-weight: 600; letter-spacing: -.006em;
      height: 40px; padding: 0 18px; border-radius: 999px; overflow: hidden;
      background: linear-gradient(180deg, rgba(46,46,52,.94), rgba(8,8,10,.96));
      -webkit-backdrop-filter: blur(14px) saturate(180%); backdrop-filter: blur(14px) saturate(180%);
      border: .5px solid rgba(255,255,255,.16);
      box-shadow: 0 2px 8px rgba(0,0,0,.28), inset 0 1px 0 rgba(255,255,255,.2), inset 0 -1px 0 rgba(0,0,0,.3);
      transition: transform .14s var(--ease), box-shadow .22s var(--ease), filter .22s var(--ease);
    }
    /* top light sweep for a glassy, modern surface */
    .cta::after {
      content: ""; position: absolute; inset: 0 0 auto 0; height: 50%; pointer-events: none;
      background: linear-gradient(180deg, rgba(255,255,255,.16), rgba(255,255,255,0));
    }
    .cta:hover { transform: translateY(-1px); filter: brightness(1.12);
      box-shadow: 0 8px 20px rgba(0,0,0,.3), inset 0 1px 0 rgba(255,255,255,.26); }
    .cta:active { transform: translateY(0) scale(.96); filter: brightness(.98); }
    .cta:focus-visible { outline: 2px solid var(--green); outline-offset: 2px; }
    /* secondary (restore): light frosted glass, ink text */
    .cta.ghost {
      color: var(--ink); background: linear-gradient(180deg, rgba(255,255,255,.72), rgba(255,255,255,.4));
      border: .5px solid var(--hairline);
      box-shadow: 0 2px 8px rgba(0,0,0,.06), inset 0 1px 0 rgba(255,255,255,.85);
    }
    .cta.ghost::after { background: linear-gradient(180deg, rgba(255,255,255,.5), rgba(255,255,255,0)); }
    .cta.ghost:hover { filter: brightness(1.03);
      box-shadow: 0 8px 18px rgba(0,0,0,.1), inset 0 1px 0 rgba(255,255,255,.95); }
    .actions { display: flex; align-items: center; gap: 8px; }

    .pop { display: none; transform: translate(-50%, -100%); animation: rise .2s var(--ease); }
    .pop .cta { height: 38px; padding: 0 16px; font-size: 13px; white-space: nowrap; }

    .toast {
      bottom: 90px; inset-inline-start: 24px; display: none; align-items: center; gap: 10px; max-width: 360px;
      background: var(--glass-card); -webkit-backdrop-filter: blur(34px) saturate(200%);
      backdrop-filter: blur(34px) saturate(200%); border: .5px solid var(--hairline);
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
  // Act on mousedown (not click): mousedown always fires and preventDefault keeps the composer
  // selection/focus intact. Relying on click was fragile — the editor could move/collapse the
  // selection between mousedown and mouseup so the click never landed on the button.
  popBtn.addEventListener("mousedown", (event) => {
    event.preventDefault();
    popAction?.();
  });
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

/** Deterministic values masked, but names/orgs still pending (model loading or NER pass not done):
 *  ORANGE dot + "partly protected" — never a full-green "safe" claim while a name may be exposed. */
function setChipPending() {
  ui.dot.classList.remove("green");
  ui.chipLabel.textContent = "מוגן חלקית · שמות בהמתנה";
  ui.chipBtn.style.display = "none";
  ui.restoreBtn.style.display = session.hasKey ? "" : "none";
  ui.chip.style.display = "flex";
}

/** Everything redacted (incl. names, model was ready): green dot, only שחזר. */
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

/** The composer to act on: the focused one, or the last focused one IF it's still in the DOM (SPA
 *  chat sites detach the editor on send/navigate — never write to a detached node). */
function activeComposer(): Composer | null {
  const focused = focusedComposer();
  if (focused) {
    lastComposer = focused;
    return focused;
  }
  if (lastComposer && lastComposer.isConnected) {
    return lastComposer;
  }
  lastComposer = null;
  return null;
}

/** True after a deterministic pass while NER names/orgs are still not applied (model loading, or the
 *  NER pass hasn't run yet). Drives the "partly protected" chip so we never falsely claim full safety. */
let namesPending = false;

function updateChip() {
  const composer = activeComposer();
  const text = composer ? getText(composer) : "";
  const distinct = composer
    ? new Set(session.detect(text).map((s) => text.slice(s.start, s.end)))
    : new Set<string>();
  if (distinct.size > 0) {
    setChipDetected(distinct.size);
  } else if (namesPending) {
    setChipPending();
  } else if (session.hasKey) {
    setChipProtected(0);
  } else {
    hideChip();
  }
}

function writeWithInstruction(composer: Composer, redacted: string, addInstruction: boolean) {
  const withInstruction =
    addInstruction && !redacted.includes(INSTRUCTION_MARKER) ? redacted + INSTRUCTION : redacted;
  setWholeText(composer, withInstruction);
  highlightTokens(composer); // paint the [TOKEN_n] chips green so the user sees what was masked
}

// ---- redact-all (the chip) -----------------------------------------------------------
// Two passes, so we never (a) block on the model, (b) overwrite text typed during the await, or
// (c) claim full protection before names are actually masked.
async function redactAll() {
  const composer = activeComposer();
  if (!composer) {
    return;
  }
  // Pass 1 — deterministic + manual, synchronous: write immediately, no race window.
  const original = getText(composer);
  const detPass = session.redact(original, []);
  writeWithInstruction(composer, detPass.text, detPass.newRows.length > 0);
  namesPending = true;
  setChipPending();
  showToast(
    detPass.newRows.length > 0
      ? `הוסתרו ${detPass.newRows.length} פרטים · נוספה הנחיה ל-AI`
      : "נסרק — ממתין לזיהוי שמות",
  );

  // Pass 2 — NER names/orgs. Detect on the pre-redaction text, then re-read the CURRENT composer and
  // mask the values still present there, so anything typed meanwhile is preserved (and also masked).
  const nerSpans = await requestNer(original);
  if (!composer.isConnected) {
    return; // composer was swapped out (message sent) — don't touch a detached node
  }
  const valued = nerSpans.map((span) => ({
    value: original.slice(span.start, span.end),
    type: span.type,
  }));
  const current = getText(composer);
  const nerPass = session.redactNerValues(current, valued);
  if (nerPass.newRows.length > 0) {
    writeWithInstruction(composer, nerPass.text, true);
    showToast(`הוסתרו גם ${nerPass.newRows.length} שמות/ארגונים`);
  }
  if (nerReady) {
    namesPending = false;
    setChipProtected(detPass.newRows.length + nerPass.newRows.length);
  }
  // If the model isn't ready yet, stay "partly protected" until the user redacts again once it loads.
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
    const value = ctx.value.trim();
    ui.popBtn.textContent = "הסתר בחירה";
    popAction = () => {
      ui.pop.style.display = "none";
      const composer = activeComposer();
      if (!composer || value.length === 0) {
        showToast("לא ניתן להסתיר את הבחירה");
        return;
      }
      // Mask ONLY the selected value — not a full auto-redact of the whole message.
      const { text, newRows } = session.redactManualValue(getText(composer), value);
      if (newRows.length > 0) {
        writeWithInstruction(composer, text, true);
        showToast(`הוסתר: ${value}`);
      } else {
        showToast(`לא נמצא "${value}" בתיבה`);
      }
      updateChip();
    };
  } else if (session.hasKey) {
    ui.popBtn.textContent = "שחזר בחירה";
    popAction = () => {
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

// The offscreen NER model announces readiness (relayed via the SW). Until then, names/orgs aren't
// caught automatically — let the user know so it's not mistaken for a miss.
let nerReady = false;
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "ner:ready" && !nerReady) {
    nerReady = true;
    showToast("מנוע זיהוי השמות מוכן — הסתירו שוב לזיהוי שמות, ארגונים ומקומות");
  }
});

// Restore the key from storage (survives reload within the 24h window); then show the chip's שחזר
// affordance if a key from earlier today is still around.
void session.hydrate().then(() => updateChip());

// eslint-disable-next-line no-console
console.log("[mechikon] inline content script ready on", location.host);
