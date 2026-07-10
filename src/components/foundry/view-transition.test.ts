/**
 * view-transition seam tests. happy-dom has no `startViewTransition`, so the unit suite
 * exercises the progressive-enhancement fall-through (the update runs directly, never via a
 * transition) and — by stubbing the API onto `document` — the enhanced path, including the
 * robustness guarantees: the update still runs when the API throws or its promises reject.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveRouteViewTransitionTypes,
  ROUTE_VIEW_TRANSITION_TYPE,
  shouldViewTransition,
  viewTransitionsSupported,
  withViewTransition,
} from './view-transition';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

// The reduced-motion read is mocked so we can drive both branches without a real matchMedia.
const prefersReducedMotion = vi.fn<() => boolean>(() => false);
vi.mock('@/lib/env/motion', () => ({
  PREFERS_REDUCED_MOTION_QUERY: '(prefers-reduced-motion: reduce)',
  prefersReducedMotion: () => prefersReducedMotion(),
}));

/** Install a fake View Transitions API on `document`, returning the spy + a control handle. */
function stubViewTransitions(
  transition: { ready?: Promise<void>; finished?: Promise<void> } = {
    ready: Promise.resolve(),
    finished: Promise.resolve(),
  },
) {
  const start = vi.fn((cb: () => void) => {
    cb(); // the real API runs the update callback; mirror that so we can assert it ran
    return transition;
  });
  (document as unknown as { startViewTransition?: unknown }).startViewTransition = start;
  return start;
}

afterEach(() => {
  delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
  prefersReducedMotion.mockReset();
  prefersReducedMotion.mockReturnValue(false);
  usePreferencesStore.setState({ reduceEffects: false });
});

describe('viewTransitionsSupported', () => {
  it('is false when the API is absent (happy-dom default)', () => {
    expect(viewTransitionsSupported()).toBe(false);
  });

  it('is true when document exposes startViewTransition', () => {
    stubViewTransitions();
    expect(viewTransitionsSupported()).toBe(true);
  });
});

describe('shouldViewTransition', () => {
  it('is false without the API even when motion is allowed', () => {
    prefersReducedMotion.mockReturnValue(false);
    expect(shouldViewTransition()).toBe(false);
  });

  it('is true with the API and motion allowed', () => {
    stubViewTransitions();
    prefersReducedMotion.mockReturnValue(false);
    expect(shouldViewTransition()).toBe(true);
  });

  it('is false with the API but reduced motion', () => {
    stubViewTransitions();
    prefersReducedMotion.mockReturnValue(true);
    expect(shouldViewTransition()).toBe(false);
  });

  it('is false with the API and OS motion allowed but "Reduce effects" (F9) on', () => {
    stubViewTransitions();
    prefersReducedMotion.mockReturnValue(false);
    usePreferencesStore.setState({ reduceEffects: true });
    // The F9 switch OR's into the shared decoration-motion gate, so the cross-fade is skipped.
    expect(shouldViewTransition()).toBe(false);
  });
});

describe('withViewTransition', () => {
  it('runs the update directly (never via a transition) when the API is absent', () => {
    const update = vi.fn();
    withViewTransition(update);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('runs the update directly and does NOT start a transition under reduced motion', () => {
    const start = stubViewTransitions();
    prefersReducedMotion.mockReturnValue(true);
    const update = vi.fn();

    withViewTransition(update);

    expect(update).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it('starts a transition and runs the update when supported and motion is allowed', () => {
    const start = stubViewTransitions();
    prefersReducedMotion.mockReturnValue(false);
    const update = vi.fn();

    withViewTransition(update);

    expect(start).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('still runs the update when startViewTransition throws', () => {
    const start = vi.fn(() => {
      throw new Error('refused to start');
    });
    (document as unknown as { startViewTransition?: unknown }).startViewTransition = start;
    prefersReducedMotion.mockReturnValue(false);
    const update = vi.fn();

    expect(() => withViewTransition(update)).not.toThrow();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('swallows a rejected ready/finished promise (update already ran)', async () => {
    stubViewTransitions({
      ready: Promise.reject(new Error('skipped')),
      finished: Promise.reject(new Error('skipped')),
    });
    prefersReducedMotion.mockReturnValue(false);
    const update = vi.fn();

    expect(() => withViewTransition(update)).not.toThrow();
    expect(update).toHaveBeenCalledTimes(1);
    // Let the swallowed rejections settle; the test fails on an unhandled rejection otherwise.
    await Promise.resolve();
  });
});

describe('resolveRouteViewTransitionTypes', () => {
  it('returns false (skip) when the pathname did not change', () => {
    stubViewTransitions();
    prefersReducedMotion.mockReturnValue(false);
    expect(resolveRouteViewTransitionTypes({ pathChanged: false })).toBe(false);
  });

  it('returns false (skip) under reduced motion even on a path change', () => {
    stubViewTransitions();
    prefersReducedMotion.mockReturnValue(true);
    expect(resolveRouteViewTransitionTypes({ pathChanged: true })).toBe(false);
  });

  it('returns false (skip) when the API is unavailable', () => {
    prefersReducedMotion.mockReturnValue(false);
    expect(resolveRouteViewTransitionTypes({ pathChanged: true })).toBe(false);
  });

  it('returns the route type on a path change when supported and motion allowed', () => {
    stubViewTransitions();
    prefersReducedMotion.mockReturnValue(false);
    expect(resolveRouteViewTransitionTypes({ pathChanged: true })).toEqual([ROUTE_VIEW_TRANSITION_TYPE]);
  });
});
