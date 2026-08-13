// Phase-0 spike — full round trip: redact -> instruct the AI -> restore.
//  - Toggle redact mode; selecting text redacts it (same value=same token, all occurrences, typed).
//  - When the first token is added to a field, an instruction is appended telling the AI the
//    bracketed values are masks and must be kept verbatim in its reply (token-survival mitigation).
//  - "שחזר בחירה" reverses tokens back to the original values using the session map.
(() => {
  let redactMode = false;
  let redactBtn = null;

  // Session: value -> token, counter per type, and the marker we use to avoid double-instructing.
  const session = new Map();
  const counters = Object.create(null);

  const INSTRUCTION =
    "  [הנחיה למערכת: ערכים בסוגריים מרובעים כמו [NAME_1] או [NUM_1] הם מסכות למידע רגיש. " +
    "התייחס אליהם בתשובתך והשאר אותם בדיוק כפי שהם, ללא שינוי, כדי שנוכל לשחזר את המידע המקורי.]";
  const INSTRUCTION_MARKER = "[הנחיה למערכת:";

  boot();

  function boot() {
    if (!document.body) {
      window.addEventListener("DOMContentLoaded", boot, { once: true });
      return;
    }
    mountButtons();
    document.addEventListener("mouseup", onSelectionDone, true);
    document.addEventListener("keyup", onSelectionDone, true);
    toast("מחיקון spike נטען ✓", 3500);
  }

  function mountButtons() {
    const host = document.createElement("div");
    host.style.cssText =
      "position:fixed;z-index:2147483647;bottom:20px;left:20px;display:flex;gap:8px;flex-direction:column;align-items:flex-start;";
    const shadow = host.attachShadow({ mode: "open" });

    redactBtn = document.createElement("button");
    redactBtn.addEventListener("mousedown", (e) => e.preventDefault());
    redactBtn.addEventListener("click", toggleRedact);

    const restoreBtn = document.createElement("button");
    restoreBtn.textContent = "שחזר בחירה";
    restoreBtn.style.cssText = btnCss("#4a3aff");
    restoreBtn.addEventListener("mousedown", (e) => e.preventDefault());
    restoreBtn.addEventListener("click", () => toast(restoreSelection(), 5000));

    shadow.appendChild(redactBtn);
    shadow.appendChild(restoreBtn);
    document.body.appendChild(host);
    paintRedactBtn();
  }

  function btnCss(bg) {
    return (
      "font:14px/1 system-ui,sans-serif;border:0;padding:12px 16px;border-radius:10px;" +
      "cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.3);color:#fff;background:" + bg + ";"
    );
  }

  function toggleRedact() {
    redactMode = !redactMode;
    paintRedactBtn();
    document.documentElement.style.cursor = redactMode ? "crosshair" : "";
    toast(redactMode ? "מצב הסתרה פעיל — סמן טקסט" : "מצב הסתרה כבוי", 2200);
  }

  function paintRedactBtn() {
    redactBtn.textContent = redactMode ? "● מצב הסתרה פעיל (כבה)" : "מחיקון: הפעל מצב הסתרה";
    redactBtn.style.cssText = btnCss(redactMode ? "#1b8a5a" : "#2C1608");
  }

  // ---- token session -----------------------------------------------------------------
  function tokenFor(value) {
    const v = value.trim();
    if (session.has(v)) {
      return session.get(v);
    }
    const type = classify(v);
    counters[type] = (counters[type] || 0) + 1;
    const token = "[" + type + "_" + counters[type] + "]";
    session.set(v, token);
    return token;
  }

  function classify(v) {
    const digits = v.replace(/\D/g, "");
    if (digits.length >= 3 && /^[\d\-\s()+]+$/.test(v)) {
      return "NUM";
    }
    return "NAME";
  }

  // ---- redact ------------------------------------------------------------------------
  function onSelectionDone(e) {
    if (!redactMode) {
      return;
    }
    if (e && e.target && e.target.closest && e.target.closest("button")) {
      return;
    }
    setTimeout(redactSelection, 0);
  }

  function redactSelection() {
    const el = document.activeElement;

    // (1) textarea / input
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
        return;
      }
      const count = occurrences(el.value, value);
      el.value = el.value.split(value).join(token);
      ensureInstructionInput(el);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      toast('הוסתר "' + value + '" → ' + token + "  (" + count + " מופעים)", 4000);
      return;
    }

    // (2) contenteditable
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
      return;
    }
    const count = replaceAllEditable(editable, value, token);
    if (count > 0) {
      ensureInstructionEditable(editable);
      toast('הוסתר "' + value + '" → ' + token + "  (" + count + " מופעים)", 4000);
    } else {
      navigator.clipboard.writeText(token).catch(() => {});
      toast("לא הוחלף במקום — " + token + " הועתק, הדבק ידנית", 4000);
    }
  }

  // ---- instruction injection (token-survival) ----------------------------------------
  function ensureInstructionInput(el) {
    if (el.value.indexOf(INSTRUCTION_MARKER) !== -1) {
      return;
    }
    el.value = el.value + INSTRUCTION;
  }

  function ensureInstructionEditable(editable) {
    if ((editable.textContent || "").indexOf(INSTRUCTION_MARKER) !== -1) {
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(editable);
    range.collapse(false); // caret to end
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    editable.focus();
    document.execCommand("insertText", false, INSTRUCTION);
  }

  // ---- restore -----------------------------------------------------------------------
  function restoreSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      return "סמן את תשובת ה-AI (עם הטוקנים) ואז לחץ שחזר";
    }
    const original = sel.toString();
    const restored = applyRestore(original);
    if (restored === original) {
      return "לא נמצאו טוקנים בבחירה (או שה-AI שינה אותם)";
    }
    const editable = closestEditable(sel.getRangeAt(0).startContainer);
    if (editable) {
      editable.focus();
      if (document.execCommand("insertText", false, restored)) {
        return "שוחזר ✓";
      }
    }
    // static DOM (assistant message is not editable) — replace the range contents directly
    try {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(restored));
      return "שוחזר ✓ (הוצג במקום)";
    } catch (err) {
      navigator.clipboard.writeText(restored).catch(() => {});
      return "שוחזר → הועתק ללוח (הדבק לראות)";
    }
  }

  function applyRestore(text) {
    let out = text;
    // reverse map token -> value; longer tokens first is irrelevant (unique), simple pass
    session.forEach((token, value) => {
      out = out.split(token).join(value);
    });
    return out;
  }

  // ---- helpers -----------------------------------------------------------------------
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
    host.style.cssText = "position:fixed;z-index:2147483647;bottom:120px;left:20px;";
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
  console.log("[mechikon spike] round-trip content script loaded on", location.host);
})();
