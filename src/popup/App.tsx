import { useCallback, useRef, useState } from "react";
import type { KeyRow } from "@engine/types";
import { anonymizeWith } from "@engine/pipeline";
import { fromKeyFile, toKeyFile } from "@engine/key";
import { restore } from "@engine/restore";
import { extractText, ACCEPTED } from "./extract";
import { requestNer } from "../shared/ner";

type Status = "idle" | "working" | "done" | "error";

interface Result {
  readonly redacted: string;
  readonly key: readonly KeyRow[];
  readonly baseName: string;
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
  const inputRef = useRef<HTMLInputElement>(null);
  const keyInputRef = useRef<HTMLInputElement>(null);

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

  const handleFile = useCallback(async (file: File) => {
    setStatus("working");
    setError("");
    setResult(null);
    try {
      const buffer = await file.arrayBuffer();
      const text = await extractText(file.name, buffer);
      if (!text.trim()) {
        throw new Error("empty");
      }
      const nerSpans = await requestNer(text);
      const { anonymizedText, key } = anonymizeWith(text, nerSpans);
      const baseName = file.name.replace(/\.[^.]+$/, "");
      setResult({ redacted: anonymizedText, key, baseName });
      setStatus("done");
    } catch (err) {
      setError(friendlyError(err instanceof Error ? err.message : String(err), file.name));
      setStatus("error");
    }
  }, []);

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

      {mode === "redact" && status !== "done" && (
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
            <button
              type="button"
              onClick={() => keyInputRef.current?.click()}
              className="h-11 rounded-full border border-zinc-200 px-4 text-sm font-semibold transition hover:bg-zinc-50"
            >
              {keyRows ? `מפתח נטען · ${keyRows.length}` : "טען קובץ מפתח"}
            </button>
            {result?.key && (
              <button
                type="button"
                onClick={() => {
                  setKeyRows(result.key);
                  setRestoreMsg("מפתח נטען");
                }}
                className="h-11 rounded-full px-3 text-[13px] font-medium text-zinc-500 hover:text-ink"
              >
                השתמש במפתח האחרון
              </button>
            )}
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
