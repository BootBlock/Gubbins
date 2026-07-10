/**
 * decoration-motion gate tests. The module's whole point is that the two ways to turn decoration
 * off — the OS `prefers-reduced-motion` setting and the in-app **animation level** — OR together,
 * across two thresholds: *motion* (Calm and calmer) and the earlier *flourish* tier (Balanced and
 * calmer). These tests pin that truth table down for both the reactive hooks and the imperative
 * readers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import {
  decorationMotionReduced,
  decorationFlourishReduced,
  useDecorationMotionReduced,
  useDecorationFlourishReduced,
} from './decoration-motion';
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
  usePreferencesStore.setState({ animationLevel: 'full' });
});
afterEach(() => {
  cleanup();
  usePreferencesStore.setState({ animationLevel: 'full' });
});

describe('decorationMotionReduced (imperative, motion tier = Calm and calmer)', () => {
  it('is false at the Full level with the OS allowing motion', () => {
    expect(decorationMotionReduced()).toBe(false);
  });

  it('is false at Balanced — that tier only drops flourishes, not all motion', () => {
    usePreferencesStore.setState({ animationLevel: 'balanced' });
    expect(decorationMotionReduced()).toBe(false);
  });

  it('is true at Calm (and calmer)', () => {
    usePreferencesStore.setState({ animationLevel: 'calm' });
    expect(decorationMotionReduced()).toBe(true);
    usePreferencesStore.setState({ animationLevel: 'headache' });
    expect(decorationMotionReduced()).toBe(true);
  });

  it('is true when the OS prefers reduced motion even at Full — the OR', () => {
    prefersReducedMotion.mockReturnValue(true);
    expect(decorationMotionReduced()).toBe(true);
  });
});

describe('decorationFlourishReduced (imperative, flourish tier = Balanced and calmer)', () => {
  it('is false only at Full', () => {
    expect(decorationFlourishReduced()).toBe(false);
  });

  it('is true from Balanced onwards (one tier earlier than motion)', () => {
    usePreferencesStore.setState({ animationLevel: 'balanced' });
    expect(decorationFlourishReduced()).toBe(true);
    usePreferencesStore.setState({ animationLevel: 'calm' });
    expect(decorationFlourishReduced()).toBe(true);
  });

  it('is true when the OS prefers reduced motion even at Full — the OR', () => {
    prefersReducedMotion.mockReturnValue(true);
    expect(decorationFlourishReduced()).toBe(true);
  });
});

describe('useDecorationMotionReduced (reactive)', () => {
  it('ORs the injected reduced-motion read with the Calm-and-calmer threshold', () => {
    const a = renderHook(() => useDecorationMotionReduced(provide(false)));
    expect(a.result.current).toBe(false);
    a.unmount();

    // Balanced does not reduce *all* motion.
    usePreferencesStore.setState({ animationLevel: 'balanced' });
    const b = renderHook(() => useDecorationMotionReduced(provide(false)));
    expect(b.result.current).toBe(false);
    b.unmount();

    // Calm does.
    usePreferencesStore.setState({ animationLevel: 'calm' });
    const c = renderHook(() => useDecorationMotionReduced(provide(false)));
    expect(c.result.current).toBe(true);
    c.unmount();

    // OS prefers reduced motion, level Full → reduced (the OS side alone gates decoration).
    usePreferencesStore.setState({ animationLevel: 'full' });
    const d = renderHook(() => useDecorationMotionReduced(provide(true)));
    expect(d.result.current).toBe(true);
  });
});

describe('useDecorationFlourishReduced (reactive)', () => {
  it('fires one tier earlier than the motion gate (Balanced)', () => {
    const a = renderHook(() => useDecorationFlourishReduced(provide(false)));
    expect(a.result.current).toBe(false);
    a.unmount();

    usePreferencesStore.setState({ animationLevel: 'balanced' });
    const b = renderHook(() => useDecorationFlourishReduced(provide(false)));
    expect(b.result.current).toBe(true);
  });
});
