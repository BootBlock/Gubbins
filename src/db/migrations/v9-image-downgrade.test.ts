import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories/constants';
import { runMigrations } from './engine';
import { migrations } from './index';

describe('v9 image-downgrade-marker migration', () => {
  let driver: MemoryDriver;

  async function makeImage(id: string, path: string): Promise<void> {
    await driver.execute('INSERT INTO items (id, name, location_id) VALUES (?, ?, ?);', [
      `item-${id}`,
      `Item ${id}`,
      UNASSIGNED_LOCATION_ID,
    ]);
    await driver.execute(
      'INSERT INTO item_images (id, item_id, full_res_opfs_path) VALUES (?, ?, ?);',
      [id, `item-${id}`, path],
    );
  }

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations.filter((m) => m.version <= 9));
  });

  afterEach(async () => {
    await driver.close();
  });

  it('reaches schema version 9', async () => {
    const row = await driver.queryOne<{ user_version: number }>('PRAGMA user_version;');
    expect(Number(row?.user_version)).toBe(9);
  });

  it('adds a nullable full_res_downgraded_at column defaulting NULL', async () => {
    await makeImage('img1', 'images/a.webp');
    const row = await driver.queryOne<{ full_res_downgraded_at: number | null }>(
      'SELECT full_res_downgraded_at FROM item_images WHERE id = ?;',
      ['img1'],
    );
    expect(row?.full_res_downgraded_at).toBeNull();
  });

  it('records a downgrade stamp without disturbing the NOT-NULL path', async () => {
    await makeImage('img1', 'images/a.webp');
    await driver.execute(
      'UPDATE item_images SET full_res_downgraded_at = ? WHERE id = ?;',
      [1_900_000_000_000, 'img1'],
    );
    const row = await driver.queryOne<{
      full_res_downgraded_at: number | null;
      full_res_opfs_path: string;
    }>('SELECT full_res_downgraded_at, full_res_opfs_path FROM item_images WHERE id = ?;', [
      'img1',
    ]);
    expect(row?.full_res_downgraded_at).toBe(1_900_000_000_000);
    expect(row?.full_res_opfs_path).toBe('images/a.webp');
  });
});
