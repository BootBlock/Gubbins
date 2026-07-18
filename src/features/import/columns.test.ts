import { describe, expect, it } from 'vitest';
import { cellAsAmount, cellAsCount, cellAt, headerKey, mapColumns } from './columns';

describe('headerKey', () => {
  it('lower-cases and strips everything that is not a letter or digit', () => {
    expect(headerKey('Unit Cost')).toBe('unitcost');
    expect(headerKey('unit_cost')).toBe('unitcost');
    expect(headerKey('UNIT-COST')).toBe('unitcost');
    expect(headerKey('  Qty.  ')).toBe('qty');
  });

  it('keeps digits, so a numbered header stays distinguishable', () => {
    expect(headerKey('Column 2')).toBe('column2');
  });
});

describe('mapColumns', () => {
  const synonyms = {
    name: ['name', 'description'],
    quantity: ['qty', 'quantity'],
    price: ['price', 'unitcost'],
  } as const;

  it('resolves each logical column to its cell index', () => {
    expect(mapColumns(['Description', 'Qty', 'Unit Cost'], synonyms)).toEqual({
      name: 0,
      quantity: 1,
      price: 2,
    });
  });

  it('omits logical columns nothing matched', () => {
    expect(mapColumns(['Name'], synonyms)).toEqual({ name: 0 });
  });

  it('binds to the leftmost cell when a header is duplicated', () => {
    expect(mapColumns(['Price', 'Qty', 'Unit cost'], synonyms)).toEqual({ price: 0, quantity: 1 });
  });

  it('matches regardless of case, spacing and punctuation', () => {
    expect(mapColumns(['  UNIT_COST '], synonyms)).toEqual({ price: 0 });
  });

  it('returns an empty map for an empty header', () => {
    expect(mapColumns([], synonyms)).toEqual({});
  });
});

describe('cellAt', () => {
  const row = ['  Widget  ', '', '   '];

  it('trims the cell it reads', () => {
    expect(cellAt(row, 0)).toBe('Widget');
  });

  it('is null for an absent column, a blank cell and a whitespace-only cell', () => {
    expect(cellAt(row, undefined)).toBeNull();
    expect(cellAt(row, 1)).toBeNull();
    expect(cellAt(row, 2)).toBeNull();
  });

  it('is null when the row is shorter than the index', () => {
    expect(cellAt(row, 9)).toBeNull();
  });
});

describe('cellAsCount', () => {
  it('reads a plain whole number', () => {
    expect(cellAsCount(['5'], 0, 1)).toBe(5);
  });

  it('reads a grouped figure as written by a spreadsheet', () => {
    expect(cellAsCount(['1,000'], 0, 1)).toBe(1000);
  });

  it('rounds a decimal quantity to the nearest whole', () => {
    expect(cellAsCount(['2.0'], 0, 1)).toBe(2);
    expect(cellAsCount(['2.6'], 0, 1)).toBe(3);
  });

  it('keeps the leading integer of a quantity written with a unit', () => {
    expect(cellAsCount(['3 pcs'], 0, 1)).toBe(3);
    expect(cellAsCount(['10 units'], 0, 1)).toBe(10);
  });

  it('falls back for an absent, blank, unparseable, zero or negative count', () => {
    expect(cellAsCount([], undefined, 7)).toBe(7);
    expect(cellAsCount([''], 0, 7)).toBe(7);
    expect(cellAsCount(['lots'], 0, 7)).toBe(7);
    expect(cellAsCount(['0'], 0, 7)).toBe(7);
    expect(cellAsCount(['-3'], 0, 7)).toBe(7);
  });
});

describe('cellAsAmount', () => {
  it('reads a plain and a currency-prefixed amount', () => {
    expect(cellAsAmount(['12.99'], 0)).toBe(12.99);
    expect(cellAsAmount(['£12.99'], 0)).toBe(12.99);
  });

  it('handles both decimal conventions', () => {
    expect(cellAsAmount(['1,234.56'], 0)).toBe(1234.56);
    expect(cellAsAmount(['1.234,56'], 0)).toBe(1234.56);
  });

  it('accepts zero', () => {
    expect(cellAsAmount(['0'], 0)).toBe(0);
  });

  it('is null for an absent, blank, unparseable or negative amount', () => {
    expect(cellAsAmount([], undefined)).toBeNull();
    expect(cellAsAmount([''], 0)).toBeNull();
    expect(cellAsAmount(['free'], 0)).toBeNull();
    expect(cellAsAmount(['-1.00'], 0)).toBeNull();
  });
});
