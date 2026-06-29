import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BATCH_KEY,
  activeBatches,
  batchIdentityFromKey,
  batchKeyOf,
  isDefaultBatch,
  normaliseBatch,
  planBatchConsumption,
  planBatchSelection,
  sortFefo,
  totalBatched,
  type BatchLine,
} from './batches';

const line = (
  batchKey: string,
  quantity: number,
  expiryDate: number | null = null,
  batchNumber: string | null = null,
  lotNumber: string | null = null,
): BatchLine => ({ batchKey, quantity, expiryDate, batchNumber, lotNumber });

describe('batchKeyOf / normaliseBatch', () => {
  it('maps an all-empty identity to the default (untracked) batch key', () => {
    expect(batchKeyOf({ batchNumber: null, lotNumber: null, expiryDate: null })).toBe(DEFAULT_BATCH_KEY);
    expect(batchKeyOf({ batchNumber: '  ', lotNumber: '', expiryDate: Number.NaN })).toBe(DEFAULT_BATCH_KEY);
    expect(isDefaultBatch(DEFAULT_BATCH_KEY)).toBe(true);
  });

  it('produces a stable, distinct key per identity', () => {
    const a = batchKeyOf({ batchNumber: 'B1', lotNumber: 'L9', expiryDate: 100 });
    const again = batchKeyOf({ batchNumber: ' B1 ', lotNumber: 'L9', expiryDate: 100 });
    const different = batchKeyOf({ batchNumber: 'B1', lotNumber: 'L9', expiryDate: 200 });
    expect(a).toBe(again); // trimmed equal => same key
    expect(a).not.toBe(different);
    expect(isDefaultBatch(a)).toBe(false);
  });

  it('normalises blank attributes and non-finite expiry to null', () => {
    expect(normaliseBatch({ batchNumber: ' ', lotNumber: 'L', expiryDate: Number.POSITIVE_INFINITY })).toEqual({
      batchNumber: null,
      lotNumber: 'L',
      expiryDate: null,
    });
  });
});

describe('sortFefo', () => {
  it('orders by soonest expiry first, untracked (no expiry) last', () => {
    const batches = [line('c', 1, null), line('a', 1, 300), line('b', 1, 100)];
    expect(sortFefo(batches).map((b) => b.batchKey)).toEqual(['b', 'a', 'c']);
  });

  it('breaks ties by batch key and does not mutate the input', () => {
    const batches = [line('y', 1, 100), line('x', 1, 100)];
    const sorted = sortFefo(batches);
    expect(sorted.map((b) => b.batchKey)).toEqual(['x', 'y']);
    expect(batches.map((b) => b.batchKey)).toEqual(['y', 'x']);
  });
});

describe('planBatchConsumption (FEFO)', () => {
  const batches = [line('exp-aug', 5, 200), line('exp-jun', 3, 100), line(DEFAULT_BATCH_KEY, 4, null)];

  it('draws soonest-expiry first, then the untracked remainder', () => {
    expect(planBatchConsumption(batches, 9)).toEqual({
      consumed: [
        { batchKey: 'exp-jun', amount: 3 },
        { batchKey: 'exp-aug', amount: 5 },
        { batchKey: DEFAULT_BATCH_KEY, amount: 1 },
      ],
      shortfall: 0,
    });
  });

  it('stops once satisfied, leaving later batches untouched', () => {
    expect(planBatchConsumption(batches, 2)).toEqual({
      consumed: [{ batchKey: 'exp-jun', amount: 2 }],
      shortfall: 0,
    });
  });

  it('reports a shortfall rather than overdrawing', () => {
    expect(planBatchConsumption(batches, 100)).toEqual({
      consumed: [
        { batchKey: 'exp-jun', amount: 3 },
        { batchKey: 'exp-aug', amount: 5 },
        { batchKey: DEFAULT_BATCH_KEY, amount: 4 },
      ],
      shortfall: 88,
    });
  });

  it('floors and guards the requested amount', () => {
    expect(planBatchConsumption(batches, 2.9)).toEqual({
      consumed: [{ batchKey: 'exp-jun', amount: 2 }],
      shortfall: 0,
    });
    expect(planBatchConsumption(batches, 0)).toEqual({ consumed: [], shortfall: 0 });
    expect(planBatchConsumption(batches, Number.NaN)).toEqual({ consumed: [], shortfall: 0 });
  });
});

describe('batchIdentityFromKey (inverse of batchKeyOf)', () => {
  it('maps the default key to the untracked identity', () => {
    expect(batchIdentityFromKey(DEFAULT_BATCH_KEY)).toEqual({
      batchNumber: null,
      lotNumber: null,
      expiryDate: null,
    });
  });

  it('round-trips every identity batchKeyOf can produce', () => {
    for (const identity of [
      { batchNumber: 'A1', lotNumber: null, expiryDate: null },
      { batchNumber: null, lotNumber: 'L9', expiryDate: null },
      { batchNumber: 'A1', lotNumber: 'L9', expiryDate: 1_700_000_000_000 },
      { batchNumber: null, lotNumber: null, expiryDate: 200 },
    ]) {
      const key = batchKeyOf(identity);
      expect(batchIdentityFromKey(key)).toEqual(identity);
      expect(batchKeyOf(batchIdentityFromKey(key))).toBe(key); // key-stable
    }
  });

  it('degrades a malformed key to the untracked identity rather than throwing', () => {
    expect(batchIdentityFromKey('not-json')).toEqual({
      batchNumber: null,
      lotNumber: null,
      expiryDate: null,
    });
  });
});

describe('planBatchSelection (explicit lot)', () => {
  const batches = [line('A', 5, 100), line('B', 3, 200)];

  it('consumes only the chosen lot, leaving others untouched', () => {
    expect(planBatchSelection(batches, 'B', 2)).toEqual({
      consumed: [{ batchKey: 'B', amount: 2 }],
      shortfall: 0,
    });
  });

  it('caps the take at the lot quantity and reports the unmet remainder as shortfall', () => {
    // Asking 5 of lot B (only 3 there) takes 3 and never spills into lot A.
    expect(planBatchSelection(batches, 'B', 5)).toEqual({
      consumed: [{ batchKey: 'B', amount: 3 }],
      shortfall: 2,
    });
  });

  it('treats an unknown/empty lot as a full shortfall', () => {
    expect(planBatchSelection(batches, 'Z', 4)).toEqual({ consumed: [], shortfall: 4 });
    expect(planBatchSelection([line('A', 0)], 'A', 2)).toEqual({ consumed: [], shortfall: 2 });
  });

  it('floors and guards a non-integer / negative request', () => {
    expect(planBatchSelection(batches, 'A', 2.9)).toEqual({
      consumed: [{ batchKey: 'A', amount: 2 }],
      shortfall: 0,
    });
    expect(planBatchSelection(batches, 'A', -1)).toEqual({ consumed: [], shortfall: 0 });
  });
});

describe('totalBatched / activeBatches', () => {
  const batches = [line('a', 5, 200), line('b', 0, 100), line(DEFAULT_BATCH_KEY, 4, null)];

  it('sums the held quantities', () => {
    expect(totalBatched(batches)).toBe(9);
  });

  it('drops empty batches and orders FEFO', () => {
    expect(activeBatches(batches).map((b) => b.batchKey)).toEqual(['a', DEFAULT_BATCH_KEY]);
  });
});
