import { describe, expect, it } from 'vitest';

import { MS_PER_DAY } from '@/db/repositories/constants';

import { bucketStockAging, parseAcquiredAt, type AgingInput } from './stock-aging';

/** A fixed reference instant for deterministic age maths (2026-06-30T00:00:00Z). */
const NOW = Date.UTC(2026, 5, 30);

/** Build an {@link AgingInput} with sensible defaults overridable per test. */
function makeItem(overrides: Partial<AgingInput> = {}): AgingInput {
  return {
    id: 'i1',
    name: 'Widget',
    quantity: 1,
    unitCost: null,
    lastInboundAt: null,
    acquiredAtMs: null,
    createdAt: NOW,
    ...overrides,
  };
}

/** A reference instant exactly `days` days before {@link NOW}. */
function daysAgo(days: number): number {
  return NOW - days * MS_PER_DAY;
}

describe('parseAcquiredAt', () => {
  it('parses an ISO datetime string', () => {
    expect(parseAcquiredAt('2026-01-15T08:30:00Z')).toBe(Date.parse('2026-01-15T08:30:00Z'));
  });

  it('parses a date-only string', () => {
    expect(parseAcquiredAt('2026-01-15')).toBe(Date.parse('2026-01-15'));
  });

  it('returns null for an empty / whitespace string', () => {
    expect(parseAcquiredAt('')).toBeNull();
    expect(parseAcquiredAt('   ')).toBeNull();
  });

  it('returns null for garbage', () => {
    expect(parseAcquiredAt('not-a-date')).toBeNull();
  });

  it('returns null for null / undefined', () => {
    expect(parseAcquiredAt(null)).toBeNull();
    expect(parseAcquiredAt(undefined)).toBeNull();
  });
});

describe('bucketStockAging — reference precedence', () => {
  it('prefers lastInboundAt over acquiredAtMs and createdAt', () => {
    // lastInboundAt is 10 days old → 0–30 bucket, despite older acquired/created.
    const report = bucketStockAging(
      [
        makeItem({
          lastInboundAt: daysAgo(10),
          acquiredAtMs: daysAgo(200),
          createdAt: daysAgo(400),
        }),
      ],
      NOW,
    );
    expect(report.buckets[0]?.itemCount).toBe(1);
    expect(report.buckets[0]?.label).toBe('0–30 days');
  });

  it('falls back to acquiredAtMs when there is no inbound', () => {
    // acquiredAtMs 60 days old → 31–90 bucket; createdAt is much older but ignored.
    const report = bucketStockAging(
      [makeItem({ lastInboundAt: null, acquiredAtMs: daysAgo(60), createdAt: daysAgo(400) })],
      NOW,
    );
    expect(report.buckets[1]?.label).toBe('31–90 days');
    expect(report.buckets[1]?.itemCount).toBe(1);
  });

  it('falls back to createdAt when neither inbound nor acquired is known', () => {
    const report = bucketStockAging(
      [makeItem({ lastInboundAt: null, acquiredAtMs: null, createdAt: daysAgo(120) })],
      NOW,
    );
    expect(report.buckets[2]?.label).toBe('91–180 days');
    expect(report.buckets[2]?.itemCount).toBe(1);
  });
});

describe('bucketStockAging — default bucketing', () => {
  it('places items in each of the four default buckets with correct counts/quantities/values', () => {
    const report = bucketStockAging(
      [
        makeItem({ id: 'a', lastInboundAt: daysAgo(10), quantity: 2, unitCost: 5 }), // 0–30
        makeItem({ id: 'b', lastInboundAt: daysAgo(60), quantity: 3, unitCost: 10 }), // 31–90
        makeItem({ id: 'c', lastInboundAt: daysAgo(120), quantity: 4, unitCost: 1 }), // 91–180
        makeItem({ id: 'd', lastInboundAt: daysAgo(400), quantity: 5, unitCost: 2 }), // 180+
      ],
      NOW,
    );

    expect(report.buckets).toHaveLength(4);
    expect(report.buckets.map((b) => b.itemCount)).toEqual([1, 1, 1, 1]);
    expect(report.buckets.map((b) => b.quantity)).toEqual([2, 3, 4, 5]);
    expect(report.buckets.map((b) => b.value)).toEqual([10, 30, 4, 10]);

    expect(report.totalQuantity).toBe(14);
    expect(report.totalValue).toBe(54);
  });

  it('treats the bucket upper bounds as inclusive', () => {
    const exactly = (days: number) =>
      bucketStockAging([makeItem({ lastInboundAt: daysAgo(days) })], NOW).buckets;

    // 30 → 0–30, 31 → 31–90, 180 → 91–180, 181 → 180+.
    expect(exactly(30)[0]?.itemCount).toBe(1);
    expect(exactly(31)[1]?.itemCount).toBe(1);
    expect(exactly(180)[2]?.itemCount).toBe(1);
    expect(exactly(181)[3]?.itemCount).toBe(1);
  });
});

describe('bucketStockAging — edge cases', () => {
  it('excludes items with non-positive quantity', () => {
    const report = bucketStockAging(
      [
        makeItem({ id: 'zero', quantity: 0, lastInboundAt: daysAgo(10) }),
        makeItem({ id: 'neg', quantity: -3, lastInboundAt: daysAgo(10) }),
      ],
      NOW,
    );
    expect(report.totalQuantity).toBe(0);
    expect(report.totalValue).toBe(0);
    for (const bucket of report.buckets) expect(bucket.itemCount).toBe(0);
  });

  it('clamps a future reference instant to age 0 (first bucket)', () => {
    const report = bucketStockAging(
      [makeItem({ lastInboundAt: NOW + 5 * MS_PER_DAY })],
      NOW,
    );
    expect(report.buckets[0]?.itemCount).toBe(1);
    expect(report.buckets[0]?.label).toBe('0–30 days');
  });

  it('returns four zeroed buckets for empty input', () => {
    const report = bucketStockAging([], NOW);
    expect(report.buckets).toHaveLength(4);
    expect(report.buckets.map((b) => b.label)).toEqual([
      '0–30 days',
      '31–90 days',
      '91–180 days',
      '180+ days',
    ]);
    for (const bucket of report.buckets) {
      expect(bucket.itemCount).toBe(0);
      expect(bucket.quantity).toBe(0);
      expect(bucket.value).toBe(0);
    }
    expect(report.totalQuantity).toBe(0);
    expect(report.totalValue).toBe(0);
    expect(report.now).toBe(NOW);
  });

  it('reports the open-ended oldest bucket with a null maxDays', () => {
    const report = bucketStockAging([], NOW);
    expect(report.buckets[3]?.maxDays).toBeNull();
    expect(report.buckets[3]?.minDays).toBe(181);
    expect(report.buckets[0]?.minDays).toBe(0);
    expect(report.buckets[0]?.maxDays).toBe(30);
  });
});

describe('bucketStockAging — custom bounds', () => {
  it('generalises to arbitrary sorted bounds (N bounds → N+1 buckets)', () => {
    const report = bucketStockAging(
      [
        makeItem({ id: 'a', lastInboundAt: daysAgo(3) }), // 0–7
        makeItem({ id: 'b', lastInboundAt: daysAgo(10) }), // 8–14
        makeItem({ id: 'c', lastInboundAt: daysAgo(20) }), // 14+
      ],
      NOW,
      [7, 14],
    );
    expect(report.buckets).toHaveLength(3);
    expect(report.buckets.map((b) => b.label)).toEqual(['0–7 days', '8–14 days', '14+ days']);
    expect(report.buckets.map((b) => b.itemCount)).toEqual([1, 1, 1]);
  });

  it('sorts and de-duplicates unsorted/duplicate bounds defensively', () => {
    const report = bucketStockAging([], NOW, [180, 30, 30, 90]);
    expect(report.buckets.map((b) => b.label)).toEqual([
      '0–30 days',
      '31–90 days',
      '91–180 days',
      '180+ days',
    ]);
  });

  it('falls back to the default bounds for an empty bounds list', () => {
    const report = bucketStockAging([], NOW, []);
    expect(report.buckets.map((b) => b.label)).toEqual([
      '0–30 days',
      '31–90 days',
      '91–180 days',
      '180+ days',
    ]);
  });
});
