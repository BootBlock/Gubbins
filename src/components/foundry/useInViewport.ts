/**
 * useInViewport — the shared IntersectionObserver engine for **gating work on visibility**,
 * sibling to {@link useRevealOnScroll} (which gates an *entrance animation* on the same signal).
 * Given a ref to place on a container, it reports whether that container is currently on screen
 * — or within {@link DEFAULT_VIEWPORT_MARGIN} of it — so a caller can leave an expensive query
 * idle until the panel it feeds is actually being looked at.
 *
 * Behaviour, and why it is shaped this way:
 *  - **Enhance-downward.** When no IntersectionObserver exists (SSR, an engine without it) the
 *    hook reports `true` from the first render and never changes. Content is never gated on the
 *    observer: a caller falls back to fetching everything, exactly as it did before the gate.
 *    This is *not* the path the unit suite takes — happy-dom defines the constructor but never
 *    delivers an entry, so a screen test has to stub one that does.
 *  - **Not one-shot**, unlike the reveal. A panel that scrolls back out of view reports `false`
 *    again, which is the whole point on a long screen: a query behind an off-screen panel stops
 *    refetching when a write invalidates it, and picks the new figures up when the reader
 *    scrolls back. The reveal is a one-time entrance and must never re-hide, so the two
 *    deliberately differ here rather than sharing one flag.
 *  - **Injectable.** The observer factory is injectable (mirroring the reveal's seam) so the
 *    hook is component-testable with a fake observer and never needs a real browser.
 */
import { useCallback, useEffect, useState } from 'react';
import { defaultObserverFactory, type IntersectionObserverFactory } from './useRevealOnScroll';

/**
 * How far outside the viewport a container still counts as "in view".
 *
 * Deliberately generous: this gate decides when a fetch *starts*, so the query wants a head
 * start on the scroll rather than to begin the instant the panel's top edge appears — otherwise
 * every gated panel greets the reader with a spinner. Roughly one phone-screen of lead-in.
 */
export const DEFAULT_VIEWPORT_MARGIN = '300px 0px';

export interface InViewportOptions {
  /** Injectable observer factory (tests pass a fake). Defaults to the real one, or `null`. */
  readonly observerFactory?: IntersectionObserverFactory | null;
  /** The IntersectionObserver `rootMargin`. Defaults to {@link DEFAULT_VIEWPORT_MARGIN}. */
  readonly rootMargin?: string;
}

export interface InViewportState {
  /** Callback ref to place on the container whose visibility gates the work. */
  readonly ref: (el: Element | null) => void;
  /** `true` while the container is on screen (or always, when there is no observer). */
  readonly inView: boolean;
}

export function useInViewport({
  observerFactory = defaultObserverFactory,
  rootMargin = DEFAULT_VIEWPORT_MARGIN,
}: InViewportOptions = {}): InViewportState {
  // Held in state rather than a ref so the effect below re-runs when the element arrives —
  // a container rendered behind a condition (a module-gated section) mounts after first paint,
  // and a plain ref would leave it unobserved forever.
  const [el, setEl] = useState<Element | null>(null);
  const ref = useCallback((node: Element | null) => setEl(node), []);

  // Seed `true` when we cannot observe, so the caller does all of its work as it did before the
  // gate existed. With an observer, seed `false`: the observer reports the real answer on its
  // first delivery, and starting optimistically would fire every gated query on mount — which
  // is precisely what the gate is for.
  const [inView, setInView] = useState(() => observerFactory == null);

  useEffect(() => {
    if (!observerFactory || !el) return;
    const observer = observerFactory(
      (entries) => {
        // The latest entry wins: a batch can carry several samples for the same element.
        const latest = entries[entries.length - 1];
        if (latest) setInView(latest.isIntersecting);
      },
      { rootMargin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [observerFactory, el, rootMargin]);

  return { ref, inView };
}
