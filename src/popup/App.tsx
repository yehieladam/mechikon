import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyRow } from "@engine/types";
import { fromKeyFile, toKeyFile } from "@engine/key";
import { restore } from "@engine/restore";
import { extractText, ACCEPTED } from "./extract";
import { requestNer } from "../shared/ner";
import { RedactSession } from "../shared/session";
import { detectTextLang, withInstruction } from "../shared/instruction";
import { defaultLang, t, type Lang } from "../shared/i18n";

type Status = "idle" | "working" | "picking" | "done" | "error";

interface Result {
  readonly redacted: string;
  readonly baseName: string;
  readonly count: number;
}

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  // Defer revoke + removal: revoking on the same tick can abort the download before the browser
  // has captured the blob (classic Chromium gotcha) — the restore key is the only de-anon path.
  setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 1500);
}

function friendlyError(message: string, fileName: string, lang: Lang): string {
  if (message === "empty") {
    return t(lang, "noTextInFile");
  }
  if (message.startsWith(".")) {
    return t(lang, "unsupportedType", { message });
  }
  if (fileName.toLowerCase().endsWith(".pdf")) {
    return t(lang, "pdfUnreadable");
  }
  return t(lang, "fileProcessError");
}

/** Read-only text with a floating copy icon in the corner (like every AI chat), so copying never
 *  needs scrolling to a button below the box. */
function CopyableText({
  value,
  lang,
  tone = "plain",
}: {
  value: string;
  lang: Lang;
  tone?: "plain" | "ok";
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — user can still select manually */
    }
  };
  const border = tone === "ok" ? "border-emerald-200 bg-emerald-50/50" : "border-zinc-200 bg-zinc-50";
  return (
    <div className="relative">
      <textarea
        readOnly
        dir="auto"
        value={value}
        className={`h-40 w-full resize-none rounded-3xl border ${border} p-4 pt-10 text-[13px] leading-relaxed`}
      />
      <button
        type="button"
        onClick={copy}
        aria-label={t(lang, "copy")}
        className="absolute left-2.5 top-2.5 flex h-9 w-9 items-center justify-center rounded-full border border-zinc-200 bg-white/90 text-zinc-600 shadow-sm transition hover:text-ink"
      >
        {copied ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
            <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="9" y="9" width="11" height="11" rx="2.5" />
            <path d="M5 15V5a2 2 0 0 1 2-2h10" strokeLinecap="round" />
          </svg>
        )}
      </button>
    </div>
  );
}

const IS_WORD = /[\p{L}\p{N}]/u;

function splitToken(token: string): { lead: string; core: string; trail: string } {
  let s = 0;
  let e = token.length;
  while (s < e && !IS_WORD.test(token[s])) s += 1;
  while (e > s && !IS_WORD.test(token[e - 1])) e -= 1;
  return { lead: token.slice(0, s), core: token.slice(s, e), trail: token.slice(e) };
}

/** The extracted text rendered as clickable word/number units — click a value to mask it (and every
 *  repeat of it), click again to unmask. No manual copy needed. */
function ClickablePreview({
  text,
  terms,
  onToggle,
}: {
  text: string;
  terms: string[];
  onToggle: (word: string) => void;
}) {
  const parts = text.split(/(\s+)/);
  return (
    <div
      dir="auto"
      className="h-32 overflow-auto whitespace-pre-wrap rounded-3xl border border-zinc-200 bg-zinc-50 p-4 text-[13px] leading-relaxed"
    >
      {parts.map((part, i) => {
        if (part === "" || /^\s+$/.test(part)) {
          return <span key={i}>{part}</span>;
        }
        const { lead, core, trail } = splitToken(part);
        if (core === "") {
          return <span key={i}>{part}</span>;
        }
        const active = terms.includes(core);
        return (
          <span key={i}>
            {lead}
            <button
              type="button"
              onClick={() => onToggle(core)}
              className={`rounded-md px-0.5 transition ${
                active ? "bg-emerald-200 font-semibold text-emerald-900" : "hover:bg-amber-100"
              }`}
            >
              {core}
            </button>
            {trail}
          </span>
        );
      })}
    </div>
  );
}

export function App() {
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle");
  const [keySaved, setKeySaved] = useState(false);
  const [mode, setMode] = useState<"redact" | "restore">("redact");
  const [answer, setAnswer] = useState("");
  const [keyRows, setKeyRows] = useState<readonly KeyRow[] | null>(null);
  const [restored, setRestored] = useState<string | null>(null);
  const [restoreMsg, setRestoreMsg] = useState("");
  const [redactMode, setRedactMode] = useState<"auto" | "manual">("auto");
  const [extracted, setExtracted] = useState("");
  const [baseName, setBaseName] = useState("");
  const [terms, setTerms] = useState<string[]>([]);
  const [termInput, setTermInput] = useState("");
  const [session] = useState(() => new RedactSession());
  const [sessionReady, setSessionReady] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const keyInputRef = useRef<HTMLInputElement>(null);

  // The popup language FOLLOWS THE TEXT the user is working with (pasted answer in restore mode; the
  // extracted/redacted text in mask mode), falling back to the browser language when there's none yet.
  const lang = useMemo<Lang>(() => {
    const sample = mode === "restore" ? answer : extracted || result?.redacted || "";
    // detectTextLang strips our Latin tokens + any appended instruction so a Hebrew document isn't
    // read as English from its [NAME_1]-style tokens or an English note burned into result.redacted.
    return detectTextLang(sample, defaultLang());
  }, [mode, answer, extracted, result]);
  const dir = lang === "he" ? "rtl" : "ltr";
  // A live ref so event-handler callbacks read the CURRENT language without listing it as a dep.
  const langRef = useRef(lang);
  langRef.current = lang;

  // The popup shares the ONE session key with the chat overlay (same chrome.storage). Hydrate it so
  // restore is ready automatically and file tokens stay consistent with chat tokens.
  useEffect(() => {
    void session.hydrate().then(() => setSessionReady(session.hasKey));
  }, [session]);

  const finishRedact = useCallback(
    // `lang` is the language of the SOURCE document (computed by the caller from the file/preview text),
    // NOT the current UI language — so a Hebrew file always gets the Hebrew AI note even on an
    // English-locale browser, and vice versa.
    (redacted: string, base: string, lang: Lang) => {
      // Count DISTINCT masks actually in the output (not only newly minted rows) — a value already in
      // the shared key still appears as a token, so newRows can be 0 while the text is masked.
      const count = new Set(redacted.match(/\[[^[\]]+_\d+\]/g) ?? []).size;
      setResult({ redacted: withInstruction(redacted, lang), baseName: base, count });
      setSessionReady(session.hasKey);
      setKeySaved(false);
      setStatus("done");
    },
    [session],
  );

  const addTerm = useCallback((value: string) => {
    const v = value.trim();
    if (v.length > 0) {
      setTerms((prev) => (prev.includes(v) ? prev : [...prev, v]));
    }
    setTermInput("");
  }, []);

  const toggleTerm = useCallback((word: string) => {
    setTerms((prev) => (prev.includes(word) ? prev.filter((w) => w !== word) : [...prev, word]));
  }, []);

  const doManualRedact = useCallback(() => {
    const { text } = session.redactManualTerms(extracted, terms);
    finishRedact(text, baseName, detectTextLang(extracted, defaultLang()));
  }, [session, extracted, terms, baseName, finishRedact]);

  const copyRedacted = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("ok");
    } catch {
      setCopyState("fail");
    }
    setTimeout(() => setCopyState("idle"), 1600);
  }, []);

  const loadKeyFile = useCallback(async (file: File) => {
    try {
      setKeyRows(fromKeyFile(await file.text()));
      setRestoreMsg(t(langRef.current, "keyLoaded"));
    } catch {
      setKeyRows(null);
      setRestoreMsg(t(langRef.current, "invalidKeyFile"));
    }
  }, []);

  const doRestore = useCallback(() => {
    if (!answer.trim()) {
      setRestoreMsg(t(langRef.current, "pasteAiAnswer"));
      return;
    }
    if (!keyRows && !session.hasKey) {
      setRestoreMsg(t(langRef.current, "noKeyLoadOrMask"));
      return;
    }
    // Uploaded key (other device / old file) wins; otherwise the shared session key (auto-loaded).
    const { restoredText, unmatched } = keyRows
      ? restore(answer, keyRows)
      : (() => {
          const r = session.restore(answer);
          return { restoredText: r.text, unmatched: r.unmatched };
        })();
    setRestored(restoredText);
    setRestoreMsg(
      unmatched.length > 0
        ? t(langRef.current, "restoredUnmatchedDot", { n: unmatched.length })
        : t(langRef.current, "restoredCheck"),
    );
  }, [answer, keyRows, session]);

  const handleFile = useCallback(
    async (file: File) => {
      setStatus("working");
      setError("");
      setResult(null);
      const base = file.name.replace(/\.[^.]+$/, "");
      setBaseName(base);
      try {
        const buffer = await file.arrayBuffer();
        const text = await extractText(file.name, buffer);
        if (!text.trim()) {
          throw new Error("empty");
        }
        if (redactMode === "manual") {
          // Manual: show the text and let the user pick exactly what to mask.
          setExtracted(text);
          setTerms([]);
          setStatus("picking");
          return;
        }
        const ner = await requestNer(text);
        const { text: redacted } = session.redact(text, ner.spans);
        // Language of the FILE (before masking) — so the instruction matches the document, not the
        // browser locale. Also lets the results view render in the document's language.
        setExtracted(text);
        finishRedact(redacted, base, detectTextLang(text, defaultLang()));
      } catch (err) {
        setError(
          friendlyError(err instanceof Error ? err.message : String(err), file.name, langRef.current),
        );
        setStatus("error");
      }
    },
    [session, redactMode, finishRedact],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer.files?.[0];
      if (file) {
        void handleFile(file);
      }
    },
    [handleFile],
  );

  return (
    <main
      dir={dir}
      className="w-[380px] rounded-[24px] bg-white p-5 text-ink"
      style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}
    >
      <header className="mb-4 flex items-center gap-2">
        <span className="text-[15px] font-bold tracking-tight" dir="ltr">
          MECHIKON
        </span>
      </header>

      <div className="mb-4 inline-flex w-full rounded-2xl bg-zinc-100 p-1" role="group">
        <button
          type="button"
          onClick={() => setMode("redact")}
          className={`h-10 flex-1 rounded-xl text-[13px] font-semibold transition ${
            mode === "redact" ? "bg-white text-ink shadow-sm" : "text-zinc-500"
          }`}
        >
          {t(lang, "fileMaskMode")}
        </button>
        <button
          type="button"
          onClick={() => setMode("restore")}
          className={`h-10 flex-1 rounded-xl text-[13px] font-semibold transition ${
            mode === "restore" ? "bg-white text-ink shadow-sm" : "text-zinc-500"
          }`}
        >
          {t(lang, "restoreAnswer")}
        </button>
      </div>

      {mode === "redact" && status !== "done" && status !== "picking" && (
        <div className="mb-3 flex items-center gap-2 text-[13px]" role="group">
          <span className="text-zinc-400">{t(lang, "detectionLabel")}</span>
          <button
            type="button"
            onClick={() => setRedactMode("auto")}
            className={`h-9 rounded-full px-4 font-semibold transition ${
              redactMode === "auto" ? "bg-ink text-white" : "text-zinc-500 hover:text-ink"
            }`}
          >
            {t(lang, "autoMode")}
          </button>
          <button
            type="button"
            onClick={() => setRedactMode("manual")}
            className={`h-9 rounded-full px-4 font-semibold transition ${
              redactMode === "manual" ? "bg-ink text-white" : "text-zinc-500 hover:text-ink"
            }`}
          >
            {t(lang, "manualMode")}
          </button>
        </div>
      )}

      {mode === "redact" && status !== "done" && status !== "picking" && (
        <div
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              inputRef.current?.click();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`flex min-h-[140px] cursor-pointer flex-col items-center justify-center gap-2 rounded-3xl border-2 border-dashed p-6 text-center transition ${
            dragging ? "border-emerald-400 bg-emerald-50" : "border-zinc-200 hover:bg-zinc-50"
          }`}
        >
          {status === "working" ? (
            <span className="text-sm font-medium text-zinc-500">{t(lang, "processing")}</span>
          ) : (
            <>
              <span className="text-sm font-semibold">{t(lang, "dropHere")}</span>
              <span className="text-xs text-zinc-400">{t(lang, "dropTypes")}</span>
            </>
          )}
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                void handleFile(file);
              }
            }}
          />
        </div>
      )}

      {mode === "redact" && status === "error" && (
        <p className="mt-3 rounded-2xl bg-red-50 px-3 py-2 text-[13px] text-red-600">{error}</p>
      )}

      {mode === "redact" && status === "done" && result && (
        <div className="flex flex-col gap-3">
          <div
            role="status"
            className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-[13px] font-medium text-emerald-700"
          >
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            {t(lang, "redactedReady", { n: result.count })}
          </div>

          <CopyableText value={result.redacted} lang={lang} />

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void copyRedacted(result.redacted)}
              className="h-11 flex-1 rounded-full bg-black px-4 text-sm font-semibold text-white transition hover:brightness-110"
            >
              {copyState === "ok"
                ? t(lang, "copiedCheck")
                : copyState === "fail"
                  ? t(lang, "copyFailed")
                  : t(lang, "copyMaskedText")}
            </button>
            <button
              type="button"
              onClick={() =>
                download(
                  t(lang, "maskedFileName", { baseName: result.baseName }),
                  result.redacted,
                  "text/plain;charset=utf-8",
                )
              }
              className="h-11 rounded-full border border-zinc-200 px-4 text-sm font-semibold transition hover:bg-zinc-50"
            >
              {t(lang, "downloadTxt")}
            </button>
          </div>

          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              onClick={() => {
                setStatus("idle");
                setResult(null);
                setKeySaved(false);
                setExtracted("");
              }}
              className="text-[13px] font-medium text-zinc-400 hover:text-ink"
            >
              {t(lang, "anotherFile")}
            </button>
            <button
              type="button"
              onClick={() => {
                download(
                  t(lang, "keyFileName", { baseName: result.baseName }),
                  toKeyFile(session.rows),
                  "application/json;charset=utf-8",
                );
                setKeySaved(true);
              }}
              className="text-[12px] font-medium text-zinc-400 hover:text-ink"
              title={t(lang, "sameComputerAuto")}
            >
              {keySaved ? t(lang, "keySaved") : t(lang, "keyForOtherComputer")}
            </button>
          </div>
        </div>
      )}

      {mode === "redact" && status === "picking" && (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-zinc-500">{t(lang, "pickHint")}</p>
          <ClickablePreview text={extracted} terms={terms} onToggle={toggleTerm} />
          <div className="flex gap-2">
            <input
              value={termInput}
              onChange={(e) => setTermInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  addTerm(termInput);
                }
              }}
              placeholder={t(lang, "termToHide")}
              className="h-11 flex-1 rounded-full border border-zinc-200 px-4 text-[13px] placeholder:text-zinc-400"
            />
            <button
              type="button"
              onClick={() => addTerm(termInput)}
              className="h-11 rounded-full bg-ink px-4 text-[13px] font-semibold text-white"
            >
              {t(lang, "addTermBtn")}
            </button>
          </div>
          {terms.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {terms.map((term) => (
                <button
                  key={term}
                  type="button"
                  onClick={() => setTerms((prev) => prev.filter((x) => x !== term))}
                  className="rounded-full bg-emerald-100 px-3 py-1 text-[12px] font-medium text-emerald-800"
                >
                  {term} ✕
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            disabled={terms.length === 0}
            onClick={doManualRedact}
            className="h-12 rounded-full bg-black px-4 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-40"
          >
            {t(lang, "hideNTerms", { n: terms.length })}
          </button>
          <button
            type="button"
            onClick={() => {
              setStatus("idle");
              setExtracted("");
              setTerms([]);
            }}
            className="text-[13px] font-medium text-zinc-400 hover:text-ink"
          >
            {t(lang, "cancel")}
          </button>
        </div>
      )}

      {mode === "restore" && (
        <div className="flex flex-col gap-3">
          <textarea
            dir="auto"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder={t(lang, "pastePlaceholder")}
            className="h-28 w-full resize-none rounded-3xl border border-zinc-200 bg-zinc-50 p-4 text-[13px] leading-relaxed placeholder:text-zinc-400"
          />

          <div className="flex flex-wrap items-center gap-2">
            {keyRows || sessionReady ? (
              <span className="inline-flex h-11 items-center gap-2 rounded-full bg-emerald-50 px-4 text-[13px] font-semibold text-emerald-700">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                {t(lang, "keyLoadedCount", { n: keyRows ? keyRows.length : session.rows.length })}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => keyInputRef.current?.click()}
              className="h-11 rounded-full border border-zinc-200 px-4 text-[13px] font-semibold transition hover:bg-zinc-50"
            >
              {keyRows || sessionReady ? t(lang, "loadOtherKey") : t(lang, "loadKeyFile")}
            </button>
            <input
              ref={keyInputRef}
              type="file"
              accept=".json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  void loadKeyFile(file);
                }
              }}
            />
          </div>

          <button
            type="button"
            onClick={doRestore}
            className="h-12 rounded-full bg-black px-4 text-sm font-semibold text-white transition hover:brightness-110"
          >
            {t(lang, "restoreOriginals")}
          </button>

          {restoreMsg && (
            <p role="status" className="text-center text-[13px] font-medium text-zinc-500">
              {restoreMsg}
            </p>
          )}

          {restored !== null && <CopyableText value={restored} lang={lang} tone="ok" />}
        </div>
      )}

      <p className="mt-4 text-[11px] leading-relaxed text-zinc-400">{t(lang, "footerPrivacy")}</p>
    </main>
  );
}
