import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { useLabStore } from '@/state/stores/useLabStore';

const checkCriticalSupport = vi.fn(() => ({ supported: true, missing: [] }));
vi.mock('@/lib/env/feature-detection', () => ({
  checkCriticalSupport: () => checkCriticalSupport(),
}));

vi.mock('@/lib/env/support-diagnosis', () => ({
  diagnoseCriticalSupport: () => Promise.resolve({ cause: 'browser-unsupported', missing: [], signals: {} }),
}));

const acquireDatabaseTabLock = vi.fn(() =>
  Promise.resolve({ acquired: true, handle: { release: () => {} } }),
);
vi.mock('@/db/tab-lock', () => ({
  acquireDatabaseTabLock: () => acquireDatabaseTabLock(),
}));

const bootDatabase = vi.fn(() => Promise.resolve({ driver: {}, migration: { from: 0, to: 1, applied: [] } }));
vi.mock('@/db/client', () => ({
  bootDatabase: () => bootDatabase(),
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

afterEach(() => {
  cleanup();
  useLabStore.getState().resetLab();
  checkCriticalSupport.mockClear();
  acquireDatabaseTabLock.mockClear();
  bootDatabase.mockClear();
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
