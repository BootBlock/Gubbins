import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from './engine';
import { migrations } from './index';

describe('v19 location-description-color migration', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    driver = createMemoryDriver();
    // Narrowed to <= 19 so the "reaches version 19" assertion survives later bumps.
    await runMigrations(driver, migrations.filter((m) => m.version <= 19));
    await driver.execute('PRAGMA foreign_keys = ON;');
  });

  afterEach(async () => {
    await driver.close();
  });

  it('reaches schema version 19 and registers v19 last', async () => {
    const row = await driver.queryOne<{ user_version: number }>('PRAGMA user_version;');
    expect(Number(row?.user_version)).toBe(19);
    const v19 = migrations.find((m) => m.version === 19);
    expect(v19?.name).toBe('location-description-color');
  });

  it('adds nullable description + color columns (no backfill)', async () => {
    const cols = await driver.query<{ name: string; notnull: number; dflt_value: string | null }>(
      'PRAGMA table_info(locations);',
    );
    for (const name of ['description', 'color']) {
      const col = cols.find((c) => c.name === name);
      expect(col, `expected column ${name}`).toBeDefined();
      expect(col?.notnull).toBe(0);
      expect(col?.dflt_value).toBeNull();
    }
  });

  it('defaults both to NULL for a legacy-style location row', async () => {
    await driver.execute('INSERT INTO locations (id, name) VALUES (?, ?);', ['loc-a', 'Workshop']);
    const row = await driver.queryOne<{ description: string | null; color: string | null }>(
      'SELECT description, color FROM locations WHERE id = ?;',
      ['loc-a'],
    );
    expect(row?.description).toBeNull();
    expect(row?.color).toBeNull();
  });

  it('stores a description and a colour swatch key', async () => {
    await driver.execute(
      'INSERT INTO locations (id, name, description, color) VALUES (?, ?, ?, ?);',
      ['loc-b', 'Cabinet A', 'Behind the lathe', 'teal'],
    );
    const row = await driver.queryOne<{ description: string | null; color: string | null }>(
      'SELECT description, color FROM locations WHERE id = ?;',
      ['loc-b'],
    );
    expect(row?.description).toBe('Behind the lathe');
    expect(row?.color).toBe('teal');
  });
});
