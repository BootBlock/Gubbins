import { describe, it, expect } from 'vitest';
import type { Item } from '@/db/repositories';
import { COLLECTOR_FRACTION, RARITY_IDS, hashName, itemRarity } from './rarity';

/**
 * Unit tests for the pure "Collector cards" rarity seam. `itemRarity` reads only the item name, so
 * the fixture supplies just that (cast through a partial).
 */
const item = (name: string): Item => ({ name }) as Item;

describe('hashName', () => {
  it('is deterministic and a 32-bit unsigned integer', () => {
    const h = hashName('Excalibur');
    expect(h).toBe(hashName('Excalibur'));
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });

  it('differs for different names', () => {
    expect(hashName('Torch')).not.toBe(hashName('Torch ')); // a trailing space is a different name
  });
});

describe('itemRarity', () => {
  it('is deterministic — the same name always yields the same result', () => {
    const first = itemRarity(item('NE555 timer'));
    expect(itemRarity(item('NE555 timer'))).toBe(first);
  });

  it('returns null for a non-collector and a known tier for a collector', () => {
    // Deterministically pick one of each so the test never depends on a hand-computed hash.
    const collector = firstName((n) => itemRarity(item(n)) != null);
    const ordinary = firstName((n) => itemRarity(item(n)) == null);
    expect(RARITY_IDS).toContain(itemRarity(item(collector)));
    expect(itemRarity(item(ordinary))).toBeNull();
  });

  it('marks roughly COLLECTOR_FRACTION (~5%) of items as collectors', () => {
    const N = 8000;
    let collectors = 0;
    for (let i = 0; i < N; i++) if (itemRarity(item(`Widget ${i}`)) != null) collectors++;
    const frac = collectors / N;
    // Generous bounds around the 5% target — this only guards against a gross regression (e.g.
    // every card, or none, becoming a collector), not the exact rate.
    expect(frac).toBeGreaterThan(0.03);
    expect(frac).toBeLessThan(0.08);
    // Sanity: the constant the maths keys off is the advertised ~5%.
    expect(COLLECTOR_FRACTION).toBeCloseTo(0.05, 5);
  });

  it('makes the showier tiers rarer than the plainer ones', () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < 40000; i++) {
      const r = itemRarity(item(`Sample ${i}`));
      if (r) counts[r] = (counts[r] ?? 0) + 1;
    }
    // Common is the most frequent collector tier; Legendary the least.
    expect(counts.common ?? 0).toBeGreaterThan(counts.legendary ?? 0);
    expect(counts.epic ?? 0).toBeGreaterThan(counts.legendary ?? 0);
  });
});

/** Scan short synthetic names for the first that satisfies `pred` (both cases exist well within). */
function firstName(pred: (name: string) => boolean): string {
  for (let i = 0; i < 100000; i++) {
    const name = `Probe ${i}`;
    if (pred(name)) return name;
  }
  throw new Error('no matching name found');
}
