import { cn } from '@/lib/utils';
import { useCountUp } from './useCountUp';
import { useReducedMotion, type MediaQueryProvider } from './useReducedMotion';

/**
 * Foundry AnimatedNumber — a "ticker" that rolls a figure smoothly up (or down) to its
 * new value instead of snapping (spec §3 "Micro-interactions & Delight"). Used for the
 * dashboard/report stat figures and any headline count, so a value that changes while
 * the user is looking reads as *live* rather than blinking to a new number.
 *
 * The roll itself lives in the shared {@link useCountUp} engine (so this and the animated
 * `<Money>` variant can never drift); this component owns the presentation:
 *  - **At rest and on first mount it shows the true value immediately** (unless
 *    `animateOnMount`), so a freshly-loaded screen never flashes `0`, screen-reader users
 *    read the real figure, and synchronous tests see it without waiting on a frame loop.
 *  - **A change while mounted animates** from the previous value to the new one, then
 *    settles with a brief `animate-count-pop` scale bounce.
 *  - **Reduced motion snaps.** When the user prefers reduced motion (or the frame loop is
 *    unavailable) the value is set instantly with no roll and no pop — belt-and-braces
 *    alongside the global CSS catch-all.
 *
 * The rendered text is the animating figure; at rest that equals the true value, so
 * assistive tech and copy-paste read the real number. There is deliberately no `aria-live`
 * region, so screen readers announce the settled figure when it is navigated to rather than
 * every intermediate tick. `tabular-nums` keeps the width steady as digits roll so
 * surrounding layout never jitters.
 */
export interface AnimatedNumberProps {
  /** The target value to display. A change animates the roll from the previous value. */
  readonly value: number;
  /**
   * Format the (possibly fractional, mid-roll) number to display text. Defaults to a
   * rounded integer with locale grouping. Receives interpolated values during the roll,
   * so a formatter should tolerate non-integers (it is only ever passed the exact `value`
   * at the endpoints).
   */
  readonly format?: (n: number) => string;
  /** Roll duration in milliseconds. Default 650ms — brisk but legible. */
  readonly durationMs?: number;
  /** Roll up from 0 on first mount too (a "count-in" entrance). Default false. */
  readonly animateOnMount?: boolean;
  readonly className?: string;
  readonly 'data-testid'?: string;
  /** Injectable reduced-motion provider (test seam), forwarded to {@link useReducedMotion}. */
  readonly motionProvider?: MediaQueryProvider;
}

/** Default formatter: rounded integer with the runtime locale's grouping. */
function defaultFormat(n: number): string {
  return Math.round(n).toLocaleString();
}

export function AnimatedNumber({
  value,
  format = defaultFormat,
  durationMs = 650,
  animateOnMount = false,
  className,
  'data-testid': testId,
  motionProvider,
}: AnimatedNumberProps) {
  const reduced = useReducedMotion(motionProvider);
  const display = useCountUp(value, { durationMs, animateOnMount, reduced });

  return (
    // `key={value}` remounts the span on each change so the one-shot `animate-count-pop`
    // replays; the rolling `display` lives in the hook's state, so it is unaffected.
    <span
      key={value}
      className={cn('inline-block tabular-nums', !reduced && 'animate-count-pop', className)}
      data-testid={testId}
    >
      {format(display)}
    </span>
  );
}
