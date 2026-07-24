/**
 * Issues #157 / #192: the pure "one flag per item" helper shared by every sync write path. See
 * `supplier-part-flags.ts` for why the invariant matters.
 */
import { describe, it, expect } from 'vitest';
import { dedupeSupplierPartFlags, supplierPartFlagClears, flagWinner } from './supplier-part-flags';
import type { SqlRow } from '@/db/rpc/driver';

function part(over: Partial<SqlRow> & { id: string; item_id: string; updated_at: number }): SqlRow {
  return { is_preferred: 0, is_price_source: 0, ...over };
}

describe('dedupeSupplierPartFlags (issues #157 / #192)', () => {
  it('keeps only the newest flagged row per item, clearing the rest', () => {
    const rows = [
      part({ id: 'p1', item_id: 'i1', is_price_source: 1, updated_at: 100 }),
      part({ id: 'p2', item_id: 'i1', is_price_source: 1, updated_at: 200 }),
    ];
    const out = dedupeSupplierPartFlags(rows);
    expect(out.map((r) => [r.id, r.is_price_source])).toEqual([
      ['p1', 0],
      ['p2', 1],
    ]);
  });

  it('breaks a tie by the smaller id', () => {
    const rows = [
      part({ id: 'p-b', item_id: 'i1', is_preferred: 1, updated_at: 5 }),
      part({ id: 'p-a', item_id: 'i1', is_preferred: 1, updated_at: 5 }),
    ];
    const out = new Map(dedupeSupplierPartFlags(rows).map((r) => [r.id, r.is_preferred]));
    expect(out.get('p-a')).toBe(1);
    expect(out.get('p-b')).toBe(0);
  });

  it('treats the two flags and separate items independently', () => {
    const rows = [
      part({ id: 'a1', item_id: 'iA', is_preferred: 1, is_price_source: 1, updated_at: 10 }),
      part({ id: 'a2', item_id: 'iA', is_preferred: 1, updated_at: 20 }), // wins is_preferred for iA
      part({ id: 'a3', item_id: 'iA', is_price_source: 1, updated_at: 30 }), // wins is_price_source for iA
      part({ id: 'b1', item_id: 'iB', is_preferred: 1, updated_at: 1 }), // sole pin for iB — untouched
    ];
    const out = new Map(dedupeSupplierPartFlags(rows).map((r) => [r.id, r]));
    expect(out.get('a1')!.is_preferred).toBe(0);
    expect(out.get('a1')!.is_price_source).toBe(0);
    expect(out.get('a2')!.is_preferred).toBe(1);
    expect(out.get('a3')!.is_price_source).toBe(1);
    expect(out.get('b1')!.is_preferred).toBe(1);
  });

  it('does not mutate the input rows', () => {
    const rows = [
      part({ id: 'p1', item_id: 'i1', is_price_source: 1, updated_at: 100 }),
      part({ id: 'p2', item_id: 'i1', is_price_source: 1, updated_at: 200 }),
    ];
    dedupeSupplierPartFlags(rows);
    expect(rows[0]!.is_price_source).toBe(1); // original still flagged
  });
});

describe('supplierPartFlagClears', () => {
  it('lists one (column, item) per item that keeps a flag', () => {
    const rows = [
      part({ id: 'p1', item_id: 'iA', is_price_source: 1, updated_at: 1 }),
      part({ id: 'p2', item_id: 'iB', is_preferred: 1, updated_at: 1 }),
      part({ id: 'p3', item_id: 'iC', updated_at: 1 }), // unflagged — no clear
    ];
    expect(supplierPartFlagClears(rows).sort((a, b) => a.itemId.localeCompare(b.itemId))).toEqual([
      { column: 'is_price_source', itemId: 'iA' },
      { column: 'is_preferred', itemId: 'iB' },
    ]);
  });
});

describe('flagWinner', () => {
  it('prefers the newer updated_at, else the smaller id', () => {
    expect(flagWinner({ id: 'a', updatedAt: 1 }, { id: 'b', updatedAt: 2 }).id).toBe('b');
    expect(flagWinner({ id: 'b', updatedAt: 5 }, { id: 'a', updatedAt: 5 }).id).toBe('a');
  });
});
