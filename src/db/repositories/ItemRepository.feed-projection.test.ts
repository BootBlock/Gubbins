/**
 * Issue #529 — the three item attention feeds project text, not image bytes.
 *
 * `listLowStock`, `listExpiring` and `listWarrantyExpiring` back the dashboard widgets, the
 * alert centre, the Upcoming agenda and the bridge's iCal feed; every one of those renders a
 * name beside a quantity or a date, and none renders a picture. Projecting the correlated
 * thumbnail subquery therefore dragged a WebP BLOB out of the worker, through structured
 * clone, for each of up to 100 rows a widget and 500 an agenda lane — a cost bounded by photo
 * coverage rather than by the row cap, and so invisible until most items carry an image.
 *
 * These assert the *statement*, not just the mapped result: discarding the blob after the
 * worker has already materialised and transferred it is exactly the bug, so a test that only
 * checked `thumbnailBlob` would pass against the shape being fixed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ImageRepository } from './ImageRepository';
import { ItemRepository } from './ItemRepository';
import type { Item, Page } from './types';

/** Records the SQL every `query` runs while `run` is in flight, then restores the driver. */
async function captureSql(driver: MemoryDriver, run: () => Promise<unknown>): Promise<string[]> {
  const sql: string[] = [];
  const query = driver.query.bind(driver);
  driver.query = ((text: string, params?: unknown) => {
    sql.push(text);
    return query(text, params as never);
  }) as typeof driver.query;
  try {
    await run();
  } finally {
    driver.query = query;
  }
  return sql;
}

describe('item attention feeds never read the thumbnail BLOB (#529)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let images: ImageRepository;
  /** One item that matches all three feeds at once, and carries a photo. */
  let itemId: string;

  const NOW = Date.UTC(2026, 0, 15);
  const THUMBNAIL = new Uint8Array([1, 2, 3, 4]);

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    images = new ImageRepository(driver);

    const item = await items.create({
      name: 'Photographed Filament',
      trackingMode: 'DISCRETE',
      quantity: 1,
      reorderPoint: 5, // low stock
      expiryDate: NOW + 3 * 86_400_000, // expiring soon
      warrantyExpiresAt: '2026-01-20', // warranty expiring soon
    });
    itemId = item.id;
    await images.add({ itemId, thumbnailBlob: THUMBNAIL, fullResOpfsPath: '/filament.webp' });
  });

  afterEach(async () => {
    await driver.close();
  });

  const feeds: readonly { name: string; read: () => Promise<Page<Item>> }[] = [
    { name: 'listLowStock', read: () => items.listLowStock({ qtyThreshold: 5 }) },
    { name: 'listExpiringWithin', read: () => items.listExpiringWithin(30, NOW) },
    { name: 'listWarrantyExpiring', read: () => items.listWarrantyExpiring(30, NOW) },
  ];

  for (const feed of feeds) {
    it(`${feed.name} selects no thumbnail — neither the subquery nor a NULL alias`, async () => {
      const sql = await captureSql(driver, feed.read);

      expect(sql).not.toHaveLength(0);
      expect(sql.some((s) => s.includes('thumbnail_blob FROM item_images'))).toBe(false);
      // Aliasing a literal NULL would be just as wrong here, for a different reason: it is
      // indistinguishable from an item that genuinely has no image (see the assertion below).
      expect(sql.some((s) => s.includes('NULL AS thumbnail_blob'))).toBe(false);
    });

    it(`${feed.name} reports the thumbnail as unread, not as absent`, async () => {
      const page = await feed.read();
      const row = page.rows.find((r) => r.id === itemId);

      // The row is in the feed at all — otherwise the assertion below is vacuous.
      expect(row).toBeDefined();
      // `undefined` means "this read did not ask"; `null` would claim the item has no image,
      // which is false — it has one, and `getById` below still returns it.
      expect(row!.thumbnailBlob).toBeUndefined();
    });
  }

  it('still returns the thumbnail on the reads that render one', async () => {
    const item = await items.getById(itemId);
    expect(item?.thumbnailBlob).toEqual(THUMBNAIL);
  });
});
