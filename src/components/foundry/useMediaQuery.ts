/**
 * useMediaQuery / useLargeFormat — a live, reactive read of a CSS media query
 * (spec §2.4.2 canonical page frame; §3 adaptive layout).
 *
 * Generalises the `useReducedMotion` seam: it evaluates an arbitrary media query and
 * re-renders the consumer whenever the match state changes (the device rotates, a
 * foldable unfolds, a window is resized). The `matchMedia` access goes through the same
 * **injectable provider** as `useReducedMotion`, so the hook is component-testable with a
 * fake `MediaQueryList` and never needs a real browser.
 *
 * Most responsive layout should stay declarative — the `large-format:` Tailwind variant
 * (backed by {@link LARGE_FORMAT_QUERY}) covers the common "widen this on a big touch
 * device" case with zero JS. Reach for {@link useLargeFormat} only when a component must
 * change its *structure* (render a different tree, mount a different control), which CSS
 * variants can't express.
 */
import { useEffect, useState } from 'react';
import { COMPACT_LAYOUT_QUERY, LARGE_FORMAT_QUERY } from '@/lib/env/device';
import { useLabFlag } from '@/state/stores/useLabStore';
import { defaultMediaQueryProvider, type MediaQueryProvider } from './useReducedMotion';

/**
 * `true` while `query` currently matches, updating live. Pass a fake `provider` in tests;
 * production callers use the default (feature-detected `matchMedia`). Degrades to `false`
 * where `matchMedia` is unavailable.
 */
export function useMediaQuery(
  query: string,
  provider: MediaQueryProvider = defaultMediaQueryProvider,
): boolean {
  const [matches, setMatches] = useState<boolean>(() => provider(query)?.matches ?? false);

  useEffect(() => {
    const media = provider(query);
    if (!media) {
      setMatches(false);
      return;
    }
    // Sync once in case the value changed between the initial render and this effect.
    setMatches(media.matches);
    const onChange = () => setMatches(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query, provider]);

  return matches;
}

/**
 * `true` on a large-format touch device (tablet / unfolded foldable), updating live as
 * the device folds/unfolds or rotates. The declarative `large-format:` Tailwind variant
 * is preferred for pure styling; use this hook only for structural changes.
 *
 * The `force-large-format` lab flag (`/lab`, hidden testing screen) forces this to `true`
 * regardless of the real query, so the tablet layout can be checked on a desktop — a large
 * window with a fine (mouse) pointer can otherwise never match {@link LARGE_FORMAT_QUERY}.
 */
export function useLargeFormat(provider: MediaQueryProvider = defaultMediaQueryProvider): boolean {
  const matches = useMediaQuery(LARGE_FORMAT_QUERY, provider);
  const forced = useLabFlag('force-large-format');
  return forced || matches;
}

/**
 * `true` on a **compact** viewport — narrower than the tablet floor, per
 * {@link COMPACT_LAYOUT_QUERY} — updating live as the window is resized, the device rotates
 * or the user zooms.
 *
 * This one is a hook rather than a CSS variant on purpose. The master-detail screens move
 * their master pane *into a drawer* here, and a pane can only live in one place at a time:
 * rendering it twice and hiding one copy would duplicate its heading id, its roving-tabindex
 * tree and its virtualiser. That is a **structural** change, which is exactly the case
 * {@link useMediaQuery} exists for; pure styling still belongs in a Tailwind variant.
 */
export function useCompactLayout(provider: MediaQueryProvider = defaultMediaQueryProvider): boolean {
  return useMediaQuery(COMPACT_LAYOUT_QUERY, provider);
}
