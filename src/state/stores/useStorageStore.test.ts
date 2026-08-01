import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import {
  useStorageStore,
  useStoragePersisted,
  storageWriteGate,
  POLL_INTERVAL_MS,
  WRITE_GATE_MAX_AGE_MS,
  EXHAUSTION_RECOVERY_MARGIN_BYTES,
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

/** The quota the headroom cases below measure against — big enough for a GB-scale free-up. */
const TEN_GB = 10 * 1024 * 1024 * 1024;
/** Headroom the estimate is happy about (half the quota — well inside the `ok` tier). */
const FIVE_GB = 5 * 1024 * 1024 * 1024;

/**
 * Make the next `estimate()` report `available` free bytes out of {@link TEN_GB}. The headroom
 * cases are all about a *padded* estimate, so these readings deliberately classify as `ok` — the
 * disagreement between what the browser reports and what the disk does is the whole point.
 */
function reportAvailable(available: number): void {
  const usage = TEN_GB - available;
  estimateStorage.mockResolvedValue({ usage, quota: TEN_GB, ratio: usage / TEN_GB, supported: true });
}

/** Reset the observation-derived half of the tier (issue #504) alongside the measured half. */
function resetStorageState(): void {
  useStorageStore.setState({
    tier: 'ok',
    measuredTier: 'ok',
    exhaustion: null,
    ratio: 0,
    lastCheckedAt: 0,
  });
}

afterEach(() => {
  cleanup();
  useLabStore.getState().resetLab();
  useStorageStore.getState().stopMonitoring();
  resetStorageState();
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
    resetStorageState();
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
    resetStorageState();
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
    useStorageStore.setState({
      tier: 'locked',
      measuredTier: 'locked',
      ratio: 0.99,
      lastCheckedAt: Date.now() - 60_000,
    });
    reportRatio(0.1); // the user has since deleted a great deal
    await expect(storageWriteGate()).resolves.toBeUndefined();
  });

  it('still refuses while a write has provably run out of space, whatever the estimate says', async () => {
    // Issue #504: re-measuring is exactly what *cannot* clear this — the estimate is the thing
    // that was wrong. A bulk write waved through here fails deep inside a transaction instead.
    reportRatio(0.1);
    useStorageStore.getState().reportExhaustion();
    await expect(storageWriteGate()).rejects.toMatchObject({ code: 'WRITE_SUSPENDED' });
  });
});

/**
 * Issue #504: the tier was computed from `navigator.storage.estimate()` alone, so a write that
 * genuinely ran out of space — the one condition the whole storage subsystem exists to handle —
 * left the tier at `ok`: no banner, no Triage, no Hard Stop, and every later write failing.
 */
describe('an observed out-of-space failure', () => {
  beforeEach(() => {
    estimateStorage.mockClear();
    reportRatio(0);
    resetStorageState();
  });

  it('raises the tier to the Hard Stop even while the estimate reports ample headroom', () => {
    useStorageStore.getState().reportExhaustion();
    expect(useStorageStore.getState().tier).toBe('locked');
    // The measurement itself is untouched — the banners need it to explain the disagreement.
    expect(useStorageStore.getState().measuredTier).toBe('ok');
  });

  it('survives the very next measurement, which is the reading that was wrong', async () => {
    useStorageStore.getState().reportExhaustion();
    reportRatio(0.1);
    await useStorageStore.getState().refresh();
    expect(useStorageStore.getState().tier).toBe('locked');
    expect(useStorageStore.getState().measuredTier).toBe('ok');
  });

  it('never lowers a measured tier that is already worse', async () => {
    reportRatio(0.99);
    await useStorageStore.getState().refresh();
    useStorageStore.getState().reportExhaustion();
    expect(useStorageStore.getState().tier).toBe('locked');
  });

  it('re-surfaces the banner even if the user had dismissed the warning one', () => {
    useStorageStore.setState({ warningDismissed: true });
    useStorageStore.getState().reportExhaustion();
    expect(useStorageStore.getState().warningDismissed).toBe(false);
  });

  it('is released by a write that lands, once a measurement has been taken since', async () => {
    useStorageStore.getState().reportExhaustion();
    await useStorageStore.getState().refresh();

    useStorageStore.getState().reportWriteSucceeded();
    expect(useStorageStore.getState().exhaustion).toBeNull();
    expect(useStorageStore.getState().tier).toBe('ok');
  });

  it('is not released by a write that was already in flight when it failed', () => {
    useStorageStore.getState().reportExhaustion();
    // No measurement has completed since, so this write proves nothing about the disk now.
    useStorageStore.getState().reportWriteSucceeded();
    expect(useStorageStore.getState().tier).toBe('locked');
  });

  it('drops back to the measured tier rather than to ok when a write releases it', async () => {
    reportRatio(0.85); // warning
    await useStorageStore.getState().refresh();
    useStorageStore.getState().reportExhaustion();
    await useStorageStore.getState().refresh();
    expect(useStorageStore.getState().tier).toBe('locked');

    useStorageStore.getState().reportWriteSucceeded();
    expect(useStorageStore.getState().tier).toBe('warning');
  });

  it('is released once headroom measurably returns — space freed outside Gubbins', async () => {
    // Nothing inside the app can write while the Hard Stop holds, so without this the user who
    // clears space on the *device* — where the padded estimate never showed pressure in the first
    // place — would have no way out of it.
    reportAvailable(FIVE_GB);
    useStorageStore.getState().reportExhaustion();
    await useStorageStore.getState().refresh();
    expect(useStorageStore.getState().tier).toBe('locked');

    reportAvailable(FIVE_GB + EXHAUSTION_RECOVERY_MARGIN_BYTES + 1);
    await useStorageStore.getState().refresh();
    expect(useStorageStore.getState().exhaustion).toBeNull();
    expect(useStorageStore.getState().tier).toBe('ok');
  });

  it('holds through headroom jitter below the recovery margin', async () => {
    reportAvailable(FIVE_GB);
    useStorageStore.getState().reportExhaustion();
    await useStorageStore.getState().refresh();

    reportAvailable(FIVE_GB + EXHAUSTION_RECOVERY_MARGIN_BYTES);
    await useStorageStore.getState().refresh();
    expect(useStorageStore.getState().tier).toBe('locked');
  });

  it('takes its headroom baseline from a measurement started after the failure', async () => {
    // A refresh already in flight describes the disk *before* the failure. Adopting its (larger)
    // reading as the baseline would set a bar the recovered disk never has to clear.
    reportAvailable(8 * 1024 * 1024 * 1024);
    const inFlight = useStorageStore.getState().refresh();
    useStorageStore.getState().reportExhaustion();
    await inFlight;

    reportAvailable(FIVE_GB);
    await useStorageStore.getState().refresh();
    reportAvailable(FIVE_GB + EXHAUSTION_RECOVERY_MARGIN_BYTES + 1);
    await useStorageStore.getState().refresh();
    expect(useStorageStore.getState().tier).toBe('ok');
  });

  it('cannot be released by headroom the browser does not report', async () => {
    estimateStorage.mockResolvedValue({ usage: 0, quota: 0, ratio: 0, supported: false });
    useStorageStore.getState().reportExhaustion();
    await useStorageStore.getState().refresh();
    await useStorageStore.getState().refresh();
    expect(useStorageStore.getState().tier).toBe('locked');

    // …but a write that lands still speaks for itself.
    useStorageStore.getState().reportWriteSucceeded();
    expect(useStorageStore.getState().tier).toBe('ok');
  });

  it('tightens the running poll at once, rather than waiting out the interval it armed', async () => {
    // Found by driving the real app: the loop picks its cadence from the last *measurement*, and
    // this tier change does not come from one. Left alone it keeps the five minutes an `ok`
    // reading warranted — so the space could come back and the Hard Stop hold for minutes.
    vi.useFakeTimers();
    try {
      reportRatio(0);
      useStorageStore.getState().startMonitoring();
      await vi.advanceTimersByTimeAsync(0);
      expect(useStorageStore.getState().tier).toBe('ok');

      useStorageStore.getState().reportExhaustion();
      await vi.advanceTimersByTimeAsync(0); // let the report's own immediate re-measure settle
      expect(useStorageStore.getState().tier).toBe('locked');
      const measured = estimateStorage.mock.calls.length;

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS.locked);
      expect(estimateStorage.mock.calls.length).toBeGreaterThan(measured);
    } finally {
      useStorageStore.getState().stopMonitoring();
      vi.useRealTimers();
    }
  });

  it('polls at the Hard Stop cadence while it holds, so recovery is noticed quickly', () => {
    useStorageStore.getState().reportExhaustion();
    expect(POLL_INTERVAL_MS[useStorageStore.getState().tier]).toBe(POLL_INTERVAL_MS.locked);
  });
});
