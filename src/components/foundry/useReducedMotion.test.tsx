import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useReducedMotion, type MediaQueryLike, type MediaQueryProvider } from './useReducedMotion';

afterEach(cleanup);

/** A controllable fake MediaQueryList that can flip `matches` and notify listeners. */
class FakeMedia implements MediaQueryLike {
  matches: boolean;
  private listeners = new Set<() => void>();
  constructor(matches: boolean) {
    this.matches = matches;
  }
  addEventListener(_type: 'change', listener: () => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'change', listener: () => void) {
    this.listeners.delete(listener);
  }
  /** Simulate the OS preference changing. */
  set(matches: boolean) {
    this.matches = matches;
    this.listeners.forEach((l) => l());
  }
}

function provideMedia(media: MediaQueryLike | null): MediaQueryProvider {
  return vi.fn(() => media);
}

describe('useReducedMotion (spec §3 / WCAG 2.3.3)', () => {
  it('reports the initial preference', () => {
    const { result } = renderHook(() => useReducedMotion(provideMedia(new FakeMedia(true))));
    expect(result.current).toBe(true);
  });

  it('reports false when motion is permitted', () => {
    const { result } = renderHook(() => useReducedMotion(provideMedia(new FakeMedia(false))));
    expect(result.current).toBe(false);
  });

  it('updates live when the OS preference changes', () => {
    const media = new FakeMedia(false);
    const { result } = renderHook(() => useReducedMotion(provideMedia(media)));
    expect(result.current).toBe(false);
    act(() => media.set(true));
    expect(result.current).toBe(true);
    act(() => media.set(false));
    expect(result.current).toBe(false);
  });

  it('removes its listener on unmount (no leak)', () => {
    const media = new FakeMedia(true);
    const remove = vi.spyOn(media, 'removeEventListener');
    const { unmount } = renderHook(() => useReducedMotion(provideMedia(media)));
    unmount();
    expect(remove).toHaveBeenCalled();
  });

  it('degrades to false where matchMedia is unavailable (provider returns null)', () => {
    const { result } = renderHook(() => useReducedMotion(provideMedia(null)));
    expect(result.current).toBe(false);
  });
});
