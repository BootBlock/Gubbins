import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ImageRepository } from './ImageRepository';
import { ItemRepository } from './ItemRepository';

describe('ImageRepository', () => {
  let driver: MemoryDriver;
  let images: ImageRepository;
  let items: ItemRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    images = new ImageRepository(driver);
    items = new ItemRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('stores only a thumbnail blob and an OPFS path pointer (Anti-Base64, §4.2.1)', async () => {
    const item = await items.create({ name: 'Pictured' });
    const thumb = new Uint8Array([10, 20, 30]);
    const img = await images.add({
      itemId: item.id,
      thumbnailBlob: thumb,
      fullResOpfsPath: '/images/abc.webp',
    });
    expect(img.fullResOpfsPath).toBe('/images/abc.webp');
    expect(Array.from(img.thumbnailBlob as Uint8Array)).toEqual([10, 20, 30]);

    const list = await images.listForItem(item.id);
    expect(list).toHaveLength(1);
  });

  it('rejects a blank OPFS path', async () => {
    const item = await items.create({ name: 'X' });
    await expect(
      images.add({ itemId: item.id, thumbnailBlob: null, fullResOpfsPath: '  ' }),
    ).rejects.toBeInstanceOf(Error);
  });

  it('returns the OPFS path on removal so the caller can delete the raw file', async () => {
    const item = await items.create({ name: 'Pictured' });
    const img = await images.add({
      itemId: item.id,
      thumbnailBlob: null,
      fullResOpfsPath: '/images/del.webp',
    });
    const path = await images.remove(img.id);
    expect(path).toBe('/images/del.webp');
    expect(await images.listForItem(item.id)).toHaveLength(0);
  });

  it('lists images ordered by position', async () => {
    const item = await items.create({ name: 'Pictured' });
    await images.add({ itemId: item.id, thumbnailBlob: null, fullResOpfsPath: '/b.webp', position: 2 });
    await images.add({ itemId: item.id, thumbnailBlob: null, fullResOpfsPath: '/a.webp', position: 1 });
    const list = await images.listForItem(item.id);
    expect(list.map((i) => i.fullResOpfsPath)).toEqual(['/a.webp', '/b.webp']);
  });

  it('gates image growth on the storage Hard Stop, but allows removal to free space', async () => {
    const item = await items.create({ name: 'Pictured' });
    const img = await images.add({
      itemId: item.id,
      thumbnailBlob: null,
      fullResOpfsPath: '/keep.webp',
    });

    const locked = new ImageRepository(driver, { isWriteSuspended: () => true });
    await expect(
      locked.add({ itemId: item.id, thumbnailBlob: null, fullResOpfsPath: '/no.webp' }),
    ).rejects.toMatchObject({ code: 'WRITE_SUSPENDED' });
    await expect(locked.remove(img.id)).resolves.toBe('/keep.webp');
  });
});
