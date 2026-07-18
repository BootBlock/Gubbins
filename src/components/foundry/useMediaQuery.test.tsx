import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useMediaQuery, useLargeFormat } from './useMediaQuery';
import { LARGE_FORMAT_QUERY } from '@/lib/env/device';
import { useLabStore } from '@/state/stores/useLabStore';
import type { MediaQueryLike, MediaQueryProvider } from './useReducedMotion';

const CLEAN_LAB = { flags: {} } as const;

afterEach(() => {
  cleanup();
  useLabStore.setState(CLEAN_LAB);
});

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
  /** Simulate the device rotating / (un)folding so the match state flips. */
  set(matches: boolean) {
    this.matches = matches;
    this.listeners.forEach((l) => l());
  }
}

function provideMedia(media: MediaQueryLike | null): MediaQueryProvider {
  return vi.fn(() => media);
}

describe('useMediaQuery (spec §2.4.2 / §3)', () => {
  it('reports the initial match state', () => {
    const { result } = renderHook(() =>
      useMediaQuery('(min-width: 900px)', provideMedia(new FakeMedia(true))),
    );
    expect(result.current).toBe(true);
  });

  it('updates live when the query starts/stops matching', () => {
    const media = new FakeMedia(false);
    const { result } = renderHook(() => useMediaQuery('(min-width: 900px)', provideMedia(media)));
    expect(result.current).toBe(false);
    act(() => media.set(true));
    expect(result.current).toBe(true);
    act(() => media.set(false));
    expect(result.current).toBe(false);
  });

  it('removes its listener on unmount (no leak)', () => {
    const media = new FakeMedia(true);
    const remove = vi.spyOn(media, 'removeEventListener');
    const { unmount } = renderHook(() => useMediaQuery('(min-width: 900px)', provideMedia(media)));
    unmount();
    expect(remove).toHaveBeenCalled();
  });

  it('degrades to false where matchMedia is unavailable (provider returns null)', () => {
    const { result } = renderHook(() => useMediaQuery('(min-width: 900px)', provideMedia(null)));
    expect(result.current).toBe(false);
  });
});

describe('useLargeFormat', () => {
  it('resolves the large-format query through the provider', () => {
    const provider = provideMedia(new FakeMedia(true));
    const { result } = renderHook(() => useLargeFormat(provider));
    expect(result.current).toBe(true);
    expect(provider).toHaveBeenCalledWith(LARGE_FORMAT_QUERY);
  });

  it('is false on a standard device', () => {
    const { result } = renderHook(() => useLargeFormat(provideMedia(new FakeMedia(false))));
    expect(result.current).toBe(false);
  });

  describe('force-large-format lab flag (`/lab`, hidden testing screen)', () => {
    it('forces true on a standard (small/fine-pointer) device when the flag is on', () => {
      useLabStore.setState({ flags: { 'force-large-format': true } });
      const { result } = renderHook(() => useLargeFormat(provideMedia(new FakeMedia(false))));
      expect(result.current).toBe(true);
    });

    it('leaves a genuinely large-format device true when the flag is on', () => {
      useLabStore.setState({ flags: { 'force-large-format': true } });
      const { result } = renderHook(() => useLargeFormat(provideMedia(new FakeMedia(true))));
      expect(result.current).toBe(true);
    });

    it('does not affect the real query result when the flag is off (byte-identical baseline)', () => {
      useLabStore.setState({ flags: { 'force-large-format': false } });
      const { result } = renderHook(() => useLargeFormat(provideMedia(new FakeMedia(false))));
      expect(result.current).toBe(false);
    });
  });
});
