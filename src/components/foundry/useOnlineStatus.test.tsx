import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useLabStore } from '@/state/stores/useLabStore';
import { useOnlineStatus, type OnlineStatusApi } from './useOnlineStatus';

afterEach(() => {
  cleanup();
  useLabStore.getState().resetLab();
});

/** A controllable fake seam: flip `online` then call `emit()` to notify subscribers. */
function makeFakeApi(initial: boolean) {
  let online = initial;
  const listeners = new Set<() => void>();
  const api: OnlineStatusApi = {
    isOnline: () => online,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    api,
    set(next: boolean) {
      online = next;
      listeners.forEach((l) => l());
    },
    listenerCount: () => listeners.size,
  };
}

describe('useOnlineStatus — live connectivity (spec §2 offline-first)', () => {
  it('reflects the initial connectivity from the seam', () => {
    const fake = makeFakeApi(false);
    const { result } = renderHook(() => useOnlineStatus(fake.api));
    expect(result.current).toBe(false);
  });

  it('updates when the seam emits a connectivity change', () => {
    const fake = makeFakeApi(true);
    const { result } = renderHook(() => useOnlineStatus(fake.api));
    expect(result.current).toBe(true);
    act(() => fake.set(false));
    expect(result.current).toBe(false);
    act(() => fake.set(true));
    expect(result.current).toBe(true);
  });

  it('unsubscribes from the seam on unmount', () => {
    const fake = makeFakeApi(true);
    const { unmount } = renderHook(() => useOnlineStatus(fake.api));
    expect(fake.listenerCount()).toBe(1);
    unmount();
    expect(fake.listenerCount()).toBe(0);
  });

  it('leaves connectivity untouched with the `force-offline` lab flag off (default)', () => {
    const fake = makeFakeApi(true);
    const { result } = renderHook(() => useOnlineStatus(fake.api));
    expect(result.current).toBe(true);
  });

  it('reports offline while the `force-offline` lab flag is on, even when the real seam is online', () => {
    useLabStore.getState().setFlag('force-offline', true);
    const fake = makeFakeApi(true);
    const { result } = renderHook(() => useOnlineStatus(fake.api));
    expect(result.current).toBe(false);
  });

  it('goes back to reflecting the real seam once the flag is switched off again', () => {
    useLabStore.getState().setFlag('force-offline', true);
    const fake = makeFakeApi(true);
    const { result, rerender } = renderHook(() => useOnlineStatus(fake.api));
    expect(result.current).toBe(false);
    act(() => useLabStore.getState().setFlag('force-offline', false));
    rerender();
    expect(result.current).toBe(true);
  });
});
