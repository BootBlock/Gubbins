/**
 * decoration-motion gate tests (visual-flair F9). The whole point of the module is that the two
 * ways to turn decoration off — the OS `prefers-reduced-motion` setting and the in-app "Reduce
 * effects" switch — OR together, so both the reactive hook and the imperative reader see the
 * combined result. These tests pin that truth table down.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { decorationMotionReduced, useDecorationMotionReduced } from './decoration-motion';
import type { MediaQueryLike, MediaQueryProvider } from './useReducedMotion';
import { PREFERS_REDUCED_MOTION_QUERY } from '@/lib/env/motion';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

// The imperative reader calls `prefersReducedMotion()` from this module; mock it so the OS side is
// controllable without a real matchMedia. (The reactive hook uses an injected provider instead.)
const prefersReducedMotion = vi.fn<() => boolean>(() => false);
vi.mock('@/lib/env/motion', () => ({
  PREFERS_REDUCED_MOTION_QUERY: '(prefers-reduced-motion: reduce)',
  prefersReducedMotion: () => prefersReducedMotion(),
}));

/** A minimal static MediaQueryList fake for the reactive hook's reduced-motion read. */
class FakeMedia implements MediaQueryLike {
  constructor(public matches: boolean) {}
  addEventListener() {}
  removeEventListener() {}
}

/** A provider answering the reduced-motion query with `reduced`. */
function provide(reduced: boolean): MediaQueryProvider {
  return vi.fn((query: string) =>
    query === PREFERS_REDUCED_MOTION_QUERY ? new FakeMedia(reduced) : new FakeMedia(false),
  );
}

beforeEach(() => {
  prefersReducedMotion.mockReset();
  prefersReducedMotion.mockReturnValue(false);
  usePreferencesStore.setState({ reduceEffects: false });
});
afterEach(() => {
  cleanup();
  usePreferencesStore.setState({ reduceEffects: false });
});

describe('decorationMotionReduced (imperative)', () => {
  it('is false when neither the OS nor the "Reduce effects" pref asks to reduce', () => {
    expect(decorationMotionReduced()).toBe(false);
  });

  it('is true when the OS prefers reduced motion (pref off)', () => {
    prefersReducedMotion.mockReturnValue(true);
    expect(decorationMotionReduced()).toBe(true);
  });

  it('is true when "Reduce effects" is on even though the OS allows motion — the F9 OR', () => {
    usePreferencesStore.setState({ reduceEffects: true });
    expect(decorationMotionReduced()).toBe(true);
  });

  it('is true when both ask to reduce', () => {
    prefersReducedMotion.mockReturnValue(true);
    usePreferencesStore.setState({ reduceEffects: true });
    expect(decorationMotionReduced()).toBe(true);
  });
});

describe('useDecorationMotionReduced (reactive)', () => {
  it('ORs the injected reduced-motion read with the "Reduce effects" pref', () => {
    // OS motion allowed, pref off → not reduced.
    const a = renderHook(() => useDecorationMotionReduced(provide(false)));
    expect(a.result.current).toBe(false);
    a.unmount();

    // OS motion allowed but "Reduce effects" on → reduced (the pref alone gates decoration).
    usePreferencesStore.setState({ reduceEffects: true });
    const b = renderHook(() => useDecorationMotionReduced(provide(false)));
    expect(b.result.current).toBe(true);
    b.unmount();

    // OS prefers reduced motion, pref off → reduced (the OS side alone gates decoration).
    usePreferencesStore.setState({ reduceEffects: false });
    const c = renderHook(() => useDecorationMotionReduced(provide(true)));
    expect(c.result.current).toBe(true);
  });
});
