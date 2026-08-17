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
import { RedactSession } from "../shared/session";
import { requestNer } from "../shared/ner";
import {
  detectTextLang,
  withInstruction as buildWithInstruction,
} from "../shared/instruction";
import { defaultLang, t, type Lang } from "../shared/i18n";
import {
  closestEditable,
  currentSelection,
  focusedComposer,
  getText,
  highlightTokens,
  isInput,
  replaceSelection,
  setWholeText,
  wordAtPoint,
  type Composer,
} from "./editor";

const session = new RedactSession();
let lastComposer: Composer | null = null;
// The UI language FOLLOWS THE TEXT the user is writing (Hebrew vs Latin), falling back to the browser
// language when the composer is empty. Recomputed in updateChip; applied to labels + text direction.
let uiLang: Lang = defaultLang();
// These are used by makeDraggable, which mountUi() calls at module load — so they MUST be declared
// before that call, or accessing them hits the `let`/`const` temporal dead zone and the whole content
// script throws at load (a runtime error tsc/build do not catch).
const CHIP_POS_KEY = "chipPos.v1";
let reclampChipPosition: () => void = () => {};

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
    /* text direction is set inline per UI language (Hebrew=rtl, English=ltr) — see applyLang(). */
    .chip, .pop, .toast { position: fixed; z-index: 2147483647; font-family: var(--font); }
    button { font-family: var(--font); cursor: pointer; border: 0; -webkit-font-smoothing: antialiased; }

    /* Pinned bottom-LEFT explicitly (inset-inline-start resolves to the RIGHT under dir:rtl, where the
       send button lives) so we never cover the composer's send control. */
    .chip {
      bottom: 24px; left: 24px; right: auto; display: none; align-items: center; gap: 13px;
      background: var(--glass-card); -webkit-backdrop-filter: blur(34px) saturate(200%);
      backdrop-filter: blur(34px) saturate(200%); border: .5px solid var(--hairline);
      border-radius: 20px; padding: 12px 12px 12px 18px; box-shadow: var(--shadow);
      animation: rise .34s var(--ease); cursor: grab; touch-action: none; user-select: none;
    }
    .chip.dragging { cursor: grabbing; animation: none; }
    /* the drag surface is the chip itself; buttons opt back into the pointer so they stay clickable */
    .chip .cta { cursor: pointer; }
    /* glass sheen */
    .chip::before {
      content: ""; position: absolute; inset: 0; border-radius: 20px; pointer-events: none;
      background: linear-gradient(180deg, rgba(255,255,255,.55), rgba(255,255,255,0) 42%);
    }
    /* One dot, three unmistakable states: detected (amber, pulsing = act), pending (green, spinning
       = working), protected (green, check = safe). Motion is gated by prefers-reduced-motion below. */
    .dot {
      position: relative; width: 10px; height: 10px; border-radius: 50%; flex: 0 0 auto;
      background: var(--orange); box-shadow: 0 0 0 4px rgba(255,149,0,.16);
      transition: background .35s var(--ease), box-shadow .35s var(--ease);
    }
    .dot.idle { background: rgba(10,10,10,.28); box-shadow: 0 0 0 4px rgba(10,10,10,.05); }
    .dot.detected { animation: pulse 1.8s var(--ease) infinite; }
    @keyframes pulse {
      0%, 100% { box-shadow: 0 0 0 4px rgba(255,149,0,.18); }
      50% { box-shadow: 0 0 0 8px rgba(255,149,0,.04); }
    }
    .dot.pending { background: var(--green); box-shadow: 0 0 0 4px rgba(52,199,89,.14); }
    .dot.pending::after {
      content: ""; position: absolute; inset: -5px; border-radius: 50%;
      border: 2px solid transparent; border-top-color: var(--green); animation: spin .8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .dot.green {
      background: var(--green); box-shadow: 0 0 0 4px rgba(52,199,89,.16), 0 0 10px rgba(52,199,89,.5);
    }
    .dot.green::after {
      content: ""; position: absolute; left: 3px; top: 1px; width: 2px; height: 5px;
      border: solid #fff; border-width: 0 1.6px 1.6px 0; transform: rotate(45deg);
    }
    .info { display: flex; flex-direction: column; gap: 1px; line-height: 1.2; }
    .brand { font-size: 10px; font-weight: 700; letter-spacing: .1em; color: rgba(10,10,10,.4); }
    .label { font-size: 14px; font-weight: 600; color: var(--ink); letter-spacing: -.01em;
      font-variant-numeric: tabular-nums; }

    .cta {
      position: relative; color: #fff; font-size: 13.5px; font-weight: 600; letter-spacing: -.006em;
      height: 44px; padding: 0 18px; border-radius: 999px; overflow: hidden;
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
    /* active toggle (pick mode ON) — filled ink */
    .cta.ghost.active { color: #fff; background: linear-gradient(180deg, rgba(46,46,52,.94), rgba(8,8,10,.96)); }
    .actions { display: flex; align-items: center; gap: 8px; }

    .pop { display: none; transform: translate(-50%, -100%); animation: rise .2s var(--ease); }
    .pop .cta { height: 44px; padding: 0 18px; font-size: 13.5px; white-space: nowrap; }

    .toast {
      bottom: 92px; left: 24px; right: auto; display: none; align-items: center; gap: 10px; max-width: 360px;
      background: var(--glass-card); -webkit-backdrop-filter: blur(34px) saturate(200%);
      backdrop-filter: blur(34px) saturate(200%); border: .5px solid var(--hairline);
      border-radius: 14px; padding: 12px 16px; box-shadow: var(--shadow);
      color: var(--ink); font-size: 14px; font-weight: 500; animation: rise .34s var(--ease);
    }
    /* Toast dot color follows meaning, not always-green: ok=green, error=amber, info=grey. */
    .toast::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--green); flex: 0 0 auto; }
    .toast[data-kind="error"]::before { background: var(--orange); }
    .toast[data-kind="info"]::before { background: rgba(10,10,10,.35); }

    @keyframes rise { from { opacity: 0; transform: translateY(8px) scale(.98); } }
    @media (prefers-reduced-motion: reduce) {
      .chip, .pop, .toast { animation: none; }
      .cta, .dot { transition: none; }
      .dot.detected, .dot.pending::after { animation: none; }
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
  chipLabel.setAttribute("aria-live", "polite");
  info.append(brand, chipLabel);
  const actions = document.createElement("div");
  actions.className = "actions";
  const chipBtn = document.createElement("button");
  chipBtn.className = "cta";
  chipBtn.textContent = t(uiLang, "btnHide");
  keepFocus(chipBtn);
  chipBtn.addEventListener("click", redactAll);
  const pickBtn = document.createElement("button");
  pickBtn.className = "cta ghost";
  pickBtn.textContent = t(uiLang, "btnPick");
  keepFocus(pickBtn);
  pickBtn.addEventListener("click", togglePickMode);
  const restoreBtn = document.createElement("button");
  restoreBtn.className = "cta ghost";
  restoreBtn.textContent = t(uiLang, "btnRestore");
  keepFocus(restoreBtn);
  restoreBtn.addEventListener("click", restoreVisible);
  actions.append(chipBtn, pickBtn, restoreBtn);
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
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");

  shadow.append(style, chip, pop, toast);
  document.documentElement.appendChild(host);

  makeDraggable(chip);

  return { chipLabel, chip, dot, chipBtn, pickBtn, restoreBtn, pop, popBtn, toast };
}

// ---- drag: let the user move the chip so it never covers the composer / send button --------

/** Drag the chip by its body (buttons excluded). Position persists in chrome.storage.local and is
 *  clamped to the viewport on restore + on resize so it can never end up off-screen. */
function makeDraggable(chip: HTMLElement) {
  let startX = 0;
  let startY = 0;
  let originLeft = 0;
  let originTop = 0;
  let dragging = false;

  const pin = (left: number, top: number) => {
    const maxLeft = Math.max(0, window.innerWidth - chip.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - chip.offsetHeight);
    const l = Math.min(Math.max(0, left), maxLeft);
    const t = Math.min(Math.max(0, top), maxTop);
    chip.style.left = `${l}px`;
    chip.style.top = `${t}px`;
    chip.style.right = "auto";
    chip.style.bottom = "auto";
    return { l, t };
  };

  const onMove = (e: PointerEvent) => {
    if (!dragging) {
      return;
    }
    pin(originLeft + (e.clientX - startX), originTop + (e.clientY - startY));
  };

  const onUp = () => {
    if (!dragging) {
      return;
    }
    dragging = false;
    chip.classList.remove("dragging");
    document.removeEventListener("pointermove", onMove, true);
    document.removeEventListener("pointerup", onUp, true);
    document.removeEventListener("pointercancel", onUp, true);
    void chrome.storage.local.set({
      [CHIP_POS_KEY]: { left: parseFloat(chip.style.left), top: parseFloat(chip.style.top) },
    });
  };

  chip.addEventListener("pointerdown", (e) => {
    // Buttons (and anything inside them) must keep their own click — only the chip body drags.
    if ((e.target as HTMLElement).closest("button")) {
      return;
    }
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = chip.getBoundingClientRect();
    originLeft = rect.left;
    originTop = rect.top;
    chip.classList.add("dragging");
    // Capture the pointer so we ALWAYS get the terminating pointerup/pointercancel on the chip —
    // otherwise a release outside the window is never delivered and the chip sticks to the cursor.
    try {
      chip.setPointerCapture(e.pointerId);
    } catch {
      // setPointerCapture can throw on a stale pointerId — the document listeners still cover it.
    }
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onUp, true); // touch scroll/gesture cancels the drag
  });

  // Re-clamp to the current viewport. Exposed so it can run when the chip first becomes visible
  // (it's display:none at restore, so its height is 0 then and can't be clamped against yet).
  reclampChipPosition = () => {
    if (chip.style.left) {
      pin(parseFloat(chip.style.left), parseFloat(chip.style.top));
    }
  };

  // Restore the saved position (if any) and keep it on-screen when the window resizes.
  void chrome.storage.local.get(CHIP_POS_KEY).then((bag) => {
    const saved = bag[CHIP_POS_KEY] as { left: number; top: number } | undefined;
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      pin(saved.left, saved.top);
    }
  });
  window.addEventListener("resize", () => reclampChipPosition());
}

// ---- click-to-hide: pick mode --------------------------------------------------------
// When ON, a click on any word/number in a composer masks exactly that value in place (and every
// repeat), instead of moving the caret. Toggle OFF to edit/send normally. Auto "הסתר" still works too.
let pickMode = false;

function togglePickMode() {
  if (pickMode) {
    exitPickMode();
  } else {
    enterPickMode();
  }
}

function enterPickMode() {
  pickMode = true;
  document.documentElement.style.cursor = "crosshair";
  paintPickBtn();
  showToast(t(uiLang, "pickModeToast"), "info");
}

/** Always safe to call — leaves the mode and restores the cursor so it can't get stuck globally
 *  (e.g. after the user sends the message without toggling off). */
function exitPickMode() {
  if (!pickMode) {
    return;
  }
  pickMode = false;
  document.documentElement.style.cursor = "";
  paintPickBtn();
}

document.addEventListener(
  "keydown",
  (event) => {
    if (event.key === "Escape") {
      exitPickMode();
    }
  },
  true,
);

// ---- send-guard: don't let unmasked PII leave the browser on Enter -------------------
// Safety net for the moment the user forgets to mask. If Enter would send a composer that still holds
// sensitive text, block that one send and warn; pressing Enter again for the SAME values sends them
// (their explicit choice). Shift+Enter (newline) and IME composition are never touched.

/** Every sensitive value present in `text`: deterministically-detected PII (ID/phone/email/IBAN/…)
 *  PLUS any known original value from the restore key — including NER names/orgs — that reappears.
 *  The key-value check is what makes a live-restored answer pasted back into the box get caught even
 *  for categories the keystroke-path detector doesn't model. Fails CLOSED: an engine error counts as
 *  sensitive so the guard blocks rather than leaks. */
function sensitiveValuesIn(text: string): Set<string> {
  const found = new Set<string>();
  try {
    for (const span of session.detect(text)) {
      found.add(text.slice(span.start, span.end));
    }
  } catch {
    found.add(" detect-error"); // force a block on the rare engine throw — never fail open
  }
  for (const row of session.rows) {
    if (row.original.length >= 2 && text.includes(row.original)) {
      found.add(row.original);
    }
  }
  return found;
}

// The exact value-set the user was last warned about. The bypass is CONTENT-bound, not time-bound: a
// second Enter only passes if the current sensitive set is the same one already warned — introduce a
// new/different sensitive value and it re-blocks (a stale time window would let fresh PII slip through).
let warnedValues: Set<string> | null = null;
window.addEventListener(
  "keydown",
  (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
      return;
    }
    const target = event.target as Element | null;
    // Cover BOTH composer families — a bare <textarea>/<input> is not contentEditable, so
    // closestEditable alone would miss it and the send would go unguarded.
    const editable: Composer | null = isInput(target) ? target : closestEditable(target);
    if (!editable) {
      return;
    }
    const sensitive = sensitiveValuesIn(getText(editable));
    if (sensitive.size === 0) {
      warnedValues = null; // clean composer — disarm and allow
      return;
    }
    if (warnedValues && [...sensitive].every((v) => warnedValues?.has(v))) {
      warnedValues = null; // exactly the values the user already confirmed — allow this send
      return;
    }
    // Block this send; arm the bypass for THIS content (new PII later will re-block).
    event.preventDefault();
    event.stopImmediatePropagation();
    warnedValues = sensitive;
    lastComposer = editable;
    applyLang(detectTextLang(getText(editable), defaultLang()));
    updateChip(); // surface the amber "sensitive values detected" state
    showToast(t(uiLang, "sendBlocked", { n: sensitive.size }), "error");
  },
  true,
);

function paintPickBtn() {
  ui.pickBtn.textContent = pickMode ? t(uiLang, "pickActive") : t(uiLang, "btnPick");
  ui.pickBtn.classList.toggle("active", pickMode);
}

/** Apply the UI language: button labels + text direction (Hebrew rtl / English ltr). Called from
 *  updateChip whenever the detected language of the composer text changes. */
function applyLang(lang: Lang) {
  uiLang = lang;
  const dir = lang === "he" ? "rtl" : "ltr";
  ui.chip.style.direction = dir;
  ui.pop.style.direction = dir;
  ui.toast.style.direction = dir;
  ui.chipBtn.textContent = t(lang, "btnHide");
  ui.restoreBtn.textContent = t(lang, "btnRestore");
  paintPickBtn();
}

document.addEventListener(
  "mousedown",
  (event) => {
    if (!pickMode) {
      return;
    }
    const editable = closestEditable(event.target as Node | null);
    if (!editable) {
      return; // click outside a composer (e.g. our own UI) — ignore
    }
    const word = wordAtPoint(event.clientX, event.clientY);
    if (!word || word.trim().length === 0) {
      return;
    }
    event.preventDefault(); // don't move the caret — we're masking, not editing
    event.stopPropagation();
    const src = getText(editable);
    const { text } = session.redactManualValue(src, word);
    // Write whenever the text actually changed — NOT only when a brand-new row was minted. A value
    // already in the key (masked earlier this session) reuses its token and mints no new row, but the
    // composer still needs the substitution, or the click looks like it did nothing.
    if (text !== src) {
      writeWithInstruction(editable, text, true);
      showToast(t(uiLang, "hiddenValue", { v: word }));
      updateChip();
    } else {
      showToast(t(uiLang, "notFoundToHide", { v: word }), "info");
    }
  },
  true,
);

/** Stop a UI button from stealing focus / clearing the page selection when pressed. */
function keepFocus(btn: HTMLElement) {
  btn.addEventListener("mousedown", (e) => e.preventDefault());
}

type ToastKind = "ok" | "error" | "info";
function showToast(text: string, kind: ToastKind = "ok") {
  ui.toast.textContent = text;
  ui.toast.dataset.kind = kind;
  ui.toast.style.display = "flex";
  window.setTimeout(() => (ui.toast.style.display = "none"), 4000);
}

/** Sensitive values found but not yet redacted: amber pulsing dot + count + הסתר (and שחזר if a key exists). */
function setChipDetected(count: number) {
  ui.dot.className = "dot detected";
  ui.chipLabel.textContent = t(uiLang, "detectedCount", { n: count });
  ui.chipBtn.style.display = "";
  ui.restoreBtn.style.display = session.hasKey ? "" : "none";
  ui.chip.style.display = "flex";
}

/** Deterministic values masked, but names/orgs still pending (model loading or NER pass not done):
 *  spinning green dot + "masking names…" — never a full "safe" claim while a name may be exposed. */
function setChipPending() {
  ui.dot.className = "dot pending";
  ui.chipLabel.textContent = t(uiLang, "maskingNames");
  ui.chipBtn.style.display = "none";
  ui.restoreBtn.style.display = session.hasKey ? "" : "none";
  ui.chip.style.display = "flex";
}

/** Everything redacted (incl. names, model was ready): green check dot, only שחזר. */
function setChipProtected(count: number) {
  ui.dot.className = "dot green";
  ui.chipLabel.textContent =
    count > 0 ? t(uiLang, "protectedCount", { n: count }) : t(uiLang, "protectedLabel");
  ui.chipBtn.style.display = "none";
  ui.restoreBtn.style.display = "";
  ui.chip.style.display = "flex";
}

/** Composer has text but nothing auto-detected — neutral dot, manual "בחר ידנית" still available. */
function setChipIdle() {
  ui.dot.className = "dot idle";
  ui.chipLabel.textContent = t(uiLang, "pickWhat");
  ui.chipBtn.style.display = "none";
  ui.restoreBtn.style.display = session.hasKey ? "" : "none";
  ui.chip.style.display = "flex";
}

function hideChip() {
  ui.chip.style.display = "none";
}

/** Restore every placeholder token visible on the page (the AI's answer) back to its real value,
 *  in place. Skips the composer and script/style. Robust across sites (no per-site selectors). */
function restoreVisible() {
  if (!session.hasKey) {
    showToast(t(uiLang, "nothingToRestore"), "error");
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
  showToast(
    changed > 0 ? t(uiLang, "restoredPlaces", { n: changed }) : t(uiLang, "noTokensOnPage"),
    changed > 0 ? "ok" : "error",
  );
}

// ---- live restore: un-mask the AI's answer as it streams in --------------------------
// When a key exists, restore [TOKEN]s to their real values live, as the answer renders — so the user
// reads real values with no manual step. Read-only areas ONLY (never a composer). This is a local
// display change; if the user copies a restored answer back into the composer, the send-guard catches
// it — its key-value check re-flags any restored value (names/orgs included), so live restore can't
// cause a silent re-leak.
let liveTimer = 0;
const livePending = new Set<Text>();

/** Queue any token-bearing text node under `node` (a changed text node or a freshly added subtree). */
function queueLiveNode(node: Node): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const tn = node as Text;
    if (tn.nodeValue && tn.nodeValue.indexOf("[") !== -1) {
      livePending.add(tn);
    }
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return;
  }
  const el = node as HTMLElement;
  const tag = el.tagName;
  if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") {
    return;
  }
  if (!el.textContent || el.textContent.indexOf("[") === -1) {
    return; // no token anywhere inside — skip the walk entirely
  }
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const tn = n as Text;
    if (tn.nodeValue && tn.nodeValue.indexOf("[") !== -1) {
      livePending.add(tn);
    }
  }
}

function flushLiveRestore(): void {
  liveTimer = 0;
  const nodes = [...livePending];
  livePending.clear();
  for (const tn of nodes) {
    if (!tn.isConnected) {
      continue;
    }
    const parent = tn.parentElement;
    // Never rewrite inside a composer (that is the user's own input, handled by the mask flow).
    if (!parent || closestEditable(parent)) {
      continue;
    }
    const original = tn.nodeValue ?? "";
    if (original.indexOf("[") === -1) {
      continue;
    }
    const { text } = session.restore(original);
    // Setting nodeValue re-fires the observer, but the restored text has no tokens left, so the next
    // pass finds nothing to change and the loop terminates.
    if (text !== original) {
      tn.nodeValue = text;
    }
  }
}

const liveObserver = new MutationObserver((records) => {
  if (!session.hasKey) {
    return;
  }
  for (const rec of records) {
    if (rec.type === "characterData") {
      queueLiveNode(rec.target);
    }
    rec.addedNodes.forEach(queueLiveNode);
  }
  if (livePending.size > 0 && liveTimer === 0) {
    liveTimer = window.setTimeout(flushLiveRestore, 120);
  }
});

function startLiveRestore(): void {
  if (document.body) {
    liveObserver.observe(document.body, { childList: true, characterData: true, subtree: true });
  }
}

// ---- auto-detect: watch the composer -------------------------------------------------
let detectTimer = 0;
function scheduleDetect() {
  const composer = focusedComposer();
  if (composer) {
    lastComposer = composer;
  }
  window.clearTimeout(detectTimer);
  detectTimer = window.setTimeout(updateChip, 350);
}
// Typing fires "input"; clicking into a box that ALREADY holds text fires "focusin" (no input) — cover
// both so a composer that had text before the script loaded still lights up the chip.
document.addEventListener("input", scheduleDetect, true);
document.addEventListener("focusin", scheduleDetect, true);

/** Find a composer that already contains text (page loaded with a draft, or the extension reloaded
 *  after the user typed). Returns the first non-empty text-bearing composer, else null.
 *  Only TEXT-like inputs are matched — a bare `input` selector would also catch checkboxes (value
 *  "on"), hidden fields, and submit buttons, whose non-empty `.value` would make us mask into the
 *  WRONG element. */
function findComposerWithText(): Composer | null {
  const focused = focusedComposer();
  if (focused && getText(focused).trim().length > 0) {
    return focused;
  }
  const candidates = document.querySelectorAll<HTMLElement>(
    "textarea, input[type='text'], input[type='search'], input[type='url'], input[type='email'], " +
      "input:not([type]), [contenteditable='true'], [contenteditable='']",
  );
  for (const el of candidates) {
    if (getText(el).trim().length > 0) {
      return el;
    }
  }
  return null;
}

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
  // Nothing focused and no live last-composer — fall back to any box that already holds text (draft
  // present before focus, or a fresh reload) so the chip can still act on it.
  const withText = findComposerWithText();
  if (withText) {
    lastComposer = withText;
    return withText;
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
  // UI language follows the composer's CONTENT (tokens + any appended instruction stripped, so a
  // Hebrew draft with masked values isn't misread as English), falling back to the browser language.
  applyLang(detectTextLang(text, defaultLang()));
  const distinct = composer
    ? new Set(session.detect(text).map((s) => text.slice(s.start, s.end)))
    : new Set<string>();
  if (distinct.size > 0) {
    setChipDetected(distinct.size);
  } else if (namesPending) {
    setChipPending();
  } else if (session.hasKey) {
    setChipProtected(0);
  } else if (text.trim().length > 0) {
    setChipIdle(); // text present, nothing auto-detected — still offer manual pick
  } else {
    exitPickMode(); // composer emptied (e.g. message sent) — don't leave pick mode stuck on
    hideChip();
    return;
  }
  // The chip is now visible; re-clamp its restored position against its real (non-zero) height.
  reclampChipPosition();
}

function writeWithInstruction(composer: Composer, redacted: string, addInstruction: boolean) {
  // The instruction matches the TEXT's language (so an English draft gets the English note), not the
  // chip's — usually the same, but the text is the source of truth for what the AI will read.
  const out = addInstruction
    ? buildWithInstruction(redacted, detectTextLang(redacted, uiLang))
    : redacted;
  setWholeText(composer, out);
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
      ? t(uiLang, "hiddenWithInstruction", { n: detPass.newRows.length })
      : t(uiLang, "scannedWaitingNames"),
    detPass.newRows.length > 0 ? "ok" : "info",
  );

  // Pass 2 — NER names/orgs. Detect on the pre-redaction text, then re-read the CURRENT composer and
  // mask the values still present there, so anything typed meanwhile is preserved (and also masked).
  const ner = await requestNer(original);
  if (ner.ok) {
    nerReady = true; // a real response proves the model is up (covers the missed one-shot broadcast)
  }
  if (!composer.isConnected) {
    return; // composer was swapped out (message sent) — don't touch a detached node
  }
  const valued = ner.spans.map((span) => ({
    value: original.slice(span.start, span.end),
    type: span.type,
  }));
  const current = getText(composer);
  const nerPass = session.redactNerValues(current, valued);
  if (nerPass.newRows.length > 0) {
    writeWithInstruction(composer, nerPass.text, true);
    showToast(t(uiLang, "alsoHidNames", { n: nerPass.newRows.length }));
  }
  // Only claim full protection when the model ACTUALLY ran (ner.ok). A timeout (ok=false) is NOT the
  // same as "no names" — stay partly-protected so we never show a false green while names may be exposed.
  if (ner.ok) {
    namesPending = false;
    setChipProtected(detPass.newRows.length + nerPass.newRows.length);
  }
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
    ui.popBtn.textContent = t(uiLang, "popHide");
    popAction = () => {
      ui.pop.style.display = "none";
      // Operate on the exact element the selection is in (not whatever is "focused") so the value is
      // always found and replaced in the right place.
      const composer = ctx.el;
      if (!composer || !composer.isConnected || value.length === 0) {
        showToast(t(uiLang, "cannotHideSelection"), "error");
        return;
      }
      // Mask ONLY the selected value — not a full auto-redact of the whole message. Write whenever the
      // text changed (a repeated value reuses its token and mints no new row, but still must be masked).
      const src = getText(composer);
      const { text } = session.redactManualValue(src, value);
      if (text !== src) {
        writeWithInstruction(composer, text, true);
        showToast(t(uiLang, "hiddenValue", { v: value }));
      } else {
        showToast(t(uiLang, "notFoundInBox", { v: value }), "error");
      }
      updateChip();
    };
  } else if (session.hasKey) {
    ui.popBtn.textContent = t(uiLang, "popRestore");
    popAction = () => {
      const { text, unmatched } = session.restore(ctx.value);
      replaceSelection(text);
      ui.pop.style.display = "none";
      showToast(
        unmatched.length > 0
          ? t(uiLang, "restoredUnmatched", { n: unmatched.length })
          : t(uiLang, "restored"),
        unmatched.length > 0 ? "info" : "ok",
      );
    };
  } else {
    ui.pop.style.display = "none";
    return;
  }
  ui.pop.style.left = `${ctx.rect.left + ctx.rect.width / 2}px`;
  // Clamp to the viewport top so a selection near the top doesn't push the popover off-screen.
  ui.pop.style.top = `${Math.max(52, ctx.rect.top - 6)}px`;
  ui.pop.style.display = "block";
}

// The offscreen NER model announces readiness (relayed via the SW). Until then, names/orgs aren't
// caught automatically — let the user know so it's not mistaken for a miss.
let nerReady = false;
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "ner:ready" && !nerReady) {
    nerReady = true;
    showToast(t(uiLang, "nerReady"));
  }
});

// Restore the key from storage (survives reload within the 24h window); then show the chip's שחזר
// affordance if a key from earlier today is still around, and light up for any draft already in a box.
void session.hydrate().then(() => updateChip());
// SPA composers mount after our script — retry the initial scan a few times so a pre-existing draft
// is picked up even if the editor wasn't in the DOM yet at load.
[400, 1200, 2500].forEach((ms) => window.setTimeout(updateChip, ms));
// Watch the page and un-mask tokens in AI answers as they stream in (no-op until a key exists).
startLiveRestore();

// eslint-disable-next-line no-console
console.log("[mechikon] inline content script ready on", location.host);
