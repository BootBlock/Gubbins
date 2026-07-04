import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useReducedMotion, type MediaQueryProvider } from './useReducedMotion';

/**
 * Foundry AnimatedNumber — a "ticker" that rolls a figure smoothly up (or down) to its
 * new value instead of snapping (spec §3 "Micro-interactions & Delight"). Used for the
 * dashboard/report stat figures and any headline count, so a value that changes while
 * the user is looking reads as *live* rather than blinking to a new number.
 *
 * Behaviour, and why it is shaped this way:
 *  - **At rest and on first mount it shows the true value immediately** (unless
 *    `animateOnMount`), so a freshly-loaded screen never flashes `0`, screen-reader users
 *    read the real figure, and synchronous tests see it without waiting on a frame loop.
 *  - **A change while mounted animates** from the previous value to the new one over
 *    `durationMs`, easing on an expo-out curve that mirrors the `--ease-emphasized` token,
 *    then settles with a brief `animate-count-pop` scale bounce.
 *  - **Reduced motion snaps.** When the user prefers reduced motion (or the frame loop is
 *    unavailable, e.g. SSR/jsdom without rAF) the value is set instantly with no roll and
 *    no pop — belt-and-braces alongside the global CSS catch-all.
 *
 * The rendered text is the animating figure; at rest that equals the true value, so
 * assistive tech and copy-paste read the real number. `tabular-nums` keeps the width
 * steady as digits roll so surrounding layout never jitters.
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

/** Expo-out easing, matching the shape of the `--ease-emphasized` cubic-bezier. */
function easeOutExpo(t: number): number {
  return t >= 1 ? 1 : 1 - 2 ** (-10 * t);
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
  // The figure currently painted. Seeded at the true value (or 0 for a count-in) so the
  // first paint is correct without waiting on a frame.
  const [display, setDisplay] = useState(() => (animateOnMount ? 0 : value));
  // Where the last roll ended — the start point for the next one. A ref (not state) so
  // updating it never triggers a render.
  const fromRef = useRef(animateOnMount ? 0 : value);

  useEffect(() => {
    const from = fromRef.current;
    const to = value;
    fromRef.current = to;

    // Snap for reduced-motion, a no-op change, or where rAF is unavailable.
    if (reduced || from === to || typeof requestAnimationFrame !== 'function') {
      setDisplay(to);
      return;
    }

    let raf = 0;
    let start = 0;
    const step = (now: number) => {
      if (start === 0) start = now;
      const t = Math.min(1, (now - start) / durationMs);
      const eased = easeOutExpo(t);
      setDisplay(from + (to - from) * eased);
      if (t < 1) raf = requestAnimationFrame(step);
      else setDisplay(to); // land exactly on the target, never a rounding artefact
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, durationMs, reduced]);

  return (
    // `key={value}` remounts the span on each change so the one-shot `animate-count-pop`
    // replays; the rolling `display` lives in component state, so it is unaffected.
    <span
      key={value}
      className={cn('inline-block tabular-nums', !reduced && 'animate-count-pop', className)}
      data-testid={testId}
    >
      {format(display)}
    </span>
  );
}
