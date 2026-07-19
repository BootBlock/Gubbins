import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository } from '@/db/repositories';
import { MemoryCloudProvider } from './providers/memory-provider';
import { runSync } from './sync-engine';

/**
 * Issue #151 — the synced `kit_components` table round-trips between two devices (§7.3).
 *
 * A kit edge was excluded from `SYNC_TABLES` in v1 as "device-local", which meant a user's kit
 * definitions never reached their other devices and — because the same list drives the portable
 * `backup.json` — were lost silently on a restore. It carries its own `updated_at` + auto-stamp
 * trigger, so it now travels by the same generic LWW path every other entity table uses, with the
 * one wrinkle its random-UUID id brings: two devices adding the same component to the same kit
 * invent two ids for one `UNIQUE (kit_item_id, component_item_id)` pair, settled by the §7.5
 * natural-key pass rather than aborting the merge.
 */
async function makeDevice(): Promise<{ driver: MemoryDriver; items: ItemRepository }> {
  const driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  await driver.execute('PRAGMA foreign_keys = ON;');
  return { driver, items: new ItemRepository(driver) };
}

const NO_QUOTA = { skipQuotaCheck: true } as const;

describe('kit_components sync round-trip (§7.3, issue #151)', () => {
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

  it('publishes a kit definition, and the peer sees its components', async () => {
    const kit = await a.items.create({ name: 'First-aid kit' });
    const bandages = await a.items.create({ name: 'Bandages' });
    const scissors = await a.items.create({ name: 'Scissors' });
    await a.items.addKitComponent(kit.id, bandages.id, 2);
    await a.items.addKitComponent(kit.id, scissors.id, 1);

    expect((await runSync(a.driver, provider, NO_QUOTA)).status).toBe('PUBLISHED');
    expect((await runSync(b.driver, provider, NO_QUOTA)).status).toBe('SYNCED');

    const components = await b.items.listKitComponents(kit.id);
    expect(components).toHaveLength(2);
    expect(components.map((c) => [c.name, c.quantity])).toEqual(
      expect.arrayContaining([
        ['Bandages', 2],
        ['Scissors', 1],
      ]),
    );
  });

  it('propagates a re-quantify by LWW and a removal by tombstone', async () => {
    const kit = await a.items.create({ name: 'Repair kit' });
    const screws = await a.items.create({ name: 'Screws' });
    const [edge] = await a.items.addKitComponent(kit.id, screws.id, 4);
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    expect(await b.items.listKitComponents(kit.id)).toHaveLength(1);

    await a.items.updateKitComponentQty(edge!.id, 9);
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    expect((await b.items.listKitComponents(kit.id))[0]?.quantity).toBe(9);

    await a.items.removeKitComponent(edge!.id);
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    expect(await b.items.listKitComponents(kit.id)).toHaveLength(0);
  });

  it('converges when both devices add the same component to the same kit (UNIQUE collision)', async () => {
    const kit = await a.items.create({ name: 'Camera bag' });
    const lens = await a.items.create({ name: 'Lens cloth' });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    // Offline, each device invents its own row id for the same (kit, component) pair.
    await a.items.addKitComponent(kit.id, lens.id, 1);
    await b.items.addKitComponent(kit.id, lens.id, 3);

    // The merge must settle the natural-key collision rather than trip UNIQUE and roll back.
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    await runSync(a.driver, provider, NO_QUOTA);

    const onA = await a.items.listKitComponents(kit.id);
    const onB = await b.items.listKitComponents(kit.id);
    expect(onA).toHaveLength(1);
    expect(onB).toHaveLength(1);
    expect(onA[0]?.id).toBe(onB[0]?.id);
    expect(onA[0]?.quantity).toBe(onB[0]?.quantity);
  });

  it('drops an incoming edge whose component item did not survive the merge (FK guard)', async () => {
    const kit = await a.items.create({ name: 'Tool roll' });
    const spanner = await a.items.create({ name: 'Spanner' });
    await a.items.addKitComponent(kit.id, spanner.id, 1);
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    expect(await b.items.listKitComponents(kit.id)).toHaveLength(1);

    // A hard-deletes the component (cascading the edge, leaving an items tombstone); the peer must
    // drop the item and its now-orphaned kit edge rather than trip the edge's NOT NULL FK.
    await a.items.hardDelete(spanner.id);
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    expect(await b.items.getById(spanner.id)).toBeUndefined();
    expect(await b.items.listKitComponents(kit.id)).toHaveLength(0);
  });
});
