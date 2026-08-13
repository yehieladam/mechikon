import { useCallback, useRef, useState } from "react";
import type { KeyRow } from "@engine/types";
import { anonymizeWith } from "@engine/pipeline";
import { toKeyFile } from "@engine/key";
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
  const inputRef = useRef<HTMLInputElement>(null);

  const copyRedacted = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("ok");
    } catch {
      setCopyState("fail");
    }
    setTimeout(() => setCopyState("idle"), 1600);
  }, []);

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
        <span className="text-[13px] text-zinc-400">· מיסוך קבצים</span>
      </header>

      {status !== "done" && (
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
          className={`flex min-h-[132px] cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed p-6 text-center transition ${
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

      {status === "error" && (
        <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-[13px] text-red-600">{error}</p>
      )}

      {status === "done" && result && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-[13px] font-medium text-emerald-700">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            הוסתרו {result.key.length} פרטים — מוכן לשליחה ל-AI
          </div>

          <textarea
            readOnly
            dir="auto"
            value={result.redacted}
            className="h-40 w-full resize-none rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-[13px] leading-relaxed"
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

          <button
            type="button"
            onClick={() =>
              download(
                `${result.baseName}-מפתח-שחזור.json`,
                toKeyFile(result.key),
                "application/json;charset=utf-8",
              )
            }
            className="h-11 rounded-full border border-zinc-200 px-4 text-sm font-semibold transition hover:bg-zinc-50"
          >
            הורד מפתח שחזור (שמרו לעצמכם)
          </button>

          <button
            type="button"
            onClick={() => {
              setStatus("idle");
              setResult(null);
            }}
            className="text-[13px] font-medium text-zinc-400 hover:text-ink"
          >
            קובץ נוסף
          </button>
        </div>
      )}

      <p className="mt-4 text-[11px] leading-relaxed text-zinc-400">
        המידע הרגיש לא עוזב את הדפדפן. שמרו את מפתח השחזור כדי להחזיר את הערכים המקוריים בהמשך.
      </p>
    </main>
  );
}
