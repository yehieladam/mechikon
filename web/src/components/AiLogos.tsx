/**
 * Brand marks for the "copy and open in <service>" buttons. Inline SVG only — no external asset, no
 * network request (keeps the app self-contained and CSP-safe). Each logo carries the service's own
 * brand color so the buttons read as authentic launchers rather than generic links. Trademarks belong
 * to their owners; used here only to attribute the destination of an outbound "open in" link.
 */
interface LogoProps {
  readonly className?: string;
}

/** OpenAI / ChatGPT — the official blossom knot, monochrome (inherits currentColor). */
export function OpenAiLogo({ className }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" className={className} aria-hidden="true" fill="currentColor">
      <path d="M22.28 9.82a5.98 5.98 0 0 0-.52-4.91 6.05 6.05 0 0 0-6.52-2.9A6.06 6.06 0 0 0 4.98 4.18a5.98 5.98 0 0 0-3.99 2.9 6.05 6.05 0 0 0 .74 7.1 5.98 5.98 0 0 0 .52 4.91 6.05 6.05 0 0 0 6.52 2.9A5.98 5.98 0 0 0 13.26 24a6.06 6.06 0 0 0 5.77-4.21 5.99 5.99 0 0 0 4-2.9 6.05 6.05 0 0 0-.75-7.07zM13.26 22.43a4.48 4.48 0 0 1-2.88-1.04l.14-.08 4.78-2.76a.8.8 0 0 0 .39-.68v-6.74l2.02 1.17a.07.07 0 0 1 .04.05v5.58a4.5 4.5 0 0 1-4.49 4.5zM3.6 18.3a4.47 4.47 0 0 1-.54-3.01l.14.08 4.79 2.76a.77.77 0 0 0 .78 0l5.84-3.37v2.33a.08.08 0 0 1-.03.06L9.74 22.05A4.5 4.5 0 0 1 3.6 18.3zM2.34 7.9a4.49 4.49 0 0 1 2.37-1.98v5.68a.77.77 0 0 0 .39.68l5.81 3.35-2.02 1.17a.08.08 0 0 1-.07 0l-4.83-2.79A4.5 4.5 0 0 1 2.34 7.9zm16.6 3.86-5.84-3.39 2.02-1.16a.08.08 0 0 1 .07 0l4.83 2.79a4.49 4.49 0 0 1-.68 8.1v-5.68a.79.79 0 0 0-.4-.66zm2-3.03-.14-.08-4.77-2.78a.78.78 0 0 0-.79 0L9.41 7.23V4.9a.07.07 0 0 1 .03-.06l4.83-2.79a4.5 4.5 0 0 1 6.68 4.66zM8.31 12.86l-2.02-1.16a.08.08 0 0 1-.04-.06V6.07a4.5 4.5 0 0 1 7.38-3.45l-.14.08-4.78 2.76a.8.8 0 0 0-.4.68zm1.1-2.36 2.6-1.5 2.61 1.5v3l-2.6 1.5-2.6-1.5z" />
    </svg>
  );
}

/** Google Gemini — the four-point spark, blue-to-purple brand gradient. */
export function GeminiLogo({ className }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="gemini-grad" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#4796E3" />
          <stop offset="0.5" stopColor="#8964E0" />
          <stop offset="1" stopColor="#B03CD1" />
        </linearGradient>
      </defs>
      <path
        fill="url(#gemini-grad)"
        d="M12 0c.6 6.4 5.6 11.4 12 12-6.4.6-11.4 5.6-12 12-.6-6.4-5.6-11.4-12-12C6.4 11.4 11.4 6.4 12 0z"
      />
    </svg>
  );
}

/** Anthropic Claude — the sunburst mark, Claude coral. */
export function ClaudeLogo({ className }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" className={className} aria-hidden="true">
      <g stroke="#D97757" strokeWidth="2.1" strokeLinecap="round">
        <path d="M12 3v18" />
        <path d="M3.6 7.5l16.8 9" />
        <path d="M20.4 7.5l-16.8 9" />
      </g>
    </svg>
  );
}
