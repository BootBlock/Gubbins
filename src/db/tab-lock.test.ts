import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const hasWebLocks = vi.fn(() => true);
vi.mock('@/lib/env/feature-detection', () => ({
  hasWebLocks: () => hasWebLocks(),
}));

import { TAB_LOCK_OVERRIDE_KEY } from '@/lib/storage-keys';
import { acquireDatabaseTabLock, setTabLockOverride } from './tab-lock';

/** Stand-in for `navigator.locks` whose `request` we drive per test. */
function installLockManager(request: (...args: unknown[]) => Promise<unknown>): void {
  Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
}

beforeEach(() => {
  hasWebLocks.mockReturnValue(true);
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe('acquireDatabaseTabLock — the guard fails closed', () => {
  it('denies when the Web Locks API is missing, rather than assuming sole ownership', async () => {
    hasWebLocks.mockReturnValue(false);

    const outcome = await acquireDatabaseTabLock();

    expect(outcome.acquired).toBe(false);
    // Nothing to wait on: with no lock manager there is no release to observe.
    expect(outcome.acquired === false && outcome.reason).toBe('unavailable');
    expect(outcome.acquired === false && outcome.whenReleased).toBeNull();
  });

  it('denies when the lock manager itself errors', async () => {
    installLockManager(() => Promise.reject(new Error('lock manager unavailable')));

    const outcome = await acquireDatabaseTabLock();

    expect(outcome.acquired).toBe(false);
    expect(outcome.acquired === false && outcome.reason).toBe('unavailable');
  });

  it('reports `held` — with a release signal — when another tab owns the database', async () => {
    let releaseOwner: (() => void) | null = null;
    installLockManager((_name, options, callback) => {
      const opts = options as { ifAvailable?: boolean };
      if (opts.ifAvailable) {
        // Owned elsewhere: the browser invokes the callback with a null lock.
        return Promise.resolve((callback as (lock: null) => void)(null));
      }
      // The queued blocking request settles only once the owner goes away.
      return new Promise((resolve) => {
        releaseOwner = () => resolve(undefined);
      });
    });

    const outcome = await acquireDatabaseTabLock();

    expect(outcome.acquired).toBe(false);
    expect(outcome.acquired === false && outcome.reason).toBe('held');

    const whenReleased = outcome.acquired === false ? outcome.whenReleased : null;
    expect(whenReleased).not.toBeNull();

    const settled = vi.fn();
    void whenReleased?.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    releaseOwner?.();
    await whenReleased;
    expect(settled).toHaveBeenCalled();
  });

  it('acquires when the lock is free', async () => {
    installLockManager((_name, _options, callback) =>
      Promise.resolve((callback as (lock: object) => unknown)({})),
    );

    const outcome = await acquireDatabaseTabLock();

    expect(outcome.acquired).toBe(true);
    // Releasing must not throw — it settles the promise that holds the lock open.
    expect(() => outcome.acquired === true && outcome.handle.release()).not.toThrow();
  });
});

describe('acquireDatabaseTabLock — the per-tab override', () => {
  it('lets a tab proceed after the user overrides a missing Web Locks API', async () => {
    hasWebLocks.mockReturnValue(false);
    setTabLockOverride();

    const outcome = await acquireDatabaseTabLock();

    expect(outcome.acquired).toBe(true);
  });

  it('lets a tab proceed after the user overrides a lock-manager error', async () => {
    installLockManager(() => Promise.reject(new Error('lock manager unavailable')));
    setTabLockOverride();

    const outcome = await acquireDatabaseTabLock();

    expect(outcome.acquired).toBe(true);
  });

  it('records the override in sessionStorage only, so it dies with the tab', () => {
    setTabLockOverride();

    expect(sessionStorage.getItem(TAB_LOCK_OVERRIDE_KEY)).toBe('1');
    expect(localStorage.getItem(TAB_LOCK_OVERRIDE_KEY)).toBeNull();
  });
});
