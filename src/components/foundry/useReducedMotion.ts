/**
 * useReducedMotion — a live, reactive read of the user's reduced-motion preference
 * (spec §3 premium-but-accessible UI; WCAG 2.3.3 Animation from Interactions).
 *
 * Mirrors the `prefers-color-scheme` seam (`useApplyTheme`): it reads the preference
 * and re-renders the consumer if the OS setting changes mid-session. The matchMedia
 * access goes through an **injectable provider** (the `useWakeLock` `apiOverride`
 * pattern) so the hook is component-testable with a fake `MediaQueryList` and never
 * needs a real browser.
 *
 * Foundry primitives use this to drop their decorative entrance animations when the
 * user prefers reduced motion — defence-in-depth alongside the global CSS
 * `@media (prefers-reduced-motion: reduce)` catch-all in `styles/index.css`.
 */
import { useEffect, useState } from 'react';
import { PREFERS_REDUCED_MOTION_QUERY } from '@/lib/env/motion';

/** The slice of `MediaQueryList` the hook depends on (so a fake is trivial). */
export interface MediaQueryLike {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

/** Resolve a media query to an observable `MediaQueryList`, or `null` if unsupported. */
export type MediaQueryProvider = (query: string) => MediaQueryLike | null;

/**
 * One `MediaQueryList` per query string, for the whole document (issue #419).
 *
 * `matchMedia(q)` mints a *new* list object each call: the query is re-parsed and the result
 * registered with the engine's media-query evaluator. That is per-consumer work, and the app has
 * consumers per *row* — a `Tooltip` and a `Menu` inside every item card each ask the same
 * question, so a screen of cards built and threw away dozens of identical lists, and did it again
 * every time the virtualiser recycled a row during a scroll. The lists are immutable handles onto
 * a global fact, so sharing one per query is free: each hook still attaches and detaches its own
 * `change` listener, and the set of distinct queries in the app is a handful of constants.
 */
const mediaQueryCache = new Map<string, MediaQueryLike | null>();

/**
 * The `matchMedia` the cache above was filled from. Nothing replaces `matchMedia` in the browser,
 * but a test suite replaces it constantly — and a cache that outlived the function it was built
 * from would hand one test the previous test's stub. Keying on the function makes the cache say
 * what it actually means: these lists came from *this* `matchMedia`.
 */
let cachedMatchMedia: typeof matchMedia | null = null;

/** Default provider — the real `matchMedia`, feature-detected, one list per distinct query. */
export const defaultMediaQueryProvider: MediaQueryProvider = (query) => {
  const fn = typeof matchMedia === 'function' ? matchMedia : null;
  if (fn !== cachedMatchMedia) {
    mediaQueryCache.clear();
    cachedMatchMedia = fn;
  }
  const cached = mediaQueryCache.get(query);
  if (cached !== undefined) return cached;
  const media = fn ? fn(query) : null;
  mediaQueryCache.set(query, media);
  return media;
};

/**
 * `true` when the user prefers reduced motion, updating live. Pass a fake `provider`
 * in tests; production callers use the default.
 */
export function useReducedMotion(provider: MediaQueryProvider = defaultMediaQueryProvider): boolean {
  const [reduced, setReduced] = useState<boolean>(
    () => provider(PREFERS_REDUCED_MOTION_QUERY)?.matches ?? false,
  );

  useEffect(() => {
    const media = provider(PREFERS_REDUCED_MOTION_QUERY);
    if (!media) return;
    // Sync once in case the value changed between the initial render and this effect.
    setReduced(media.matches);
    const onChange = () => setReduced(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [provider]);

  return reduced;
}
