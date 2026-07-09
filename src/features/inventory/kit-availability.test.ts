import { describe, it, expect } from 'vitest';
import { buildableCount } from './kit-availability';

/**
 * Kits v1 — the pure "how many whole kits can I build?" maths. The buildable count is the
 * minimum, over every component, of `floor(stock / qtyPerKit)`; the result also names the
 * scarcest component(s) that pin it. Fully dependency-free, so it is exercised exhaustively
 * here in isolation from the repository and UI.
 */
describe('buildableCount', () => {
  it('takes the minimum over components of floor(stock / qtyPerKit)', () => {
    // bandages: 10/2 = 5, scissors: 3/1 = 3, plasters: 20/5 = 4 → min 3.
    const result = buildableCount([
      { name: 'bandage', quantity: 2, stock: 10 },
      { name: 'scissors', quantity: 1, stock: 3 },
      { name: 'plaster', quantity: 5, stock: 20 },
    ]);
    expect(result.count).toBe(3);
    expect(result.limiting.map((c) => c.name)).toEqual(['scissors']);
  });

  it('reports every component tied for the limiting minimum', () => {
    const result = buildableCount([
      { name: 'a', quantity: 1, stock: 2 },
      { name: 'b', quantity: 2, stock: 4 },
      { name: 'c', quantity: 1, stock: 5 },
    ]);
    // a: 2, b: 2, c: 5 → min 2, tied between a and b.
    expect(result.count).toBe(2);
    expect(result.limiting.map((c) => c.name)).toEqual(['a', 'b']);
  });

  it('is 0 when any component has no stock, naming the missing one', () => {
    const result = buildableCount([
      { name: 'have', quantity: 1, stock: 100 },
      { name: 'missing', quantity: 1, stock: 0 },
    ]);
    expect(result.count).toBe(0);
    expect(result.limiting.map((c) => c.name)).toEqual(['missing']);
  });

  it('is 0 with no limiting components for an empty kit', () => {
    expect(buildableCount([])).toEqual({ count: 0, limiting: [] });
  });

  it('rounds down partial coverage', () => {
    // 7 units, 2 per kit → 3 whole kits (one unit spare).
    const result = buildableCount([{ name: 'x', quantity: 2, stock: 7 }]);
    expect(result.count).toBe(3);
  });

  it('ignores a non-positive quantity rather than dividing by zero', () => {
    // A qty of 0 could never come from the DB (a CHECK forbids it), but the maths must not
    // yield Infinity — the zero-qty line imposes no constraint and the real one wins.
    const result = buildableCount([
      { name: 'bad', quantity: 0, stock: 5 },
      { name: 'real', quantity: 2, stock: 6 },
    ]);
    expect(result.count).toBe(3);
    expect(result.limiting.map((c) => c.name)).toEqual(['real']);
  });
});
