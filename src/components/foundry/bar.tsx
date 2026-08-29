import { cn } from '@/lib/utils';

/**
 * Floor, in percent, for a *positive* fill fraction, so a row worth a rounding error still shows a
 * stub of a bar rather than nothing. A fraction of exactly `0` renders an empty track instead —
 * "nothing here" must not look like "a little here".
 */
const MIN_PERCENT = 2;

/**
 * Foundry Bar — the single, canonical horizontal proportional bar: a rounded track with a tinted
 * fill whose width is a fraction of the whole. It is what the report breakdowns draw their rows
 * with (value by category/location, spend, sales, stock ageing, ABC tiers), so the track height,
 * radius, tokens, transition and grow-in entrance are defined once instead of being re-typed at
 * each call site.
 *
 * Behaviour:
 *  - **It grows in on mount** via the one-shot `animate-bar-grow` keyframe (issue #448): the fill
 *    sweeps out from zero to its value rather than appearing fully drawn. A *later* change to
 *    `value` then transitions, as it always did.
 *  - **Reduced motion is handled in CSS, not here.** `animate-bar-grow` and `transition-[width]`
 *    are both neutralised by the global `prefers-reduced-motion` / "Reduce effects" catch-alls,
 *    which clamp them to ~0.01ms — the bar is simply drawn at its value. No JS gate is needed
 *    because there is no static hold to undo; the true width is always the underlying style.
 *  - **It is decorative** (`aria-hidden`), because every call site states the figure the bar
 *    depicts in adjacent text and a screen reader should not hear it twice.
 *
 * Adopted so far by the five report breakdowns only. Several other bars around the app still carry
 * their own markup (`BudgetMeter`, `PickingSection`, `AchievementsScreen`, `StepRail`,
 * `AuditDayDialog`, `StorageTriageDialog`, `LocationFullnessBar`, `LocationTreeItem`) and are
 * candidates to move across — though the ones that carry a `role="progressbar"` would need a
 * labelled variant adding here first, which is deliberately not built until something needs it.
 * Two will not move: the consumable `GaugeBar` must not re-fire an entrance as the virtualised
 * grid recycles its rows, and the spend/sales-over-time strips are vertical columns rather than a
 * fraction-of-a-whole row.
 */
export interface BarProps {
  /**
   * The fill fraction, `0`–`1` (a share of the largest row, of a total). Values outside the range
   * are clamped; a non-finite value is treated as `0`.
   */
  readonly value: number;
  /** Tailwind classes for the fill — a `bg-*` token. Default `bg-primary`. */
  readonly fillClassName?: string;
  readonly 'data-testid'?: string;
}

/** The fill width as a whole-number percentage: clamped to 0–100, floored per {@link MIN_PERCENT}. */
export function barPercent(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(MIN_PERCENT, Math.round(Math.min(1, value) * 100));
}

export function Bar({ value, fillClassName = 'bg-primary', 'data-testid': testId }: BarProps) {
  return (
    <div className="h-2 overflow-hidden rounded-full bg-secondary" aria-hidden="true" data-testid={testId}>
      <div
        className={cn(
          'h-full rounded-full animate-bar-grow transition-[width] duration-500 ease-emphasized',
          fillClassName,
        )}
        style={{ width: `${barPercent(value)}%` }}
      />
    </div>
  );
}
