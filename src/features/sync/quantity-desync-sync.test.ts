import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository } from '@/db/repositories';
import { MemoryCloudProvider } from './providers/memory-provider';
import { runSync } from './sync-engine';

/**
 * Issue #189 — `items.quantity` is a trigger-derived SUM over the per-location `item_stock`
 * ledger (Phase 25). Those recompute triggers fire only on an `item_stock` write, so a merge
 * that upserts a winning `items` row *without* a matching `item_stock` write used to leave the
 * peer's stale `quantity` in place, out of step with the breakdown it is defined as. The merge
 * now re-derives `quantity` from the post-apply ledger, so the headline count and the
 * per-location sum can never diverge across a sync.
 */
async function makeDevice(): Promise<{ driver: MemoryDriver; items: ItemRepository }> {
  const driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  await driver.execute('PRAGMA foreign_keys = ON;');
  return { driver, items: new ItemRepository(driver) };
}

const NO_QUOTA = { skipQuotaCheck: true } as const;

/** The per-location `item_stock` sum — the figure `items.quantity` must always equal. */
async function stockSum(driver: MemoryDriver, itemId: string): Promise<number> {
  const rows = await driver.query<{ total: number }>(
    'SELECT COALESCE(SUM(quantity), 0) AS total FROM item_stock WHERE item_id = ?;',
    [itemId],
  );
  return Number(rows[0]!.total);
}

describe('items.quantity stays equal to the item_stock sum across sync (issue #189)', () => {
  let a: Awaited<ReturnType<typeof makeDevice>>;
  let b: Awaited<ReturnType<typeof makeDevice>>;
  let provider: MemoryCloudProvider;

  beforeEach(async () => {
    a = await makeDevice();
    b = await makeDevice();
    provider = new MemoryCloudProvider();
  });

  afterEach(async () => {
    await a.driver.close();
    await b.driver.close();
  });

  it('re-derives quantity when a peer items row wins LWW but its stock does not', async () => {
    // Shared baseline: a DISCRETE item with 10 on hand, cloned onto both devices.
    const item = await a.items.create({ name: 'Resistor reel', quantity: 10 });
    await runSync(a.driver, provider, NO_QUOTA); // A publishes
    await runSync(b.driver, provider, NO_QUOTA); // B clones — both read 10 / item_stock 10

    // Device A adjusts stock down to 7 (items.quantity → 7, item_stock → 7).
    await a.items.adjustQuantity(item.id, -3);
    expect(await stockSum(a.driver, item.id)).toBe(7);

    // Device B, *later on the wall clock*, edits only the name — no stock change. Pin the two
    // timestamps that decide the merge so the reproduction is deterministic regardless of
    // millisecond timing: B's items row is forced far newer (it must win LWW) while B's
    // item_stock is forced far older (it must lose to A's adjusted stock, so no stock write
    // fires on A). Both are set directly, bypassing the auto-stamp trigger (NEW ≠ OLD).
    await b.items.update(item.id, { name: 'Resistor reel (1kΩ)' });
    await b.driver.execute('UPDATE items SET updated_at = ? WHERE id = ?;', [9_000_000_000_000, item.id]);
    await b.driver.execute('UPDATE item_stock SET updated_at = ? WHERE item_id = ?;', [1, item.id]);

    // B pushes its newer name (carrying its stale quantity 10); A then pulls it. A adopts B's
    // items row by LWW, but its own newer item_stock (7) wins, so no stock write fires.
    await runSync(b.driver, provider, NO_QUOTA);
    await runSync(a.driver, provider, NO_QUOTA);

    const merged = await a.items.getById(item.id);
    expect(merged!.name).toBe('Resistor reel (1kΩ)'); // B's edit won LWW…
    expect(await stockSum(a.driver, item.id)).toBe(7); // …its stale stock did not…
    expect(merged!.quantity).toBe(7); // …and the headline count matches the breakdown.
  });
});
