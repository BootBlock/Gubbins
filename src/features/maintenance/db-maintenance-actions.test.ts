import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ImageRepository } from '@/db/repositories/ImageRepository';
import { ItemRepository } from '@/db/repositories/ItemRepository';
import {
  checkDatabaseHealth,
  compactDatabase,
  databaseBytes,
  sweepOrphanImages,
  type MaintenancePorts,
} from './db-maintenance-actions';

describe('Database Maintenance engine', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let images: ImageRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    images = new ImageRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  describe('compact & optimise', () => {
    it('reports a non-negative byte size', async () => {
      expect(await databaseBytes(driver)).toBeGreaterThan(0);
    });

    it('reclaims space freed by deletes and leaves the FTS index searchable', async () => {
      // Grow the file with bulky rows, then delete them all so VACUUM has pages to reclaim.
      const created: string[] = [];
      for (let i = 0; i < 200; i += 1) {
        const item = await items.create({ name: `Widget ${i}`, description: 'x'.repeat(500) });
        created.push(item.id);
      }
      // A surviving row so full-text search can be exercised after compaction.
      const keeper = await items.create({ name: 'Findable resistor' });
      for (const id of created) await items.hardDelete(id);

      const result = await compactDatabase({ db: driver });

      expect(result.beforeBytes).toBeGreaterThan(0);
      expect(result.afterBytes).toBeLessThanOrEqual(result.beforeBytes);
      expect(result.reclaimedBytes).toBe(Math.max(0, result.beforeBytes - result.afterBytes));
      expect(result.reclaimedBytes).toBeGreaterThan(0);
      // The reported stats explain the reclaim: a fraction of the file matching the bytes,
      // and the free pages the deletes left behind for VACUUM to return.
      expect(result.reclaimedFraction).toBeCloseTo(result.reclaimedBytes / result.beforeBytes);
      expect(result.reclaimedFraction).toBeGreaterThan(0);
      expect(result.freePagesBefore).toBeGreaterThan(0);

      // FTS survived the optimize + VACUUM: the keeper is still discoverable.
      const hits = await driver.query<{ rowid: number }>(
        `SELECT rowid FROM items_fts WHERE items_fts MATCH 'resistor';`,
      );
      expect(hits.length).toBe(1);
      expect(await items.getById(keeper.id)).toBeDefined();
    });
  });

  describe('check health', () => {
    it('reports a clean bill of health for a freshly migrated database', async () => {
      const result = await checkDatabaseHealth({ db: driver });
      expect(result.ok).toBe(true);
      expect(result.problems).toEqual([]);
    });

    it('surfaces a foreign-key violation without mutating anything', async () => {
      // Slip a dangling image row past the FK guard (as a sync bug might), then detect it.
      await driver.execute('PRAGMA foreign_keys = OFF;');
      await driver.execute(
        `INSERT INTO item_images (id, item_id, thumbnail_blob, full_res_opfs_path, position)
         VALUES (?, ?, ?, ?, ?);`,
        [crypto.randomUUID(), 'ghost-item', null, 'images/dangling.webp', 0],
      );
      await driver.execute('PRAGMA foreign_keys = ON;');

      const result = await checkDatabaseHealth({ db: driver });
      expect(result.ok).toBe(false);
      expect(result.problems.some((p) => p.includes('item_images'))).toBe(true);

      // Read-only: the offending row is still there (the tool reports, never deletes).
      const row = await driver.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM item_images;');
      expect(Number(row?.n)).toBe(1);
    });
  });

  describe('remove orphaned image files', () => {
    function portsWith(filenames: string[] | null): { ports: MaintenancePorts; deleted: string[] } {
      const deleted: string[] = [];
      return {
        deleted,
        ports: {
          db: driver,
          listImageFilenames: async () => filenames,
          deleteImageFile: async (path) => {
            deleted.push(path);
          },
        },
      };
    }

    it('reports unsupported when OPFS cannot be read, deleting nothing', async () => {
      const { ports, deleted } = portsWith(null);
      const result = await sweepOrphanImages(ports);
      expect(result).toEqual({ supported: false, scanned: 0, referenced: 0, removed: 0 });
      expect(deleted).toEqual([]);
    });

    it('deletes only files that no item_images row references', async () => {
      const item = await items.create({ name: 'Camera' });
      await images.add({ itemId: item.id, thumbnailBlob: null, fullResOpfsPath: 'images/keep.webp' });

      const { ports, deleted } = portsWith(['keep.webp', 'orphan-1.webp', 'orphan-2.webp']);
      const result = await sweepOrphanImages(ports);

      expect(result).toEqual({ supported: true, scanned: 3, referenced: 1, removed: 2 });
      expect(deleted.sort()).toEqual(['images/orphan-1.webp', 'images/orphan-2.webp']);
      expect(deleted).not.toContain('images/keep.webp');
    });

    it('keeps a referenced file even when its bare name differs only by path prefix', async () => {
      const item = await items.create({ name: 'Scope' });
      await images.add({ itemId: item.id, thumbnailBlob: null, fullResOpfsPath: 'images/a.webp' });

      const { ports, deleted } = portsWith(['a.webp']);
      const result = await sweepOrphanImages(ports);

      expect(result.removed).toBe(0);
      expect(result.referenced).toBe(1);
      expect(deleted).toEqual([]);
    });
  });
});
