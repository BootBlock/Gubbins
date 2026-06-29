import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useWakeLock, type WakeLockApi, type WakeLockSentinelLike } from './useWakeLock';

afterEach(cleanup);

/** A controllable fake wake sentinel that records release() and its listeners. */
class FakeSentinel implements WakeLockSentinelLike {
  released = false;
  private listeners = new Set<() => void>();
  release = vi.fn(async () => {
    this.released = true;
  });
  addEventListener(_type: 'release', listener: () => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'release', listener: () => void) {
    this.listeners.delete(listener);
  }
}

/** Build an injectable fake seam plus the list of sentinels it has handed out. */
function fakeApi(supported = true) {
  const sentinels: FakeSentinel[] = [];
  const api: WakeLockApi = {
    supported,
    request: vi.fn(async () => {
      const sentinel = new FakeSentinel();
      sentinels.push(sentinel);
      return sentinel;
    }),
  };
  return { api, sentinels };
}

/** Flush the hook's fire-and-forget async reconciliation. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useWakeLock (spec §3 kiosk wake lock)', () => {
  it('acquires a screen wake lock when kiosk mode is enabled', async () => {
    const { api, sentinels } = fakeApi();
    renderHook(() => useWakeLock(true, api));
    await flush();
    expect(api.request).toHaveBeenCalledTimes(1);
    expect(sentinels).toHaveLength(1);
    expect(sentinels[0]!.released).toBe(false);
  });

  it('never requests a lock when kiosk mode is off', async () => {
    const { api } = fakeApi();
    renderHook(() => useWakeLock(false, api));
    await flush();
    expect(api.request).not.toHaveBeenCalled();
  });

  it('never requests a lock on an unsupported platform (graceful degradation)', async () => {
    const { api } = fakeApi(false);
    renderHook(() => useWakeLock(true, api));
    await flush();
    expect(api.request).not.toHaveBeenCalled();
  });

  it('releases the held lock when kiosk mode is turned off', async () => {
    const { api, sentinels } = fakeApi();
    const { rerender } = renderHook(({ on }: { on: boolean }) => useWakeLock(on, api), {
      initialProps: { on: true },
    });
    await flush();
    expect(sentinels[0]!.released).toBe(false);

    rerender({ on: false });
    await flush();
    expect(sentinels[0]!.release).toHaveBeenCalled();
    expect(sentinels[0]!.released).toBe(true);
  });

  it('releases the held lock on unmount', async () => {
    const { api, sentinels } = fakeApi();
    const { unmount } = renderHook(() => useWakeLock(true, api));
    await flush();
    unmount();
    await flush();
    expect(sentinels[0]!.released).toBe(true);
  });
});
