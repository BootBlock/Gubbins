import { describe, it, expect, vi } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ImageRepository } from '@/db/repositories/ImageRepository';
import { ItemRepository } from '@/db/repositories/ItemRepository';
import type { MaintenancePorts } from './db-maintenance-actions';
import {
  isOrphanSweepDue,
  runAutoOrphanSweep,
  ORPHAN_SWEEP_INTERVAL_MS,
  SWEEP_MIN_FILE_AGE_MS,
  type AutoSweepDeps,
} from './auto-orphan-sweep';

describe('auto orphan sweep', () => {
  describe('isOrphanSweepDue', () => {
    it('is due when it has never run', () => {
      expect(isOrphanSweepDue(null, 1_000)).toBe(true);
    });

    it('is not due until the interval has elapsed', () => {
      const last = 1_000_000;
      expect(isOrphanSweepDue(last, last + ORPHAN_SWEEP_INTERVAL_MS - 1)).toBe(false);
      expect(isOrphanSweepDue(last, last + ORPHAN_SWEEP_INTERVAL_MS)).toBe(true);
    });

    it('honours a custom interval', () => {
      expect(isOrphanSweepDue(0, 500, 1_000)).toBe(false);
      expect(isOrphanSweepDue(0, 1_000, 1_000)).toBe(true);
    });
  });

  describe('runAutoOrphanSweep', () => {
    async function seededDriver(): Promise<{ driver: MemoryDriver }> {
      const driver = createMemoryDriver();
      await runMigrations(driver, migrations);
      const items = new ItemRepository(driver);
      const images = new ImageRepository(driver);
      const item = await items.create({ name: 'Camera' });
      await images.add({ itemId: item.id, thumbnailBlob: null, fullResOpfsPath: 'images/keep.webp' });
      return { driver };
    }

    /** Ports over a set of OPFS filenames, recording deletions. */
    function makePorts(driver: MemoryDriver, filenames: string[] | null) {
      const deleted: string[] = [];
      const ports: MaintenancePorts = {
        db: driver,
        listImageFilenames: async () => filenames,
        deleteImageFile: async (path) => {
          deleted.push(path);
        },
        imagesBytesOnDisk: async () => null,
      };
      return { ports, deleted };
    }

    it('skips the sweep entirely when not yet due', async () => {
      const { driver } = await seededDriver();
      const makePortsSpy = vi.fn();
      const writeLastSweptAt = vi.fn();

      const result = await runAutoOrphanSweep({
        now: 5_000,
        readLastSweptAt: () => 5_000, // just swept
        writeLastSweptAt,
        makePorts: makePortsSpy as unknown as AutoSweepDeps['makePorts'],
      });

      expect(result).toBeNull();
      expect(makePortsSpy).not.toHaveBeenCalled();
      expect(writeLastSweptAt).not.toHaveBeenCalled();
      await driver.close();
    });

    it('sweeps orphans and stamps the timestamp when due', async () => {
      const { driver } = await seededDriver();
      const { ports, deleted } = makePorts(driver, ['keep.webp', 'orphan.webp']);
      const writeLastSweptAt = vi.fn();

      const result = await runAutoOrphanSweep({
        now: 42,
        readLastSweptAt: () => null,
        writeLastSweptAt,
        makePorts: () => ports,
      });

      expect(result).toEqual({ supported: true, scanned: 2, referenced: 1, removed: 1 });
      expect(deleted).toEqual(['images/orphan.webp']);
      expect(writeLastSweptAt).toHaveBeenCalledExactlyOnceWith(42);
      await driver.close();
    });

    it('passes the safety margin and clock through to the ports factory', async () => {
      const { driver } = await seededDriver();
      const { ports } = makePorts(driver, []);
      const makePortsSpy = vi.fn(() => ports);

      await runAutoOrphanSweep({
        now: 123,
        readLastSweptAt: () => null,
        writeLastSweptAt: () => {},
        makePorts: makePortsSpy,
      });

      expect(makePortsSpy).toHaveBeenCalledExactlyOnceWith(SWEEP_MIN_FILE_AGE_MS, 123);
      await driver.close();
    });

    it('does not stamp the timestamp when OPFS is unsupported, so the next launch retries', async () => {
      const { driver } = await seededDriver();
      const { ports, deleted } = makePorts(driver, null); // OPFS unreadable
      const writeLastSweptAt = vi.fn();

      const result = await runAutoOrphanSweep({
        now: 99,
        readLastSweptAt: () => null,
        writeLastSweptAt,
        makePorts: () => ports,
      });

      expect(result).toEqual({ supported: false, scanned: 0, referenced: 0, removed: 0 });
      expect(deleted).toEqual([]);
      expect(writeLastSweptAt).not.toHaveBeenCalled();
      await driver.close();
    });
  });
});
