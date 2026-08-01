import { afterEach, describe, expect, it, vi } from 'vitest';
import { DbError } from '@/db/errors';
import {
  isStorageExhaustionError,
  reportStorageFailure,
  reportStorageWriteSucceeded,
  setStorageOutcomeObserver,
} from './exhaustion';

/** A `QuotaExceededError` as the browser raises it from an OPFS write. */
function quotaExceeded(): DOMException {
  return new DOMException('The quota has been exceeded.', 'QuotaExceededError');
}

afterEach(() => setStorageOutcomeObserver(null));

/**
 * Issue #504: the tier used to be computed from `navigator.storage.estimate()` alone, so the one
 * condition the whole storage subsystem exists for — a write that genuinely ran out of space —
 * could never trigger it. Recognising that failure is the first half of the fix.
 */
describe('isStorageExhaustionError', () => {
  it('recognises SQLITE_FULL out of the database worker', () => {
    expect(isStorageExhaustionError(new DbError('SQLITE_FULL', 'database or disk is full'))).toBe(true);
  });

  it('recognises a QuotaExceededError from a raw OPFS write', () => {
    expect(isStorageExhaustionError(quotaExceeded())).toBe(true);
  });

  it("recognises SQLite's full-disk wording even when no result code was reported", () => {
    // `mapResultCode` only yields SQLITE_FULL from the numeric code; a driver that reports none
    // leaves the fixed diagnostic string as the only evidence, and it is unambiguous.
    expect(isStorageExhaustionError(new Error('SQLITE error: database or disk is full'))).toBe(true);
  });

  it('unwraps a cause chain, which is how DbError carries the original', () => {
    const wrapped = DbError.fromUnknown(quotaExceeded(), 'UNKNOWN');
    expect(isStorageExhaustionError(wrapped)).toBe(true);
  });

  it('gives up rather than looping on a self-referential cause chain', () => {
    const looping = new Error('nope') as Error & { cause?: unknown };
    looping.cause = looping;
    expect(isStorageExhaustionError(looping)).toBe(false);
  });

  it('does not fire on failures that have nothing to do with space', () => {
    // This raises the Hard Stop, so a false positive suspends every write on the device.
    expect(isStorageExhaustionError(new DbError('SQLITE_BUSY', 'database is locked'))).toBe(false);
    expect(isStorageExhaustionError(new DbError('WORKER_TIMEOUT', 'no answer'))).toBe(false);
    expect(isStorageExhaustionError(new DbError('SQLITE_CONSTRAINT', 'UNIQUE constraint failed'))).toBe(
      false,
    );
    expect(isStorageExhaustionError(new DOMException('gone', 'NotFoundError'))).toBe(false);
    expect(isStorageExhaustionError('database or disk is full')).toBe(false);
    expect(isStorageExhaustionError(null)).toBe(false);
    expect(isStorageExhaustionError(undefined)).toBe(false);
  });
});

describe('the registered outcome observer', () => {
  it('passes on only genuine out-of-space failures', () => {
    const onExhausted = vi.fn();
    setStorageOutcomeObserver({ onExhausted, onWriteSucceeded: vi.fn() });

    reportStorageFailure(new DbError('SQLITE_BUSY', 'database is locked'));
    expect(onExhausted).not.toHaveBeenCalled();

    reportStorageFailure(new DbError('SQLITE_FULL', 'database or disk is full'));
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it('is a no-op with nothing registered, so the Bridge and unit tests are unaffected', () => {
    // The Bridge shares these modules and has neither a quota nor the stores behind the observer.
    expect(() => reportStorageFailure(quotaExceeded())).not.toThrow();
    expect(() => reportStorageWriteSucceeded()).not.toThrow();
  });
});
