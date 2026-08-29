import { cn } from '@/lib/utils';

/**
 * Foundry Bar — the single, canonical horizontal proportional bar: a rounded track with a tinted
 * fill whose width is a fraction of the whole. It is what every report breakdown draws its rows
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
 *  - **It is decorative by default** (`aria-hidden`), because every call site already states the
 *    figure the bar depicts in adjacent text and a screen reader should not hear it twice. Pass
 *    `label` where the bar is the *only* expression of the value, and it becomes a labelled
 *    `role="progressbar"` reporting a 0–100 percentage instead.
 *
 * Bars that are **not** a fraction-of-a-whole row — the consumable `GaugeBar` (which must not
 * re-fire its entrance as the virtualised grid recycles rows) and the vertical column strips in
 * the spend/sales-over-time charts — deliberately stay on their own markup.
 */
export interface BarProps {
  /**
   * The fill fraction, `0`–`1` (a share of the largest row, of a budget, of a total). Values
   * outside the range are clamped; a non-finite value is treated as `0`.
   */
  readonly value: number;
  /**
   * Floor, in percent, for a *positive* fraction, so a row worth a rounding error still shows a
   * stub of a bar rather than nothing. A fraction of exactly `0` always renders an empty track —
   * "nothing here" must not look like "a little here". Default `2`.
   */
  readonly minPercent?: number;
  /** Tailwind classes for the fill — a `bg-*` token. Default `bg-primary`. */
  readonly fillClassName?: string;
  /** Classes merged onto the track (e.g. a taller `h-3`). */
  readonly className?: string;
  /**
   * Accessible name. Given, the track becomes a `role="progressbar"` announcing the fill as a
   * 0–100 percentage. Omit it for the usual decorative case, where the figure is already in text
   * beside the bar.
   */
  readonly label?: string;
  readonly 'data-testid'?: string;
}

/** The fill width as a whole-number percentage, clamped and floored per {@link BarProps}. */
export function barPercent(value: number, minPercent = 2): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(minPercent, Math.round(Math.min(1, value) * 100));
}

export function Bar({
  value,
  minPercent = 2,
  fillClassName = 'bg-primary',
  className,
  label,
  'data-testid': testId,
}: BarProps) {
  const percent = barPercent(value, minPercent);
  const semantics = label
    ? ({
        role: 'progressbar' as const,
        'aria-label': label,
        'aria-valuenow': percent,
        'aria-valuemin': 0,
        'aria-valuemax': 100,
      } as const)
    : ({ 'aria-hidden': true } as const);

  return (
    <div
      className={cn('h-2 overflow-hidden rounded-full bg-secondary', className)}
      data-testid={testId}
      {...semantics}
    >
      <div
        className={cn(
          'h-full rounded-full animate-bar-grow transition-[width] duration-500 ease-emphasized',
          fillClassName,
        )}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
