import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository, LocationRepository, UNASSIGNED_LOCATION_ID } from '@/db/repositories';
import { MemoryCloudProvider } from './providers/memory-provider';
import { runSync, needsFullResync, TOMBSTONE_TTL_MS } from './sync-engine';

async function makeDevice(): Promise<{ driver: MemoryDriver; items: ItemRepository; locations: LocationRepository }> {
  const driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  return {
    driver,
    items: new ItemRepository(driver),
    locations: new LocationRepository(driver),
  };
}

const NO_QUOTA = { skipQuotaCheck: true } as const;

describe('runSync round-trip (§7.3)', () => {
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

  it('publishes on first sync, then a peer pulls the new rows', async () => {
    const item = await a.items.create({ name: 'ESP32', locationId: UNASSIGNED_LOCATION_ID });
    const first = await runSync(a.driver, provider, NO_QUOTA);
    expect(first.status).toBe('PUBLISHED');

    const pull = await runSync(b.driver, provider, NO_QUOTA);
    expect(pull.status).toBe('SYNCED');
    expect(pull.pulled).toBeGreaterThanOrEqual(1);
    expect((await b.items.getById(item.id))?.name).toBe('ESP32');
  });

  it('resolves a concurrent edit by Last-Write-Wins', async () => {
    const item = await a.items.create({ name: 'Original', locationId: UNASSIGNED_LOCATION_ID });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    // B renames later than A's last write, then pushes.
    await b.items.update(item.id, { name: 'Renamed on B' });
    await runSync(b.driver, provider, NO_QUOTA);

    // A syncs and should adopt B's newer name.
    await runSync(a.driver, provider, NO_QUOTA);
    expect((await a.items.getById(item.id))?.name).toBe('Renamed on B');
  });

  it('propagates a hard delete via a tombstone', async () => {
    const item = await a.items.create({ name: 'Doomed', locationId: UNASSIGNED_LOCATION_ID });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    expect(await b.items.getById(item.id)).toBeDefined();

    await a.items.hardDelete(item.id);
    await runSync(a.driver, provider, NO_QUOTA);

    const pull = await runSync(b.driver, provider, NO_QUOTA);
    expect(pull.deleted).toBeGreaterThanOrEqual(1);
    expect(await b.items.getById(item.id)).toBeUndefined();
  });

  it('re-parents an item whose location was deleted on a peer (§7.5.2)', async () => {
    const loc = await a.locations.create({ name: 'Shelf' });
    const item = await a.items.create({ name: 'On shelf', locationId: loc.id });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    // A deletes the location (its own copy re-parents locally), then pushes.
    await a.locations.delete(loc.id);
    await runSync(a.driver, provider, NO_QUOTA);

    // B, offline, makes a *newer* edit to the item still sitting in the doomed
    // location — the genuine §7.5.2 conflict. The unambiguous future timestamp makes
    // B's row win LWW deterministically (the location row stays old, so the remote
    // tombstone still removes it), so B's own reconcile must intercept-and-re-parent.
    await b.driver.execute(
      'UPDATE items SET name = ?, updated_at = updated_at + 1000000 WHERE id = ?;',
      ['Still here on B', item.id],
    );
    const pull = await runSync(b.driver, provider, NO_QUOTA);

    expect(pull.reparented).toBeGreaterThanOrEqual(1);
    const moved = await b.items.getById(item.id);
    expect(moved?.locationId).toBe(UNASSIGNED_LOCATION_ID);
    expect(moved?.name).toBe('Still here on B'); // B's edit survived
    const history = await b.items.getHistory(item.id);
    expect(history.rows.some((h) => h.action === 'RE_PARENTED')).toBe(true);
  });

  it('reconciles concurrent gauge consumption with Delta-CRDT, not LWW (§7.3)', async () => {
    const spool = await a.items.create({
      name: 'PLA spool',
      locationId: UNASSIGNED_LOCATION_ID,
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, tareWeight: 0, currentNetValue: 1000 },
    });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    // Concurrent offline usage: A uses 45 g, B uses 10 g.
    await a.items.adjustGauge(spool.id, { delta: -45 });
    await b.items.adjustGauge(spool.id, { delta: -10 });

    // B pushes first, then A reconciles.
    await runSync(b.driver, provider, NO_QUOTA);
    await runSync(a.driver, provider, NO_QUOTA);

    const merged = await a.items.getById(spool.id);
    expect(merged?.gauge?.currentNetValue).toBe(945);
  });
});

describe('needsFullResync (§7.2 TTL)', () => {
  it('is false for a never-synced or recently-synced device', () => {
    expect(needsFullResync(0, 1_000_000)).toBe(false);
    expect(needsFullResync(1_000_000 - 1000, 1_000_000)).toBe(false);
  });
  it('is true once the last sync predates the tombstone TTL', () => {
    const now = 10 * TOMBSTONE_TTL_MS;
    expect(needsFullResync(now - TOMBSTONE_TTL_MS - 1, now)).toBe(true);
  });
});
