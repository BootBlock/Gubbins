import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from './engine';
import { migrations, TARGET_SCHEMA_VERSION } from './index';
import { v1Initial } from './v1-initial';
import { captureSchemaSnapshot } from './__fixtures__/schema-snapshot';
import goldenSnapshot from './__fixtures__/schema-baseline.snapshot.json';

/**
 * Schema-baseline lock.
 *
 * `schema-baseline.snapshot.json` is the committed GOLDEN fixture — the full,
 * deterministic schema dump (every `sqlite_master.sql`, every column / FK / index, and
 * `user_version`) the sole `v1-initial` migration produces. These tests build a fresh
 * database from the registered `migrations` and assert the resulting schema reproduces the
 * fixture **byte-for-byte**, so any unintended schema change (an edited table, index,
 * trigger, FK or column) fails until the fixture is deliberately regenerated. Gubbins is
 * pre-release, so every historical migration (the original v1…v24 chain and the later
 * forward steps v2…v7) is folded into this single baseline at `user_version = 1`.
 */
describe('schema baseline lock', () => {
  let driver: MemoryDriver;

  beforeEach(() => {
    driver = createMemoryDriver();
  });

  afterEach(async () => {
    await driver.close();
  });

  it('registers the single consolidated baseline migration', () => {
    expect(migrations).toHaveLength(1);
    expect(migrations[0]).toBe(v1Initial);
    expect(v1Initial.version).toBe(1);
    // The build's target is simply the highest registered version.
    expect(TARGET_SCHEMA_VERSION).toBe(1);
  });

  it('reproduces the golden schema shape byte-for-byte (zero unintended drift)', async () => {
    await runMigrations(driver, migrations);
    const snapshot = await captureSchemaSnapshot(driver);

    // The schema SHAPE — every sqlite_master.sql object, and every table's columns,
    // foreign keys and indexes — must be byte-for-byte identical to the committed golden.
    expect(snapshot.objects).toEqual(goldenSnapshot.objects);
    expect(snapshot.tables).toEqual(goldenSnapshot.tables);
  });

  it('produces the same set of schema objects as the golden fixture', async () => {
    await runMigrations(driver, migrations);
    const snapshot = await captureSchemaSnapshot(driver);
    const names = (snap: { objects: readonly { type: string; name: string }[] }) =>
      snap.objects.map((o) => `${o.type}:${o.name}`).sort();
    expect(names(snapshot)).toEqual(names(goldenSnapshot));
  });

  it('boots a fresh database cleanly to the target user_version', async () => {
    const report = await runMigrations(driver, migrations);
    expect(report.from).toBe(0);
    expect(report.to).toBe(1);
    expect(report.applied).toEqual([1]);

    const row = await driver.queryOne<{ user_version: number | bigint }>('PRAGMA user_version;');
    expect(Number(row?.user_version)).toBe(1);
  });

  it('creates the partial warranty index (folded former v2)', async () => {
    await runMigrations(driver, migrations);
    const index = await driver.queryOne<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_items_warranty';",
    );
    expect(index?.sql).toBe(
      'CREATE INDEX idx_items_warranty ON items(warranty_expires_at) WHERE warranty_expires_at IS NOT NULL',
    );
  });

  it('creates the partial active-location index (folded former v3)', async () => {
    await runMigrations(driver, migrations);
    const index = await driver.queryOne<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_items_active_location';",
    );
    expect(index?.sql).toBe(
      'CREATE INDEX idx_items_active_location ON items(location_id) WHERE is_active = 1',
    );
  });

  it('records the current target schema version in the golden fixture', () => {
    // The golden is the committed dump of the *current* target schema; its recorded
    // user_version therefore tracks the highest registered migration.
    expect(goldenSnapshot.userVersion).toBe(TARGET_SCHEMA_VERSION);
  });

  it('accepts is_unlimited = 1 on a DISCRETE item but rejects it on other modes', async () => {
    await runMigrations(driver, migrations);
    const loc = '00000000-0000-4000-8000-000000000001'; // seeded Unassigned location

    // DISCRETE + unlimited is the sole permitted combination — the CHECK admits it.
    await driver.execute(
      `INSERT INTO items (id, name, location_id, tracking_mode, quantity, is_unlimited)
       VALUES ('u1', 'Tap water', ?, 'DISCRETE', 0, 1);`,
      [loc],
    );

    // Every non-DISCRETE mode with is_unlimited = 1 must be refused by the DISCRETE-only CHECK.
    for (const mode of ['SERIALISED', 'UNTRACKED'] as const) {
      const qty = mode === 'SERIALISED' ? 1 : 0;
      await expect(
        driver.execute(
          `INSERT INTO items (id, name, location_id, tracking_mode, quantity, is_unlimited)
           VALUES (?, ?, ?, ?, ?, 1);`,
          [`bad-${mode}`, `Bad ${mode}`, loc, mode, qty],
        ),
      ).rejects.toThrow(/CHECK constraint failed/i);
    }
  });

  it('accepts a null or non-negative unit_cost but rejects a negative one', async () => {
    await runMigrations(driver, migrations);
    const loc = '00000000-0000-4000-8000-000000000001'; // seeded Unassigned location

    // NULL (unset) and a non-negative cost are both admitted by the CHECK.
    await driver.execute(
      `INSERT INTO items (id, name, location_id, tracking_mode, quantity, unit_cost)
       VALUES ('uc-null', 'No cost', ?, 'DISCRETE', 1, NULL),
              ('uc-pos', 'Priced', ?, 'DISCRETE', 1, 12.5);`,
      [loc, loc],
    );

    // A negative unit_cost — from any peer, older build or restored backup the sync merge
    // applies as a direct column write — must be refused by the non-negativity CHECK.
    await expect(
      driver.execute(
        `INSERT INTO items (id, name, location_id, tracking_mode, quantity, unit_cost)
         VALUES ('uc-neg', 'Bad', ?, 'DISCRETE', 1, -1);`,
        [loc],
      ),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  it('creates the revaluations table + current_value column (folded former v4)', async () => {
    await runMigrations(driver, migrations);

    const table = await driver.queryOne<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'revaluations';",
    );
    expect(table?.name).toBe('revaluations');

    const column = await driver.queryOne<{ name: string }>(
      "SELECT name FROM pragma_table_info('items') WHERE name = 'current_value';",
    );
    expect(column?.name).toBe('current_value');
  });

  it('creates the item_relations table (folded former v5)', async () => {
    await runMigrations(driver, migrations);

    const table = await driver.queryOne<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'item_relations';",
    );
    expect(table?.name).toBe('item_relations');

    // Both endpoints cascade on item delete, and a self-relation is refused by the CHECK.
    const loc = '00000000-0000-4000-8000-000000000001'; // seeded Unassigned location
    await driver.execute(
      `INSERT INTO items (id, name, location_id, tracking_mode, quantity)
       VALUES ('ir-a', 'A', ?, 'DISCRETE', 1), ('ir-b', 'B', ?, 'DISCRETE', 1);`,
      [loc, loc],
    );
    await driver.execute(
      `INSERT INTO item_relations (id, from_item_id, to_item_id, kind) VALUES ('ir-a|ir-b|WORKS_WITH', 'ir-a', 'ir-b', 'WORKS_WITH');`,
    );
    await expect(
      driver.execute(
        `INSERT INTO item_relations (id, from_item_id, to_item_id, kind) VALUES ('self', 'ir-a', 'ir-a', 'WORKS_WITH');`,
      ),
    ).rejects.toThrow(/CHECK constraint failed/i);

    // Deleting an endpoint cascades the relation away.
    await driver.execute("DELETE FROM items WHERE id = 'ir-b';");
    const remaining = await driver.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM item_relations;');
    expect(Number(remaining?.n)).toBe(0);
  });

  it('creates the standalone wishlist table (folded former v6)', async () => {
    await runMigrations(driver, migrations);

    const table = await driver.queryOne<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wishlist';",
    );
    expect(table?.name).toBe('wishlist');

    // priority defaults to NONE and a negative target price is refused by the partial CHECK.
    await driver.execute("INSERT INTO wishlist (id, name) VALUES ('w1', 'Cordless drill');");
    const row = await driver.queryOne<{ priority: string; target_price: number | null }>(
      "SELECT priority, target_price FROM wishlist WHERE id = 'w1';",
    );
    expect(row?.priority).toBe('NONE');
    expect(row?.target_price).toBeNull();

    await expect(
      driver.execute("INSERT INTO wishlist (id, name, target_price) VALUES ('w2', 'Bad', -1);"),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  it('creates the test_records table (folded former v7)', async () => {
    await runMigrations(driver, migrations);

    const table = await driver.queryOne<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_records';",
    );
    expect(table?.name).toBe('test_records');

    // kind/result default and a record cascades on item delete.
    const loc = '00000000-0000-4000-8000-000000000001'; // seeded Unassigned location
    await driver.execute(
      `INSERT INTO items (id, name, location_id, tracking_mode, quantity)
       VALUES ('tr-item', 'Meter', ?, 'SERIALISED', 1);`,
      [loc],
    );
    await driver.execute(
      "INSERT INTO test_records (id, item_id, name) VALUES ('tr1', 'tr-item', 'Insulation');",
    );
    const row = await driver.queryOne<{ kind: string; result: string; reading: number | null }>(
      "SELECT kind, result, reading FROM test_records WHERE id = 'tr1';",
    );
    expect(row?.kind).toBe('TEST');
    expect(row?.result).toBe('PASS');
    expect(row?.reading).toBeNull();

    // Deleting the owning item cascades the record away.
    await driver.execute("DELETE FROM items WHERE id = 'tr-item';");
    const remaining = await driver.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM test_records;');
    expect(Number(remaining?.n)).toBe(0);
  });

  it('refuses a database whose version is ahead of the target', async () => {
    // A database left ahead of the highest registered version (target 1) — e.g. a
    // pre-squash install stranded on a former forward chain — must be refused loudly
    // (SCHEMA_TOO_NEW → the boot rescue screen offers a reset), never silently no-opped.
    await driver.execute('PRAGMA user_version = 9;');
    await expect(runMigrations(driver, migrations)).rejects.toMatchObject({
      code: 'SCHEMA_TOO_NEW',
    });
  });
});
