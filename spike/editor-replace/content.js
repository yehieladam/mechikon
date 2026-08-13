// Phase-0 spike content script. THE question this answers: can we replace a
// user's selection IN PLACE inside ChatGPT's / Claude's / Gemini's editor without
// the editor reverting or desyncing? Three strategies, tried in order. A toast
// reports which one fired so we know per-site what actually works.
(() => {
  // Fixed Latin token — deliberately the real production token shape ([ID_1]),
  // so the spike also proves the token itself survives the editor untouched.
  const TOKEN = "[ID_1]";

  // Snapshot of the selection captured at right-click time. The context-menu
  // click lands AFTER the native menu closes, by which point the live selection
  // may be gone — so we grab it on `contextmenu` and hold it.
  let snapshot = null;

  document.addEventListener(
    "contextmenu",
    () => {
      const active = document.activeElement;
      if (
        active &&
        (active.tagName === "TEXTAREA" || active.tagName === "INPUT") &&
        active.selectionStart != null &&
        active.selectionStart !== active.selectionEnd
      ) {
        snapshot = {
          kind: "input",
          el: active,
          start: active.selectionStart,
          end: active.selectionEnd,
          text: active.value.slice(active.selectionStart, active.selectionEnd),
        };
        return;
      }

      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
        snapshot = {
          kind: "range",
          range: sel.getRangeAt(0).cloneRange(),
          text: sel.toString(),
        };
        return;
      }

      snapshot = null;
    },
    true,
  );

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "SPIKE_REPLACE") {
      return;
    }
    toast(replaceSelection(TOKEN));
  });

  function replaceSelection(token) {
    if (!snapshot) {
      return "אין בחירה — סמן טקסט ואז קליק-ימני";
    }

    // (1) Plain textarea / input — the reliable path (setRangeText + input event).
    if (snapshot.kind === "input") {
      try {
        const el = snapshot.el;
        el.focus();
        el.setRangeText(token, snapshot.start, snapshot.end, "end");
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return `OK [1] textarea/input: "${snapshot.text}" → ${token}`;
      } catch (err) {
        return "FAIL [1] input: " + errMsg(err);
      }
    }

    // (2) contenteditable — execCommand("insertText") is the one edit path that
    // ProseMirror (ChatGPT) / Lexical (Claude) / Gemini treat as a native keystroke.
    try {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(snapshot.range);
      const editable = closestEditable(snapshot.range.startContainer);
      if (editable) {
        editable.focus();
        sel.removeAllRanges();
        sel.addRange(snapshot.range);
      }
      const ok = document.execCommand("insertText", false, token);
      if (ok) {
        return `OK [2] execCommand insertText: "${snapshot.text}" → ${token}`;
      }
    } catch (err) {
      // fall through to clipboard
    }

    // (3) Fallback — never corrupt editor state silently; hand it to the clipboard.
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

  // Shadow-DOM toast so the page's own CSS can't hide or restyle it.
  function toast(text) {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;z-index:2147483647;bottom:20px;right:20px;";
    const shadow = host.attachShadow({ mode: "open" });
    const box = document.createElement("div");
    box.textContent = text;
    box.style.cssText =
      "font:14px/1.5 system-ui,sans-serif;background:#2C1608;color:#F7F4EF;" +
      "padding:12px 16px;border-radius:10px;max-width:380px;direction:rtl;" +
      "box-shadow:0 4px 16px rgba(0,0,0,.3);white-space:pre-wrap;";
    shadow.appendChild(box);
    document.body.appendChild(host);
    setTimeout(() => host.remove(), 6000);
  }

  // eslint-disable-next-line no-console
  console.log("[mechikon spike] content script loaded on", location.host);
})();
