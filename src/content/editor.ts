/**
 * DOM text operations for AI-chat composers. Two editor families exist across the target sites:
 * plain <textarea> (some inputs) and contenteditable rich editors (ProseMirror on ChatGPT, Lexical
 * on Claude, Gemini's editor). Every mutation goes through the one path each family treats as a
 * native edit, so the framework's model stays in sync (proven in the phase-0 spike).
 */

export type InputEl = HTMLTextAreaElement | HTMLInputElement;
export type EditableEl = HTMLElement;
export type Composer = InputEl | EditableEl;

export function isInput(el: Element | null | undefined): el is InputEl {
  return !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT");
}

/** The composer the user is currently editing: a focused textarea/input or a contenteditable. */
export function focusedComposer(): Composer | null {
  const el = document.activeElement as HTMLElement | null;
  if (!el) {
    return null;
  }
  if (isInput(el)) {
    return el;
  }
  if (el.isContentEditable) {
    return el;
  }
  return null;
}

export function getText(el: Composer): string {
  if (isInput(el)) {
    return el.value;
  }
  // innerText (not textContent) so line breaks between the editor's inner blocks/<br> are preserved —
  // textContent glues every paragraph into one line, which then gets written back as a single flat line
  // and mangles multi-line drafts. Fall back to textContent if innerText is unavailable.
  return el.innerText ?? el.textContent ?? "";
}

/** Replace the entire composer content with `text`, as one native edit. */
export function setWholeText(el: Composer, text: string): boolean {
  if (isInput(el)) {
    el.focus();
    setInputValue(el, text);
    return true;
  }
  el.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  sel?.removeAllRanges();
  sel?.addRange(range);
  return document.execCommand("insertText", false, text);
}

/** Set a React-controlled input's value via the native setter so React's onChange still fires. */
function setInputValue(el: InputEl, text: string): void {
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) {
    setter.call(el, text);
  } else {
    el.value = text;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export interface SelectionCtx {
  readonly value: string;
  readonly rect: DOMRect;
  /** True when the selection sits inside an editable composer (offer redact); false = read-only (offer restore). */
  readonly inEditable: boolean;
  /** The exact editable element the selection is in (the target to redact into) — null when read-only. */
  readonly el: Composer | null;
}

/** The current non-empty selection with where it is, or null. Handles both input and contenteditable. */
export function currentSelection(): SelectionCtx | null {
  const active = document.activeElement as HTMLElement | null;
  if (
    isInput(active) &&
    active.selectionStart != null &&
    active.selectionEnd != null &&
    active.selectionStart !== active.selectionEnd
  ) {
    return {
      value: active.value.slice(active.selectionStart, active.selectionEnd),
      rect: active.getBoundingClientRect(),
      inEditable: true,
      el: active,
    };
  }
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
    const range = sel.getRangeAt(0);
    const editable = closestEditable(range.startContainer);
    return {
      value: sel.toString(),
      rect: range.getBoundingClientRect(),
      inEditable: !!editable,
      el: editable,
    };
  }
  return null;
}

/** Replace just the current selection with `text` (used by restore). Falls back to raw DOM for
 *  read-only assistant messages, which are not editable. */
export function replaceSelection(text: string): boolean {
  const active = document.activeElement as HTMLElement | null;
  if (
    isInput(active) &&
    active.selectionStart != null &&
    active.selectionEnd != null &&
    active.selectionStart !== active.selectionEnd
  ) {
    active.setRangeText(text, active.selectionStart, active.selectionEnd, "end");
    active.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    return false;
  }
  const range = sel.getRangeAt(0);
  const editable = closestEditable(range.startContainer);
  if (editable) {
    editable.focus();
    if (document.execCommand("insertText", false, text)) {
      return true;
    }
  }
  try {
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
    return true;
  } catch {
    return false;
  }
}

/** Our real placeholder tokens are Latin-label + digits, e.g. [NAME_1]. The instruction's digit-free
 *  [סוג_מספר] never matches, so it is never highlighted. */
const TOKEN = /\[[A-Za-z]+_\d+\]/g;

/**
 * Best-effort: wrap each placeholder token in the composer with a green "chip" span so the user can
 * SEE what was masked before sending. Contenteditable only (a textarea can't style substrings).
 * Purely cosmetic and mutation-tolerant: the token TEXT is unchanged (textContent still returns the
 * clean token), and if the site's editor rejects the DOM change we swallow it — no functional impact.
 */
export function highlightTokens(el: Composer): void {
  if (isInput(el)) {
    return;
  }
  try {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if ((node.parentElement as HTMLElement | null)?.dataset.mechikonTok) {
          return NodeFilter.FILTER_REJECT; // already wrapped
        }
        TOKEN.lastIndex = 0;
        return node.nodeValue && TOKEN.test(node.nodeValue)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    });
    const targets: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      targets.push(node as Text);
    }
    for (const textNode of targets) {
      wrapTokens(textNode);
    }
  } catch {
    // The rich editor rejected the DOM mutation — highlight is cosmetic, so ignore.
  }
}

function wrapTokens(textNode: Text): void {
  const text = textNode.nodeValue ?? "";
  TOKEN.lastIndex = 0;
  const fragment = document.createDocumentFragment();
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN.exec(text)) !== null) {
    if (match.index > last) {
      fragment.appendChild(document.createTextNode(text.slice(last, match.index)));
    }
    const chip = document.createElement("span");
    chip.textContent = match[0];
    chip.dataset.mechikonTok = "1";
    chip.style.cssText =
      "background:rgba(52,199,89,.20);color:#0a7d38;border-radius:4px;padding:0 3px;font-weight:600;";
    fragment.appendChild(chip);
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(last)));
  }
  textNode.parentNode?.replaceChild(fragment, textNode);
}

/** The whole word/number under a screen point (letters+digits run), or null. Used by click-to-hide:
 *  the user clicks a value in the composer and we mask exactly that token. */
export function wordAtPoint(x: number, y: number): string | null {
  let node: Node | null = null;
  let offset = 0;
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (typeof document.caretRangeFromPoint === "function") {
    const range = document.caretRangeFromPoint(x, y);
    node = range?.startContainer ?? null;
    offset = range?.startOffset ?? 0;
  } else if (doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(x, y);
    node = pos?.offsetNode ?? null;
    offset = pos?.offset ?? 0;
  }
  if (!node || node.nodeType !== Node.TEXT_NODE) {
    return null;
  }
  const text = (node as Text).nodeValue ?? "";
  const isWord = (ch: string) => /[\p{L}\p{N}]/u.test(ch);
  let i = offset;
  if (i >= text.length || !isWord(text[i])) {
    i -= 1; // a click on the right edge lands one past the last char
  }
  if (i < 0 || !isWord(text[i])) {
    return null;
  }
  let start = i;
  let end = i + 1;
  while (start > 0 && isWord(text[start - 1])) {
    start -= 1;
  }
  while (end < text.length && isWord(text[end])) {
    end += 1;
  }
  // Reject a click INSIDE an existing placeholder token, e.g. the "NUM"/"1" of "[NUM_1]" — masking
  // those would nest tokens and orphan the original mapping (breaking restore).
  const before = start > 0 ? text[start - 1] : "";
  const after = end < text.length ? text[end] : "";
  if ((before === "[" || before === "_") && (after === "_" || after === "]")) {
    return null;
  }
  return text.slice(start, end);
}

/**
 * The editing HOST for a node — the OUTERMOST contentEditable element, not the nearest one. In rich
 * editors (Gemini, Claude, ProseMirror) every line is an inner block that INHERITS contenteditable, so
 * the nearest ancestor is a single paragraph. Operating on that reads/writes one line only, flattens
 * the rest, and re-appends the AI instruction mid-text. Climbing to the host makes every manual action
 * see and rewrite the whole composer.
 */
export function closestEditable(node: Node | null): HTMLElement | null {
  let el: HTMLElement | null =
    node && node.nodeType === 1 ? (node as HTMLElement) : node?.parentElement ?? null;
  while (el && !el.isContentEditable) {
    el = el.parentElement;
  }
  if (!el) {
    return null;
  }
  // Climb to the highest still-editable ancestor (the element that actually carries the contenteditable).
  let host = el;
  for (let p = host.parentElement; p && p.isContentEditable; p = p.parentElement) {
    host = p;
  }
  return host;
}
