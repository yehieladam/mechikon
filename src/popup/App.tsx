import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyRow } from "@engine/types";
import { anonymizeManualOnly, anonymizeWith } from "@engine/pipeline";
import { fromKeyFile, toKeyFile } from "@engine/key";
import { restore } from "@engine/restore";
import { extractText, ACCEPTED } from "./extract";
import { requestNer } from "../shared/ner";

type Status = "idle" | "working" | "picking" | "done" | "error";

interface Result {
  readonly redacted: string;
  readonly key: readonly KeyRow[];
  readonly baseName: string;
}

// Persist the last file's restore key so the "שחזור" tab is ready automatically in the same session
// (survives closing/reopening the popup within 24h) — no need to re-load the key file by hand.
const FILE_KEY = "fileKey.v1";
const FILE_KEY_TTL = 24 * 60 * 60 * 1000;

async function saveFileKey(rows: readonly KeyRow[]): Promise<void> {
  await chrome.storage.local.set({ [FILE_KEY]: { rows, expiresAt: Date.now() + FILE_KEY_TTL } });
}

async function loadFileKey(): Promise<KeyRow[] | null> {
  const bag = await chrome.storage.local.get(FILE_KEY);
  const stored = bag[FILE_KEY] as { rows: KeyRow[]; expiresAt: number } | undefined;
  if (!stored || stored.expiresAt <= Date.now()) {
    return null;
  }
  return stored.rows;
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
  const inputRef = useRef<HTMLInputElement>(null);
  const keyInputRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLTextAreaElement>(null);

  // Auto-load the last file's key so "שחזור" needs no manual key upload in the same session.
  useEffect(() => {
    void loadFileKey().then((rows) => {
      if (rows) {
        setKeyRows(rows);
      }
    });
  }, []);

  const finishRedact = useCallback((redacted: string, key: readonly KeyRow[], base: string) => {
    setResult({ redacted, key, baseName: base });
    setKeyRows(key); // restore tab is immediately ready
    void saveFileKey(key);
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

  const addSelection = useCallback(() => {
    const el = previewRef.current;
    if (el && el.selectionStart !== el.selectionEnd) {
      addTerm(el.value.slice(el.selectionStart, el.selectionEnd));
    }
  }, [addTerm]);

  const doManualRedact = useCallback(() => {
    const { anonymizedText, key } = anonymizeManualOnly(extracted, terms);
    finishRedact(anonymizedText, key, baseName);
  }, [extracted, terms, baseName, finishRedact]);

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
    if (!keyRows) {
      setRestoreMsg("טענו קודם קובץ מפתח");
      return;
    }
    if (!answer.trim()) {
      setRestoreMsg("הדביקו את תשובת ה-AI");
      return;
    }
    const { restoredText, unmatched } = restore(answer, keyRows);
    setRestored(restoredText);
    setRestoreMsg(unmatched.length > 0 ? `שוחזר · ${unmatched.length} סימונים לא זוהו` : "שוחזר ✓");
  }, [answer, keyRows]);

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
        const nerSpans = await requestNer(text);
        const { anonymizedText, key } = anonymizeWith(text, nerSpans);
        finishRedact(anonymizedText, key, base);
      } catch (err) {
        setError(friendlyError(err instanceof Error ? err.message : String(err), file.name));
        setStatus("error");
      }
    },
    [redactMode, finishRedact],
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
      className="w-[380px] bg-white p-5 text-ink"
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
            הוסתרו {result.key.length} פרטים — מוכן לשליחה ל-AI
          </div>

          <textarea
            readOnly
            dir="auto"
            value={result.redacted}
            className="h-40 w-full resize-none rounded-2xl border border-zinc-200 bg-zinc-50 p-3 text-[13px] leading-relaxed"
          />

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

          <div className="rounded-2xl border border-amber-300 bg-amber-50/60 p-3">
            <button
              type="button"
              onClick={() => {
                download(
                  `${result.baseName}-מפתח-שחזור.json`,
                  toKeyFile(result.key),
                  "application/json;charset=utf-8",
                );
                setKeySaved(true);
              }}
              className="h-11 w-full rounded-full bg-amber-500 px-4 text-sm font-semibold text-white transition hover:brightness-110"
            >
              {keySaved ? "מפתח נשמר ✓" : "הורד מפתח שחזור"}
            </button>
            <p className="mt-2 text-center text-[12px] font-medium text-amber-700">
              בלי הקובץ הזה לא ניתן לשחזר את המידע בהמשך
            </p>
          </div>

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
        </div>
      )}

      {mode === "redact" && status === "picking" && (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-zinc-500">
            בחרו מה להסתיר: סמנו טקסט והוסיפו, או הקלידו מונח.
          </p>
          <textarea
            ref={previewRef}
            readOnly
            dir="auto"
            value={extracted}
            className="h-28 w-full resize-none rounded-2xl border border-zinc-200 bg-zinc-50 p-3 text-[13px] leading-relaxed"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={addSelection}
              className="h-11 rounded-full border border-zinc-200 px-4 text-[13px] font-semibold transition hover:bg-zinc-50"
            >
              הוסף בחירה
            </button>
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
            className="h-32 w-full resize-none rounded-2xl border border-zinc-200 bg-zinc-50 p-3 text-[13px] leading-relaxed placeholder:text-zinc-400"
          />

          <div className="flex flex-wrap items-center gap-2">
            {keyRows ? (
              <span className="inline-flex h-11 items-center gap-2 rounded-full bg-emerald-50 px-4 text-[13px] font-semibold text-emerald-700">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                מפתח הסשן טעון · {keyRows.length}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => keyInputRef.current?.click()}
              className="h-11 rounded-full border border-zinc-200 px-4 text-[13px] font-semibold transition hover:bg-zinc-50"
            >
              {keyRows ? "טען מפתח אחר" : "טען קובץ מפתח"}
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

          {restored !== null && (
            <>
              <textarea
                readOnly
                dir="auto"
                value={restored}
                className="h-40 w-full resize-none rounded-2xl border border-emerald-200 bg-emerald-50/50 p-3 text-[13px] leading-relaxed"
              />
              <button
                type="button"
                onClick={() => void copyRedacted(restored)}
                className="h-12 rounded-full bg-black px-4 text-sm font-semibold text-white transition hover:brightness-110"
              >
                {copyState === "ok" ? "הועתק ✓" : "העתק טקסט משוחזר"}
              </button>
            </>
          )}
        </div>
      )}

      <p className="mt-4 text-[11px] leading-relaxed text-zinc-400">
        המידע הרגיש לא עוזב את הדפדפן. שמרו את מפתח השחזור כדי להחזיר את הערכים המקוריים בהמשך.
      </p>
    </main>
  );
}
