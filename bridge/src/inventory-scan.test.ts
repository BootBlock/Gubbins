/**
 * Aggregate stock-level counting (EI-5/EI-6). Pure over a fake paginated repository — no DB.
 *
 * The regression these guard: out-of-stock must be counted **independently** of low-stock. With
 * the app-default (opt-in, off) low-stock thresholds, a depleted item carrying no reorder point is
 * still out of stock, even though it is never "low" — so the published sensor / metric counts match
 * the app's own "Out of stock" filter rather than sticking at zero.
 */
import { describe, expect, it } from 'vitest';
import type { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import type { Item, Page } from '@/db/repositories/types';
import { countStockLevels } from './inventory-scan.ts';

/** A minimal item stub — only the reorder-policy slice is read by the scan. */
function item(overrides: Partial<Item>): Item {
  return {
    trackingMode: 'DISCRETE',
    quantity: 10,
    gauge: null,
    reorderPoint: null,
    reorderGaugePercent: null,
    reorderQty: null,
    isUnlimited: false,
    ...overrides,
  } as unknown as Item;
}

/** A fake ItemRepository that returns a single page of the given rows. */
function fakeRepo(rows: Item[]): ItemRepository {
  return {
    list: async (): Promise<Page<Item>> => ({ rows, limit: rows.length, offset: 0, hasMore: false }),
  } as unknown as ItemRepository;
}

describe('countStockLevels', () => {
  it('counts a depleted item with no reorder point as out of stock, not as low', async () => {
    const counts = await countStockLevels(fakeRepo([item({ quantity: 0 })]));
    expect(counts).toEqual({ lowStockItems: 0, outOfStockItems: 1 });
  });

  it('counts low and out-of-stock independently (out-of-stock is not a subset of low)', async () => {
    const counts = await countStockLevels(
      fakeRepo([
        item({ quantity: 0 }), // out of stock, no reorder point → out only
        item({ quantity: 2, reorderPoint: 5 }), // low but in stock → low only
        item({ quantity: 0, reorderPoint: 5 }), // low AND out → both
        item({ quantity: 50 }), // healthy → neither
      ]),
    );
    expect(counts).toEqual({ lowStockItems: 2, outOfStockItems: 2 });
  });

  it('excludes items with no bulk stock level and unlimited supply from out-of-stock', async () => {
    const counts = await countStockLevels(
      fakeRepo([
        item({ quantity: 0, trackingMode: 'SERIALISED' }),
        item({ quantity: 0, trackingMode: 'UNTRACKED' }),
        item({ quantity: 0, isUnlimited: true }),
      ]),
    );
    expect(counts).toEqual({ lowStockItems: 0, outOfStockItems: 0 });
  });
});
