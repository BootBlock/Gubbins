/**
 * The Danger Zone deletes the full-resolution OPFS files its selected targets orphan — and
 * **only** those (issue #820).
 *
 * Item photos and location photos share one flat OPFS `images/` directory, so the earlier
 * "remove the directory" cleanup made erasing either kind destroy the other kind's originals
 * while leaving its rows and thumbnails in place. Nothing signalled the loss, and a
 * full-resolution file is not carried in the sync artefact, so it could not come back from a
 * peer.
 *
 * `EraseTarget.imageTable` claims to name the photo table that target's `buildStatements`
 * empties. This file is the drift test that claim asks for: rather than reading the two
 * declarations side by side, it drives the real erase against a real database holding one of
 * each kind of photo, and requires the set of files deleted to equal the set of rows that
 * disappeared. Mutate either side — point a target at the wrong table, narrow a `DELETE` — and
 * the comparison goes red.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { UNRESTRICTED_AUTHORITY } from '@/features/users/permissions';
import { eraseTargets, type ErasePorts } from './erase-actions';
import { ERASE_TARGETS, type EraseTargetId } from './erase-targets';

/** A minimal Storage stand-in; the image targets touch none of it. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  } as Storage;
}

/** The paths of every photo row currently in the database, both kinds together. */
async function storedPaths(driver: MemoryDriver): Promise<Set<string>> {
  const rows = await driver.query<{ full_res_opfs_path: string }>(
    `SELECT full_res_opfs_path FROM item_images
     UNION ALL
     SELECT full_res_opfs_path FROM location_photos;`,
  );
  return new Set(rows.map((row) => row.full_res_opfs_path));
}

/** Every target that claims to own OPFS files, so a new one is covered without editing this. */
const IMAGE_TARGET_IDS: readonly EraseTargetId[] = ERASE_TARGETS.filter((target) => target.imageTable).map(
  (target) => target.id,
);

describe('erasing photos deletes the files those rows owned, and no others', () => {
  let driver: MemoryDriver;
  let deleteImageFiles: ReturnType<typeof vi.fn>;

  const ITEM_PATH = 'images/item-a.webp';
  const LOCATION_PATH = 'images/location-b.webp';

  /** Every path handed to the batch delete, flattened across however many calls were made. */
  function deletedPaths(): string[] {
    return deleteImageFiles.mock.calls.flatMap(([paths]) => paths as string[]);
  }

  function ports(): ErasePorts {
    return {
      db: driver,
      deleteImageFiles,
      deleteIdb: vi.fn(async () => {}),
      local: fakeStorage(),
      authority: () => UNRESTRICTED_AUTHORITY,
    };
  }

  /** One item photo and one location photo, each with its own full-resolution file. */
  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    deleteImageFiles = vi.fn(async () => {});

    await driver.execute('INSERT INTO locations (id, name, is_system) VALUES (?, ?, 0);', [
      'loc-1',
      'Shelf A',
    ]);
    await driver.execute('INSERT INTO items (id, name, location_id) VALUES (?, ?, ?);', [
      'item-1',
      'Widget',
      'loc-1',
    ]);
    await driver.execute('INSERT INTO item_images (id, item_id, full_res_opfs_path) VALUES (?, ?, ?);', [
      'img-1',
      'item-1',
      ITEM_PATH,
    ]);
    await driver.execute(
      `INSERT INTO location_photos (id, location_id, full_res_opfs_path, natural_width, natural_height)
       VALUES (?, ?, ?, 800, 600);`,
      ['photo-1', 'loc-1', LOCATION_PATH],
    );
  });

  afterEach(async () => {
    await driver.close();
  });

  it.each(IMAGE_TARGET_IDS)('deletes exactly the files whose rows "%s" removed', async (id) => {
    const before = await storedPaths(driver);
    await eraseTargets([id], { tombstone: false }, ports());
    const after = await storedPaths(driver);

    const orphaned = new Set([...before].filter((path) => !after.has(path)));
    const deleted = new Set(deletedPaths());

    expect([...deleted].sort()).toEqual([...orphaned].sort());
    // A row that survived still has its file — the failure this whole test exists for.
    for (const path of after) expect(deleted.has(path)).toBe(false);
  });

  it('keeps the location photo and its file when item photos are erased', async () => {
    await eraseTargets(['item-photos'], { tombstone: false }, ports());

    expect(await storedPaths(driver)).toEqual(new Set([LOCATION_PATH]));
    expect(deletedPaths()).toEqual([ITEM_PATH]);
  });

  it('keeps the item photo and its file when location photos are erased', async () => {
    await eraseTargets(['location-photos'], { tombstone: false }, ports());

    expect(await storedPaths(driver)).toEqual(new Set([ITEM_PATH]));
    expect(deletedPaths()).toEqual([LOCATION_PATH]);
  });

  it('keeps every location photo file when all items are erased', async () => {
    await eraseTargets(['items'], { tombstone: false }, ports());

    expect(await storedPaths(driver)).toEqual(new Set([LOCATION_PATH]));
    expect(deletedPaths()).toEqual([ITEM_PATH]);
  });

  it('deletes a shared file once when overlapping targets are erased together', async () => {
    await eraseTargets(['items', 'item-photos'], { tombstone: false }, ports());

    expect(deletedPaths()).toEqual([ITEM_PATH]);
  });

  it('deletes both kinds when both targets are erased together', async () => {
    await eraseTargets(['item-photos', 'location-photos'], { tombstone: false }, ports());

    expect(await storedPaths(driver)).toEqual(new Set());
    expect(deletedPaths().sort()).toEqual([ITEM_PATH, LOCATION_PATH].sort());
  });
});
