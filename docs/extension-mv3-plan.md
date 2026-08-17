# Mechikon Chrome MV3 Extension — Development Plan

> Generated 2026-08-13. Branch: `feat/extension-mv3` off `main`.
> Confirmed decisions: right-click context menu; AI-chat sites only; deterministic-immediate + NER-in-background;
> restore key in chrome.storage.local with 24h sliding expiry; popup file output = burned-token PDF (same as web app).

## 1. Architecture

MV3 components share `engine/src` via the `@engine` alias. Rule from `web/src/worker/engine.worker.ts` carries over:
import specific engine modules, never the `@engine/index` barrel (the barrel drags transformers.js + onnxruntime
into any graph that touches `ner.ts`).

- **Popup** — file flow (port of web app). Hosts its own engine Web Worker.
- **Service worker** (`src/background/`) — context menus (הסתר/פענח), message router, deterministic engine
  (pure JS, no WASM), keyStore + expiry.
- **Offscreen document** — hosts the engine worker + 185MB NER model (WASM); MV3 SWs cannot run WASM inference.
- **Content script** — AI chat sites only; selection capture, in-place replace, toasts.

Deterministic recognizers (`DETERMINISTIC_RECOGNIZERS`, `engine/src/pipeline.ts`) run directly in the SW — no WASM,
no offscreen. Only NER needs the offscreen document.

Tokens are **Latin** `[ID_1]`/`[NAME_2]`/`[PHONE_1]` (locked 2026-08-06; `LABELS` in `engine/src/anonymize.ts`).
`restore()` still matches legacy Hebrew-labeled keys via its tolerant `[label_digits]` pattern.

## 2. Build phases (each independently shippable)

### Phase 0 — Editor-replace spike (0.5d) — DE-RISK FIRST
Prove in-place replacement survives ProseMirror (ChatGPT) / Lexical (Claude) on live sites before committing Phase 2.

### Phase 1 — Popup file flow, parity with web app (4–6d)
Hard MV3 problem: transformers.js loads ORT WASM runtime (`.mjs` = remote code) — blocked by MV3 CSP regardless of
connect-src. Must **vendor** ORT files and point `env.backends.onnx.wasm.wasmPaths` at local copies. `numThreads=1`
(extension pages not crossOriginIsolated; `threadCount()` already handles this).

| File | Action | Purpose |
|---|---|---|
| `engine/src/ner.ts` | modify (additive) | Add `wasmPaths?`/`modelHost?` to `HebrewNerOptions`; web passes neither ⇒ unchanged. Pre-wires R2 self-host (P4-02). |
| `web/src/worker/engine.worker.ts` | modify (additive) | `loadNer` gains optional `{wasmPaths}` pass-through. |
| `scripts/fetch-ort-assets.mjs` | net-new | Downloads 2 ORT files at transformers-4.2.0's pinned version into `src/public/vendor/ort/`. Use `curl -4`/ipv4first (broken-IPv6 caveat). |
| `src/worker/extensionEngineClient.ts` | net-new (port of `engineClient.ts`) | Spawns `engine.worker.ts` with Comlink; `loadNer({wasmPaths: chrome.runtime.getURL("vendor/ort/")})`. |
| `src/popup/App.tsx` | rewrite (port) | Compact popup version of `web/src/App.tsx` tool flow (drop zone → progress → result). Reuses `web/src/lib/*` + `AiLogos.tsx`. |
| `src/popup/keyPanel.tsx` | net-new (port) | Restore-key card: encrypted-default (`keyCrypto.ts`), plain-escape, CSV/JSON. |
| `src/popup/openInTab.tsx` | net-new | "פתח בלשונית" — popup close aborts first 185MB download; stopgap until offscreen (Phase 3). |
| `src/i18n.ts` + `src/locales/he.ts` | net-new | i18next like `web/src/i18n.ts`; shares web locales + extension-only keys. |
| `vite.config.ts` | modify | es workers, es2022 target, `optimizeDeps.exclude:["mupdf"]`, `@web` alias, `publicDir:"src/public"`. |

Scope cut: **scanned-PDF OCR excluded** (tesseract assets under `chrome-extension://` unverified). `classifyPdf`
detects scan → popup shows "use the website" notice. OCR-in-extension = Phase 5 spike.

### Phase 2 — Inline REDACT, deterministic-only (3–4d)

| File | Action | Purpose |
|---|---|---|
| `src/background/index.ts` | net-new | SW entry. `onInstalled` → 2 context menus (`redact`/`restore`, `contexts:["selection"]`, `documentUrlPatterns` = AI sites). `onClicked` → message content script. |
| `src/background/inlineRedact.ts` | net-new | `detectDeterministic` + `resolveOverlaps` + occurrences via `@engine/pipeline`, then `tokenSession` remap. |
| `src/background/tokenSession.ts` | net-new (pure) | **Cross-message token consistency.** `anonymize()` numbers per-text from 1 → two selections both mint `[ID_1]` for different values → restore corruption. Remaps fresh result against stored session key: same `(original,type)` ⇒ reuse placeholder; new ⇒ next free index. Unit-tested. |
| `src/background/keyStore.ts` | net-new | storage.local schema + append/read. Write path lands here (redact without persisting = no restore). Expiry enforcement = Phase 4. |
| `src/content/index.ts` | net-new | Snapshots live `Range`+text on `contextmenu` (menu `selectionText` is unreliable for offset-exact replace). Handles SW commands. |
| `src/content/replaceSelection.ts` | net-new | In-place replace surviving editors. Ladder: (1) textarea/input `setRangeText`+`input` event; (2) contenteditable `execCommand("insertText")`; (3) fallback clipboard+toast. |
| `src/content/toast.ts` | net-new | Shadow-DOM RTL toast, i18n. |
| `src/messages.ts` | net-new | Typed message envelopes (discriminated union, no `any`). |
| `src/manifest.config.ts` | modify | `permissions:["contextMenus","storage"]`, background SW, content_scripts matches. |

### Phase 3 — NER-in-background augmentation, offscreen (3–4d)

| File | Action | Purpose |
|---|---|---|
| `src/offscreen/offscreen.html` + `index.ts` | net-new | Hosts engine worker, `loadNer` on create, answers `anonymizeSmart`. |
| `src/background/offscreenHost.ts` | net-new | `ensureOffscreen()` idempotent `createDocument({reasons:["WORKERS"]})`. Loads model on first inline redact (not install). Cache-Storage cached after first (model-cache-reinit). |
| `src/background/inlineRedact.ts` | modify | Two-phase: deterministic instant; NER `anonymizeSmart` diff for PERSON/ORG/LOC when ready → tokenSession → augment. |
| `src/content/index.ts` | modify | `augment` command: re-read composer, replace still-present values. Post-send → toast "שמות זוהו אחרי השליחה". |
| `src/popup/App.tsx` | modify | Shared "מנוע חכם: מוכן/בטעינה" banner (port `nerController.ts`). |
| `src/manifest.config.ts` | modify | + `"offscreen"`. |

### Phase 4 — Inline RESTORE + key expiry (2–3d)

| File | Action | Purpose |
|---|---|---|
| `src/background/inlineRestore.ts` | net-new | `restore(text, keyStore.rows)` from `@engine/restore`. Returns restored + `unmatched[]`. |
| `src/background/keyStore.ts` | modify | Sliding `expiresAt`, `chrome.alarms` hourly + SW-startup + lazy-on-read cleanup. + `"alarms"`. |
| `src/content/index.ts` | modify | פענח: AI bubbles are plain DOM → `Range.deleteContents/insertNode`. Unmatched → toast (never dropped). |
| `src/popup/sessionPanel.tsx` | net-new | Inline-session card: N values, expiry countdown, "נקה עכשיו", export via `toKeyFile`. |

### Phase 5 — Harden + live E2E + Store prep (3–5d)
Site adapters (`src/content/siteAdapters.ts` if needed), OCR-in-extension go/no-go, privacy policy, listing assets,
data-safety form, permission justifications, security-reviewer pass (cap selection ~100k chars, textContent-only toasts).

## 3. Manifest (concrete)

```
permissions:  P2:"contextMenus","storage"  P3:+"offscreen"  P4:+"alarms"
              (NO activeTab/scripting/tabs — static content_scripts need none)
host_permissions: NONE (content_scripts.matches grants the origins)
background: { service_worker:"src/background/index.ts", type:"module" }
content_scripts: [{ matches:[
  "https://chatgpt.com/*","https://chat.openai.com/*",
  "https://claude.ai/*","https://gemini.google.com/*"
], js:["src/content/index.ts"], run_at:"document_idle" }]
CSP.extension_pages: unchanged (wasm-unsafe-eval; connect-src HF hosts; jsdelivr ABSENT — ORT vendored)
```
Later-release site candidates: copilot.microsoft.com, chat.deepseek.com, grok.com, chat.mistral.ai, perplexity.ai.
Never `<all_urls>`.

## 4. Storage schema (chrome.storage.local, key "inlineKey.v1")

```jsonc
{ "version":"inlineKey.v1",
  "rows":[{"placeholder":"[ID_1]","original":"040493384","type":"ISRAELI_ID"}], // exact KeyRow shape → restore()/toKeyFile() zero-conversion
  "counters":{"ID":2,"NAME":4},   // next free index per LABEL (tokenSession)
  "createdAt":..., "lastWriteAt":..., "expiresAt":... }  // lastWriteAt+24h, sliding
```
Cleanup (all three, SW is ephemeral): hourly alarm; SW-startup; lazy-on-read. Caps mirror `engine/src/key.ts`
(MAX_KEY_ROWS 50k, field 10k). Plaintext at rest — accepted tradeoff; 24h expiry + "clear now" + export compensate.

## 5. Token-survival risk
Latin tokens chosen because they survive ChatGPT/RTL; `restore()` normalizes bidi/quotes/spaces. Residual:
1. LLM drops brackets (`[ID_1]`→`ID_1`) — unrecoverable. Mitigation: post-redact toast offers "העתק הנחיה ל-AI"
   snippet ("keep tokens like [ID_1] exactly"). Detect on פענח: 0 tokens + non-empty key → hint toast.
2. Partial restore: `RestoreResult.unmatched` surfaced, never swallowed.
3. Collision: engine guards minting; `tokenSession` extends across session.

## 6. Build wiring
Two builds already coexist (root crxjs→`dist/`, `web/vite.config.ts`→`dist-web/`). No new vite config; root changes
only. `src/offscreen/offscreen.html` added as extra rollup input. `"prebuild":"node scripts/fetch-ort-assets.mjs"`.
Delete `extension/` spike after new build verified (own commit).

## 7. Test plan
- Engine: existing suites untouched.
- Unit (vitest): `tokenSession`, `keyStore` expiry (fake storage), `replaceSelection` textarea+range in jsdom,
  message type guards, ORT-assets presence.
- E2E (Playwright `--load-extension=dist`): popup file flow on `web/test-fixtures` PDFs; local fixture chat page
  (contenteditable+textarea) for contextmenu→הסתר→tokens→פענח→restore+expiry. Live sites never in CI. `@model` grep.
- Manual (Phase 5, live): ChatGPT/Claude/Gemini redact+send+restore, NER before/after send, popup vs web app,
  24h expiry, popup-close-during-download, update mid-session.
- Pre-push: full `npm test` + `npm run lint` from root.

## 8. Risks (ranked)
1. HIGH — editor state corruption on in-place replace. → Phase 0 spike, execCommand ladder + clipboard fallback, site adapters.
2. MED-HIGH — ORT vendoring under MV3 (spike-precedented). → version-lock assertion.
3. MED — offscreen lifetime + Store justification (`reasons:["WORKERS"]` validate on load).
4. MED — token mangling by LLM (§5).
5. MED — 185MB download in popup (open-in-tab stopgap → offscreen fix).
6. MED (accepted) — plaintext key in storage.local (24h expiry + clear + export).
7. LOW-MED — selectionText vs live Range (solved by contextmenu snapshot; iframes out of scope v1).
8. OPEN — honor web app category-control (`categories.ts` disabledTypes)? `anonymizeWith` accepts `disabledTypes`. Yes-later.
9. OPEN — scan OCR in extension. Phase 5 spike; fallback = "use the website".

## 9. Effort
| Phase | Est |
|---|---|
| 0 spike | 0.5d |
| 1 popup file flow | 4–6d |
| 2 inline redact | 3–4d |
| 3 offscreen NER | 3–4d |
| 4 restore + expiry | 2–3d |
| 5 harden + Store | 3–5d |
| **Total** | **~16–22d (3–4.5 weeks)** |
Each phase = own PR off `feat/extension-mv3` sub-branches, CI green.
