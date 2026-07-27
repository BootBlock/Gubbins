import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { useLabStore } from '@/state/stores/useLabStore';

const checkCriticalSupport = vi.fn(() => ({ supported: true, missing: [] as string[] }));
const checkIsolationSupport = vi.fn(() => ({ supported: true, missing: [] as string[] }));
vi.mock('@/lib/env/feature-detection', () => ({
  checkCriticalSupport: () => checkCriticalSupport(),
  checkIsolationSupport: () => checkIsolationSupport(),
}));

const diagnoseCriticalSupport = vi.fn(() =>
  Promise.resolve({ cause: 'browser-unsupported', missing: [], signals: {} }),
);
// `isolationIsSettled` is the real (pure) one: the gate's decision is exactly the pair
// "cause + settled", and mocking half of it would test nothing (issue #255).
vi.mock('@/lib/env/support-diagnosis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/env/support-diagnosis')>()),
  diagnoseCriticalSupport: () => diagnoseCriticalSupport(),
}));

/** Signals for a page a service worker is controlling — i.e. isolation is not coming back. */
const SETTLED = { serviceWorkerApi: true, serviceWorkerActive: true, serviceWorkerControlling: true };

const acquireDatabaseTabLock = vi.fn(() =>
  Promise.resolve({ acquired: true, handle: { release: () => {} } }),
);
vi.mock('@/db/tab-lock', () => ({
  acquireDatabaseTabLock: () => acquireDatabaseTabLock(),
}));

const bootDatabase = vi.fn(() => Promise.resolve({ driver: {}, migration: { from: 0, to: 1, applied: [] } }));
const countStoredItems = vi.fn(() => Promise.resolve(0));
vi.mock('@/db/client', () => ({
  bootDatabase: () => bootDatabase(),
  countStoredItems: () => countStoredItems(),
}));

vi.mock('@/state/stores/useStorageStore', () => ({
  useStorageStore: {
    getState: () => ({
      requestPersistence: () => Promise.resolve(true),
      startMonitoring: () => {},
    }),
  },
  // Boot installs this as the bulk-write Hard Stop (issue #200); the mock only has to exist.
  storageWriteGate: () => Promise.resolve(),
}));

import { useDatabaseBoot } from './useDatabaseBoot';
import { readDbPresence, writeDbPresence } from '@/db/db-presence';

afterEach(() => {
  cleanup();
  localStorage.clear();
  useLabStore.getState().resetLab();
  checkCriticalSupport.mockClear().mockReturnValue({ supported: true, missing: [] });
  checkIsolationSupport.mockClear().mockReturnValue({ supported: true, missing: [] });
  diagnoseCriticalSupport
    .mockClear()
    .mockResolvedValue({ cause: 'browser-unsupported', missing: [], signals: {} });
  acquireDatabaseTabLock.mockClear();
  bootDatabase.mockClear().mockResolvedValue({ driver: {}, migration: { from: 0, to: 1, applied: [] } });
  countStoredItems.mockClear().mockResolvedValue(0);
});

/**
 * Cross-origin isolation is preferred, not required (issue #255): without it the database opens
 * on the `opfs-sahpool` VFS. The gate must therefore let an un-isolated browser *through* — but
 * not while isolation is merely on its way, because the fallback database a premature boot
 * creates is the one this origin would then be stuck with.
 */
describe('useDatabaseBoot — cross-origin isolation is preferred, not required', () => {
  it('boots on the fallback VFS when isolation is settled and not coming', async () => {
    checkIsolationSupport.mockReturnValue({ supported: false, missing: ['SharedArrayBuffer'] });
    diagnoseCriticalSupport.mockResolvedValue({
      cause: 'isolation-blocked',
      missing: [],
      signals: SETTLED,
    });

    const { result } = renderHook(() => useDatabaseBoot());

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(bootDatabase).toHaveBeenCalledTimes(1);
  });

  it('waits instead of booting while the header-injecting worker is still starting up', async () => {
    checkIsolationSupport.mockReturnValue({ supported: false, missing: ['SharedArrayBuffer'] });
    diagnoseCriticalSupport.mockResolvedValue({ cause: 'isolation-pending', missing: [], signals: SETTLED });

    const { result } = renderHook(() => useDatabaseBoot());

    await waitFor(() => expect(result.current.status).toBe('unsupported'));
    expect(bootDatabase).not.toHaveBeenCalled();
  });

  it('waits when a worker exists but has not activated — a slow first install looks identical', async () => {
    // The reading that must NOT commit this origin to the fallback VFS: the probe gives up after
    // a few seconds, which a first visit still precaching the app can easily exceed.
    checkIsolationSupport.mockReturnValue({ supported: false, missing: ['SharedArrayBuffer'] });
    diagnoseCriticalSupport.mockResolvedValue({
      cause: 'isolation-blocked',
      missing: [],
      signals: { serviceWorkerApi: true, serviceWorkerActive: false, serviceWorkerControlling: false },
    });

    const { result } = renderHook(() => useDatabaseBoot());

    await waitFor(() => expect(result.current.status).toBe('unsupported'));
    expect(bootDatabase).not.toHaveBeenCalled();
  });

  it('boots where no service worker exists to supply the headers at all', async () => {
    checkIsolationSupport.mockReturnValue({ supported: false, missing: ['SharedArrayBuffer'] });
    diagnoseCriticalSupport.mockResolvedValue({
      cause: 'isolation-blocked',
      missing: [],
      signals: { serviceWorkerApi: false, serviceWorkerActive: false, serviceWorkerControlling: false },
    });

    const { result } = renderHook(() => useDatabaseBoot());

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(bootDatabase).toHaveBeenCalledTimes(1);
  });

  it('still blocks on a cause no VFS could survive', async () => {
    checkIsolationSupport.mockReturnValue({ supported: false, missing: ['SharedArrayBuffer'] });
    diagnoseCriticalSupport.mockResolvedValue({ cause: 'site-data-blocked', missing: [], signals: SETTLED });

    const { result } = renderHook(() => useDatabaseBoot());

    await waitFor(() => expect(result.current.status).toBe('unsupported'));
    expect(bootDatabase).not.toHaveBeenCalled();
  });

  it('blocks when there is no OPFS at all — the one thing neither VFS can do without', async () => {
    checkCriticalSupport.mockReturnValue({
      supported: false,
      missing: ['Origin Private File System (OPFS)'],
    });

    const { result } = renderHook(() => useDatabaseBoot());

    await waitFor(() => expect(result.current.status).toBe('unsupported'));
    expect(bootDatabase).not.toHaveBeenCalled();
  });
});

/**
 * A database that has vanished must not boot as a silent fresh install (issue #505). The two
 * cases reach this hook identically — nothing was on disk, so a clean v1 was built — and only
 * the marker outside the database can tell them apart.
 */
describe('useDatabaseBoot — a vanished database', () => {
  const SEEN_BEFORE = { version: 1, lastSeenAt: 1, lastKnownItems: 42, unacknowledgedLoss: null } as const;

  it('starts normally on a device that has never held a database', async () => {
    const { result } = renderHook(() => useDatabaseBoot());

    await waitFor(() => expect(result.current.status).toBe('ready'));
    // …and records the boot, so a *later* disappearance is detectable at all.
    expect(readDbPresence()?.lastSeenAt).toBeGreaterThan(0);
  });

  it('stops on the loss notice when a device that had a database had to build a new one', async () => {
    writeDbPresence(SEEN_BEFORE);

    const { result } = renderHook(() => useDatabaseBoot());

    await waitFor(() => expect(result.current.status).toBe('data-lost'));
    expect(result.current.status === 'data-lost' && result.current.loss).toMatchObject({
      lastSeenAt: 1,
      lastKnownItems: 42,
    });
  });

  it('keeps raising the notice until it is acknowledged, not just on the boot that found it', async () => {
    // The boot after the loss opens the empty database the previous one created, so nothing in
    // the migration report says anything is wrong any more.
    bootDatabase.mockResolvedValue({ driver: {}, migration: { from: 1, to: 1, applied: [] } });
    writeDbPresence({
      ...SEEN_BEFORE,
      unacknowledgedLoss: { detectedAt: 2, lastSeenAt: 1, lastKnownItems: 42 },
    });

    const { result } = renderHook(() => useDatabaseBoot());

    await waitFor(() => expect(result.current.status).toBe('data-lost'));
  });

  it('says nothing when the database was simply already there', async () => {
    bootDatabase.mockResolvedValue({ driver: {}, migration: { from: 1, to: 1, applied: [] } });
    writeDbPresence(SEEN_BEFORE);

    const { result } = renderHook(() => useDatabaseBoot());

    await waitFor(() => expect(result.current.status).toBe('ready'));
  });

  it('records how much is here, for the notice a later boot might have to show', async () => {
    countStoredItems.mockResolvedValue(248);

    renderHook(() => useDatabaseBoot());

    await waitFor(() => expect(readDbPresence()?.lastKnownItems).toBe(248));
  });

  it('still starts when the count fails — a figure for next time is not worth a failed boot', async () => {
    countStoredItems.mockRejectedValue(new Error('no such table: items'));

    const { result } = renderHook(() => useDatabaseBoot());

    await waitFor(() => expect(result.current.status).toBe('ready'));
  });
});

describe('useDatabaseBoot — `schema-too-new` lab flag', () => {
  it('boots normally when the flag is off (default)', async () => {
    const { result } = renderHook(() => useDatabaseBoot());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(bootDatabase).toHaveBeenCalledTimes(1);
    expect(acquireDatabaseTabLock).toHaveBeenCalledTimes(1);
  });

  it('presents the schema-too-new error without opening the real database', async () => {
    useLabStore.getState().setFlag('schema-too-new', true);
    const { result } = renderHook(() => useDatabaseBoot());

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.status === 'error' && result.current.error.code).toBe('SCHEMA_TOO_NEW');

    // Nothing on disk was touched: neither the tab lock nor the real database boot ran.
    expect(acquireDatabaseTabLock).not.toHaveBeenCalled();
    expect(bootDatabase).not.toHaveBeenCalled();
  });
});
