# Mechikon — client-side Hebrew PII anonymizer

Mechikon is a fully client-side web application that detects and redacts
personally identifiable information (PII) in Hebrew (and English) text and
documents — text, DOCX, XLSX, PPTX, and PDF (including scanned PDFs via OCR).
All processing happens in the browser: documents never leave the device.

This repository is the corresponding source of the hosted application at
https://mechikon.bai-solutions.com, published under the GNU Affero General
Public License v3.0 (see `LICENSE`), including as required by AGPL-3.0
section 13 for users interacting with the service over a network. The app
links the AGPL-licensed mupdf library.

## Layout

- `engine/` — framework-free PII detection/redaction engine (TypeScript)
- `web/` — the web app (React + Vite), workers, tests, and fixtures
- `scripts/` — build/setup tooling (vendors the tesseract.js OCR runtime and
  Hebrew/English traineddata into `web/public/vendor` at build time)

## Build

Requires Node.js >= 20.

```
npm ci
npm run build:web
```

Output is emitted to `dist-web/`. Other useful scripts:

- `npm run dev:web` — local dev server
- `npm run typecheck` / `npm run lint` / `npm run test` — checks and unit tests
- `npm run test:e2e` — Playwright end-to-end tests (real browser, production
  headers via `vite preview`)

The NER model (~185 MB) is downloaded by the browser at runtime from
Hugging Face and cached; it is not part of this repository. The OCR
traineddata is fetched once at build time by `prebuild:web`.

## License and trademarks

Code: AGPL-3.0-or-later (see `LICENSE`). The names "Mechikon" / "מחיקון",
the logo, and "BAI Solutions" branding are trademarks and are not licensed
under the AGPL — see `NOTICE`. A fork may use the code, but not the brand.
