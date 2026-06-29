import { describe, it, expect } from 'vitest';
import { isArchiveDue, ARCHIVE_INTERVAL_MS } from './auto-archive';

describe('isArchiveDue (§2.7 weekly archive cadence, Phase 14)', () => {
  it('is due when the device has never archived', () => {
    expect(isArchiveDue(null, 1_000_000)).toBe(true);
  });

  it('is not due before the interval has elapsed', () => {
    const last = 1_000_000;
    expect(isArchiveDue(last, last + ARCHIVE_INTERVAL_MS - 1)).toBe(false);
  });

  it('is due once the weekly interval has elapsed', () => {
    const last = 1_000_000;
    expect(isArchiveDue(last, last + ARCHIVE_INTERVAL_MS)).toBe(true);
  });
});
