/**
 * Issue #603 — `suppliers.name_key` is a UNIQUE index over random-UUID ids, and it was the one
 * such index across `SYNC_TABLES` with no entry in the §7.5 natural-key collision registry.
 *
 * A supplier is created implicitly: naming one on a supplier part or a purchase order runs
 * `SupplierRepository.resolveRef` → `resolveOrCreate`, which mints a row. So two devices that
 * each record a part from "RS Components" invent two ids for one `name_key` without the user
 * ever meaning to create anything twice. The merge then emitted a plain `ON CONFLICT(id)`
 * upsert, whose target does not cover `idx_suppliers_name_key`, and the INSERT took the whole
 * atomic apply down with it — the bricked-sync failure issue #187 exists to prevent, on the
 * table it never reached.
 *
 * Run over `node:sqlite` with the real migrations and foreign keys enabled, because the claim is
 * about what SQLite does with the emitted batch rather than about the plan's shape. The second
 * half of each case is what a `UNIQUE_KEY_SPECS` entry alone does not give: a retired supplier's
 * parts, their price history and the purchase orders naming it must all survive on the winner.
 * Retiring the loser before the upserts would cascade through `supplier_parts` into
 * `supplier_part_price_history` — which references the *part*, so nothing re-emits it — which is
 * why the retirement is deferred until every child has moved.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { migrations } from '@/db/migrations';
import { runMigrations } from '@/db/migrations/engine';
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories/constants';
import { ITEM_HISTORY_TABLE, STOCK_DELTAS_TABLE, SYNC_TABLES } from '@/db/repositories/tombstone';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runSnapshotMerge } from './merge';
import { reconcile } from './reconcile';
import { buildSchemaDictionary } from './schema-dictionary';
import { applyPlan, buildLocalSnapshot, restoreSnapshot } from './snapshot';
import type { SyncSnapshot } from './types';

const ITEM_ID = 'itm-resistor';
/** The two ids one folded name ends up under, one per device. */
const LOCAL_SUPPLIER = 'sup-local';
const REMOTE_SUPPLIER = 'sup-remote';

async function freshDriver(): Promise<MemoryDriver> {
  const driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  await driver.execute('PRAGMA foreign_keys = ON;');
  return driver;
}

/**
 * One device's view: the shared item, its own supplier for "RS Components", a part quoting that
 * supplier with a price-history point, and a purchase order placed with it.
 *
 * `name` differs per device on purpose (`RS Components` against `rs-components`) while
 * `name_key` — what `supplierNameKey()` stores, and what the index is built over — is identical.
 * That is the real shape of the collision: the folded key collides where the typed names do not.
 */
async function seedDevice(
  driver: MemoryDriver,
  opts: { supplierId: string; name: string; updatedAt: number },
): Promise<void> {
  await driver.execute('INSERT INTO items (id, name, location_id, updated_at) VALUES (?, ?, ?, ?);', [
    ITEM_ID,
    '10k resistor',
    UNASSIGNED_LOCATION_ID,
    100,
  ]);
  await driver.execute('INSERT INTO suppliers (id, name, name_key, updated_at) VALUES (?, ?, ?, ?);', [
    opts.supplierId,
    opts.name,
    'rscomponents',
    opts.updatedAt,
  ]);
  await driver.execute(
    `INSERT INTO supplier_parts (id, item_id, supplier_id, order_code, updated_at)
     VALUES (?, ?, ?, ?, ?);`,
    [`part-${opts.supplierId}`, ITEM_ID, opts.supplierId, `code-${opts.supplierId}`, opts.updatedAt],
  );
  await driver.execute(
    `INSERT INTO supplier_part_price_history (id, supplier_part_id, unit_cost, recorded_at, updated_at)
     VALUES (?, ?, ?, ?, ?);`,
    [`price-${opts.supplierId}`, `part-${opts.supplierId}`, 1_000_000, opts.updatedAt, opts.updatedAt],
  );
  await driver.execute(
    'INSERT INTO purchase_orders (id, supplier_id, reference, updated_at) VALUES (?, ?, ?, ?);',
    [`po-${opts.supplierId}`, opts.supplierId, `PO-${opts.supplierId}`, opts.updatedAt],
  );
  await driver.execute(
    `INSERT INTO purchase_order_lines (id, po_id, item_id, supplier_part_id, ordered_qty, updated_at)
     VALUES (?, ?, ?, ?, ?, ?);`,
    [
      `line-${opts.supplierId}`,
      `po-${opts.supplierId}`,
      ITEM_ID,
      `part-${opts.supplierId}`,
      5,
      opts.updatedAt,
    ],
  );
}

/** The snapshot the peer device publishes. Its supplier is the newer row, so it wins. */
async function remoteSnapshot(): Promise<SyncSnapshot> {
  const source = await freshDriver();
  try {
    await seedDevice(source, { supplierId: REMOTE_SUPPLIER, name: 'rs-components', updatedAt: 200 });
    return await buildLocalSnapshot(source, 1000);
  } finally {
    await source.close();
  }
}

describe('the same supplier created on two devices (issue #603)', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    driver = await freshDriver();
    await seedDevice(driver, { supplierId: LOCAL_SUPPLIER, name: 'RS Components', updatedAt: 100 });
  });

  afterEach(async () => {
    await driver.close();
  });

  /** Every id of `table`, sorted, so a missing row reads as a missing id rather than a count. */
  async function idsOf(table: string): Promise<string[]> {
    const rows = await driver.query<{ id: string }>(`SELECT id FROM ${table} ORDER BY id;`);
    return rows.map((r) => r.id);
  }

  /** What the merged database must look like, whichever path wrote it. */
  async function expectConverged(): Promise<void> {
    // One supplier, and it is the newer peer's row — the loser's id is retired, not duplicated.
    const suppliers = await driver.query<{ id: string; name_key: string }>(
      'SELECT id, name_key FROM suppliers;',
    );
    expect(suppliers).toEqual([{ id: REMOTE_SUPPLIER, name_key: 'rscomponents' }]);

    // Both devices' parts survive, both pointing at the winner: the two sides' catalogue entries
    // merge onto one supplier rather than one side's being cascaded away.
    const parts = await driver.query<{ id: string; supplier_id: string }>(
      'SELECT id, supplier_id FROM supplier_parts ORDER BY id;',
    );
    expect(parts).toEqual([
      { id: `part-${LOCAL_SUPPLIER}`, supplier_id: REMOTE_SUPPLIER },
      { id: `part-${REMOTE_SUPPLIER}`, supplier_id: REMOTE_SUPPLIER },
    ]);

    // The grandchildren a cascade would have taken with the retired supplier.
    expect(await idsOf('supplier_part_price_history')).toEqual([
      `price-${LOCAL_SUPPLIER}`,
      `price-${REMOTE_SUPPLIER}`,
    ]);

    // Purchase orders are SET NULL rather than CASCADE, so the money record was never at risk —
    // but it must still name the surviving supplier instead of reading as an unknown one.
    const orders = await driver.query<{ id: string; supplier_id: string | null }>(
      'SELECT id, supplier_id FROM purchase_orders ORDER BY id;',
    );
    expect(orders).toEqual([
      { id: `po-${LOCAL_SUPPLIER}`, supplier_id: REMOTE_SUPPLIER },
      { id: `po-${REMOTE_SUPPLIER}`, supplier_id: REMOTE_SUPPLIER },
    ]);

    // And the order lines still name the part they were placed against.
    const lines = await driver.query<{ id: string; supplier_part_id: string | null }>(
      'SELECT id, supplier_part_id FROM purchase_order_lines ORDER BY id;',
    );
    expect(lines).toEqual([
      { id: `line-${LOCAL_SUPPLIER}`, supplier_part_id: `part-${LOCAL_SUPPLIER}` },
      { id: `line-${REMOTE_SUPPLIER}`, supplier_part_id: `part-${REMOTE_SUPPLIER}` },
    ]);
  }

  it('merges the peer snapshot instead of aborting on idx_suppliers_name_key', async () => {
    const remote = await remoteSnapshot();
    const dictionary = await buildSchemaDictionary(driver, [
      ...SYNC_TABLES,
      ITEM_HISTORY_TABLE,
      STOCK_DELTAS_TABLE,
    ]);
    const local = await buildLocalSnapshot(driver, 1);
    const plan = reconcile(local, remote, { offset: 0, dictionary });

    expect(plan.collisions).toContainEqual({
      table: 'suppliers',
      loserId: LOCAL_SUPPLIER,
      winnerId: REMOTE_SUPPLIER,
      deletedAt: 200,
    });

    await applyPlan(driver, plan, dictionary);

    await expectConverged();
  });

  it('restores a backup taken on the other device (§2 merge restore)', async () => {
    await restoreSnapshot(driver, await remoteSnapshot());

    await expectConverged();
  });

  it('clones the remote after a tombstone-TTL expiry (§7.2)', async () => {
    // `lastSyncTimestamp` sits below this device's rows (stamped 100) so they are salvaged: a
    // clone wipes the syncable tables and re-applies only what changed since the last sync, and
    // a local supplier that was never salvaged would be absent for a reason this test is not
    // about.
    await runSnapshotMerge(driver, {
      mode: 'clone',
      remote: await remoteSnapshot(),
      offset: 0,
      effectiveNow: 2000,
      lastSyncTimestamp: 50,
      historyPrunedBefore: 0,
      forceTies: false,
    });

    await expectConverged();
  });
});
