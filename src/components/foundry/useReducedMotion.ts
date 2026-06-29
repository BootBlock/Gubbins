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

/** Default provider — the real `matchMedia`, feature-detected. */
export const defaultMediaQueryProvider: MediaQueryProvider = (query) =>
  typeof matchMedia === 'function' ? matchMedia(query) : null;

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
