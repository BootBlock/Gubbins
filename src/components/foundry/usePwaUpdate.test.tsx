import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { usePwaUpdate, type PwaUpdateApi, type PwaUpdateHandlers } from './usePwaUpdate';

afterEach(cleanup);

/**
 * A controllable fake seam: capture the handlers from `register`, expose `emitWaiting()`
 * to simulate a new worker becoming available, and spy on the returned updater.
 */
function makeFakeApi() {
  let handlers: PwaUpdateHandlers | undefined;
  const update = vi.fn(async (_reloadPage?: boolean) => {});
  let registerCalls = 0;
  const api: PwaUpdateApi = {
    register(h) {
      registerCalls += 1;
      handlers = h;
      return update;
    },
  };
  return {
    api,
    update,
    emitWaiting: () => handlers?.onNeedRefresh(),
    registerCalls: () => registerCalls,
  };
}

describe('usePwaUpdate — waiting-worker detection (spec §2 PWA update prompt)', () => {
  it('starts with no refresh pending', () => {
    const fake = makeFakeApi();
    const { result } = renderHook(() => usePwaUpdate(fake.api));
    expect(result.current.needRefresh).toBe(false);
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
});
