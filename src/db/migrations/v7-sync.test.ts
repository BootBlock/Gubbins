import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from './engine';
import { migrations } from './index';

describe('v7 sync-tombstones-meta migration', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations.filter((m) => m.version <= 7));
  });

  afterEach(async () => {
    await driver.close();
  });

  it('reaches schema version 7', async () => {
    const row = await driver.queryOne<{ user_version: number }>('PRAGMA user_version;');
    expect(Number(row?.user_version)).toBe(7);
  });

  it('creates the tombstones and sync_meta tables', async () => {
    const tables = await driver.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;",
    );
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(['tombstones', 'sync_meta']),
    );
  });

  it('seeds exactly one pinned sync_meta row with zeroed defaults', async () => {
    const rows = await driver.query<{ id: number; last_sync_timestamp: number; clock_offset: number }>(
      'SELECT * FROM sync_meta;',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 1, last_sync_timestamp: 0, clock_offset: 0 });
  });

  it('rejects a second sync_meta row (the id = 1 CHECK pins it to a singleton)', async () => {
    await expect(
      driver.execute('INSERT INTO sync_meta (id) VALUES (2);'),
    ).rejects.toThrow();
  });

  it('keys tombstones by (table_name, id); re-deleting refreshes deleted_at', async () => {
    await driver.execute(
      "INSERT INTO tombstones (table_name, id, deleted_at) VALUES ('items', 'abc', 100);",
    );
    // Same key re-inserted with OR REPLACE updates the timestamp rather than erroring.
    await driver.execute(
      "INSERT OR REPLACE INTO tombstones (table_name, id, deleted_at) VALUES ('items', 'abc', 200);",
    );
    const rows = await driver.query<{ deleted_at: number }>(
      "SELECT deleted_at FROM tombstones WHERE table_name = 'items' AND id = 'abc';",
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.deleted_at)).toBe(200);
  });

  it('allows the same id under different tables', async () => {
    await driver.execute(
      "INSERT INTO tombstones (table_name, id, deleted_at) VALUES ('items', 'shared', 1);",
    );
    await driver.execute(
      "INSERT INTO tombstones (table_name, id, deleted_at) VALUES ('locations', 'shared', 1);",
    );
    const count = await driver.queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM tombstones WHERE id = 'shared';",
    );
    expect(Number(count?.n)).toBe(2);
  });
});
