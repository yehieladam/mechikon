/**
 * Hebrew NER — `onnx-community/dictabert-ner-ONNX` (q8) via transformers.js 4.2.0. An async facade
 * over the same `Span` shape the deterministic recognizers produce. Names/orgs/places are genuine
 * neural detection (CLAUDE.md hard rule 1) — never used for the number entities.
 *
 * Carries the two MANDATORY Phase-0 fixes (browser-poc/PHASE0_FINDINGS.md):
 *  1. `installTokenizerRegexShim()` — dictabert's pretokenizer regex uses `\"`/`\'` (Hebrew
 *     gershayim/geresh), illegal under the `u` flag transformers.js compiles it with, so V8 rejects
 *     it and NER never runs. We patch the global RegExp to strip only those illegal escapes from
 *     u/v-flagged patterns.
 *  2. `reconstructNerSpans()` — transformers.js 4.2.0 with `aggregation_strategy:'simple'` returns
 *     null char offsets and leaves `##` wordpiece markers in the surface (truncating hyphenated
 *     names like `רחל לוי-אברמוביץ` to `"רחל לוי ##-"`). We rebuild offsets by aligning to the
 *     source text and extend across the `##`-truncated continuation. This pure step is unit-tested
 *     against RECORDED model outputs (browser-poc/browser_result.json); the live model runs only in
 *     the manual recall harness (the 185 MB model is never downloaded in CI).
 */
import type { NerEntityType, Span } from "./types";

/** One raw span as returned by the token-classification pipeline. */
export interface RawNerSpan {
  /** Model tag: PER / ORG / GPE / LOC / FAC. */
  readonly raw: string;
  /** Surface string; may contain `##` wordpiece markers. */
  readonly surface: string;
  readonly score: number;
}

const TAG_MAP: Readonly<Record<string, NerEntityType>> = {
  PER: "PERSON",
  ORG: "ORGANIZATION",
  GPE: "LOCATION",
  LOC: "LOCATION",
  FAC: "LOCATION",
};

/** Map a raw model tag to our entity type (server-style), or null to drop it. */
export function mapNerTag(raw: string): NerEntityType | null {
  return TAG_MAP[raw.toUpperCase()] ?? null;
}

/** Hebrew letters incl. finals (U+05D0–U+05EA) — used to extend across `##`-truncated names. */
const HEBREW_LETTER = /[א-ת]/;
/** Hebrew points/cantillation (niqqud) — stripped before matching so a niqqud-bearing name in the PDF
 *  text still matches a model seed that dropped the points (H-nerspan). */
const NIQQUD = /[֑-ׇ]/;

/** Strip `##` wordpiece markers (optionally with a leading space) to get a searchable seed. */
function cleanSurface(surface: string): string {
  return surface.replace(/ ?##/g, "").trim();
}

/** A seed as it must look for matching: `##` removed, niqqud stripped, whitespace runs collapsed to a
 *  single space, trimmed. The shadow of the text is normalized the same way, so a name split by a line
 *  break / double space / niqqud still matches — without ever matching a DIFFERENT string. */
function normalizeSeed(surface: string): string {
  return cleanSurface(surface).replace(NIQQUD, "").replace(/\s+/g, " ").trim();
}

/** Build a normalized shadow of `text` (niqqud stripped, whitespace runs collapsed to a single space)
 *  with an offset map: map[k] = original index of shadow char k. A collapsed whitespace run maps to the
 *  run's first original index. Lets us find a whitespace/niqqud-variant occurrence and map it back to
 *  the exact original span. */
function seedSearchShadow(text: string): { shadow: string; map: number[] } {
  let shadow = "";
  const map: number[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (NIQQUD.test(ch)) {
      i += 1; // strip niqqud
      continue;
    }
    if (/\s/.test(ch)) {
      const runStart = i;
      while (i < text.length && /\s/.test(text[i])) {
        i += 1;
      }
      shadow += " ";
      map.push(runStart);
      continue;
    }
    shadow += ch;
    map.push(i);
    i += 1;
  }
  return { shadow, map };
}

/**
 * Rebuild real char-offset spans from raw pipeline output aligned to `text`. Pure; processes spans
 * in order with a running cursor so repeated surfaces map to successive positions. Matching is
 * whitespace-flexible and niqqud-insensitive (via a normalized shadow + offset map), so names split by
 * a line break / double space / niqqud are still found — but only a REAL occurrence ever matches; a
 * seed that isn't present is skipped defensively (never guesses an offset).
 */
export function reconstructNerSpans(text: string, rawSpans: readonly RawNerSpan[]): Span[] {
  const { shadow, map } = seedSearchShadow(text);
  const spans: Span[] = [];
  let shadowCursor = 0;

  for (const rawSpan of rawSpans) {
    const type = mapNerTag(rawSpan.raw);
    if (type === null) {
      continue;
    }
    const seed = normalizeSeed(rawSpan.surface);
    if (seed.length === 0) {
      continue;
    }
    let shadowStart = shadow.indexOf(seed, shadowCursor);
    if (shadowStart === -1) {
      shadowStart = shadow.indexOf(seed);
    }
    if (shadowStart === -1) {
      continue;
    }
    const shadowEnd = shadowStart + seed.length;
    const start = map[shadowStart];
    let end = map[shadowEnd - 1] + 1;
    // Extend across a `##`-truncated wordpiece continuation (hyphenated names), in ORIGINAL text.
    while (end < text.length && HEBREW_LETTER.test(text[end])) {
      end += 1;
    }
    spans.push({ start, end, type, score: rawSpan.score });
    // Advance the shadow cursor past this match (and past any original-text extension).
    shadowCursor = shadowEnd;
    while (shadowCursor < shadow.length && map[shadowCursor] < end) {
      shadowCursor += 1;
    }
  }

  return spans;
}

/**
 * Install the Phase-0 tokenizer RegExp shim (idempotent). Strips only the ASCII escapes that are
 * illegal under `/u` (`\"`, `\'`, …) from u/v-flagged patterns; identical semantics, since such a
 * backslash before a non-special ASCII char just matches the char. Must run before the pipeline
 * compiles the tokenizer.
 */
export function installTokenizerRegexShim(): void {
  const g = globalThis as typeof globalThis & { __nerRegexShim?: boolean };
  if (g.__nerRegexShim) {
    return;
  }
  const OrigRegExp = g.RegExp;
  const VALID_ESCAPE = /[dDwWsSbBnrtfv0xucpPkq\\/.*+?()[\]{}|^$]/;
  const sanitize = (pattern: string): string =>
    pattern.replace(/\\([\x20-\x7E])/g, (match, ch: string) => (VALID_ESCAPE.test(ch) ? match : ch));

  // reason: patching the global RegExp constructor is the sanctioned Phase-0 fix; typed loosely
  // because we mirror the native constructor's overloads.
  const Patched = function (pattern?: unknown, flags?: unknown) {
    if (typeof pattern === "string" && typeof flags === "string" && /[uv]/.test(flags)) {
      try {
        return new OrigRegExp(pattern, flags);
      } catch (err) {
        if (err instanceof SyntaxError) {
          return new OrigRegExp(sanitize(pattern), flags);
        }
        throw err;
      }
    }
    return new OrigRegExp(pattern as string, flags as string | undefined);
  } as unknown as RegExpConstructor;
  // instances are real RegExps (we return `new OrigRegExp`), but mirror the prototype so any
  // `x instanceof RegExp` / static-property access on the constructor still behaves natively.
  Object.defineProperty(Patched, "prototype", { value: OrigRegExp.prototype });

  g.RegExp = Patched;
  g.__nerRegexShim = true;
}

const MODEL_ID = "onnx-community/dictabert-ner-ONNX";
/**
 * MODEL INTEGRITY (B6): pin the exact model snapshot instead of the mutable `main` ref. This is the
 * main-branch commit of onnx-community/dictabert-ner-ONNX as of 2026-08-09 (the only commit the repo
 * has ever served here; verified via the HF API). With a commit SHA, every fetch resolves
 * `/resolve/<sha>/...` — an immutable, commit-addressed snapshot — so a later (possibly malicious)
 * push to the model repo can never change what this app downloads and runs.
 *
 * Why no post-download digest check: transformers.js 4.2.0 manages fetching + browser caching
 * internally and exposes no integrity/hash hook on the download path (the sha256 verification that
 * exists lives only in the experimental `CrossOriginStorage` cache backend, off by default; the only
 * intercept point would be replacing `env.customCache` wholesale — a fragile reimplementation of its
 * cache layer). Pinning the revision + TLS is the accepted integrity measure. If the model is ever
 * re-exported, update this SHA deliberately and re-run the recall harness.
 */
const MODEL_REVISION = "4f0aabf58566526df6f3fb548e0fd2619fbf2b1d";
const DTYPE = "q8"; // int8 — q8 parity proven in Phase 0

export interface HebrewNerOptions {
  /**
   * WASM by default — it beats WebGPU on integrated GPUs (Phase-0 finding). `cpu` is the
   * onnxruntime-node execution provider, used only by the node recall harness (the browser has no
   * `cpu` device); q8 output is identical to wasm, so recall measured on cpu is representative.
   */
  readonly device?: "wasm" | "webgpu" | "cpu";
  readonly progressCallback?: (event: unknown) => void;
  /**
   * WASM threads. Multi-threaded ORT needs a crossOriginIsolated context (COOP/COEP); the caller
   * passes the right number (1 when not isolated — e.g. extension pages — else min(4, cores)).
   * Set before the pipeline compiles.
   */
  readonly numThreads?: number;
}

/** Async detection facade — same span shape as the deterministic recognizers. */
export interface HebrewNer {
  recognize(text: string): Promise<readonly Span[]>;
}

/**
 * Load the dictabert-ner pipeline (applies the shim first) and return an async recognizer. The
 * model is imported dynamically so this module carries no top-level transformers.js cost — pure
 * helpers above stay unit-testable without the 185 MB model.
 */
export async function createHebrewNer(options: HebrewNerOptions = {}): Promise<HebrewNer> {
  installTokenizerRegexShim();
  const transformers = await import("@huggingface/transformers");
  // Load the model from the remote host, never a same-origin /models path: a SPA dev/prod server
  // answers /models/* with index.html (200), which transformers would try to parse as the model and
  // fail. When the model self-hosts on R2 (P4-02) this points at that origin instead.
  transformers.env.allowLocalModels = false;
  const wasmBackend = transformers.env.backends.onnx.wasm;
  if (options.numThreads !== undefined && wasmBackend) {
    wasmBackend.numThreads = options.numThreads;
  }
  const { pipeline } = transformers;
  const classifier = await pipeline("token-classification", MODEL_ID, {
    device: options.device ?? "wasm",
    dtype: DTYPE,
    revision: MODEL_REVISION,
    progress_callback: options.progressCallback,
  });

  return {
    async recognize(text: string): Promise<readonly Span[]> {
      const output = (await classifier(text, {
        aggregation_strategy: "simple",
      })) as Array<{ entity_group: string; word: string; score: number }>;
      const rawSpans: RawNerSpan[] = output.map((entity) => ({
        raw: entity.entity_group,
        surface: entity.word,
        score: Number(entity.score),
      }));
      return reconstructNerSpans(text, rawSpans);
    },
  };
}
