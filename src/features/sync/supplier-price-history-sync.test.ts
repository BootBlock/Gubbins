import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository, SupplierPartRepository } from '@/db/repositories';
import { MemoryCloudProvider } from './providers/memory-provider';
import { runSync } from './sync-engine';

/**
 * Phase 81 — the synced `supplier_part_price_history` table round-trips between two devices
 * (§7.3). A price point is a plain (insert-only) LWW row carrying its own `updated_at`, so
 * once it joined `SYNC_TABLES` it publishes, reconciles, and is FK-guarded through the same
 * generic engine path every other entity table uses — proven end-to-end here.
 */
async function makeDevice(): Promise<{
  driver: MemoryDriver;
  items: ItemRepository;
  parts: SupplierPartRepository;
}> {
  const driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  await driver.execute('PRAGMA foreign_keys = ON;');
  return {
    driver,
    items: new ItemRepository(driver),
    parts: new SupplierPartRepository(driver),
  };
}

const NO_QUOTA = { skipQuotaCheck: true } as const;

describe('supplier_part_price_history sync round-trip (§7.3)', () => {
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

  it('publishes price points, then a peer pulls the full series', async () => {
    const item = await a.items.create({ name: 'Resistor' });
    const part = await a.parts.create(item.id, { supplierName: 'RS', unitCost: 1.0, currency: 'GBP' });
    await a.parts.update(part.id, { unitCost: 1.4, source: 'SCRAPE' });

    expect((await runSync(a.driver, provider, NO_QUOTA)).status).toBe('PUBLISHED');
    expect((await runSync(b.driver, provider, NO_QUOTA)).status).toBe('SYNCED');

    const onB = await b.parts.listPriceHistory(part.id);
    expect(onB).toHaveLength(2);
    expect(onB.map((p) => p.unitCost).sort()).toEqual([1.0, 1.4]);
    expect(onB.find((p) => p.unitCost === 1.4)?.source).toBe('SCRAPE');
  });

  it('drops an incoming price point whose supplier part did not survive the merge (FK guard)', async () => {
    // A creates an item + supplier part + price point and syncs them out.
    const item = await a.items.create({ name: 'Cap' });
    const part = await a.parts.create(item.id, { supplierName: 'RS', unitCost: 2.0 });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    expect(await b.parts.listPriceHistory(part.id)).toHaveLength(1);

    // A deletes the supplier part (cascading its price history, leaving a supplier_parts
    // tombstone) and syncs; the peer must drop the part and its now-orphaned history.
    await a.parts.delete(part.id);
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    expect(await b.parts.getById(part.id)).toBeUndefined();
    expect(await b.parts.listPriceHistory(part.id)).toHaveLength(0);
  });
});
