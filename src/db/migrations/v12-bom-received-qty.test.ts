import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from './engine';
import { migrations } from './index';

describe('v12 bom-received-qty migration', () => {
  let driver: MemoryDriver;

  async function makeLine(id: string): Promise<void> {
    await driver.execute('INSERT INTO projects (id, name) VALUES (?, ?);', [`proj-${id}`, `Project ${id}`]);
    await driver.execute(
      `INSERT INTO project_bom_lines (id, project_id, required_qty) VALUES (?, ?, 5);`,
      [id, `proj-${id}`],
    );
  }

  beforeEach(async () => {
    driver = createMemoryDriver();
    // Narrowed to <= 12 so the "reaches version 12" assertion survives later bumps
    // (the established per-version pattern — Phase 24 narrowed the v11 test likewise).
    await runMigrations(driver, migrations.filter((m) => m.version <= 12));
  });

  afterEach(async () => {
    await driver.close();
  });

  it('reaches schema version 12', async () => {
    const row = await driver.queryOne<{ user_version: number }>('PRAGMA user_version;');
    expect(Number(row?.user_version)).toBe(12);
  });

  it('adds received_qty defaulting to 0 (nothing received yet)', async () => {
    await makeLine('l1');
    const row = await driver.queryOne<{ received_qty: number }>(
      'SELECT received_qty FROM project_bom_lines WHERE id = ?;',
      ['l1'],
    );
    expect(row?.received_qty).toBe(0);
  });

  it('accumulates an instalment without disturbing the requirement', async () => {
    await makeLine('l1');
    await driver.execute('UPDATE project_bom_lines SET received_qty = 2 WHERE id = ?;', ['l1']);
    const row = await driver.queryOne<{ received_qty: number; required_qty: number }>(
      'SELECT received_qty, required_qty FROM project_bom_lines WHERE id = ?;',
      ['l1'],
    );
    expect(row?.received_qty).toBe(2);
    expect(row?.required_qty).toBe(5);
  });
});
