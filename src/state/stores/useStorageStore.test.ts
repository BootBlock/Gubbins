import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import {
  useStorageStore,
  useStoragePersisted,
  storageWriteGate,
  POLL_INTERVAL_MS,
  WRITE_GATE_MAX_AGE_MS,
} from './useStorageStore';
import { useLabStore } from './useLabStore';
import * as storageApi from '@/features/storage/storage-api';

vi.mock('@/features/storage/storage-api', () => ({
  estimateStorage: vi.fn(async () => ({ usage: 0, quota: 100, ratio: 0, supported: true })),
  isStoragePersisted: vi.fn(async () => true),
  requestPersistentStorage: vi.fn(async () => true),
}));

const estimateStorage = vi.mocked(storageApi.estimateStorage);

/** Make the next `estimate()` report `ratio` of the quota as used. */
function reportRatio(ratio: number): void {
  estimateStorage.mockResolvedValue({ usage: ratio * 100, quota: 100, ratio, supported: true });
}

afterEach(() => {
  cleanup();
  useLabStore.getState().resetLab();
  useStorageStore.getState().stopMonitoring();
});

describe('useStoragePersisted — `storage-persistence-denied` lab flag', () => {
  it('reflects the real persisted state when the flag is off (default)', () => {
    useStorageStore.setState({ persisted: true });
    const { result } = renderHook(() => useStoragePersisted());
    expect(result.current).toBe(true);
  });

  it('reads as not persisted while the flag is on, even though the browser granted it', () => {
    useStorageStore.setState({ persisted: true });
    useLabStore.getState().setFlag('storage-persistence-denied', true);
    const { result } = renderHook(() => useStoragePersisted());
    expect(result.current).toBe(false);
    // The real store value is untouched — only the presentation-facing read is overridden.
    expect(useStorageStore.getState().persisted).toBe(true);
  });

  it('stays false when the flag is on and the browser never granted persistence either', () => {
    useStorageStore.setState({ persisted: false });
    useLabStore.getState().setFlag('storage-persistence-denied', true);
    const { result } = renderHook(() => useStoragePersisted());
    expect(result.current).toBe(false);
  });
});

/**
 * Issue #200: a flat five-minute poll leaves the Hard Stop reading a tier that a bulk write can
 * have invalidated minutes earlier. These cover the two halves of the fix — measuring more often
 * as the ceiling nears, and re-measuring on demand before a bulk write commits.
 */
describe('storage telemetry freshness', () => {
  beforeEach(() => {
    estimateStorage.mockClear();
    reportRatio(0);
    useStorageStore.setState({ tier: 'ok', ratio: 0, lastCheckedAt: 0 });
  });

  it('records when each measurement was taken', async () => {
    expect(useStorageStore.getState().lastCheckedAt).toBe(0);
    await useStorageStore.getState().refresh();
    expect(useStorageStore.getState().lastCheckedAt).toBeGreaterThan(0);
  });

  it('refreshIfStale skips a measurement that is still fresh', async () => {
    await useStorageStore.getState().refresh();
    expect(estimateStorage).toHaveBeenCalledTimes(1);
    await useStorageStore.getState().refreshIfStale(WRITE_GATE_MAX_AGE_MS);
    expect(estimateStorage).toHaveBeenCalledTimes(1);
  });

  it('refreshIfStale re-measures once the reading has aged out', async () => {
    await useStorageStore.getState().refresh();
    useStorageStore.setState({ lastCheckedAt: Date.now() - WRITE_GATE_MAX_AGE_MS - 1 });
    await useStorageStore.getState().refreshIfStale(WRITE_GATE_MAX_AGE_MS);
    expect(estimateStorage).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent refreshes into a single estimate', async () => {
    const store = useStorageStore.getState();
    await Promise.all([store.refresh(), store.refresh(), store.refresh()]);
    expect(estimateStorage).toHaveBeenCalledTimes(1);
  });

  it('polls far more often once usage is near the ceiling than when there is headroom', () => {
    expect(POLL_INTERVAL_MS.ok).toBe(5 * 60 * 1000);
    expect(POLL_INTERVAL_MS.warning).toBeLessThan(POLL_INTERVAL_MS.ok);
    expect(POLL_INTERVAL_MS.critical).toBeLessThan(POLL_INTERVAL_MS.warning);
    expect(POLL_INTERVAL_MS.locked).toBeLessThanOrEqual(POLL_INTERVAL_MS.critical);
  });

  it('does not poison later refreshes when one measurement fails', async () => {
    estimateStorage.mockRejectedValueOnce(new Error('estimate exploded'));
    await expect(useStorageStore.getState().refresh()).rejects.toThrow('estimate exploded');

    // The coalescing slot must have been released, or every later refresh would return the
    // same rejected promise for the rest of the page's life.
    reportRatio(0.5);
    await expect(useStorageStore.getState().refresh()).resolves.toBeUndefined();
    expect(useStorageStore.getState().ratio).toBe(0.5);
  });

  it('keeps polling after a failed measurement', async () => {
    vi.useFakeTimers();
    try {
      estimateStorage.mockRejectedValueOnce(new Error('estimate exploded'));
      useStorageStore.getState().startMonitoring();
      await vi.advanceTimersByTimeAsync(0);
      expect(estimateStorage).toHaveBeenCalledTimes(1);

      // The loop must have re-armed despite the rejection — telemetry is exactly what is
      // needed when things are going wrong.
      reportRatio(0.99);
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS.ok);
      expect(estimateStorage).toHaveBeenCalledTimes(2);
      expect(useStorageStore.getState().tier).toBe('locked');
    } finally {
      useStorageStore.getState().stopMonitoring();
      vi.useRealTimers();
    }
  });

  it('re-schedules the poll at the cadence the latest tier warrants', async () => {
    vi.useFakeTimers();
    try {
      reportRatio(0.99); // locked
      useStorageStore.getState().startMonitoring();
      await vi.advanceTimersByTimeAsync(0);
      expect(useStorageStore.getState().tier).toBe('locked');
      expect(estimateStorage).toHaveBeenCalledTimes(1);

      // The `ok` interval would not have fired yet; the locked one has.
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS.locked);
      expect(estimateStorage).toHaveBeenCalledTimes(2);
    } finally {
      useStorageStore.getState().stopMonitoring();
      vi.useRealTimers();
    }
  });
});

describe('storageWriteGate — the Hard Stop for bulk writes', () => {
  beforeEach(() => {
    estimateStorage.mockClear();
    reportRatio(0);
    useStorageStore.setState({ tier: 'ok', ratio: 0, lastCheckedAt: 0 });
  });

  it('permits the write when a fresh measurement has headroom', async () => {
    await expect(storageWriteGate()).resolves.toBeUndefined();
    expect(estimateStorage).toHaveBeenCalled();
  });

  it('refuses the write when a fresh measurement is at the locked tier', async () => {
    reportRatio(0.99);
    await expect(storageWriteGate()).rejects.toMatchObject({ code: 'WRITE_SUSPENDED' });
  });

  it('re-measures rather than trusting a stale `ok` tier — the bug this fixes', async () => {
    // The store still believes storage is fine, from a reading taken long ago...
    useStorageStore.setState({ tier: 'ok', ratio: 0.1, lastCheckedAt: Date.now() - 5 * 60 * 1000 });
    // ...but the disk has since filled.
    reportRatio(0.99);
    await expect(storageWriteGate()).rejects.toMatchObject({ code: 'WRITE_SUSPENDED' });
  });

  it('does not refuse on a stale `locked` tier that a fresh measurement clears', async () => {
    useStorageStore.setState({ tier: 'locked', ratio: 0.99, lastCheckedAt: Date.now() - 60_000 });
    reportRatio(0.1); // the user has since deleted a great deal
    await expect(storageWriteGate()).resolves.toBeUndefined();
  });
});
