import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ImageRepository } from './ImageRepository';
import { ItemRepository } from './ItemRepository';
import { StorageRepository } from './StorageRepository';

describe('StorageRepository (spec §7.6.2, §7.6.3)', () => {
  let driver: MemoryDriver;
  let storage: StorageRepository;
  let items: ItemRepository;
  let images: ImageRepository;

  /** Append a history row with an explicit created_at (bypasses the repo for control). */
  async function addHistory(itemId: string, createdAt: number): Promise<void> {
    await driver.execute(
      `INSERT INTO item_history (id, item_id, action, created_at) VALUES (?, ?, ?, ?);`,
      [crypto.randomUUID(), itemId, 'QUANTITY_CHANGE', createdAt],
    );
  }

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    storage = new StorageRepository(driver);
    items = new ItemRepository(driver);
    images = new ImageRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  describe('row counts (§7.6.2)', () => {
    it('counts items, history and images separately', async () => {
      const a = await items.create({ name: 'A' }); // logs a CREATED history row
      await items.create({ name: 'B' });
      await addHistory(a.id, 1000);
      await images.add({ itemId: a.id, thumbnailBlob: null, fullResOpfsPath: 'images/a.webp' });

      const counts = await storage.rowCounts();
      expect(counts.items).toBe(2);
      expect(counts.itemImages).toBe(1);
      // 2 CREATED rows + 1 manual = 3.
      expect(counts.itemHistory).toBe(3);
    });
  });

  describe('history pruning (§7.6.3 Workflow A)', () => {
    it('counts and lists only history strictly older than the cutoff', async () => {
      const item = await items.create({ name: 'Logged' });
      await addHistory(item.id, 100);
      await addHistory(item.id, 200);
      await addHistory(item.id, 300);

      expect(await storage.countHistoryBefore(250)).toBe(2);
      const page = await storage.listHistoryBefore(250, { limit: 100 });
      expect(page.rows.map((r) => r.createdAt).sort()).toEqual([100, 200]);
    });

    it('deletes the targeted rows and reports how many, leaving newer rows intact', async () => {
      const item = await items.create({ name: 'Logged' }); // CREATED at ~now
      await addHistory(item.id, 100);
      await addHistory(item.id, 200);

      const removed = await storage.pruneHistoryBefore(250);
      expect(removed).toBe(2);
      // The recent CREATED row survives.
      const remaining = await driver.query('SELECT id FROM item_history;');
      expect(remaining).toHaveLength(1);
    });

    it('prunes even at the storage Hard Stop (a DELETE frees space)', async () => {
      const item = await items.create({ name: 'Logged' });
      await addHistory(item.id, 100);
      const locked = new StorageRepository(driver, { isWriteSuspended: () => true });
      await expect(locked.pruneHistoryBefore(250)).resolves.toBeGreaterThanOrEqual(1);
    });
  });

  describe('image downgrading (§7.6.3 Workflow B)', () => {
    async function addImageAt(path: string, createdAt: number): Promise<string> {
      const item = await items.create({ name: `for ${path}` });
      const img = await images.add({ itemId: item.id, thumbnailBlob: null, fullResOpfsPath: path });
      await driver.execute('UPDATE item_images SET created_at = ? WHERE id = ?;', [createdAt, img.id]);
      return img.id;
    }

    it('lists downgradable images older than the cutoff with their OPFS paths', async () => {
      await addImageAt('images/old.webp', 100);
      await addImageAt('images/new.webp', 9_000);

      expect(await storage.countDowngradableBefore(5_000)).toBe(1);
      const page = await storage.listDowngradableBefore(5_000, { limit: 100 });
      expect(page.rows.map((r) => r.fullResOpfsPath)).toEqual(['images/old.webp']);
    });

    it('marks an image downgraded, keeping the thumbnail and excluding it next time', async () => {
      const id = await addImageAt('images/old.webp', 100);
      await storage.markImageDowngraded(id, 12_345);

      const row = await driver.queryOne<{ full_res_downgraded_at: number }>(
        'SELECT full_res_downgraded_at FROM item_images WHERE id = ?;',
        [id],
      );
      expect(row?.full_res_downgraded_at).toBe(12_345);
      // Already-downgraded images are not offered again.
      expect(await storage.countDowngradableBefore(5_000)).toBe(0);
    });

    it('marks downgraded even at the Hard Stop (it reclaims space, never bricks the user)', async () => {
      const id = await addImageAt('images/old.webp', 100);
      const locked = new StorageRepository(driver, { isWriteSuspended: () => true });
      await expect(locked.markImageDowngraded(id, 999)).resolves.toBeUndefined();
    });
  });
});
