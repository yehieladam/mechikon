import { useTranslation } from "react-i18next";
import type { EntityType } from "@engine/types";
import {
  FAMILY_LABEL_KEY,
  FAMILY_ORDER,
  FAMILY_SWATCH_CLASS,
  FAMILY_TYPES,
  isFamilyDisabled,
  type CategoryFamily,
} from "./lib/categories";

interface CategoryLegendProps {
  /** Per-EntityType counts from the current result key (same source as the old count chips). */
  readonly counts: ReadonlyMap<EntityType, number>;
  /** The EntityTypes the user has disabled (never redacted). */
  readonly disabled: readonly EntityType[];
  /** While a (re)detection is running, toggles are inert to avoid racing the worker. */
  readonly busy: boolean;
  /** The current source is a scanned PDF — drives the IL_NUMBER caution copy. */
  readonly isScan: boolean;
  readonly onToggleFamily: (family: CategoryFamily) => void;
}

/** Sum the counts of a family's member types (0 when none were detected / all are disabled). */
function familyCount(counts: ReadonlyMap<EntityType, number>, family: CategoryFamily): number {
  return FAMILY_TYPES[family].reduce((sum, type) => sum + (counts.get(type) ?? 0), 0);
}

/**
 * The category-control legend: a color-coded switch per family. Turning a family OFF leaves those values
 * visible in the redacted output. Color is never the sole signal — every row carries a text label, its
 * count, and an explicit "visible" badge when off. MANUAL is shown as an always-on, non-toggleable row.
 *
 * A disabled family reports a 0 count (its spans are filtered out), so a row also renders whenever the
 * family is disabled — otherwise the user could never turn it back on.
 */
export function CategoryLegend({
  counts,
  disabled,
  busy,
  isScan,
  onToggleFamily,
}: CategoryLegendProps): JSX.Element {
  const { t } = useTranslation();
  const manualCount = counts.get("MANUAL") ?? 0;
  const numbersDisabled = isFamilyDisabled(disabled, "numbers");

  const rows = FAMILY_ORDER.map((family) => {
    const off = isFamilyDisabled(disabled, family);
    const count = familyCount(counts, family);
    return { family, off, count };
  }).filter((row) => row.count > 0 || row.off);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-ink">{t("category.legend")}</span>
        <span className="text-xs text-zinc-600">{t("category.hint")}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {rows.map(({ family, off, count }) => {
          const label = t(FAMILY_LABEL_KEY[family]);
          return (
            <button
              key={family}
              type="button"
              role="switch"
              aria-checked={!off}
              aria-disabled={busy}
              aria-label={t(off ? "category.toggleOff" : "category.toggleOn", { family: label })}
              onClick={() => {
                // aria-disabled (not the native `disabled` attribute) keeps the button in the tab order,
                // so a keyboard/SR user does not lose focus to <body> when a toggle kicks off a reprocess
                // (which flips busy=true and would otherwise disable the just-activated button mid-press).
                if (busy) return;
                onToggleFamily(family);
              }}
              className={`inline-flex min-h-[44px] items-center gap-2 rounded-full px-3 py-1 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-1 ${
                busy ? "cursor-not-allowed opacity-50" : ""
              } ${
                off
                  ? "border border-dashed border-hairline bg-white text-zinc-600"
                  : "border border-hairline bg-white text-ink shadow-sm hover:bg-surface"
              }`}
            >
              <span
                aria-hidden="true"
                className={`h-3 w-3 shrink-0 rounded-full ${FAMILY_SWATCH_CLASS[family]} ${
                  off ? "opacity-40" : ""
                }`}
              />
              <span className={off ? "line-through decoration-zinc-400" : "font-medium"}>{label}</span>
              {off ? (
                <span className="rounded-full bg-surface px-2 py-0.5 text-xs font-medium text-zinc-600">
                  {t("category.visible")}
                </span>
              ) : (
                <span className="tabular-nums text-zinc-600">{count}</span>
              )}
            </button>
          );
        })}
        {manualCount > 0 && (
          <span
            className="inline-flex min-h-[44px] items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-sm text-amber-800"
            title={t("category.manualAlways")}
          >
            <span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full bg-amber-300" />
            <span className="font-medium">{t("category.manualAlways")}</span>
            <span className="tabular-nums">{manualCount}</span>
          </span>
        )}
      </div>
      {isScan && numbersDisabled && (
        <p role="alert" className="text-xs text-amber-700">
          {t("category.scanNumbersWarning")}
        </p>
      )}
    </div>
  );
}
