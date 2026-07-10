import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository } from '@/db/repositories';
import { MemoryCloudProvider } from './providers/memory-provider';
import { runSync } from './sync-engine';

/**
 * Feature-gap G7 — the synced `test_records` table round-trips between two devices (§7.3). A test
 * record is a plain append-only LWW row carrying its own `updated_at` with a random-UUID id and an
 * `item_id` FK → items (ON DELETE CASCADE), so once it joined `SYNC_TABLES` (+ the reconcile
 * `FK_REFS` item guard) it publishes, reconciles, deletes and is FK-guarded through the same
 * generic engine path `revaluations` uses — no bespoke handling.
 */
async function makeDevice(): Promise<{ driver: MemoryDriver; items: ItemRepository }> {
  const driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  await driver.execute('PRAGMA foreign_keys = ON;');
  return { driver, items: new ItemRepository(driver) };
}

const NO_QUOTA = { skipQuotaCheck: true } as const;

describe('test_records sync round-trip (§7.3)', () => {
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

  it('publishes a record, then a peer pulls it', async () => {
    const meter = await a.items.create({ name: 'Multimeter', trackingMode: 'SERIALISED' });
    await a.items.recordTestResult(meter.id, {
      kind: 'CALIBRATION',
      name: 'Annual calibration',
      result: 'PASS',
      reading: 12.5,
      unit: 'MΩ',
    });

    expect((await runSync(a.driver, provider, NO_QUOTA)).status).toBe('PUBLISHED');
    expect((await runSync(b.driver, provider, NO_QUOTA)).status).toBe('SYNCED');

    const pulled = await b.items.listTestRecords(meter.id);
    expect(pulled).toHaveLength(1);
    expect(pulled[0]).toMatchObject({
      kind: 'CALIBRATION',
      name: 'Annual calibration',
      result: 'PASS',
      reading: 12.5,
      unit: 'MΩ',
    });
  });

  it('propagates a removal via a tombstone', async () => {
    const meter = await a.items.create({ name: 'Tester', trackingMode: 'SERIALISED' });
    const rec = await a.items.recordTestResult(meter.id, { name: 'Bad entry' });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    expect(await b.items.listTestRecords(meter.id)).toHaveLength(1);

    await a.items.removeTestRecord(rec.id);
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    expect(await b.items.listTestRecords(meter.id)).toHaveLength(0);
  });

  it('drops an incoming record whose item did not survive the merge (FK guard)', async () => {
    const gone = await a.items.create({ name: 'Retired unit', trackingMode: 'SERIALISED' });
    await a.items.recordTestResult(gone.id, { name: 'Final test', result: 'FAIL' });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    expect(await b.items.listTestRecords(gone.id)).toHaveLength(1);

    // A hard-deletes the item (cascading its records, leaving an items tombstone) and syncs; the
    // peer must drop the item and its now-orphaned test records.
    await a.items.hardDelete(gone.id);
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    expect(await b.items.getById(gone.id)).toBeUndefined();
    expect(await b.items.listTestRecords(gone.id)).toHaveLength(0);
  });
});
