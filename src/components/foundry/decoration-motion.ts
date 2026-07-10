/**
 * decoration-motion — the single "should decorative motion be suppressed?" gate.
 *
 * Two things can turn the app's decorative motion/flair off, and every JS-driven effect must
 * respect *both*:
 *  - the OS `prefers-reduced-motion` setting ({@link useReducedMotion} / {@link prefersReducedMotion});
 *  - the in-app **animation level** (`usePreferencesStore.animationLevel`), the graded scale
 *    (`full` → `balanced` → `calm` → `off` → `headache`) that dials decoration down without forcing
 *    OS-level reduced motion. It supersedes the earlier binary "Reduce effects" switch.
 *
 * Rather than have each effect read both sources and OR them itself — inevitably drifting — they
 * all route through this gate. It is deliberately additive: the pref can only ever suppress *more*
 * motion, never re-enable it, so an OS reduced-motion preference always wins.
 *
 * Two thresholds off the level (encoded once in `theme-registry.ts`):
 *  - **motion** ({@link suppressesMotion}, Calm and calmer) — *all* decorative motion. Read by the
 *    count-up/Money roll (F2), scroll-reveal (F3), and view-transitions (F6).
 *  - **flourish** ({@link suppressesFlourish}, Balanced and calmer) — only the showiest effects.
 *    Read by the milestone burst (F4) and pointer tilt (F7); it is a *subset* of motion, so once
 *    motion is suppressed the flourishes are too.
 *
 * Each threshold has a reactive reader (render-time, mirroring {@link useReducedMotion}) and an
 * imperative one (event-time, mirroring {@link prefersReducedMotion}). The pure-CSS effects
 * (F1/F3/F5/F8/F11) need no reader here — they are gated in `styles/index.css` off the
 * `data-reduce-effects` / `data-anim-level` attributes the apply seam projects from the level.
 */
import { prefersReducedMotion } from '@/lib/env/motion';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { suppressesFlourish, suppressesMotion } from '@/features/settings/theme-registry';
import { useReducedMotion, type MediaQueryProvider } from './useReducedMotion';

/**
 * Reactive gate: `true` when *all* decorative motion should be suppressed — the OS prefers reduced
 * motion, **or** the animation level is Calm or calmer. Re-renders the consumer when either
 * changes. `provider` is the same injectable `matchMedia` seam {@link useReducedMotion} takes
 * (tests pass a fake `MediaQueryList`; the store's `animationLevel` is set directly on the store).
 */
export function useDecorationMotionReduced(provider?: MediaQueryProvider): boolean {
  const osReduced = useReducedMotion(provider);
  const level = usePreferencesStore((s) => s.animationLevel);
  return osReduced || suppressesMotion(level);
}

/**
 * Imperative gate: the same decision as {@link useDecorationMotionReduced}, read live (no
 * subscription) — for event-time callers such as the view-transition seam.
 */
export function decorationMotionReduced(): boolean {
  return prefersReducedMotion() || suppressesMotion(usePreferencesStore.getState().animationLevel);
}

/**
 * Reactive gate for the showiest **flourishes** (success burst F4, pointer tilt F7, and — via CSS
 * — the spotlight sweep F5): `true` when the OS prefers reduced motion, **or** the animation level
 * is Balanced or calmer. A superset of {@link useDecorationMotionReduced} (fires one tier earlier).
 */
export function useDecorationFlourishReduced(provider?: MediaQueryProvider): boolean {
  const osReduced = useReducedMotion(provider);
  const level = usePreferencesStore((s) => s.animationLevel);
  return osReduced || suppressesFlourish(level);
}

/**
 * Imperative flourish gate: the same decision as {@link useDecorationFlourishReduced}, read live.
 */
export function decorationFlourishReduced(): boolean {
  return prefersReducedMotion() || suppressesFlourish(usePreferencesStore.getState().animationLevel);
}
