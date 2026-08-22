/**
 * Issue #548: restoring a snapshot must not re-stamp `updated_at` on a row it did not change.
 *
 * A restore rebuilds the stock ledger one row at a time, and the derived-quantity recompute
 * triggers used to see every intermediate partial sum: an item with stock in two locations
 * restored its settled total, watched the projection knock it down to the first location's share
 * and back up again, and — because that recompute writes `quantity` without touching `updated_at`
 * — the auto-stamp trigger fired on each step and stamped a row nobody edited. The same chain ran
 * one level down for a placement holding more than one batch, bumping `item_stock.updated_at` too.
 *
 * The bridge is where that bites: `POST /api/v1/snapshot` hydrates the served file through this
 * path on every push, so those items always looked newer than the app's genuine edits to them and
 * last-write-wins discarded the edits with a `200 ok`. The property asserted here is the direct
 * one — restore a snapshot, and every `updated_at` is byte-identical to what the snapshot carried
 * — plus the merge-restore case that shows the projection is still settled where it genuinely has
 * to be.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { SYNC_TABLES, ITEM_HISTORY_TABLE, STOCK_DELTAS_TABLE } from '@/db/repositories/tombstone';
import { ItemRepository, LocationRepository, ProjectRepository } from '@/db/repositories';
import {
  buildLocalSnapshot,
  buildCloneStatements,
  restoreSnapshot,
  withCaptureDisabled,
  withDeferredForeignKeys,
  withRecomputeDeferred,
} from './snapshot';
import { buildSchemaDictionary } from './schema-dictionary';
import type { SyncSnapshot } from './types';

interface Device {
  driver: MemoryDriver;
  items: ItemRepository;
  locations: LocationRepository;
  projects: ProjectRepository;
}

async function makeDevice(): Promise<Device> {
  const driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  await driver.execute('PRAGMA foreign_keys = ON;');
  return {
    driver,
    items: new ItemRepository(driver),
    locations: new LocationRepository(driver),
    projects: new ProjectRepository(driver),
  };
}

/**
 * Every `(table, id) → updated_at` the database currently holds, for the syncable tables that
 * carry the column. Comparing two of these is the whole property: a restore may add rows, but it
 * must never move a stamp the snapshot did not move.
 */
async function stamps(driver: MemoryDriver): Promise<Map<string, number>> {
  const dictionary = await buildSchemaDictionary(driver, [...SYNC_TABLES]);
  const out = new Map<string, number>();
  for (const table of SYNC_TABLES) {
    if (!dictionary[table]?.includes('updated_at')) continue;
    const rows = await driver.query<{ id: string; updated_at: number }>(
      `SELECT id, updated_at FROM ${table};`,
    );
    for (const row of rows) out.set(`${table}:${row.id}`, Number(row.updated_at));
  }
  return out;
}

/** The stamps a snapshot carries, in the same shape {@link stamps} returns. */
function snapshotStamps(snapshot: SyncSnapshot): Map<string, number> {
  const out = new Map<string, number>();
  for (const table of SYNC_TABLES) {
    for (const row of snapshot.tables[table] ?? []) {
      if (row.updated_at === undefined || row.updated_at === null) continue;
      out.set(`${table}:${String(row.id)}`, Number(row.updated_at));
    }
  }
  return out;
}

/**
 * An item whose stock sits in two locations, one of those placements holding two dated lots —
 * the shape that used to re-stamp at both levels of the projection. Returns the item's id.
 */
async function seedMultiPlacementItem(device: Device): Promise<string> {
  const drawerA = await device.locations.create({ name: 'Drawer A' });
  const drawerB = await device.locations.create({ name: 'Drawer B' });
  const item = await device.items.create({ name: 'Resistor reel', quantity: 8, locationId: drawerA.id });
  await device.items.transferStock(item.id, drawerA.id, drawerB.id, 5);

  // A second lot in drawer A, so that placement's own quantity is a sum of two batch rows.
  const project = await device.projects.create({ name: 'Restock' });
  const line = await device.projects.addLine(project.id, { itemId: item.id, requiredQty: 4 });
  await device.projects.setProcurement(line.id, 'IN_TRANSIT');
  await device.projects.receiveLine(line.id, {
    locationId: drawerA.id,
    quantity: 4,
    batch: { batchNumber: 'LOT-9', lotNumber: null, expiryDate: 4_000 },
  });
  return item.id;
}

/** The per-location sum `items.quantity` is defined as. */
async function stockSum(driver: MemoryDriver, itemId: string): Promise<number> {
  const rows = await driver.query<{ total: number }>(
    'SELECT COALESCE(SUM(quantity), 0) AS total FROM item_stock WHERE item_id = ?;',
    [itemId],
  );
  return Number(rows[0]!.total);
}

describe('a snapshot restore leaves updated_at exactly as the snapshot carried it (issue #548)', () => {
  let source: Device;
  let target: Device;

  beforeEach(async () => {
    source = await makeDevice();
    target = await makeDevice();
  });

  afterEach(async () => {
    await source.driver.close();
    await target.driver.close();
  });

  it('restores every stamp byte-identical, including the multi-placement item', async () => {
    const itemId = await seedMultiPlacementItem(source);
    const snapshot = await buildLocalSnapshot(source.driver);
    const expected = snapshotStamps(snapshot);

    await restoreSnapshot(target.driver, snapshot);

    const actual = await stamps(target.driver);
    for (const [key, stamp] of expected) {
      expect(actual.get(key), `stamp moved for ${key}`).toBe(stamp);
    }
    // The item that used to be re-stamped, named explicitly so a regression reads plainly.
    expect(actual.get(`items:${itemId}`)).toBe(expected.get(`items:${itemId}`));
    // …and the derived totals are still right, which is what the recompute was there for.
    expect(await stockSum(target.driver, itemId)).toBe(12);
    const item = await target.items.getById(itemId);
    expect(item?.quantity).toBe(12);
  });

  it('leaves the stamps alone on a wipe-and-clone replace too', async () => {
    const itemId = await seedMultiPlacementItem(source);
    const snapshot = await buildLocalSnapshot(source.driver);
    const expected = snapshotStamps(snapshot);

    const dictionary = await buildSchemaDictionary(target.driver, [
      ...SYNC_TABLES,
      ITEM_HISTORY_TABLE,
      STOCK_DELTAS_TABLE,
    ]);
    await target.driver.transaction(
      withDeferredForeignKeys(
        withCaptureDisabled(withRecomputeDeferred(buildCloneStatements(snapshot, dictionary))),
      ),
    );

    const actual = await stamps(target.driver);
    for (const [key, stamp] of expected) {
      expect(actual.get(key), `stamp moved for ${key}`).toBe(stamp);
    }
    expect(await stockSum(target.driver, itemId)).toBe(12);
  });

  it('still settles the projection when a merge restore lands stock beside local placements', async () => {
    // The backup carries the item with 5 in its own drawer and an `items.quantity` of 5 to match;
    // the target already holds the same item with 3 in a drawer the backup has never seen. Nothing
    // in the snapshot is wrong — a merge restore only ever adds, so the two halves have to be added
    // up on arrival. This is the work the per-row recompute used to do, and the settle pass now
    // does once from the finished ledger.
    const drawerD = await source.locations.create({ name: 'Drawer D' });
    const item = await source.items.create({ name: 'Resistor reel', quantity: 5, locationId: drawerD.id });

    const drawerC = await target.locations.create({ name: 'Drawer C' });
    // Seeded through `stock_batches`, the ledger's SSOT, so the live triggers project it exactly as
    // an ordinary local receipt would — the repository cannot create an item under a chosen id.
    await target.driver.execute('INSERT INTO items (id, name, quantity, location_id) VALUES (?, ?, ?, ?);', [
      item.id,
      'Resistor reel',
      0,
      drawerC.id,
    ]);
    await target.driver.execute(
      'INSERT INTO stock_batches (id, item_id, location_id, batch_key, quantity) VALUES (?, ?, ?, ?, ?);',
      [`${item.id}|${drawerC.id}|`, item.id, drawerC.id, '', 3],
    );
    expect(await stockSum(target.driver, item.id)).toBe(3);

    await restoreSnapshot(target.driver, await buildLocalSnapshot(source.driver));

    expect(await stockSum(target.driver, item.id)).toBe(8);
    const merged = await target.items.getById(item.id);
    expect(merged?.quantity).toBe(8);
  });
});
