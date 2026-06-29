import { describe, it, expect } from 'vitest';
import { buildParentOptions, itemCountMeta, type ParentLocationRow } from './parent-options';

// A plain quantity formatter stand-in (the real one is locale-aware via Intl).
const quantity = (n: number) => String(n);

const rows: ParentLocationRow[] = [
  { id: 'workshop', name: 'Workshop', isSystem: false, itemCount: 5 },
  { id: 'cabinet', name: 'Cabinet', isSystem: false, itemCount: 1 },
  { id: 'empty', name: 'Empty Shelf', isSystem: false, itemCount: 0 },
  { id: 'unassigned', name: 'Unassigned', isSystem: true, itemCount: 3 },
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
});
