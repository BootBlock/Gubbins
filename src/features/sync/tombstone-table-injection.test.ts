/**
 * Regression cover for issue #176 — SQL injection via a snapshot tombstone's `tableName`.
 *
 * A tombstone names its table as a plain string, and that name has to be interpolated into
 * `DELETE FROM <table>` because SQLite cannot parameterise an identifier. The name arrives from
 * parsed JSON, so every route a foreign snapshot takes into Gubbins — an imported backup file, a
 * peer's snapshot in a shared sync folder, an authenticated bridge push — could previously choose
 * its own SQL. A name of `items WHERE 1 OR id = ?; --` forms a single valid statement with the
 * right placeholder arity and empties the table, inside the transaction the user believes is
 * restoring their data.
 *
 * These tests pin both layers of the fix: the allow-list check at the `parseBackupJson` trust
 * boundary, and the `tombstoneDeleteStatement` guard that catches anything arriving by another
 * route.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import {
  ITEM_REGIONS_TABLE,
  ITEM_TAGS_TABLE,
  LOCATION_TAGS_TABLE,
  ItemRepository,
  SYNC_TABLES,
  UNASSIGNED_LOCATION_ID,
} from '@/db/repositories';
import { buildBackupJson, parseBackupJson, restoreFromBackupJson } from './backup';
import { buildLocalSnapshot, tombstoneDeleteStatement } from './snapshot';

/** The exploit from issue #176: a valid single statement that deletes every row. */
const INJECTED_TABLE = 'items WHERE 1 OR id = ?; --';

function backupWithTombstone(tableName: string): string {
  return JSON.stringify({
    formatVersion: 1,
    tombstones: [{ tableName, id: 'some-id', deletedAt: 1 }],
  });
}

describe('issue #176 — tombstone tableName is allow-listed (trust boundary)', () => {
  it('rejects the crafted table name outright rather than skipping the row', () => {
    expect(() => parseBackupJson(backupWithTombstone(INJECTED_TABLE))).toThrow(/not part of Gubbins/i);
  });

  it('rejects a name that is merely unknown, not just one carrying SQL', () => {
    expect(() => parseBackupJson(backupWithTombstone('sqlite_master'))).toThrow(/not part of Gubbins/i);
  });

  it('rejects a tombstone whose deletedAt is not a finite number', () => {
    for (const deletedAt of ['9999999999999', null, {}, Number.NaN]) {
      const text = JSON.stringify({
        formatVersion: 1,
        tombstones: [{ tableName: 'items', id: 'a', deletedAt }],
      });
      expect(() => parseBackupJson(text)).toThrow(/not part of Gubbins/i);
    }
  });

  it('rejects a malformed tables section with the plain envelope message', () => {
    // Would otherwise surface a raw "Cannot use 'in' operator" from statement construction.
    expect(() => parseBackupJson('{"formatVersion":1,"tables":{"items":"oops"}}')).toThrow(
      /expected format/i,
    );
    expect(() => parseBackupJson('{"formatVersion":1,"tables":{"items":[null]}}')).toThrow(
      /expected format/i,
    );
  });

  it('rejects a tombstone whose id is not a string', () => {
    const text = JSON.stringify({
      formatVersion: 1,
      tombstones: [{ tableName: 'items', id: { $ne: null }, deletedAt: 1 }],
    });
    expect(() => parseBackupJson(text)).toThrow(/not part of Gubbins/i);
  });

  it('rejects a tombstones section that is not an array', () => {
    expect(() => parseBackupJson('{"formatVersion":1,"tombstones":"nope"}')).toThrow(/expected format/i);
  });

  it('still accepts every table a tombstone may legitimately name', () => {
    for (const tableName of [...SYNC_TABLES, ITEM_TAGS_TABLE, LOCATION_TAGS_TABLE, ITEM_REGIONS_TABLE]) {
      const snapshot = parseBackupJson(backupWithTombstone(tableName));
      expect(snapshot.tombstones[0]?.tableName).toBe(tableName);
    }
  });

  it('still accepts a snapshot with no tombstones section at all (older backups)', () => {
    expect(parseBackupJson('{"formatVersion":1}').tombstones).toEqual([]);
  });
});

describe('issue #176 — tombstoneDeleteStatement guard (defence in depth)', () => {
  it('throws rather than building a DELETE around an unrecognised table', () => {
    expect(() => tombstoneDeleteStatement(INJECTED_TABLE, 'some-id')).toThrow(/unrecognised table/i);
  });

  it('never emits the injected fragment in the SQL it does build', () => {
    expect(tombstoneDeleteStatement('items', 'some-id').sql).not.toContain('WHERE 1 OR');
  });

  it('still builds the expected DELETE for a legitimate table', () => {
    expect(tombstoneDeleteStatement('items', 'abc')).toEqual({
      sql: 'DELETE FROM items WHERE id = ?;',
      params: ['abc'],
    });
  });
});

describe('issue #176 — a hostile backup cannot empty a table on restore', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('leaves every row intact when an otherwise-valid backup carries the injected tombstone', async () => {
    await items.create({ name: 'Keep me', locationId: UNASSIGNED_LOCATION_ID });
    await items.create({ name: 'Keep me too', locationId: UNASSIGNED_LOCATION_ID });

    // Take a genuine backup, then tamper with only the tombstone table name — exactly what a
    // hostile peer writing into a shared sync folder would produce.
    const tampered = JSON.parse(await buildBackupJson(driver));
    tampered.tombstones = [{ tableName: INJECTED_TABLE, id: 'some-id', deletedAt: Date.now() }];

    await expect(restoreFromBackupJson(driver, JSON.stringify(tampered))).rejects.toThrow(
      /not part of Gubbins/i,
    );

    // The restore is refused whole: nothing was deleted, and no part of the payload was applied.
    const rows = await driver.query<{ n: number }>('SELECT COUNT(*) AS n FROM items;');
    expect(Number(rows[0]?.n)).toBe(2);
  });

  it('recovers a device whose local tombstones were poisoned by an earlier build', async () => {
    await items.create({ name: 'Still here', locationId: UNASSIGNED_LOCATION_ID });

    // Simulate the row a pre-fix build would have persisted: `restoreSnapshot` wrote the
    // attacker's table name straight into the local tombstones table.
    await driver.execute('INSERT INTO tombstones (table_name, id, deleted_at) VALUES (?, ?, ?);', [
      INJECTED_TABLE,
      'poisoned',
      Date.now(),
    ]);

    // Reading the local snapshot must not carry the poisoned row onward — otherwise it is
    // re-published to every peer and throws on the next sync, stranding the device.
    const snapshot = await buildLocalSnapshot(driver);
    expect(snapshot.tombstones.map((t) => t.tableName)).not.toContain(INJECTED_TABLE);

    // Every tombstone that does survive is one the delete-builder will accept.
    for (const t of snapshot.tombstones) {
      expect(() => tombstoneDeleteStatement(t.tableName, t.id)).not.toThrow();
    }
  });
});
