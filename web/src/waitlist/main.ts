/**
 * Mechikon Chrome-extension early-access waitlist — standalone page logic (no framework, no deps).
 *
 * Talks to the isolated `public.mechikon_waitlist` table in the BAI Portal Supabase project via two
 * SECURITY DEFINER RPCs (anon has NO table read access, so no email can ever leak):
 *   - mechikon_join(name, email, profession, ref) -> { ref_code, referrals }
 *   - mechikon_status(code)                        -> { referrals }
 *
 * The signup page runs under its OWN relaxed CSP (vercel.json) that allows connect-src to the
 * Supabase host — the redaction app keeps its locked "nothing leaves the device" CSP untouched.
 *
 * No numbers are shown on purpose (maximize signups): only the user's own referral count + a
 * qualitative tier. Absolute position / total signups are never surfaced.
 */

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

const STORAGE_KEY = "mechikon_waitlist_ref";

/** Hebrew UI strings — kept in one place (this standalone page does not load the app's i18n). */
const T = {
  submitIdle: "להצטרף לגישה מוקדמת",
  submitWorking: "רגע…",
  errRequired: "צריך שם ואימייל.",
  errEmail: "אימייל לא תקין.",
  errGeneric: "משהו השתבש. נסו שוב.",
  errConfig: "השירות אינו זמין כרגע. נסו שוב מאוחר יותר.",
  copied: "הועתק ✓",
  copy: "העתקה",
  tiers: [
    { min: 6, label: "חזית התור 🔥" },
    { min: 3, label: "קרוב לחזית" },
    { min: 1, label: "מטפס" },
    { min: 0, label: "בתור" },
  ],
} as const;

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el;
}

const form = $("form") as HTMLFormElement;
const statusEl = $("status");
const errEl = $("err");
const submitBtn = $("submit") as HTMLButtonElement;

function tierFor(count: number): string {
  return (T.tiers.find((t) => count >= t.min) ?? T.tiers[T.tiers.length - 1]).label;
}

function shareUrl(code: string): string {
  return `${location.origin}/waitlist.html?ref=${encodeURIComponent(code)}`;
}

/** POST to a Supabase RPC. Throws on any non-2xx or transport error. */
async function rpc<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("config");
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`rpc ${fn} ${res.status}`);
  return (await res.json()) as T;
}

function showStatus(code: string, referrals: number): void {
  ($("count") as HTMLElement).textContent = String(referrals);
  ($("tier") as HTMLElement).textContent = tierFor(referrals);
  const linkInput = $("link") as HTMLInputElement;
  linkInput.value = shareUrl(code);
  form.classList.add("hide");
  statusEl.classList.add("show");

  // Native share (mobile) when available — much better conversion than copy on phones.
  if (typeof navigator.share === "function") {
    $("share-native").style.display = "block";
  }
}

function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

async function onSubmit(e: Event): Promise<void> {
  e.preventDefault();
  errEl.textContent = "";

  const name = (($("name") as HTMLInputElement).value || "").trim();
  const email = (($("email") as HTMLInputElement).value || "").trim();
  const profession = (($("profession") as HTMLInputElement).value || "").trim();

  if (!name || !email) {
    errEl.textContent = T.errRequired;
    return;
  }
  if (!isEmail(email)) {
    errEl.textContent = T.errEmail;
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = T.submitWorking;

  const params = new URLSearchParams(location.search);
  const ref = params.get("ref");

  try {
    const out = await rpc<{ ref_code: string; referrals: number }>("mechikon_join", {
      p_name: name,
      p_email: email,
      p_profession: profession,
      p_ref: ref,
    });
    localStorage.setItem(STORAGE_KEY, out.ref_code);
    showStatus(out.ref_code, out.referrals ?? 0);
  } catch (err) {
    errEl.textContent = err instanceof Error && err.message === "config" ? T.errConfig : T.errGeneric;
    submitBtn.disabled = false;
    submitBtn.textContent = T.submitIdle;
  }
}

function wireCopy(): void {
  const copyBtn = $("copy") as HTMLButtonElement;
  copyBtn.addEventListener("click", async () => {
    const link = ($("link") as HTMLInputElement).value;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // Fallback: select the field so the user can copy manually.
      ($("link") as HTMLInputElement).select();
    }
    copyBtn.textContent = T.copied;
    setTimeout(() => (copyBtn.textContent = T.copy), 1600);
  });

  const shareBtn = document.getElementById("share");
  shareBtn?.addEventListener("click", () => {
    const link = ($("link") as HTMLInputElement).value;
    navigator.share?.({ title: "מחיקון לכרום", text: "גישה מוקדמת לתוסף מחיקון:", url: link }).catch(
      () => {},
    );
  });
}

/** Returning visitor: if we already have their code, show status and refresh the live count. */
async function restoreExisting(): Promise<void> {
  const code = localStorage.getItem(STORAGE_KEY);
  if (!code) return;
  showStatus(code, 0);
  try {
    const out = await rpc<{ referrals: number }>("mechikon_status", { p_code: code });
    ($("count") as HTMLElement).textContent = String(out.referrals ?? 0);
    ($("tier") as HTMLElement).textContent = tierFor(out.referrals ?? 0);
  } catch {
    // keep the cached view; a failed refresh is non-fatal.
  }
}

form.addEventListener("submit", onSubmit);
wireCopy();
void restoreExisting();
