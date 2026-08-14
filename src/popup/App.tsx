import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyRow } from "@engine/types";
import { fromKeyFile, toKeyFile } from "@engine/key";
import { restore } from "@engine/restore";
import { extractText, ACCEPTED } from "./extract";
import { requestNer } from "../shared/ner";
import { RedactSession } from "../shared/session";
import { withInstruction } from "../shared/instruction";

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

function friendlyError(message: string, fileName: string): string {
  if (message === "empty") {
    return "לא נמצא טקסט בקובץ (ייתכן PDF סרוק — נסו את האתר)";
  }
  if (message.startsWith(".")) {
    return `סוג קובץ לא נתמך (${message}). נתמכים: PDF, Word, טקסט`;
  }
  if (fileName.toLowerCase().endsWith(".pdf")) {
    return "לא ניתן לקרוא את ה-PDF כאן (ייתכן שהוא סרוק או מוגן) — נסו את האתר";
  }
  return "שגיאה בעיבוד הקובץ";
}

/** Read-only text with a floating copy icon in the corner (like every AI chat), so copying never
 *  needs scrolling to a button below the box. */
function CopyableText({ value, tone = "plain" }: { value: string; tone?: "plain" | "ok" }) {
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
        aria-label="העתק"
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

  // The popup shares the ONE session key with the chat overlay (same chrome.storage). Hydrate it so
  // restore is ready automatically and file tokens stay consistent with chat tokens.
  useEffect(() => {
    void session.hydrate().then(() => setSessionReady(session.hasKey));
  }, [session]);

  const finishRedact = useCallback((redacted: string, base: string, count: number) => {
    setResult({ redacted: withInstruction(redacted), baseName: base, count });
    setSessionReady(true);
    setKeySaved(false);
    setStatus("done");
  }, []);

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
    const { text, newRows } = session.redactManualTerms(extracted, terms);
    finishRedact(text, baseName, newRows.length);
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
      setRestoreMsg(`מפתח נטען`);
    } catch {
      setKeyRows(null);
      setRestoreMsg("קובץ מפתח לא תקין");
    }
  }, []);

  const doRestore = useCallback(() => {
    if (!answer.trim()) {
      setRestoreMsg("הדביקו את תשובת ה-AI");
      return;
    }
    if (!keyRows && !session.hasKey) {
      setRestoreMsg("אין מפתח — טענו קובץ מפתח או מסכו קודם");
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
    setRestoreMsg(unmatched.length > 0 ? `שוחזר · ${unmatched.length} סימונים לא זוהו` : "שוחזר ✓");
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
        const { text: redacted, newRows } = session.redact(text, ner.spans);
        finishRedact(redacted, base, newRows.length);
      } catch (err) {
        setError(friendlyError(err instanceof Error ? err.message : String(err), file.name));
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
      dir="rtl"
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
          מיסוך קובץ
        </button>
        <button
          type="button"
          onClick={() => setMode("restore")}
          className={`h-10 flex-1 rounded-xl text-[13px] font-semibold transition ${
            mode === "restore" ? "bg-white text-ink shadow-sm" : "text-zinc-500"
          }`}
        >
          שחזור תשובה
        </button>
      </div>

      {mode === "redact" && status !== "done" && status !== "picking" && (
        <div className="mb-3 flex items-center gap-2 text-[13px]" role="group">
          <span className="text-zinc-400">זיהוי:</span>
          <button
            type="button"
            onClick={() => setRedactMode("auto")}
            className={`h-9 rounded-full px-4 font-semibold transition ${
              redactMode === "auto" ? "bg-ink text-white" : "text-zinc-500 hover:text-ink"
            }`}
          >
            אוטומטי
          </button>
          <button
            type="button"
            onClick={() => setRedactMode("manual")}
            className={`h-9 rounded-full px-4 font-semibold transition ${
              redactMode === "manual" ? "bg-ink text-white" : "text-zinc-500 hover:text-ink"
            }`}
          >
            ידני
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
            <span className="text-sm font-medium text-zinc-500">מעבד…</span>
          ) : (
            <>
              <span className="text-sm font-semibold">גררו קובץ לכאן או לחצו לבחירה</span>
              <span className="text-xs text-zinc-400">PDF · Word · טקסט — הכול נשאר במכשיר</span>
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
            הוסתרו {result.count} פרטים — מוכן לשליחה ל-AI
          </div>

          <CopyableText value={result.redacted} />

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void copyRedacted(result.redacted)}
              className="h-11 flex-1 rounded-full bg-black px-4 text-sm font-semibold text-white transition hover:brightness-110"
            >
              {copyState === "ok"
                ? "הועתק ✓"
                : copyState === "fail"
                  ? "ההעתקה נכשלה — סמנו ידנית"
                  : "העתק טקסט מוסתר"}
            </button>
            <button
              type="button"
              onClick={() =>
                download(`${result.baseName}-מוסתר.txt`, result.redacted, "text/plain;charset=utf-8")
              }
              className="h-11 rounded-full border border-zinc-200 px-4 text-sm font-semibold transition hover:bg-zinc-50"
            >
              הורד .txt
            </button>
          </div>

          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              onClick={() => {
                setStatus("idle");
                setResult(null);
                setKeySaved(false);
              }}
              className="text-[13px] font-medium text-zinc-400 hover:text-ink"
            >
              קובץ נוסף
            </button>
            <button
              type="button"
              onClick={() => {
                download(
                  `${result.baseName}-מפתח-שחזור.json`,
                  toKeyFile(session.rows),
                  "application/json;charset=utf-8",
                );
                setKeySaved(true);
              }}
              className="text-[12px] font-medium text-zinc-400 hover:text-ink"
              title="השחזור באותו מחשב אוטומטי; הקובץ נחוץ רק כדי לשחזר במחשב אחר"
            >
              {keySaved ? "מפתח נשמר ✓" : "מפתח לשחזור במחשב אחר"}
            </button>
          </div>
        </div>
      )}

      {mode === "redact" && status === "picking" && (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-zinc-500">
            לחצו על מספר או שם כדי להסתיר אותו (וכל החזרות שלו). או הקלידו מונח.
          </p>
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
              placeholder="מונח להסתרה…"
              className="h-11 flex-1 rounded-full border border-zinc-200 px-4 text-[13px] placeholder:text-zinc-400"
            />
            <button
              type="button"
              onClick={() => addTerm(termInput)}
              className="h-11 rounded-full bg-ink px-4 text-[13px] font-semibold text-white"
            >
              הוסף
            </button>
          </div>
          {terms.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {terms.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTerms((prev) => prev.filter((x) => x !== t))}
                  className="rounded-full bg-emerald-100 px-3 py-1 text-[12px] font-medium text-emerald-800"
                >
                  {t} ✕
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
            הסתר {terms.length} מונחים
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
            ביטול
          </button>
        </div>
      )}

      {mode === "restore" && (
        <div className="flex flex-col gap-3">
          <textarea
            dir="auto"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="הדביקו כאן את תשובת ה-AI (עם הסימונים)…"
            className="h-28 w-full resize-none rounded-3xl border border-zinc-200 bg-zinc-50 p-4 text-[13px] leading-relaxed placeholder:text-zinc-400"
          />

          <div className="flex flex-wrap items-center gap-2">
            {keyRows || sessionReady ? (
              <span className="inline-flex h-11 items-center gap-2 rounded-full bg-emerald-50 px-4 text-[13px] font-semibold text-emerald-700">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                מפתח טעון · {keyRows ? keyRows.length : session.rows.length}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => keyInputRef.current?.click()}
              className="h-11 rounded-full border border-zinc-200 px-4 text-[13px] font-semibold transition hover:bg-zinc-50"
            >
              {keyRows || sessionReady ? "טען מפתח אחר" : "טען קובץ מפתח"}
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
            שחזר את הערכים המקוריים
          </button>

          {restoreMsg && (
            <p role="status" className="text-center text-[13px] font-medium text-zinc-500">
              {restoreMsg}
            </p>
          )}

          {restored !== null && <CopyableText value={restored} tone="ok" />}
        </div>
      )}

      <p className="mt-4 text-[11px] leading-relaxed text-zinc-400">
        המידע הרגיש לא עוזב את הדפדפן. השחזור זמין אוטומטית בלשונית "שחזור תשובה".
      </p>
    </main>
  );
}
