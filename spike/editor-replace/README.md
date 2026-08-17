# Phase-0 spike — editor in-place replace

**Question:** does replacing a text selection in place survive the editors on
ChatGPT / Claude / Gemini? This is risk #1 in `docs/extension-mv3-plan.md`. If it
fails, the whole inline approach needs rethinking — so we test it before writing
any real extension code.

This is a **standalone unpacked extension** (plain JS, no build step). It is NOT
wired into the crxjs/vite build — throwaway, lives under `spike/` only.

## Load it

1. Chrome → `chrome://extensions`
2. Toggle **Developer mode** (top-right)
3. **Load unpacked** → select `spike/editor-replace/`
4. Open ChatGPT / Claude / Gemini and reload the tab

## Test

On each site:

1. Type a sentence in the message composer, e.g. `שלום, ת"ז שלי 040493384 תודה`
2. Select the number `040493384`
3. Right-click → **מחיקון spike — הסתר בחירה**
4. Read the toast (bottom-right).

## What the toast tells you

| Toast prefix | Meaning |
|---|---|
| `OK [1] textarea/input` | Site uses a plain `<textarea>` — easiest, always works |
| `OK [2] execCommand insertText` | contenteditable editor accepted the edit in place — **the win we need** |
| `FALLBACK [3]` | Neither worked; token copied to clipboard (manual paste). Means that site needs a custom adapter |
| `FAIL` | Something threw — copy the message |

## Report back per site

For each of ChatGPT / Claude / Gemini, note:
- Which prefix fired
- Did the token actually appear in the composer, in the right spot?
- After replacing — can you still type / send normally (editor not broken)?

Those three answers decide Phase 2's approach and estimate.
