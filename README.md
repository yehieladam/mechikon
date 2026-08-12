# mechikon — client-side Hebrew PII anonymizer

A **fully client-side** Hebrew PII anonymizer: detection runs in the user's browser, nothing
leaves the device, no server, no account. Ships as a **Chrome extension** (popup) and, later, a
public web app that reuses the same engine.

> This is the client-side track. The original server-side proof-of-concept (Python + Streamlit +
> Presidio, deployed to the BAI portal) lives separately and is unaffected.

## Status

- ✅ **Phase 0 proven** — in-browser dictabert-ner (ONNX q8) matches the server model's recall
  (88.89%) and runs ~10x faster than the 2-core server via WASM. See `browser-poc/PHASE0_FINDINGS.md`.
- 🔬 **MV3 spike built** — a minimal Manifest V3 extension proving the model runs inside a real
  extension popup. See `extension/README.md`. Awaits a manual load-unpacked verification in Chrome.
- ⏭️ **Next (P1):** the reusable `engine/` — port the deterministic recognizers + NER wrapper +
  anonymize/restore to framework-free JS. See `docs/chrome-extension-plan.md`.

## Layout

```
extension/     MV3 Chrome extension (spike → grows into the shipped popup)
engine/        reusable JS detection engine (to be built — P1)
browser-poc/   the validated Phase-0 in-browser NER spike + findings (reference)
docs/          chrome-extension-plan.md (the roadmap) + client-side-plan.md
```

## Try the extension spike (Windows, Chrome)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `extension/` folder
3. Click the toolbar icon → paste Hebrew → **Anonymize**

First run downloads the ~185 MB model once (use the "open in tab" link so a popup click-away
doesn't interrupt it); later opens load from cache. Full steps + expected output in
`extension/README.md`.

## Contributing / branches

`main` is the shared, protected line. One branch per task (`feat/…`, `fix/…`, `chore/…`), claim the
task in `docs/tasks.md` first, PR → CI → 1 review → merge — no direct pushes to `main`. Full working
agreement in `CONTRIBUTING.md`; roadmap in `docs/chrome-extension-plan.md`; task board in
`docs/tasks.md`.

## License

**AGPL-3.0-or-later** (see `LICENSE`) — required by `mupdf.js` (AGPL-3.0) and embraced as a trust
asset: the whole app is open for anyone to read and confirm nothing is uploaded. Note: third-party
model/library licenses (dictabert-ner and its ONNX conversion, transformers.js Apache-2.0) must be
verified before any public Store launch — not yet confirmed cleared.
