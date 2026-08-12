# Stack — exact versions & rationale

The authoritative stack for `mechikon`. Pin these; do not bump without re-verifying (especially
transformers.js / onnxruntime — see `browser-poc/PHASE0_FINDINGS.md`).

## Runtime / tooling
| Concern | Choice | Rationale |
|---|---|---|
| Language | **TypeScript** (strict) | 2 devs, shared code → catch errors at the boundary. |
| Runtime | **Node 20 LTS** (`.nvmrc`, `engines`) | Consistent local + CI. |
| Package manager | **npm** | Team default; lockfile committed. |
| Build | **Vite** + `@crxjs/vite-plugin` | Fast ESM build, MV3 manifest generation, HMR for the popup. |
| UI | **React 18 + Tailwind** | Team default stack; reused by the future web app. |
| Tests | **Vitest** | Vite-native, fast; unit + recall harness. |
| Lint/format | **ESLint** (typescript-eslint) + **Prettier** | Consistency; enforced in CI. |
| CI | **GitHub Actions** | typecheck + lint + test + build on every PR. |
| Deps security | **Dependabot** | Alerts + update PRs. |

## ML / detection
| Concern | Choice | Rationale / note |
|---|---|---|
| NER runtime | **`@huggingface/transformers` 4.2.0** (pinned) | v3 lacks `aggregation_strategy`. |
| ONNX runtime | onnxruntime-web (the build transformers 4.2.0 pins: `1.26.0-dev.20260416-b7804b056c`) | **Vendor `.mjs`+`.wasm` locally** — MV3 blocks the remote `.mjs`. `numThreads=1`. |
| Model | `onnx-community/dictabert-ner-ONNX`, **q8** (~185 MB) | Recall parity with the server (88.89%), proven Phase 0. |
| Model hosting | **Self-host** on our VPS/CDN (prod); HF CDN (spike) | Control, reliability, one `connect-src`, CORS `*`. Can ship a pre-patched `tokenizer.json`. |
| Backend | **WASM default**, WebGPU opportunistic | WASM beat WebGPU on integrated GPUs (Phase 0). |
| Tokenizer fix | RegExp shim for `\"`/`\'` illegal under `/u` (or patched `tokenizer.json`) | Without it NER never runs. |
| Offsets | reconstruct char offsets + strip/re-join `##` wordpieces | transformers.js returns null offsets + `##`. |

## Files (MVP)
docx via **mammoth** (read) + `docx` writer; xlsx via **SheetJS** (read+write). **PDF: out of MVP**
(own hard spike — pdf-lib, no clean PyMuPDF equivalent).

## Layering (do not violate)
`engine/` = pure TS (no DOM/React/extension). `extension/` = React shell importing `engine/`. A future
`web/` app imports the same `engine/`. This is why the engine has no framework deps.
