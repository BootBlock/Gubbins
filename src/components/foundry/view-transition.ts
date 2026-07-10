/**
 * view-transition — the single gated seam for the View Transitions API (visual-flair F6).
 *
 * The big discrete in-app swaps — top-level route navigations and the inventory density
 * (Visual ↔ Data) restyle — dissolve gracefully via `document.startViewTransition` instead
 * of hard-cutting. This module owns the whole decision in ONE place so route code and the
 * density toggle share it and no call site hand-rolls the feature-detect / reduced-motion /
 * "reduce effects" gate:
 *
 *  - {@link withViewTransition} wraps an imperative DOM update (the density toggle) — it is
 *    the general-purpose seam for any non-route swap.
 *  - {@link resolveRouteViewTransitionTypes} is the router's `defaultViewTransition.types`
 *    function, so *every* navigation (declarative `<Link>` and imperative `navigate`) is
 *    gated through the same predicate at the router level, with no per-screen wiring.
 *  - {@link useViewTransitionsEnabled} is the reactive read for render-time decisions (e.g.
 *    suppressing an entrance animation that would otherwise double up with the cross-fade).
 *
 * **Progressive enhancement.** Where the API is unavailable, or the user prefers reduced
 * motion (or, in future, has turned effects down — see below), the transition is skipped
 * *entirely*: the DOM update runs directly with no cross-fade, falling back to the existing
 * `animate-rise` / list entrances. A transition never traps focus, never swallows the update
 * if it throws or its promises reject, and never leaves the SPA half-transitioned — the
 * update always happens. The CSS side (`::view-transition-*` in `styles/index.css`) carries a
 * belt-and-braces `prefers-reduced-motion` guard on top of this JS skip.
 */
import { flushSync } from 'react-dom';
import { prefersReducedMotion } from '@/lib/env/motion';
import { useReducedMotion } from './useReducedMotion';

/**
 * The named view-transition type applied to route navigations. Not required for the plain
 * root cross-fade (the CSS targets `root` directly), but naming the transition keeps it
 * self-documenting and leaves a hook for future route-specific choreography.
 */
export const ROUTE_VIEW_TRANSITION_TYPE = 'gubbins-route';

/**
 * `true` when this environment supports same-document view transitions. `lib.dom` types
 * `startViewTransition` as always-present, but it is genuinely absent on older browsers and
 * in the (happy-dom / SSR) test environment — so the runtime `typeof` guard is load-bearing.
 */
export function viewTransitionsSupported(): boolean {
  return typeof document !== 'undefined' && typeof document.startViewTransition === 'function';
}

/**
 * The pure gate: should the given reduced-motion state permit a view-transition? Kept pure
 * (state in, boolean out) so the imperative reader ({@link shouldViewTransition}) and the
 * reactive hook ({@link useViewTransitionsEnabled}) can't drift.
 *
 * **F9 seam:** the coming "Reduce effects" appearance switch dials decoration down
 * independent of the OS reduced-motion setting. When it lands it OR's in here — one edit,
 * and every view-transition call site respects it for free.
 */
function computeShouldViewTransition(reduced: boolean): boolean {
  return viewTransitionsSupported() && !reduced;
}

/**
 * Imperative gate — evaluated at the moment of an action (a click). Reads the reduced-motion
 * preference live. Use {@link useViewTransitionsEnabled} for render-time decisions.
 */
export function shouldViewTransition(): boolean {
  return computeShouldViewTransition(prefersReducedMotion());
}

/**
 * Reactive gate for render-time decisions — re-renders the consumer when the reduced-motion
 * preference changes. A screen uses this to drop an entrance animation that would otherwise
 * double up with the cross-fade (see `InventoryScreen`'s density slide).
 */
export function useViewTransitionsEnabled(): boolean {
  return computeShouldViewTransition(useReducedMotion());
}

/**
 * Run `update` (a DOM mutation) inside a view transition when one is warranted, else run it
 * directly. The update is flushed synchronously (`flushSync`) so the transition captures the
 * *settled* new DOM rather than a mid-animation frame.
 *
 * Robustness is the whole point of centralising this:
 *  - If the gate says no (unsupported / reduced motion / effects off) the update runs
 *    directly and no cross-fade is attempted.
 *  - If `startViewTransition` throws synchronously, the update still runs.
 *  - The `ready` / `finished` promises are swallowed so a rejection can never surface as an
 *    unhandled rejection — the update has already happened inside the callback regardless.
 */
export function withViewTransition(update: () => void): void {
  if (!shouldViewTransition()) {
    update();
    return;
  }
  try {
    const transition = document.startViewTransition(() => {
      flushSync(update);
    });
    // Never let a rejected promise become unhandled; the update ran in the callback already.
    void transition.ready?.catch(() => {});
    void transition.finished?.catch(() => {});
  } catch {
    // The API is present but refused to start — fall back so the update is never dropped.
    update();
  }
}

/** The location-change info the router hands the `types` resolver. */
interface RouteChangeInfo {
  readonly pathChanged: boolean;
}

/**
 * The router's `defaultViewTransition.types` resolver. Returning `false` makes TanStack
 * Router run the navigation's DOM update directly (no `startViewTransition`); returning a
 * types array runs the cross-fade. So this is the single ON/OFF lever for *all* route
 * navigation, gated by the same predicate as {@link withViewTransition}.
 *
 * Scoped to **pathname** changes — a screen-to-screen navigation — so an in-screen
 * search/hash-only param update (which keeps its own local swap animation) is not
 * cross-faded.
 */
export function resolveRouteViewTransitionTypes({ pathChanged }: RouteChangeInfo): string[] | false {
  return pathChanged && shouldViewTransition() ? [ROUTE_VIEW_TRANSITION_TYPE] : false;
}
