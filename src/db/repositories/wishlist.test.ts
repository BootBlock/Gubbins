import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { TombstoneRepository, WishlistRepository } from './index';
import { sortWishlist } from '@/features/purchasing/wishlist';

/**
 * WishlistRepository (feature-gap G8). Exercises the thin SQL glue around the pure `wishlist.ts`
 * seam: create/update funnel through `planWishlistEntry` (validating name/link/price, softening an
 * unknown priority), the list order matches the seam's `sortWishlist`, and a delete records a
 * tombstone so the removal syncs (but a delete of a missing id records none).
 */
describe('WishlistRepository (feature-gap G8)', () => {
  let driver: MemoryDriver;
  let wishlist: WishlistRepository;
  let tombstones: TombstoneRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    await driver.execute('PRAGMA foreign_keys = ON;');
    wishlist = new WishlistRepository(driver);
    tombstones = new TombstoneRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('creates a full entry, normalising through the seam', async () => {
    const entry = await wishlist.create({
      name: '  Impact driver ',
      note: '  on sale ',
      url: 'example.test/driver',
      targetPrice: 180,
      priority: 'high',
    });
    expect(entry).toMatchObject({
      name: 'Impact driver',
      note: 'on sale',
      url: 'https://example.test/driver',
      targetPrice: 180,
      priority: 'HIGH',
    });
    expect(entry.id).toBeTruthy();
    expect(await wishlist.getById(entry.id)).toMatchObject({ name: 'Impact driver' });
  });

  it('creates a minimal entry (name only) with defaults', async () => {
    const entry = await wishlist.create({ name: 'Filters' });
    expect(entry).toMatchObject({
      name: 'Filters',
      note: null,
      url: null,
      targetPrice: null,
      priority: 'NONE',
    });
  });

  it('rejects a blank name, a non-web link and a negative price', async () => {
    await expect(wishlist.create({ name: '   ' })).rejects.toThrow(/name/i);
    await expect(wishlist.create({ name: 'X', url: 'javascript:alert(1)' })).rejects.toThrow(/link/i);
    await expect(wishlist.create({ name: 'X', targetPrice: -1 })).rejects.toThrow(/non-negative/i);
  });

  it('orders the list exactly as the pure sortWishlist seam', async () => {
    await wishlist.create({ name: 'Zebra kit', priority: 'LOW' });
    await wishlist.create({ name: 'apple corer', priority: 'HIGH' });
    await wishlist.create({ name: 'Bolt cutters', priority: 'HIGH' });
    await wishlist.create({ name: 'Gizmo', priority: 'NONE' });

    const page = await wishlist.list();
    const expected = sortWishlist(page.rows);
    expect(page.rows.map((r) => r.name)).toEqual(expected.map((r) => r.name));
    // HIGH group first (apple corer, Bolt cutters — case-insensitive), then LOW, then NONE.
    expect(page.rows.map((r) => r.name)).toEqual(['apple corer', 'Bolt cutters', 'Zebra kit', 'Gizmo']);
  });

  it('updates only the provided fields and can clear an optional one', async () => {
    const entry = await wishlist.create({
      name: 'Drill',
      note: 'keep',
      url: 'https://example.test/x',
      targetPrice: 50,
      priority: 'LOW',
    });

    const updated = await wishlist.update(entry.id, { priority: 'HIGH', note: null });
    expect(updated).toMatchObject({
      name: 'Drill', // untouched
      note: null, // cleared
      url: 'https://example.test/x', // untouched
      targetPrice: 50, // untouched
      priority: 'HIGH', // changed
    });
  });

  it('rejects an update that blanks the name / sets a bad link or price', async () => {
    const entry = await wishlist.create({ name: 'Drill' });
    await expect(wishlist.update(entry.id, { name: '  ' })).rejects.toThrow(/name/i);
    await expect(wishlist.update(entry.id, { url: 'ftp://x' })).rejects.toThrow(/link/i);
    await expect(wishlist.update(entry.id, { targetPrice: -3 })).rejects.toThrow(/non-negative/i);
  });

  it('throws when updating a missing entry', async () => {
    await expect(wishlist.update('does-not-exist', { name: 'X' })).rejects.toThrow(/does not exist/i);
  });

  it('deletes an entry and records a tombstone so the removal syncs', async () => {
    const entry = await wishlist.create({ name: 'Gone' });
    await wishlist.delete(entry.id);

    expect(await wishlist.getById(entry.id)).toBeUndefined();
    expect(await tombstones.has('wishlist', entry.id)).toBe(true);
  });

  it('is a no-op (no tombstone) when deleting a missing id', async () => {
    await wishlist.delete('never-existed');
    expect(await tombstones.has('wishlist', 'never-existed')).toBe(false);
  });
});
