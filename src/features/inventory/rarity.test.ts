import { describe, it, expect } from 'vitest';
import type { Item } from '@/db/repositories';
import { RARITY_IDS, itemCollectionValue, itemRarity } from './rarity';

/**
 * Unit tests for the pure "Collector cards" rarity seam. `itemRarity` reads only a handful of
 * value/quantity fields, so the fixture supplies just those (cast through a partial) — the rest of
 * the {@link Item} shape is irrelevant to the tier maths.
 */
const item = (over: Partial<Item>): Item => ({ quantity: 1, isUnlimited: false, ...over }) as Item;

describe('itemCollectionValue', () => {
  it('is per-unit value × quantity (current value winning over unit cost)', () => {
    expect(itemCollectionValue(item({ unitCost: 10, quantity: 3 }))).toBe(30);
    // A manual current/market value wins over the replacement unit cost.
    expect(itemCollectionValue(item({ unitCost: 10, currentValue: 40, quantity: 2 }))).toBe(80);
  });

  it('values an unlimited-supply item per single unit (its quantity is meaningless)', () => {
    expect(itemCollectionValue(item({ unitCost: 500, quantity: 999, isUnlimited: true }))).toBe(500);
  });

  it('is 0 for an unpriced, negative or non-finite per-unit value', () => {
    expect(itemCollectionValue(item({ unitCost: null, currentValue: null }))).toBe(0);
    expect(itemCollectionValue(item({ unitCost: -5, quantity: 4 }))).toBe(0);
    expect(itemCollectionValue(item({ unitCost: Number.NaN, quantity: 4 }))).toBe(0);
  });

  it('never goes negative for a negative quantity', () => {
    expect(itemCollectionValue(item({ unitCost: 10, quantity: -3 }))).toBe(0);
  });
});

describe('itemRarity', () => {
  it('buckets an item into the highest tier its collection value clears', () => {
    expect(itemRarity(item({ unitCost: null }))).toBe('common'); // unpriced ⇒ 0
    expect(itemRarity(item({ unitCost: 5, quantity: 1 }))).toBe('common'); // < 25
    expect(itemRarity(item({ unitCost: 30, quantity: 1 }))).toBe('uncommon'); // 25–99
    expect(itemRarity(item({ unitCost: 100, quantity: 1 }))).toBe('rare'); // 100–499
    expect(itemRarity(item({ unitCost: 500, quantity: 1 }))).toBe('epic'); // 500–1999
    expect(itemRarity(item({ unitCost: 2000, quantity: 1 }))).toBe('legendary'); // ≥ 2000
  });

  it('rises as quantity accumulates value', () => {
    // 40 each: one unit is Uncommon, but a pile of 60 crosses into Legendary (2400 ≥ 2000).
    expect(itemRarity(item({ unitCost: 40, quantity: 1 }))).toBe('uncommon');
    expect(itemRarity(item({ unitCost: 40, quantity: 60 }))).toBe('legendary');
  });

  it('only ever returns a known tier id', () => {
    expect(RARITY_IDS).toContain(itemRarity(item({ unitCost: 123, quantity: 7 })));
  });
});
