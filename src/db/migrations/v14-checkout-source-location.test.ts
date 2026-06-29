import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from './engine';
import { migrations } from './index';

describe('v14 checkout-source-location migration', () => {
  let driver: MemoryDriver;

  async function seed(): Promise<void> {
    await driver.execute('INSERT INTO locations (id, name) VALUES (?, ?);', ['loc-a', 'Drawer A']);
    await driver.execute(
      `INSERT INTO items (id, name, location_id, tracking_mode, quantity) VALUES (?, ?, ?, 'DISCRETE', 3);`,
      ['i1', 'Widget', 'loc-a'],
    );
    await driver.execute('INSERT INTO contacts (id, name) VALUES (?, ?);', ['c1', 'Alex']);
  }

  beforeEach(async () => {
    driver = createMemoryDriver();
    // Narrowed to <= 14 so the "reaches version 14" assertion survives later bumps
    // (the established per-version pattern — Phase 25 narrowed the v12 test likewise).
    await runMigrations(driver, migrations.filter((m) => m.version <= 14));
    await driver.execute('PRAGMA foreign_keys = ON;');
    await seed();
  });

  afterEach(async () => {
    await driver.close();
  });

  it('reaches schema version 14', async () => {
    const row = await driver.queryOne<{ user_version: number }>('PRAGMA user_version;');
    expect(Number(row?.user_version)).toBe(14);
  });

  it('adds source_location_id defaulting to NULL (no specific source)', async () => {
    await driver.execute(
      'INSERT INTO checkouts (id, item_id, contact_id, quantity) VALUES (?, ?, ?, 1);',
      ['k1', 'i1', 'c1'],
    );
    const row = await driver.queryOne<{ source_location_id: string | null }>(
      'SELECT source_location_id FROM checkouts WHERE id = ?;',
      ['k1'],
    );
    expect(row?.source_location_id).toBeNull();
  });

  it('records a lend-from location and enforces its foreign key', async () => {
    await driver.execute(
      'INSERT INTO checkouts (id, item_id, contact_id, quantity, source_location_id) VALUES (?, ?, ?, 1, ?);',
      ['k1', 'i1', 'c1', 'loc-a'],
    );
    const row = await driver.queryOne<{ source_location_id: string | null }>(
      'SELECT source_location_id FROM checkouts WHERE id = ?;',
      ['k1'],
    );
    expect(row?.source_location_id).toBe('loc-a');

    await expect(
      driver.execute(
        'INSERT INTO checkouts (id, item_id, contact_id, quantity, source_location_id) VALUES (?, ?, ?, 1, ?);',
        ['k2', 'i1', 'c1', 'ghost-loc'],
      ),
    ).rejects.toThrow();
  });
});
