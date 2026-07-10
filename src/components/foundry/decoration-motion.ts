/**
 * decoration-motion — the single "should decorative motion be suppressed?" gate (visual-flair F9).
 *
 * Two things can turn the app's decorative motion/flair off, and every JS-driven effect must
 * respect *both*:
 *  - the OS `prefers-reduced-motion` setting ({@link useReducedMotion} / {@link prefersReducedMotion});
 *  - the in-app **"Reduce effects"** appearance switch (`usePreferencesStore.reduceEffects`), the
 *    F9 lever that dials decoration down without forcing OS-level reduced motion.
 *
 * Rather than have each effect (view-transitions F6, pointer-tilt F7, the milestone burst F4, the
 * count-up/Money roll F2) read both sources and OR them itself — inevitably drifting — they all
 * route through this one gate. It is deliberately additive: reduce-effects can only ever suppress
 * *more* motion, never re-enable it, so an OS reduced-motion preference always wins.
 *
 * There are two readers, kept in lock-step by a shared meaning:
 *  - {@link useDecorationMotionReduced} — reactive, for render-time decisions (re-renders the
 *    consumer when either source changes), mirroring {@link useReducedMotion}.
 *  - {@link decorationMotionReduced} — imperative, read live at the moment of an action (a click),
 *    mirroring {@link prefersReducedMotion}.
 *
 * The pure-CSS effects (F1/F3/F5/F8) need no reader here — they are gated in `styles/index.css`,
 * whose reduced-motion catch-all is mirrored under `:root[data-reduce-effects]`.
 */
import { prefersReducedMotion } from '@/lib/env/motion';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useReducedMotion, type MediaQueryProvider } from './useReducedMotion';

/**
 * Reactive gate: `true` when decorative motion should be suppressed — the OS prefers reduced
 * motion, **or** the "Reduce effects" switch is on. Re-renders the consumer when either changes.
 * `provider` is the same injectable `matchMedia` seam {@link useReducedMotion} takes (tests pass a
 * fake `MediaQueryList`; the store's `reduceEffects` is set directly on the real store).
 */
export function useDecorationMotionReduced(provider?: MediaQueryProvider): boolean {
  const osReduced = useReducedMotion(provider);
  const reduceEffects = usePreferencesStore((s) => s.reduceEffects);
  return osReduced || reduceEffects;
}

/**
 * Imperative gate: the same decision as {@link useDecorationMotionReduced}, read live (no
 * subscription) — for event-time callers such as the view-transition seam.
 */
export function decorationMotionReduced(): boolean {
  return prefersReducedMotion() || usePreferencesStore.getState().reduceEffects;
}
