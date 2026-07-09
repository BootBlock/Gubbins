/**
 * useRevealOnScroll — the shared IntersectionObserver engine behind the Foundry scroll-reveal
 * primitive ({@link Reveal}). Given a `reduced`-motion flag it returns a ref to place on the
 * element plus the current `revealed` / `armed` state, so a caller can hold the element in a
 * pending (invisible) state until it scrolls into view, then rise it in once.
 *
 * Behaviour, and why it is shaped this way (this is the one place the reveal lives, so no call
 * site hand-rolls its own observer):
 *  - **Enhance-downward.** The reveal only ever arms when an IntersectionObserver is available
 *    *and* the user permits motion. When it can't (reduced motion, no observer, SSR/jsdom), the
 *    element is `revealed` from the very first paint — content is never gated on JS or on the
 *    observer, and never left stuck invisible.
 *  - **One-shot.** On the first intersection the element reveals and the observer disconnects,
 *    so it never re-hides on scroll-up — this is a one-time entrance, not a scroll-linked toggle.
 *  - **Injectable.** The observer factory is injectable (mirroring the `useReducedMotion`
 *    provider seam) so the hook is component-testable with a fake observer and never needs a
 *    real browser.
 *
 * Reduced motion is *also* handled globally by the `@media (prefers-reduced-motion: reduce)`
 * catch-all in `styles/index.css`; skipping the arm here is belt-and-braces on top of it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** The `IntersectionObserver` slice the hook depends on (so a fake is trivial). */
export type ObserverLike = Pick<IntersectionObserver, 'observe' | 'disconnect'>;

/** Construct an observer for a callback + options — injectable for tests. */
export type IntersectionObserverFactory = (
  callback: IntersectionObserverCallback,
  options?: IntersectionObserverInit,
) => ObserverLike;

/** Default factory — the real `IntersectionObserver`, feature-detected (`null` when absent). */
export const defaultObserverFactory: IntersectionObserverFactory | null =
  typeof IntersectionObserver === 'function'
    ? (callback, options) => new IntersectionObserver(callback, options)
    : null;

/** Reveal a touch before the element is fully on-screen, so it settles as it centres. */
export const DEFAULT_REVEAL_ROOT_MARGIN = '0px 0px -10% 0px';

/** Per-step stagger (ms) and the cap — shares the dashboard tile-cascade cadence. */
export const REVEAL_STAGGER_STEP_MS = 45;
export const REVEAL_STAGGER_CAP = 8;

/** The stagger delay (ms) for a group index, floored at 0 and capped so a long group never lags. */
export function revealStaggerMs(index: number): number {
  return Math.min(Math.max(index, 0), REVEAL_STAGGER_CAP) * REVEAL_STAGGER_STEP_MS;
}

export interface RevealOnScrollOptions {
  /**
   * The user's reduced-motion preference (already resolved by the caller via
   * {@link useReducedMotion}). When `true` the reveal is skipped — the content shows instantly
   * with no transform or delay.
   */
  readonly reduced: boolean;
  /** Injectable observer factory (tests pass a fake). Defaults to the real one, or `null`. */
  readonly observerFactory?: IntersectionObserverFactory | null;
  /** The IntersectionObserver `rootMargin`. Defaults to {@link DEFAULT_REVEAL_ROOT_MARGIN}. */
  readonly rootMargin?: string;
}

export interface RevealState {
  /** Callback ref to place on the element to observe. */
  readonly ref: (el: Element | null) => void;
  /** `true` once the element has scrolled into view (or immediately when not armed). */
  readonly revealed: boolean;
  /**
   * `true` when the reveal is active (an observer is wired and motion is permitted). When
   * `false` the caller must render the content fully visible — the reveal is a pure
   * enhancement layered on top of already-present, readable content.
   */
  readonly armed: boolean;
}

export function useRevealOnScroll({
  reduced,
  observerFactory = defaultObserverFactory,
  rootMargin = DEFAULT_REVEAL_ROOT_MARGIN,
}: RevealOnScrollOptions): RevealState {
  // Whether we can (and should) animate a reveal at all. When we can't, the element paints in
  // its final, visible state from the first frame.
  const canReveal = observerFactory != null && !reduced;

  // Seed `revealed` true when we won't animate, so the first paint is already the visible end
  // state (no flash, never stuck invisible). When we will animate, seed false — the element
  // paints pending (invisible) and the observer flips it on intersection.
  const [revealed, setRevealed] = useState(() => !canReveal);

  const elRef = useRef<Element | null>(null);
  const ref = useCallback((el: Element | null) => {
    elRef.current = el;
  }, []);

  useEffect(() => {
    if (!canReveal || revealed || !observerFactory) return;
    const el = elRef.current;
    if (!el) return;
    const observer = observerFactory(
      (entries) => {
        // One-shot: reveal on first intersection, then stop observing.
        if (entries.some((e) => e.isIntersecting)) {
          setRevealed(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [canReveal, revealed, observerFactory, rootMargin]);

  return { ref, revealed, armed: canReveal };
}
