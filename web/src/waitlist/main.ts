/**
 * Mechikon Chrome-extension early-access waitlist — standalone page logic (no framework, no deps).
 *
 * Interactive one-question-at-a-time flow: email -> profession -> name -> join. Each step validates
 * before advancing; Enter or the "המשך" button moves forward, "חזרה" moves back.
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

// The publishable key is public by design (RLS-enforced, insert-only via RPC) and ships in the client
// bundle regardless of how it is provided, so a hardcoded default lets any deploy work with zero config.
// Set VITE_SUPABASE_* to override (e.g. to rotate the key or point at a different project).
const SUPABASE_URL =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) ??
  "https://gobvecxhqxvuodsixtay.supabase.co";
const SUPABASE_KEY =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ??
  "sb_publishable_j80iyO3FVUSQtfmSCCs6-w_0Yx7WoM5";

const STORAGE_KEY = "mechikon_waitlist_ref";

/** Hebrew UI strings — kept in one place (this standalone page does not load the app's i18n). */
const T = {
  continue: "המשך",
  submitIdle: "להצטרף לגישה מוקדמת",
  submitWorking: "רגע…",
  errEmail: "אימייל לא תקין.",
  errName: "צריך שם.",
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
const nextBtn = $("next") as HTMLButtonElement;
const backBtn = $("back") as HTMLButtonElement;
const steps = Array.from(document.querySelectorAll<HTMLElement>(".step"));
const dots = Array.from(document.querySelectorAll<HTMLElement>(".dot"));
const LAST = steps.length - 1;

/** Ordered field ids, one per step (matches data-step 0/1/2 in the DOM). */
const FIELDS = ["email", "profession", "name"] as const;

let current = 0;

function tierFor(count: number): string {
  return (T.tiers.find((t) => count >= t.min) ?? T.tiers[T.tiers.length - 1]).label;
}

function shareUrl(code: string): string {
  return `${location.origin}/waitlist.html?ref=${encodeURIComponent(code)}`;
}

function valOf(step: number): string {
  return (($(FIELDS[step]) as HTMLInputElement).value || "").trim();
}

function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

/** Returns an error message for the current step, or "" if it is valid. */
function validate(step: number): string {
  const v = valOf(step);
  if (FIELDS[step] === "email") return isEmail(v) ? "" : T.errEmail;
  if (FIELDS[step] === "name") return v ? "" : T.errName;
  return ""; // profession is optional
}

function render(): void {
  steps.forEach((el, i) => (el.hidden = i !== current));
  dots.forEach((d, i) => d.classList.toggle("on", i <= current));
  backBtn.hidden = current === 0;
  nextBtn.textContent = current === LAST ? T.submitIdle : T.continue;
  errEl.textContent = "";
  const input = $(FIELDS[current]) as HTMLInputElement;
  // Focus after paint so the caret lands and the mobile keyboard opens.
  setTimeout(() => input.focus(), 0);
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
  ($("link") as HTMLInputElement).value = shareUrl(code);
  form.classList.add("hide");
  statusEl.classList.add("show");
  if (typeof navigator.share === "function") $("share-native").style.display = "block";
}

async function submitJoin(): Promise<void> {
  nextBtn.disabled = true;
  nextBtn.textContent = T.submitWorking;
  const ref = new URLSearchParams(location.search).get("ref");
  try {
    const out = await rpc<{ ref_code: string; referrals: number }>("mechikon_join", {
      p_name: valOf(2),
      p_email: valOf(0),
      p_profession: valOf(1),
      p_ref: ref,
    });
    localStorage.setItem(STORAGE_KEY, out.ref_code);
    showStatus(out.ref_code, out.referrals ?? 0);
  } catch (err) {
    errEl.textContent =
      err instanceof Error && err.message === "config" ? T.errConfig : T.errGeneric;
    nextBtn.disabled = false;
    nextBtn.textContent = T.submitIdle;
  }
}

async function onSubmit(e: Event): Promise<void> {
  e.preventDefault();
  const msg = validate(current);
  if (msg) {
    errEl.textContent = msg;
    return;
  }
  if (current < LAST) {
    current += 1;
    render();
    return;
  }
  await submitJoin();
}

function wireCopy(): void {
  const copyBtn = $("copy") as HTMLButtonElement;
  copyBtn.addEventListener("click", async () => {
    const link = ($("link") as HTMLInputElement).value;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      ($("link") as HTMLInputElement).select();
    }
    copyBtn.textContent = T.copied;
    setTimeout(() => (copyBtn.textContent = T.copy), 1600);
  });

  document.getElementById("share")?.addEventListener("click", () => {
    const link = ($("link") as HTMLInputElement).value;
    navigator.share?.({ title: "מחיקון לכרום", text: "גישה מוקדמת לתוסף מחיקון:", url: link }).catch(
      () => {},
    );
  });
}

/** Returning visitor: skip the wizard, show status and refresh the live count. */
async function restoreExisting(): Promise<boolean> {
  const code = localStorage.getItem(STORAGE_KEY);
  if (!code) return false;
  showStatus(code, 0);
  try {
    const out = await rpc<{ referrals: number }>("mechikon_status", { p_code: code });
    ($("count") as HTMLElement).textContent = String(out.referrals ?? 0);
    ($("tier") as HTMLElement).textContent = tierFor(out.referrals ?? 0);
  } catch {
    // keep the cached view; a failed refresh is non-fatal.
  }
  return true;
}

form.addEventListener("submit", onSubmit);
backBtn.addEventListener("click", () => {
  if (current > 0) {
    current -= 1;
    render();
  }
});
wireCopy();

void restoreExisting().then((restored) => {
  if (!restored) render();
});
