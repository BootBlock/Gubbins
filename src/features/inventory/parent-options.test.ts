import { describe, it, expect } from 'vitest';
import {
  buildItemLocationOptions,
  buildParentOptions,
  itemCountMeta,
  type ParentLocationRow,
} from './parent-options';

// A plain quantity formatter stand-in (the real one is locale-aware via Intl).
const quantity = (n: number) => String(n);

const rows: ParentLocationRow[] = [
  { id: 'workshop', name: 'Workshop', isSystem: false, itemCount: 5, color: 'teal' },
  { id: 'cabinet', name: 'Cabinet', isSystem: false, itemCount: 1, color: null },
  { id: 'empty', name: 'Empty Shelf', isSystem: false, itemCount: 0, color: null },
  { id: 'unassigned', name: 'Unassigned', isSystem: true, itemCount: 3, color: null },
];

describe('itemCountMeta', () => {
  it('shows a terse dash for an empty location', () => {
    expect(itemCountMeta(0, quantity)).toBe('-');
  });

  it('uses the singular for exactly one item', () => {
    expect(itemCountMeta(1, quantity)).toBe('1 item');
  });

  it('uses the plural and the formatter for many items', () => {
    expect(itemCountMeta(12500, (n) => n.toLocaleString('en-GB'))).toBe('12,500 items');
  });
});

describe('buildParentOptions', () => {
  it('leads with a "top level" row that has no count hint', () => {
    const [first] = buildParentOptions(rows, quantity);
    expect(first).toEqual({ value: '', label: '— Top level —' });
  });

  it('includes user locations with their item-count hints ("-" for empty)', () => {
    const opts = buildParentOptions(rows, quantity);
    expect(opts.map((o) => [o.value, o.meta])).toEqual([
      ['', undefined],
      ['workshop', '5 items'],
      ['cabinet', '1 item'],
      ['empty', '-'],
    ]);
  });

  it('never offers a system location as a parent', () => {
    const opts = buildParentOptions(rows, quantity);
    expect(opts.some((o) => o.value === 'unassigned')).toBe(false);
  });

  it('drops excluded ids (self + descendants when re-parenting)', () => {
    const opts = buildParentOptions(rows, quantity, new Set(['workshop', 'cabinet']));
    expect(opts.map((o) => o.value)).toEqual(['', 'empty']);
  });

  it('tints a coloured location and leaves an uncoloured one undefined', () => {
    const opts = buildParentOptions(rows, quantity);
    expect(opts.find((o) => o.value === 'workshop')?.colorClass).toBe('text-loc-teal');
    expect(opts.find((o) => o.value === 'cabinet')?.colorClass).toBeUndefined();
  });
});

describe('buildItemLocationOptions', () => {
  it('lists every location (incl. system) with no "top level" row', () => {
    const opts = buildItemLocationOptions(rows, quantity);
    expect(opts.map((o) => o.value)).toEqual(['workshop', 'cabinet', 'empty', 'unassigned']);
    expect(opts.some((o) => o.value === '')).toBe(false);
  });

  it('carries the colour tint and count hint', () => {
    const opts = buildItemLocationOptions(rows, quantity);
    expect(opts[0]).toMatchObject({ value: 'workshop', meta: '5 items', colorClass: 'text-loc-teal' });
  });
});
