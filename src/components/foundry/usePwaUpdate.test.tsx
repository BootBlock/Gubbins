import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { usePwaUpdate, type PwaUpdateApi, type PwaUpdateHandlers } from './usePwaUpdate';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/**
 * A controllable fake seam: capture the handlers from `register`, expose `emitWaiting()`
 * to simulate a new worker becoming available, and spy on the returned updater plus the
 * active `checkForUpdate` probe.
 */
function makeFakeApi() {
  let handlers: PwaUpdateHandlers | undefined;
  const update = vi.fn(async (_reloadPage?: boolean) => {});
  const checkForUpdate = vi.fn(async () => {});
  let registerCalls = 0;
  const api: PwaUpdateApi = {
    register(h) {
      registerCalls += 1;
      handlers = h;
      return update;
    },
    checkForUpdate,
  };
  return {
    api,
    update,
    checkForUpdate,
    emitWaiting: () => handlers?.onNeedRefresh(),
    registerCalls: () => registerCalls,
  };
}

/** Force `document.visibilityState` for a visibilitychange-driven test. */
function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
}

describe('usePwaUpdate — waiting-worker detection (spec §2 PWA update prompt)', () => {
  it('starts with no refresh pending', () => {
    const fake = makeFakeApi();
    const { result } = renderHook(() => usePwaUpdate(fake.api));
    expect(result.current.needRefresh).toBe(false);
    expect(result.current.updateAvailableSeq).toBe(0);
  });

  it('flags needRefresh when the seam reports a waiting worker', () => {
    const fake = makeFakeApi();
    const { result } = renderHook(() => usePwaUpdate(fake.api));
    act(() => fake.emitWaiting());
    expect(result.current.needRefresh).toBe(true);
  });

  it('update() delegates to the seam updater to apply the waiting worker', async () => {
    const fake = makeFakeApi();
    const { result } = renderHook(() => usePwaUpdate(fake.api));
    act(() => fake.emitWaiting());
    await act(async () => {
      await result.current.update();
    });
    expect(fake.update).toHaveBeenCalledOnce();
  });

  it('registers the service worker only once across re-renders', () => {
    const fake = makeFakeApi();
    const { rerender } = renderHook(() => usePwaUpdate(fake.api));
    rerender();
    rerender();
    expect(fake.registerCalls()).toBe(1);
  });

  it('increments updateAvailableSeq on every waiting-worker notification', () => {
    const fake = makeFakeApi();
    const { result } = renderHook(() => usePwaUpdate(fake.api));
    expect(result.current.updateAvailableSeq).toBe(0);
    act(() => fake.emitWaiting());
    expect(result.current.updateAvailableSeq).toBe(1);
    act(() => fake.emitWaiting());
    expect(result.current.updateAvailableSeq).toBe(2);
    // needRefresh stays true throughout — only the sequence ticks.
    expect(result.current.needRefresh).toBe(true);
  });

  it('actively re-checks for a newer worker on the interval', () => {
    vi.useFakeTimers();
    const fake = makeFakeApi();
    renderHook(() => usePwaUpdate(fake.api, 60_000));
    expect(fake.checkForUpdate).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(fake.checkForUpdate).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(fake.checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it('re-checks when the tab returns to the foreground', () => {
    const fake = makeFakeApi();
    renderHook(() => usePwaUpdate(fake.api, 60_000));
    setVisibility('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(fake.checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it('ignores visibilitychange when the tab becomes hidden', () => {
    const fake = makeFakeApi();
    renderHook(() => usePwaUpdate(fake.api, 60_000));
    setVisibility('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(fake.checkForUpdate).not.toHaveBeenCalled();
  });

  it('cleans up the interval and visibility listener on unmount', () => {
    vi.useFakeTimers();
    const fake = makeFakeApi();
    const { unmount } = renderHook(() => usePwaUpdate(fake.api, 60_000));
    unmount();
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(fake.checkForUpdate).not.toHaveBeenCalled();
    // The listener is gone too, so a post-unmount visibilitychange does nothing.
    setVisibility('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(fake.checkForUpdate).not.toHaveBeenCalled();
  });
});
