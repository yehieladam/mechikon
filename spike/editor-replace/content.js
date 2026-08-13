// Phase-0 spike content script (button edition). Two things, both impossible to miss:
//  1. A "loaded" toast on page load  -> proves the content script actually injected.
//  2. A fixed floating button        -> click to replace the current selection in place,
//                                        no dependence on the site's right-click menu.
(() => {
  const TOKEN = "[ID_1]"; // real production token shape — also proves it survives the editor

  // --- 1. prove injection: a toast the moment we load ---------------------------------
  boot();

  function boot() {
    if (document.body) {
      toast("מחיקון spike נטען ✓  (סמן טקסט ולחץ על הכפתור)", 4000);
      mountButton();
    } else {
      window.addEventListener("DOMContentLoaded", boot, { once: true });
    }
  }

  // --- 2. the floating button ---------------------------------------------------------
  function mountButton() {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;z-index:2147483647;bottom:20px;left:20px;";
    const shadow = host.attachShadow({ mode: "open" });
    const btn = document.createElement("button");
    btn.textContent = "מחיקון: הסתר בחירה";
    btn.style.cssText =
      "font:14px/1 system-ui,sans-serif;background:#2C1608;color:#F7F4EF;border:0;" +
      "padding:12px 16px;border-radius:10px;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.3);";
    // mousedown preventDefault -> clicking the button does NOT steal focus / clear the
    // selection in the editor. Critical: without this the selection is gone by click time.
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => toast(replaceSelection(TOKEN), 6000));
    shadow.appendChild(btn);
    document.body.appendChild(host);
  }

  // --- the actual replace logic (what the spike is really testing) --------------------
  function replaceSelection(token) {
    const active = document.activeElement;

    // (1) plain textarea / input
    if (
      active &&
      (active.tagName === "TEXTAREA" || active.tagName === "INPUT") &&
      active.selectionStart != null &&
      active.selectionStart !== active.selectionEnd
    ) {
      try {
        const before = active.value.slice(active.selectionStart, active.selectionEnd);
        active.setRangeText(token, active.selectionStart, active.selectionEnd, "end");
        active.dispatchEvent(new Event("input", { bubbles: true }));
        return `OK [1] textarea/input: "${before}" → ${token}`;
      } catch (err) {
        return "FAIL [1] input: " + errMsg(err);
      }
    }

    // (2) contenteditable — execCommand insertText (the native-edit path)
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      return "אין בחירה — סמן טקסט קודם, ואז לחץ (בלי ללחוץ בשום מקום אחר)";
    }
    const picked = sel.toString();
    try {
      const editable = closestEditable(sel.getRangeAt(0).startContainer);
      if (editable) {
        editable.focus();
      }
      const ok = document.execCommand("insertText", false, token);
      if (ok) {
        return `OK [2] execCommand: "${picked}" → ${token}`;
      }
    } catch (err) {
      // fall through
    }

    // (3) fallback — clipboard, never corrupt editor state silently
    try {
      navigator.clipboard.writeText(token);
      return `FALLBACK [3] לא הוחלף במקום — ${token} הועתק, הדבק ידנית`;
    } catch (err) {
      return "FAIL [3] clipboard: " + errMsg(err);
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
  console.log("[mechikon spike] content script loaded on", location.host);
})();
