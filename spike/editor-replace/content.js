// Phase-0 spike — REDACT MODE edition.
// Toggle a mode ON (button turns green, cursor becomes a crosshair, a banner shows).
// While ON: every time you finish selecting text it is redacted in place automatically,
// no trip to the button. Toggle OFF to stop. This is the real target UX, felt early.
(() => {
  const TOKEN = "[ID_1]"; // real production token shape — proves it survives the editor

  let active = false;
  let btn = null;

  boot();

  function boot() {
    if (!document.body) {
      window.addEventListener("DOMContentLoaded", boot, { once: true });
      return;
    }
    mountButton();
    // Redact whenever a selection is completed (mouse release or keyboard shift-select).
    document.addEventListener("mouseup", onSelectionDone, true);
    document.addEventListener("keyup", onSelectionDone, true);
    toast("מחיקון spike נטען ✓  (לחץ על הכפתור כדי להפעיל מצב הסתרה)", 4000);
  }

  function mountButton() {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;z-index:2147483647;bottom:20px;left:20px;";
    const shadow = host.attachShadow({ mode: "open" });
    btn = document.createElement("button");
    btn.addEventListener("mousedown", (e) => e.preventDefault()); // don't steal selection
    btn.addEventListener("click", toggle);
    shadow.appendChild(btn);
    document.body.appendChild(host);
    paintButton();
  }

  function toggle() {
    active = !active;
    paintButton();
    // Signal the mode on the whole page: crosshair cursor.
    document.documentElement.style.cursor = active ? "crosshair" : "";
    toast(active ? "מצב הסתרה פעיל — סמן טקסט והוא יוסתר" : "מצב הסתרה כבוי", 2500);
  }

  function paintButton() {
    btn.textContent = active ? "● מצב הסתרה פעיל (כבה)" : "מחיקון: הפעל מצב הסתרה";
    btn.style.cssText =
      "font:14px/1 system-ui,sans-serif;border:0;padding:12px 16px;border-radius:10px;" +
      "cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.3);color:#fff;" +
      (active ? "background:#1b8a5a;" : "background:#2C1608;");
  }

  function onSelectionDone(e) {
    if (!active) {
      return;
    }
    // Ignore events on our own button (shadow host is outside the document tree anyway).
    if (e && e.target && e.target.closest && e.target.closest("button")) {
      return;
    }
    // Let the selection settle, then redact it.
    setTimeout(() => {
      const msg = redactCurrentSelection(TOKEN);
      if (msg) {
        toast(msg, 4000);
      }
    }, 0);
  }

  function redactCurrentSelection(token) {
    const activeEl = document.activeElement;

    // (1) plain textarea / input
    if (
      activeEl &&
      (activeEl.tagName === "TEXTAREA" || activeEl.tagName === "INPUT") &&
      activeEl.selectionStart != null &&
      activeEl.selectionStart !== activeEl.selectionEnd
    ) {
      try {
        const before = activeEl.value.slice(activeEl.selectionStart, activeEl.selectionEnd);
        activeEl.setRangeText(token, activeEl.selectionStart, activeEl.selectionEnd, "end");
        activeEl.dispatchEvent(new Event("input", { bubbles: true }));
        return `הוסתר: "${before}" → ${token}`;
      } catch (err) {
        return "שגיאה [input]: " + errMsg(err);
      }
    }

    // (2) contenteditable — execCommand insertText (native-edit path)
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      return ""; // nothing selected — silent (mode stays on)
    }
    const picked = sel.toString();
    try {
      const editable = closestEditable(sel.getRangeAt(0).startContainer);
      if (editable) {
        editable.focus();
      }
      if (document.execCommand("insertText", false, token)) {
        return `הוסתר: "${picked}" → ${token}`;
      }
    } catch (err) {
      // fall through
    }

    try {
      navigator.clipboard.writeText(token);
      return `לא הוחלף במקום — ${token} הועתק, הדבק ידנית`;
    } catch (err) {
      return "שגיאה: " + errMsg(err);
    }
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

  function errMsg(err) {
    return err && err.message ? err.message : String(err);
  }

  function toast(text, ms) {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;z-index:2147483647;bottom:70px;left:20px;";
    const shadow = host.attachShadow({ mode: "open" });
    const box = document.createElement("div");
    box.textContent = text;
    box.style.cssText =
      "font:14px/1.5 system-ui,sans-serif;background:#1b8a5a;color:#fff;padding:12px 16px;" +
      "border-radius:10px;max-width:380px;direction:rtl;box-shadow:0 4px 16px rgba(0,0,0,.3);white-space:pre-wrap;";
    shadow.appendChild(box);
    document.body.appendChild(host);
    setTimeout(() => host.remove(), ms || 5000);
  }

  // eslint-disable-next-line no-console
  console.log("[mechikon spike] redact-mode content script loaded on", location.host);
})();
