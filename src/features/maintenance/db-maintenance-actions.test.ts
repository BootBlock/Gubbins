import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ImageRepository } from '@/db/repositories/ImageRepository';
import { LocationPhotoRepository } from '@/db/repositories/LocationPhotoRepository';
import { LocationRepository } from '@/db/repositories/LocationRepository';
import { ItemRepository } from '@/db/repositories/ItemRepository';
import {
  checkDatabaseHealth,
  checkSearchIndex,
  compactDatabase,
  databaseBytes,
  findMissingImageFiles,
  gatherDatabaseStats,
  sweepOrphanImages,
  verifyStockTotals,
  type MaintenancePorts,
} from './db-maintenance-actions';

describe('Database Maintenance engine', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let images: ImageRepository;
  let locations: LocationRepository;
  let locationPhotos: LocationPhotoRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    images = new ImageRepository(driver);
    locations = new LocationRepository(driver);
    locationPhotos = new LocationPhotoRepository(driver);
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

    // Regression (issue #81): item photos and location photos share one flat OPFS `images/`
    // directory. A sweep that built its referenced set from `item_images` alone would see
    // every location photo as an orphan and delete a user's pictures. If a third image-owning
    // table is ever added, this test is the one that should fail first.
    it('keeps a location photo, which lives in the same OPFS directory as item photos', async () => {
      const location = await locations.create({ name: 'Workshop' });
      await locationPhotos.addPhoto({
        locationId: location.id,
        thumbnailBlob: null,
        fullResOpfsPath: 'images/shelf.webp',
        naturalWidth: 1200,
        naturalHeight: 800,
      });
      const item = await items.create({ name: 'Multimeter' });
      await images.add({ itemId: item.id, thumbnailBlob: null, fullResOpfsPath: 'images/meter.webp' });

      const { ports, deleted } = portsWith(['shelf.webp', 'meter.webp', 'orphan.webp']);
      const result = await sweepOrphanImages(ports);

      expect(result).toEqual({ supported: true, scanned: 3, referenced: 2, removed: 1 });
      expect(deleted).toEqual(['images/orphan.webp']);
      expect(deleted).not.toContain('images/shelf.webp');
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

  // Full ports for the DB+OPFS tasks; overridable per test. OPFS defaults to an empty
  // directory that reports "unmeasurable" bytes (the `:memory:` environment has no OPFS).
  function fullPorts(overrides?: Partial<MaintenancePorts>): MaintenancePorts {
    return {
      db: driver,
      listImageFilenames: async () => [],
      deleteImageFile: async () => {},
      imagesBytesOnDisk: async () => null,
      ...overrides,
    };
  }

  describe('database statistics', () => {
    it('summarises size, per-table rows, images and versions', async () => {
      await items.create({ name: 'Widget' });
      await items.create({ name: 'Gadget' });

      const stats = await gatherDatabaseStats(fullPorts());

      expect(stats.fileBytes).toBeGreaterThan(0);
      expect(stats.totalRows).toBeGreaterThan(0);
      expect(stats.tables.find((t) => t.table === 'items')?.rows).toBe(2);
      // FTS5 shadow tables and SQLite internals are filtered out of the breakdown.
      expect(stats.tables.some((t) => t.table.includes('items_fts'))).toBe(false);
      expect(stats.tables.some((t) => t.table.startsWith('sqlite_'))).toBe(false);
      // Only non-empty tables are listed, busiest first.
      expect(stats.tables.every((t) => t.rows > 0)).toBe(true);
      expect(stats.sqliteVersion).toMatch(/^\d+\./);
      expect(stats.schemaVersion).toBeGreaterThan(0);
    });

    it('falls back to the row-count estimate when OPFS bytes cannot be measured', async () => {
      const item = await items.create({ name: 'Camera' });
      await images.add({ itemId: item.id, thumbnailBlob: null, fullResOpfsPath: 'images/a.webp' });

      const stats = await gatherDatabaseStats(fullPorts({ imagesBytesOnDisk: async () => null }));

      expect(stats.imageCount).toBe(1);
      expect(stats.imageBytesMeasured).toBe(false);
      expect(stats.imageBytes).toBeGreaterThan(0);
    });

    it('reports the measured OPFS bytes verbatim when available', async () => {
      const item = await items.create({ name: 'Camera' });
      await images.add({ itemId: item.id, thumbnailBlob: null, fullResOpfsPath: 'images/a.webp' });

      const stats = await gatherDatabaseStats(fullPorts({ imagesBytesOnDisk: async () => 4096 }));

      expect(stats.imageBytesMeasured).toBe(true);
      expect(stats.imageBytes).toBe(4096);
    });
  });

  describe('verify search index', () => {
    it('verifies a consistent index without rebuilding', async () => {
      await items.create({ name: 'Resistor' });
      const result = await checkSearchIndex({ db: driver });
      expect(result).toEqual({ ok: true, repaired: false });
    });

    it('rebuilds a desynced index and restores search', async () => {
      await items.create({ name: 'Findable capacitor' });
      // Force the external-content index out of step with its content table.
      await driver.execute(`INSERT INTO items_fts(items_fts) VALUES ('delete-all');`);
      const before = await driver.query(`SELECT rowid FROM items_fts WHERE items_fts MATCH 'capacitor';`);
      expect(before.length).toBe(0);

      const result = await checkSearchIndex({ db: driver });
      expect(result).toEqual({ ok: true, repaired: true });

      const after = await driver.query(`SELECT rowid FROM items_fts WHERE items_fts MATCH 'capacitor';`);
      expect(after.length).toBe(1);
    });
  });

  describe('verify stock totals', () => {
    it('reports all totals reconciled for a normal database', async () => {
      await items.create({ name: 'Bolt', quantity: 10 });
      const result = await verifyStockTotals({ db: driver });
      expect(result.ok).toBe(true);
      expect(result.itemDrift).toEqual([]);
      expect(result.placementDrift).toEqual([]);
    });

    it('detects an item whose quantity has drifted from its ledger', async () => {
      const item = await items.create({ name: 'Nut', quantity: 5 });
      // A direct write to items.quantity has no trigger to hold it in step with the
      // item_stock ledger (the recompute triggers fire on item_stock, not items), so it drifts.
      await driver.execute('UPDATE items SET quantity = 999 WHERE id = ?;', [item.id]);

      const result = await verifyStockTotals({ db: driver });

      expect(result.ok).toBe(false);
      expect(result.itemDrift.length).toBe(1);
      expect(result.itemDrift[0]).toMatchObject({ subject: 'Nut', declared: 999, computed: 5 });
    });
  });

  describe('find missing photo files', () => {
    it('reports unsupported when OPFS cannot be read', async () => {
      const result = await findMissingImageFiles(fullPorts({ listImageFilenames: async () => null }));
      expect(result).toEqual({ supported: false, checked: 0, missing: 0, sampleNames: [] });
    });

    it('flags rows whose file is absent, ignoring downgraded rows', async () => {
      const item = await items.create({ name: 'Scope' });
      await images.add({ itemId: item.id, thumbnailBlob: null, fullResOpfsPath: 'images/present.webp' });
      await images.add({ itemId: item.id, thumbnailBlob: null, fullResOpfsPath: 'images/gone.webp' });
      const downgraded = await images.add({
        itemId: item.id,
        thumbnailBlob: null,
        fullResOpfsPath: 'images/old.webp',
      });
      // A downgraded row deliberately dropped its full-res file — its absence is by design.
      await driver.execute('UPDATE item_images SET full_res_downgraded_at = ? WHERE id = ?;', [
        Date.now(),
        downgraded.id,
      ]);

      // Only present.webp is on disk: gone.webp is missing; old.webp is downgraded (ignored).
      const result = await findMissingImageFiles(
        fullPorts({ listImageFilenames: async () => ['present.webp'] }),
      );

      expect(result.supported).toBe(true);
      expect(result.checked).toBe(2); // present + gone; the downgraded row is excluded
      expect(result.missing).toBe(1);
      expect(result.sampleNames).toEqual(['Scope']);
    });
  });
});
