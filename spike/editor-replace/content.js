// Phase-0 spike — REDACT MODE + consistent tokens.
// Toggle mode ON; then selecting any text redacts it. Rules proven here:
//  - same value  -> same token, and ALL its occurrences in the field are redacted
//  - new value   -> a fresh token with the next number
//  - token type follows the value: digits -> [NUM_n], otherwise -> [NAME_n]
// (The real extension will swap this toy classifier for the engine's real recognizers,
//  which mint [ID_n]/[PHONE_n]/[NAME_n]/... — but the SESSION/consistency logic is the same.)
(() => {
  let active = false;
  let btn = null;

  // The session: value -> token, plus a counter per type. Lives for the page's lifetime,
  // so the same name/number always maps to the same token across selections.
  const session = new Map();
  const counters = Object.create(null);

  boot();

  function boot() {
    if (!document.body) {
      window.addEventListener("DOMContentLoaded", boot, { once: true });
      return;
    }
    mountButton();
    document.addEventListener("mouseup", onSelectionDone, true);
    document.addEventListener("keyup", onSelectionDone, true);
    toast("מחיקון spike נטען ✓  (לחץ להפעיל מצב הסתרה)", 4000);
  }

  function mountButton() {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;z-index:2147483647;bottom:20px;left:20px;";
    const shadow = host.attachShadow({ mode: "open" });
    btn = document.createElement("button");
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", toggle);
    shadow.appendChild(btn);
    document.body.appendChild(host);
    paintButton();
  }

  function toggle() {
    active = !active;
    paintButton();
    document.documentElement.style.cursor = active ? "crosshair" : "";
    toast(active ? "מצב הסתרה פעיל — סמן טקסט להסתרה" : "מצב הסתרה כבוי", 2500);
  }

  function paintButton() {
    btn.textContent = active ? "● מצב הסתרה פעיל (כבה)" : "מחיקון: הפעל מצב הסתרה";
    btn.style.cssText =
      "font:14px/1 system-ui,sans-serif;border:0;padding:12px 16px;border-radius:10px;" +
      "cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.3);color:#fff;" +
      (active ? "background:#1b8a5a;" : "background:#2C1608;");
  }

  // ---- token session (the important part) --------------------------------------------
  function tokenFor(value) {
    const v = value.trim();
    if (session.has(v)) {
      return session.get(v); // same value -> same token
    }
    const type = classify(v);
    counters[type] = (counters[type] || 0) + 1;
    const token = "[" + type + "_" + counters[type] + "]";
    session.set(v, token);
    return token;
  }

  // Toy classifier for the spike. Real engine does validated ID/phone/IBAN + Hebrew NER.
  function classify(v) {
    const digits = v.replace(/\D/g, "");
    if (digits.length >= 3 && /^[\d\-\s()+]+$/.test(v)) {
      return "NUM";
    }
    return "NAME";
  }

  // ---- redaction ---------------------------------------------------------------------
  function onSelectionDone(e) {
    if (!active) {
      return;
    }
    if (e && e.target && e.target.closest && e.target.closest("button")) {
      return;
    }
    setTimeout(redactSelection, 0);
  }

  function redactSelection() {
    const el = document.activeElement;

    // (1) plain textarea / input — replace ALL occurrences in the value string
    if (
      el &&
      (el.tagName === "TEXTAREA" || el.tagName === "INPUT") &&
      el.selectionStart != null &&
      el.selectionStart !== el.selectionEnd
    ) {
      const value = el.value.slice(el.selectionStart, el.selectionEnd).trim();
      if (!value) {
        return;
      }
      const token = tokenFor(value);
      if (token.indexOf(value) !== -1) {
        return; // safety: token contains the value, would loop — skip
      }
      const count = occurrences(el.value, value);
      el.value = el.value.split(value).join(token);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      toast('הוסתר "' + value + '" → ' + token + "  (" + count + " מופעים)", 4000);
      return;
    }

    // (2) contenteditable — replace ALL occurrences via repeated native inserts
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      return;
    }
    const value = sel.toString().trim();
    if (!value) {
      return;
    }
    const editable = closestEditable(sel.getRangeAt(0).startContainer);
    if (!editable) {
      return;
    }
    const token = tokenFor(value);
    if (token.indexOf(value) !== -1) {
      return; // safety
    }
    const count = replaceAllEditable(editable, value, token);
    if (count > 0) {
      toast('הוסתר "' + value + '" → ' + token + "  (" + count + " מופעים)", 4000);
    } else {
      // fell back
      navigator.clipboard.writeText(token).catch(() => {});
      toast("לא הוחלף במקום — " + token + " הועתק, הדבק ידנית", 4000);
    }
  }

  function replaceAllEditable(editable, value, token) {
    let count = 0;
    for (let i = 0; i < 500; i++) {
      const range = firstOccurrenceRange(editable, value);
      if (!range) {
        break;
      }
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      editable.focus();
      if (!document.execCommand("insertText", false, token)) {
        break;
      }
      count += 1;
    }
    return count;
  }

  // First occurrence of `value` inside a single text node under `root`.
  function firstOccurrenceRange(root, value) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const idx = node.nodeValue.indexOf(value);
      if (idx !== -1) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + value.length);
        return range;
      }
    }
    return null;
  }

  function occurrences(haystack, needle) {
    if (!needle) {
      return 0;
    }
    let n = 0;
    let i = haystack.indexOf(needle);
    while (i !== -1) {
      n += 1;
      i = haystack.indexOf(needle, i + needle.length);
    }
    return n;
  }

  function closestEditable(node) {
    let el = node && node.nodeType === 1 ? node : node && node.parentElement;
    while (el) {
      if (el.isContentEditable) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  function toast(text, ms) {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;z-index:2147483647;bottom:70px;left:20px;";
    const shadow = host.attachShadow({ mode: "open" });
    const box = document.createElement("div");
    box.textContent = text;
    box.style.cssText =
      "font:14px/1.5 system-ui,sans-serif;background:#1b8a5a;color:#fff;padding:12px 16px;" +
      "border-radius:10px;max-width:400px;direction:rtl;box-shadow:0 4px 16px rgba(0,0,0,.3);white-space:pre-wrap;";
    shadow.appendChild(box);
    document.body.appendChild(host);
    setTimeout(() => host.remove(), ms || 5000);
  }

  // eslint-disable-next-line no-console
  console.log("[mechikon spike] token-session content script loaded on", location.host);
})();
