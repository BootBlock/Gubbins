import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { DbError } from '@/db/errors';
import {
  IN_TRANSIT_LOCATION_ID,
  UNASSIGNED_LOCATION_ID,
} from '@/db/repositories/constants';
import { runMigrations } from './engine';
import { migrations } from './index';

describe('v4 projects-reservations-procurement migration', () => {
  let driver: MemoryDriver;

  async function makeItem(id: string): Promise<void> {
    await driver.execute('INSERT INTO items (id, name, location_id) VALUES (?, ?, ?);', [
      id,
      `Item ${id}`,
      UNASSIGNED_LOCATION_ID,
    ]);
  }

  async function makeProject(id: string): Promise<void> {
    await driver.execute('INSERT INTO projects (id, name) VALUES (?, ?);', [id, `Project ${id}`]);
  }

  beforeEach(async () => {
    driver = createMemoryDriver();
    // Scope to v1–v4 so this migration is tested in isolation as its own head
    // (later migrations advance user_version past 4).
    await runMigrations(driver, migrations.filter((m) => m.version <= 4));
  });

  afterEach(async () => {
    await driver.close();
  });

  it('reaches schema version 4', async () => {
    const row = await driver.queryOne<{ user_version: number }>('PRAGMA user_version;');
    expect(Number(row?.user_version)).toBe(4);
  });

  it('creates the Phase 4 tables', async () => {
    const tables = await driver.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;",
    );
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(['item_aliases', 'projects', 'project_bom_lines']),
    );
  });

  it('adds additive mpn/manufacturer/unit_cost columns to items, defaulting NULL', async () => {
    await makeItem('itm');
    const row = await driver.queryOne<{
      mpn: string | null;
      manufacturer: string | null;
      unit_cost: number | null;
    }>('SELECT mpn, manufacturer, unit_cost FROM items WHERE id = ?;', ['itm']);
    expect(row?.mpn).toBeNull();
    expect(row?.manufacturer).toBeNull();
    expect(row?.unit_cost).toBeNull();
  });

  it('seeds the system-locked In-Transit location, protected by the existing guards', async () => {
    const row = await driver.queryOne<{ name: string; is_system: number }>(
      'SELECT name, is_system FROM locations WHERE id = ?;',
      [IN_TRANSIT_LOCATION_ID],
    );
    expect(row?.name).toBe('In Transit');
    expect(row?.is_system).toBe(1);

    // The §4 system-lock triggers (defined in v2) must cover it too.
    await expect(
      driver.execute('UPDATE locations SET name = ? WHERE id = ?;', ['Hacked', IN_TRANSIT_LOCATION_ID]),
    ).rejects.toBeInstanceOf(DbError);
    await expect(
      driver.execute('DELETE FROM locations WHERE id = ?;', [IN_TRANSIT_LOCATION_ID]),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('de-duplicates item aliases case-insensitively', async () => {
    await makeItem('itm');
    await driver.execute('INSERT INTO item_aliases (id, item_id, alias) VALUES (?, ?, ?);', [
      'a1',
      'itm',
      'NE555',
    ]);
    await expect(
      driver.execute('INSERT INTO item_aliases (id, item_id, alias) VALUES (?, ?, ?);', [
        'a2',
        'itm',
        'ne555',
      ]),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('cascades aliases and BOM lines on parent deletes', async () => {
    await makeItem('itm');
    await makeProject('prj');
    await driver.execute('INSERT INTO item_aliases (id, item_id, alias) VALUES (?, ?, ?);', [
      'a1',
      'itm',
      'XYZ',
    ]);
    await driver.execute(
      'INSERT INTO project_bom_lines (id, project_id, item_id) VALUES (?, ?, ?);',
      ['l1', 'prj', 'itm'],
    );

    // Hard-deleting the item: alias cascades away; the BOM line survives but its
    // item_id is set NULL (ON DELETE SET NULL) so a project keeps its requirement.
    await driver.execute('DELETE FROM items WHERE id = ?;', ['itm']);
    expect(await driver.query('SELECT id FROM item_aliases WHERE id = ?;', ['a1'])).toHaveLength(0);
    const line = await driver.queryOne<{ item_id: string | null }>(
      'SELECT item_id FROM project_bom_lines WHERE id = ?;',
      ['l1'],
    );
    expect(line?.item_id).toBeNull();

    // Deleting the project cascades its lines away.
    await driver.execute('DELETE FROM projects WHERE id = ?;', ['prj']);
    expect(await driver.query('SELECT id FROM project_bom_lines WHERE id = ?;', ['l1'])).toHaveLength(
      0,
    );
  });

  it('enforces the status, costing, reservation and procurement CHECKs', async () => {
    await makeProject('prj');
    await expect(
      driver.execute('INSERT INTO projects (id, name, status) VALUES (?, ?, ?);', [
        'bad',
        'X',
        'BOGUS',
      ]),
    ).rejects.toBeInstanceOf(DbError);
    await expect(
      driver.execute(
        'INSERT INTO project_bom_lines (id, project_id, reservation_status) VALUES (?, ?, ?);',
        ['bad', 'prj', 'MAYBE'],
      ),
    ).rejects.toBeInstanceOf(DbError);
    await expect(
      driver.execute(
        'INSERT INTO project_bom_lines (id, project_id, procurement_status) VALUES (?, ?, ?);',
        ['bad', 'prj', 'LOST'],
      ),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('auto-stamps projects.updated_at on modification', async () => {
    await driver.execute('INSERT INTO projects (id, name, updated_at) VALUES (?, ?, 1000);', [
      'prj',
      'Lamp',
    ]);
    await driver.execute('UPDATE projects SET name = ? WHERE id = ?;', ['Lamp v2', 'prj']);
    const row = await driver.queryOne<{ updated_at: number }>(
      'SELECT updated_at FROM projects WHERE id = ?;',
      ['prj'],
    );
    expect(row?.updated_at).toBeGreaterThan(1000);
  });
});
