import { cn } from '@/lib/utils';
import { COUNT_UP_DURATION_MS, useCountUp, useHasRolled } from './useCountUp';
import { type MediaQueryProvider } from './useReducedMotion';
import { useDecorationMotionReduced } from './decoration-motion';

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
 *    settles with a brief `animate-count-pop` scale bounce — the pop is delayed by the roll
 *    duration so it lands *as* the figure arrives, not while it is still climbing. A figure that
 *    merely appeared at its value, with no roll behind it, does not pop at all.
 *  - **Reduced motion snaps.** When decorative motion is suppressed (OS reduced-motion OR the
 *    F9 "Reduce effects" switch, or the frame loop is unavailable) the value is set instantly
 *    with no roll and no pop — belt-and-braces alongside the global CSS catch-all.
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
  /**
   * Roll duration in milliseconds. Defaults to {@link COUNT_UP_DURATION_MS}; pass
   * `COUNT_UP_HEADLINE_DURATION_MS` for a headline total that counts in as its screen loads.
   */
  readonly durationMs?: number;
  /** Roll up from 0 on first mount too (a "count-in" entrance). Default false. */
  readonly animateOnMount?: boolean;
  readonly className?: string;
  readonly 'data-testid'?: string;
  /** Injectable reduced-motion provider (test seam), forwarded to the decoration-motion gate. */
  readonly motionProvider?: MediaQueryProvider;
}

/** Default formatter: rounded integer with the runtime locale's grouping. */
function defaultFormat(n: number): string {
  return Math.round(n).toLocaleString();
}

export function AnimatedNumber({
  value,
  format = defaultFormat,
  durationMs = COUNT_UP_DURATION_MS,
  animateOnMount = false,
  className,
  'data-testid': testId,
  motionProvider,
}: AnimatedNumberProps) {
  const reduced = useDecorationMotionReduced(motionProvider);
  const display = useCountUp(value, { durationMs, animateOnMount, reduced });
  // The pop is a settle, so it belongs only to a roll that actually ran. The hook is called
  // unconditionally — `reduced` gates the result, never the call.
  const rolled = useHasRolled(animateOnMount);
  const pop = !reduced && rolled;

  return (
    // `key={value}` remounts the span on each change so the one-shot `animate-count-pop`
    // replays; the rolling `display` lives in the hook's state, so it is unaffected. The pop is
    // held back by `durationMs` so it fires at the end of the roll (`animate-count-pop` has no
    // fill mode, so nothing is applied while it waits).
    <span
      key={value}
      className={cn('inline-block tabular-nums', pop && 'animate-count-pop', className)}
      style={pop ? { animationDelay: `${durationMs}ms` } : undefined}
      data-testid={testId}
    >
      {format(display)}
    </span>
  );
}
