import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository } from '@/db/repositories';
import { MemoryCloudProvider } from './providers/memory-provider';
import { runSync } from './sync-engine';

/**
 * Feature-gap G6 — the synced `item_relations` table round-trips between two devices (§7.3). A
 * relation is a plain LWW row carrying its own `updated_at` with a **deterministic** id (the
 * canonical `from|to|kind` triple), so once it joined `SYNC_TABLES` it publishes, reconciles and is
 * FK-guarded through the same generic engine path every other entity table uses. The deterministic
 * id also means two devices independently adding the *same* logical relation converge to one row
 * rather than colliding — proven end-to-end here.
 */
async function makeDevice(): Promise<{ driver: MemoryDriver; items: ItemRepository }> {
  const driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  await driver.execute('PRAGMA foreign_keys = ON;');
  return { driver, items: new ItemRepository(driver) };
}

const NO_QUOTA = { skipQuotaCheck: true } as const;

describe('item_relations sync round-trip (§7.3)', () => {
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

  it('publishes a relation, then a peer pulls it and sees it reciprocally', async () => {
    const camera = await a.items.create({ name: 'Camera' });
    const tripod = await a.items.create({ name: 'Tripod' });
    await a.items.addRelation({ fromItemId: camera.id, toItemId: tripod.id, kind: 'ACCESSORY_FOR' });

    expect((await runSync(a.driver, provider, NO_QUOTA)).status).toBe('PUBLISHED');
    expect((await runSync(b.driver, provider, NO_QUOTA)).status).toBe('SYNCED');

    // The relation surfaces on BOTH items on the peer (reciprocity).
    const fromCamera = await b.items.listRelations(camera.id);
    expect(fromCamera).toHaveLength(1);
    expect(fromCamera[0]).toMatchObject({ kind: 'ACCESSORY_FOR', otherItemId: tripod.id });

    const fromTripod = await b.items.listRelations(tripod.id);
    expect(fromTripod).toHaveLength(1);
    expect(fromTripod[0]).toMatchObject({ kind: 'ACCESSORY_FOR', otherItemId: camera.id });
  });

  it('converges when both devices independently add the same logical relation (deterministic id)', async () => {
    // Seed the two items on both devices via an initial sync.
    const x = await a.items.create({ name: 'Amp' });
    const y = await a.items.create({ name: 'Speaker' });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    // Each device adds the SAME symmetric relation, in opposite input order.
    await a.items.addRelation({ fromItemId: x.id, toItemId: y.id, kind: 'WORKS_WITH' });
    await b.items.addRelation({ fromItemId: y.id, toItemId: x.id, kind: 'WORKS_WITH' });

    // Round-trip both ways; the canonical id collapses the two into a single relation.
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    await runSync(a.driver, provider, NO_QUOTA);

    expect(await a.items.listRelations(x.id)).toHaveLength(1);
    expect(await b.items.listRelations(x.id)).toHaveLength(1);
  });

  it('propagates a removal via a tombstone', async () => {
    const x = await a.items.create({ name: 'Drill' });
    const y = await a.items.create({ name: 'Battery' });
    const rel = await a.items.addRelation({ fromItemId: y.id, toItemId: x.id, kind: 'SPARE_FOR' });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    expect(await b.items.listRelations(x.id)).toHaveLength(1);

    await a.items.removeRelation(rel.id);
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    expect(await b.items.listRelations(x.id)).toHaveLength(0);
  });

  it('drops an incoming relation whose endpoint item did not survive the merge (FK guard)', async () => {
    const keep = await a.items.create({ name: 'Laptop' });
    const gone = await a.items.create({ name: 'Dock' });
    await a.items.addRelation({ fromItemId: gone.id, toItemId: keep.id, kind: 'ACCESSORY_FOR' });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    expect(await b.items.listRelations(keep.id)).toHaveLength(1);

    // A hard-deletes one endpoint (cascading its relation, leaving an items tombstone) and syncs;
    // the peer must drop the item and its now-orphaned relation.
    await a.items.hardDelete(gone.id);
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    expect(await b.items.getById(gone.id)).toBeUndefined();
    expect(await b.items.listRelations(keep.id)).toHaveLength(0);
  });
});
