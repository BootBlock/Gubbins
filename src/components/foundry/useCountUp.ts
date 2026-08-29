import { useEffect, useRef, useState } from 'react';

/**
 * The expo-out decay constant. Higher means a harder rush at the start and a longer, slower
 * crawl into the target — the "settling" feel the roll is after (issue #448). At `14` the roll
 * is ~91% done a quarter of the way through and spends its whole second half on the last 1%.
 */
const DECAY = 14;

/** Normaliser that makes {@link easeOutExpo} land exactly on 1 at `t === 1`, with no step. */
const DECAY_SCALE = 1 / (1 - 2 ** -DECAY);

/**
 * Expo-out easing, sharing the shape (though not the exact curve) of the `--ease-emphasized`
 * cubic-bezier: near-instant off the mark, then decelerating hard into the target.
 */
function easeOutExpo(t: number): number {
  return t >= 1 ? 1 : (1 - 2 ** (-DECAY * t)) * DECAY_SCALE;
}

/**
 * Default roll duration — brisk but legible, for a figure that changes while the user watches.
 */
export const COUNT_UP_DURATION_MS = 650;

/**
 * Roll duration for a **headline total** — a report or dashboard valuation that counts in as its
 * screen loads and is the thing the eye lands on. Three times {@link COUNT_UP_DURATION_MS}
 * (issue #448): the extra time is nearly all spent in the eased tail, so the figure rushes up and
 * then visibly settles rather than snapping.
 */
export const COUNT_UP_HEADLINE_DURATION_MS = COUNT_UP_DURATION_MS * 3;

/**
 * Whether the ticker has a roll for the settle-pop to land on, this render: always once the
 * component has mounted, and on the very first render only when the figure counts in from zero.
 *
 * Without this the pop plays on a figure that simply *appeared* at its value — and since the pop
 * is now held back by the roll duration (issue #448), that detached bounce lands most of a second
 * after the number has been sitting still. `useRef` rather than state on purpose: the first render
 * must read `false`, and nothing needs re-rendering when it flips.
 */
export function useHasRolled(animateOnMount: boolean): boolean {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  return animateOnMount || mounted.current;
}

export interface CountUpOptions {
  /** Roll duration in milliseconds. Defaults to {@link COUNT_UP_DURATION_MS}. */
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
 *    `durationMs`, easing on a steep expo-out curve, landing exactly on the target.
 *  - **Reduced motion (or no rAF) snaps.** When `reduced` is set (or the frame loop
 *    is unavailable, e.g. SSR/jsdom) the value is set instantly with no roll —
 *    belt-and-braces alongside the global CSS reduced-motion catch-all.
 */
export function useCountUp(
  value: number,
  { durationMs = COUNT_UP_DURATION_MS, animateOnMount = false, reduced }: CountUpOptions,
): number {
  // The figure currently painted. Seeded at the true value (or 0 for a count-in) so the
  // first paint is correct without waiting on a frame.
  const [display, setDisplay] = useState(() => (animateOnMount ? 0 : value));
  // A mirror of the figure last painted, kept in step by `commit` below. It lets the effect read
  // where the display actually is without taking `display` as a dependency, which would restart
  // the roll on every frame it paints.
  const displayRef = useRef(display);

  useEffect(() => {
    /** Paint `n`, and remember it as the point any later roll starts from. */
    const commit = (n: number) => {
      displayRef.current = n;
      setDisplay(n);
    };

    // Start from what is actually on screen, not from where the last roll was *aimed*. Those
    // differ in two cases that both matter: a value that changes mid-roll picks up from the
    // figure the eye can see rather than jumping to the abandoned target, and React's
    // development-only double-invocation of effects — which tears down the first roll before a
    // frame lands — re-runs against an unmoved display instead of against its own target and so
    // no longer snaps. (That snap made the count-in invisible under `npm run dev`.)
    const from = displayRef.current;
    const to = value;

    // Snap for reduced-motion, a no-op change, or where rAF is unavailable.
    if (reduced || from === to || typeof requestAnimationFrame !== 'function') {
      commit(to);
      return;
    }

    let raf = 0;
    // `null`, not `0`: a `0` sentinel is indistinguishable from a genuine timestamp of 0, which
    // would silently swallow the first frame and restart the clock on the second.
    let start: number | null = null;
    const step = (now: number) => {
      if (start === null) start = now;
      const t = Math.min(1, (now - start) / durationMs);
      const eased = easeOutExpo(t);
      commit(from + (to - from) * eased);
      if (t < 1) raf = requestAnimationFrame(step);
      else commit(to); // land exactly on the target, never a rounding artefact
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, durationMs, reduced]);

  return display;
}
