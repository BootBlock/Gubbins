import { useEffect, useRef, useState } from 'react';

/** Expo-out easing, matching the shape of the `--ease-emphasized` cubic-bezier. */
function easeOutExpo(t: number): number {
  return t >= 1 ? 1 : 1 - 2 ** (-10 * t);
}

export interface CountUpOptions {
  /** Roll duration in milliseconds. Default 650ms — brisk but legible. */
  readonly durationMs?: number;
  /** Roll up from 0 on first mount too (a "count-in" entrance). Default false. */
  readonly animateOnMount?: boolean;
  /**
   * The user's reduced-motion preference (already resolved by the caller via
   * {@link useReducedMotion}). When `true` the value snaps with no roll — the caller
   * passes it in rather than the hook reading it, so a caller can also force-snap
   * (e.g. a non-animated `<Money>`) by passing `true`.
   */
  readonly reduced: boolean;
}

/**
 * useCountUp — the shared "ticker" engine behind the Foundry roll-up primitives
 * ({@link AnimatedNumber} and the animated `<Money>` variant). Given a target
 * `value`, it returns the figure to paint *now*.
 *
 * Behaviour, and why it is shaped this way (this is the one place the roll lives, so
 * the two primitives can never drift):
 *  - **At rest and on first mount it returns the true value immediately** (unless
 *    `animateOnMount`), so a freshly-loaded screen never flashes `0`, screen-reader
 *    users read the real figure, and synchronous tests see it without a frame loop.
 *  - **A change while mounted rolls** from the previous value to the new one over
 *    `durationMs`, easing on an expo-out curve that mirrors the `--ease-emphasized`
 *    token, landing exactly on the target.
 *  - **Reduced motion (or no rAF) snaps.** When `reduced` is set (or the frame loop
 *    is unavailable, e.g. SSR/jsdom) the value is set instantly with no roll —
 *    belt-and-braces alongside the global CSS reduced-motion catch-all.
 */
export function useCountUp(
  value: number,
  { durationMs = 650, animateOnMount = false, reduced }: CountUpOptions,
): number {
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

  return display;
}
